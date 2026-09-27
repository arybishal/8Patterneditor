// Step 5: analog texture layer — Dust, Scratches, Light Leak.
//
// Same contract as effects.js: in-place RGBA ops (alpha untouched), 0 = no-op,
// plugged into the ONE shared OPERATIONS table so preview and full-resolution
// export run identical mathematics. NOTHING here uses Math.random(): every
// field is a pure function of (normalized position, value, fixed seed), so
// re-renders never make particles/scratches/leaks jump, and preview (downscaled)
// and export (full-res) see the same logical field because every layout is
// defined in normalized image coordinates.
//
// Intensity rules (spec §3/§5/§7): raising a slider scales opacity AND the
// number of visible elements through monotonic thresholds — elements that exist
// at low intensity never move or disappear when intensity rises.

import { smoothstep } from './operations.js';

// Integer hash → [0, 1). Same mixing as grainNoise in effects.js, salted so
// independent fields (dust cell A vs dust cell B) stay decorrelated.
function hash01(x, y, salt) {
    let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ salt) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h ^= h >>> 13;
    h = Math.imul(h, 0x27d4eb2d);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}

// --- Dust -----------------------------------------------------------------
// Organic speck field over a 48×48 normalized grid. Each cell owns ONE
// particle at a seeded position/size/irregular shape — never a repeating
// circle, never a visible grid (only a seeded subset of cells activates).
// Density threshold grows with the value (monotonic: no relocations) and
// peak opacity scales with it too. Blend target is a neutral gray on all
// three channels (bright dust / dark dirt) — luminance overlay, no colored
// noise, never opaque enough to obscure the image.
const DUST_SEED = 0x1a2b3c4d;
const DUST_COLS = 48;
const DUST_ROWS = 48;

export function applyDust(data, width, height, value) {
    if (!value) return;
    const t = value / 100;
    const density = 0.05 + 0.4 * t;
    const minDim = Math.min(width, height);

    // Per-cell params are cached across pixels (cells are large; params are
    // recomputed only when crossing a cell boundary — ~2300 times per image).
    let cellX = -1;
    let cellY = -1;
    let active = false;
    let px = 0;
    let py = 0;
    let rad = 1;
    let fa = 0;
    let fb = 0;
    let ph1 = 0;
    let ph2 = 0;
    let peak = 0;
    let target = 0;

    for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height;
        const cy = Math.min(DUST_ROWS - 1, (v * DUST_ROWS) | 0);
        const rowBase = y * width * 4;
        for (let x = 0; x < width; x++) {
            const cx = Math.min(DUST_COLS - 1, (((x + 0.5) / width) * DUST_COLS) | 0);
            if (cx !== cellX || cy !== cellY) {
                cellX = cx;
                cellY = cy;
                active = hash01(cx, cy, DUST_SEED) < density;
                if (active) {
                    px = (cx + 0.15 + 0.7 * hash01(cx, cy, DUST_SEED + 1)) / DUST_COLS;
                    py = (cy + 0.15 + 0.7 * hash01(cx, cy, DUST_SEED + 2)) / DUST_ROWS;
                    rad = minDim * (0.0016 + 0.0048 * hash01(cx, cy, DUST_SEED + 3));
                    fa = 9 / rad;
                    fb = 14 / rad;
                    ph1 = hash01(cx, cy, DUST_SEED + 4) * 6.2832;
                    ph2 = hash01(cx, cy, DUST_SEED + 5) * 6.2832;
                    peak = t * (0.3 + 0.5 * hash01(cx, cy, DUST_SEED + 6));
                    target = hash01(cx, cy, DUST_SEED + 7) < 0.72 ? 240 : 16;
                }
            }
            if (!active) continue;

            // Pixel-space distance so specks stay circular in image space and
            // scale with the picture at any resolution (preview ↔ export).
            const dx = (((x + 0.5) / width) - px) * width;
            const dy = (v - py) * height;
            const d = Math.sqrt(dx * dx + dy * dy) / rad;
            if (d > 1.6) continue;

            // Irregular multi-lobed blob (sines, no atan2): breaks the circle.
            const wob = Math.sin(dx * fa + ph1) * Math.sin(dy * fb + ph2);
            const field = (1 - d) + 0.5 * wob;
            if (field <= 0) continue;
            const a = peak * smoothstep(Math.min(1, field * 1.4));
            const i = rowBase + x * 4;
            data[i] += (target - data[i]) * a;
            data[i + 1] += (target - data[i + 1]) * a;
            data[i + 2] += (target - data[i + 2]) * a;
        }
    }
}

