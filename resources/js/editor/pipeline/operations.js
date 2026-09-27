// Isolated pixel operations for the adjustment pipeline.
// Every operation receives the full RGBA working buffer (Uint8ClampedArray) and
// mutates it in place. Alpha is never modified. Writing through a clamped array
// guarantees 0–255 integer output — NaN/Infinity can never escape into the image.
//
// The pipeline calls them in a fixed documented order; each op early-returns
// when its value is 0 so untouched frames cost nothing.
//
// Insert future operations (fade, vignette, grain, film curves, color grading,
// light leaks) as new exported functions and register them in AdjustmentPipeline.

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function luminance(r, g, b) {
    return (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
}

// Smooth 0→1 ramp used for luminance masks (no harsh band boundary).
export function smoothstep(t) {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
}

// Photographic exposure: gain = 2^(stops). value -100 → 0.25×, 0 → 1×, +100 → 4×.
export function applyExposure(data, width, height, value) {
    if (!value) return;
    const gain = Math.pow(2, value / 50);
    for (let i = 0; i < data.length; i += 4) {
        data[i] *= gain;
        data[i + 1] *= gain;
        data[i + 2] *= gain;
    }
}

// White-balance temperature: warm (+) lifts red, cools blue; cool (−) mirrors it.
export function applyTemperature(data, width, height, value) {
    if (!value) return;
    const t = value / 100;
    const kr = 1 + 0.25 * t;
    const kg = 1 + 0.05 * t;
    const kb = 1 - 0.25 * t;
    for (let i = 0; i < data.length; i += 4) {
        data[i] *= kr;
        data[i + 1] *= kg;
        data[i + 2] *= kb;
    }
}

// Tint: positive → magenta (R/B up, G down), negative → green. Weights keep the
// luminance shift small instead of replacing channels outright.
export function applyTint(data, width, height, value) {
    if (!value) return;
    const t = value / 100;
    const kr = 1 + 0.18 * t;
    const kg = 1 - 0.12 * t;
    const kb = 1 + 0.18 * t;
    for (let i = 0; i < data.length; i += 4) {
        data[i] *= kr;
        data[i + 1] *= kg;
        data[i + 2] *= kb;
    }
}

// Brightness: multiplicative gain (CSS-brightness semantics), 0 = unchanged.
export function applyBrightness(data, width, height, value) {
    if (!value) return;
    const gain = 1 + value / 100;
    for (let i = 0; i < data.length; i += 4) {
        data[i] *= gain;
        data[i + 1] *= gain;
        data[i + 2] *= gain;
    }
}

// Contrast: slope around mid grey. value -100 flattens to 128, +100 doubles slope.
export function applyContrast(data, width, height, value) {
    if (!value) return;
    const slope = 1 + value / 100;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = (data[i] - 128) * slope + 128;
        data[i + 1] = (data[i + 1] - 128) * slope + 128;
        data[i + 2] = (data[i + 2] - 128) * slope + 128;
    }
}

// Highlights: luminance mask (smoothstep above 0.5). Positive pushes bright
// pixels toward white using headroom (no harsh clipping); negative scales them
// down (recovery). Pixels at or below mid luminance are never touched.
export function applyHighlights(data, width, height, value) {
    if (!value) return;
    const s = value / 100;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const l = luminance(r, g, b);
        if (l <= 0.5) continue;
        const w = smoothstep((l - 0.5) * 2);
        if (s > 0) {
            const k = 0.5 * s * w;
            data[i] = r + (255 - r) * k;
            data[i + 1] = g + (255 - g) * k;
            data[i + 2] = b + (255 - b) * k;
        } else {
            const k = 1 + 0.55 * s * w;
            data[i] = r * k;
            data[i + 1] = g * k;
            data[i + 2] = b * k;
        }
    }
}