// --- Scratches ------------------------------------------------------------
// 48 seeded thin lines, mostly vertical with slight angles, varying length,
// width, opacity and brightness (film emulsion scratches: mostly bright, a
// few dark). Rasterized per scratch over its bounding box only — O(scratch
// area), never a per-pixel geometry search and never thousands of objects.
// Existence threshold grows with intensity (monotonic — a visible scratch
// stays exactly where it is); opacity scales with intensity as well.
const SCRATCH_SEED = 0x51ed270b;
const SCRATCH_COUNT = 48;

export function applyScratches(data, width, height, value) {
    if (!value) return;
    const t = value / 100;
    const wScale = Math.min(width, height) / 1600; // thin lines, scale with image

    for (let s = 0; s < SCRATCH_COUNT; s++) {
        if (hash01(s, 1, SCRATCH_SEED) >= 0.03 + 0.97 * t) continue;

        const opacity = (0.3 + 0.6 * hash01(s, 2, SCRATCH_SEED)) * t;
        const x0 = (0.04 + 0.92 * hash01(s, 3, SCRATCH_SEED)) * width;
        const y0 = hash01(s, 4, SCRATCH_SEED) * 0.55 * height;
        const y1 = Math.min(height, y0 + (0.1 + 0.9 * hash01(s, 5, SCRATCH_SEED)) * height);
        const slope = Math.tan((hash01(s, 6, SCRATCH_SEED) - 0.5) * 0.14);
        const half = Math.max(0.5, ((0.7 + 1.8 * hash01(s, 7, SCRATCH_SEED)) * wScale) / 2);
        const target = hash01(s, 8, SCRATCH_SEED) < 0.8 ? 250 : 14;

        const yStart = Math.max(0, Math.floor(y0));
        const yEnd = Math.min(height, Math.ceil(y1));
        for (let py = yStart; py < yEnd; py++) {
            const cxp = x0 + slope * (py - y0);
            const xa = Math.max(0, Math.floor(cxp - half));
            const xb = Math.min(width - 1, Math.ceil(cxp + half));
            for (let pxx = xa; pxx <= xb; pxx++) {
                const dist = Math.abs(pxx + 0.5 - cxp);
                if (dist > half) continue;
                const fall = 1 - dist / half;
                const a = opacity * fall * fall;
                if (a <= 0.004) continue;
                const i = (py * width + pxx) * 4;
                data[i] += (target - data[i]) * a;
                data[i + 1] += (target - data[i + 1]) * a;
                data[i + 2] += (target - data[i + 2]) * a;
            }
        }
    }
}

// --- Light leak -----------------------------------------------------------
// Two edge-biased elliptical sources with smooth radial falloff (smoothstep),
// blended with a warm color via screen — detail is preserved, nothing clips
// flat, and the result is a spatial gradient, never a flat orange overlay.
// Source placement is fixed (resolution-independent by design): a normalized
// position is the only way preview and export can agree, since preview runs
// at reduced resolution. Stable across every re-render of every image.
const LEAK_SOURCES = Object.freeze([
    { cx: 0.05, cy: 0.22, rx: 0.62, ry: 0.52, g: 158, b: 74, k: 1.0 },
    { cx: 0.97, cy: 0.70, rx: 0.46, ry: 0.64, g: 118, b: 52, k: 0.7 },
]);

export function applyLightLeak(data, width, height, value) {
    if (!value) return;
    const t = value / 100;

    for (let y = 0; y < height; y++) {
        const v = (y + 0.5) / height;
        const rowBase = y * width * 4;
        for (let x = 0; x < width; x++) {
            const u = (x + 0.5) / width;
            let glow = 0;
            for (const s of LEAK_SOURCES) {
                const dx = (u - s.cx) / s.rx;
                const dy = (v - s.cy) / s.ry;
                const d2 = dx * dx + dy * dy;
                if (d2 < 1) glow += s.k * smoothstep(1 - Math.sqrt(d2));
            }
            if (glow <= 0) continue;
            const I = (glow > 1 ? 1 : glow) * t * 0.85;
            const i = rowBase + x * 4;
            data[i] = 255 - ((255 - data[i]) * (255 - 255 * I)) / 255;
            data[i + 1] = 255 - ((255 - data[i + 1]) * (255 - 158 * I)) / 255;
            data[i + 2] = 255 - ((255 - data[i + 2]) * (255 - 74 * I)) / 255;
        }
    }
}