// Shadows: luminance mask (smoothstep below 0.5). Positive lifts dark pixels,
// negative deepens them. Highlights are never touched. Smooth mask avoids
// posterization at the shadow/midtone transition.
export function applyShadows(data, width, height, value) {
    if (!value) return;
    const s = value / 100;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const l = luminance(r, g, b);
        if (l >= 0.5) continue;
        const w = 1 - smoothstep(l * 2);
        const k = 1 + 0.9 * s * w;
        data[i] = r * k;
        data[i + 1] = g * k;
        data[i + 2] = b * k;
    }
}

// Saturation: luma-preserving mix. -100 → greyscale, 0 → unchanged, +100 → 2×.
export function applySaturation(data, width, height, value) {
    if (!value) return;
    const f = 1 + value / 100;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
        data[i] = l + (r - l) * f;
        data[i + 1] = l + (g - l) * f;
        data[i + 2] = l + (b - l) * f;
    }
}

// --- sharpness helpers -----------------------------------------------------
// Scratch buffers are allocated once per image size and reused (no per-frame
// allocation churn, no leak).
let scratchA = null;
let scratchB = null;

function ensureScratch(length) {
    if (!scratchA || scratchA.length < length) {
        scratchA = new Uint8ClampedArray(length);
        scratchB = new Uint8ClampedArray(length);
    }
}

// Drop scratch buffers (full-resolution exports allocate large ones — release
// them afterwards so they aren't retained). Next sharpness frame reallocates.
export function releaseScratch() {
    scratchA = null;
    scratchB = null;
}

// Separable box blur over RGB with edge clamping (triangle kernel — a cheap
// Gaussian approximation, enough for unsharp masking).
function boxBlur(src, width, height, radius, tmp, out) {
    const win = radius * 2 + 1;

    for (let y = 0; y < height; y++) {
        const base = y * width * 4;
        for (let ch = 0; ch < 3; ch++) {
            let sum = 0;
            for (let x = -radius; x <= radius; x++) {
                const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
                sum += src[base + cx * 4 + ch];
            }
            for (let x = 0; x < width; x++) {
                tmp[base + x * 4 + ch] = sum / win;
                const outX = x - radius < 0 ? 0 : x - radius;
                const inX = x + radius + 1 >= width ? width - 1 : x + radius + 1;
                sum += src[base + inX * 4 + ch] - src[base + outX * 4 + ch];
            }
        }
    }

    for (let x = 0; x < width; x++) {
        const col = x * 4;
        for (let ch = 0; ch < 3; ch++) {
            let sum = 0;
            for (let y = -radius; y <= radius; y++) {
                const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
                sum += tmp[cy * width * 4 + col + ch];
            }
            for (let y = 0; y < height; y++) {
                out[y * width * 4 + col + ch] = sum / win;
                const outY = y - radius < 0 ? 0 : y - radius;
                const inY = y + radius + 1 >= height ? height - 1 : y + radius + 1;
                sum += tmp[inY * width * 4 + col + ch] - tmp[outY * width * 4 + col + ch];
            }
        }
    }
}

// Unsharp mask: detail = original − blurred; positive adds detail (sharpen),
// negative subtracts it (soften). Radius and amount scale with strength.
export function applySharpness(data, width, height, value) {
    if (!value) return;
    const s = value / 100;
    const radius = 1 + Math.round(Math.abs(s) * 2);
    const amount = Math.abs(s) * (s > 0 ? 1.2 : 1.0);
    const sign = s > 0 ? 1 : -1;

    ensureScratch(data.length);
    boxBlur(data, width, height, radius, scratchA, scratchB);

    for (let i = 0; i < data.length; i += 4) {
        const detail = data[i] - scratchB[i];
        data[i] += sign * detail * amount;
        const detailG = data[i + 1] - scratchB[i + 1];
        data[i + 1] += sign * detailG * amount;
        const detailB = data[i + 2] - scratchB[i + 2];
        data[i + 2] += sign * detailB * amount;
    }
}
