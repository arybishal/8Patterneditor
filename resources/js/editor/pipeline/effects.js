// Cinematic effects layer — runs after basic adjustments, before sharpness
// (see OPERATIONS order in AdjustmentPipeline.js). These functions live in the
// same shared table as the adjustments, so preview and full-resolution export
// always execute identical mathematics — never a second implementation.
//
// Signature matches operations.js: in-place on the RGBA Uint8ClampedArray,
// alpha untouched, 0 value = no-op. All three are deterministic functions of
// pixel position and value (grain uses a fixed-seed position hash), so
// repeated renders of the same state are bit-identical.

import { smoothstep } from './operations.js';

// --- Fade -----------------------------------------------------------------
// Faded film-print look: an asymmetric tonal curve, NOT a global contrast
// change. Positive values lift the black point with a (1-c)² shadow weight —
// black rises fully, midtones drift slightly, the white point stays exact.
// Negative values deepen the low end with the mirrored weight; highlights are
// never touched in either direction.
export function applyFade(data, width, height, value) {
    if (!value) return;
    const t = value / 100;
    if (t > 0) {
        const lift = t * 55;
        for (let i = 0; i < data.length; i += 4) {
            for (let ch = 0; ch < 3; ch++) {
                const c = data[i + ch];
                const u = 1 - c / 255;
                data[i + ch] = c + lift * u * u;
            }
        }
    } else {
        for (let i = 0; i < data.length; i += 4) {
            for (let ch = 0; ch < 3; ch++) {
                const c = data[i + ch];
                data[i + ch] = c * (1 + t * 0.4 * (1 - c / 255));
            }
        }
    }
}

// --- Vignette -------------------------------------------------------------
// Elliptical radial mask in normalized coordinates: nx, ny ∈ [-1, 1] per axis
// so the falloff follows the frame's aspect ratio at any size. Fully smooth
// (smoothstep) from an inner dead-zone out to the corners — no rectangular
// boundary, center untouched, corners strongest.
export function applyVignette(data, width, height, value) {
    if (!value) return;
    const strength = (value / 100) * 0.75;
    const inner = 0.35;

    for (let y = 0; y < height; y++) {
        const ny = ((y + 0.5) / height) * 2 - 1;
        const ny2 = ny * ny;
        const rowBase = y * width * 4;
        for (let x = 0; x < width; x++) {
            const nx = ((x + 0.5) / width) * 2 - 1;
            const d = Math.sqrt(nx * nx + ny2);
            if (d <= inner) continue;
            const w = smoothstep(d - inner); // d - inner, clamped by smoothstep to [0,1] at 1.0+…
            const f = 1 - strength * w;
            const i = rowBase + x * 4;
            data[i] *= f;
            data[i + 1] *= f;
            data[i + 2] *= f;
        }
    }
}

// --- Film grain -----------------------------------------------------------
// Luminance-only grain: one fixed-seed value noise sample per pixel, added
// equally to R/G/B (gray stays gray — no colored speckle). Pure function of
// (x, y): the pattern never jumps between renders, and changing the slider
// only scales the amplitude of the same field. Position hashing gives the
// same grain character at preview and export resolution — no repeating tile.
const GRAIN_SEED = 0x2545f491;

function grainNoise(x, y) {
    let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ GRAIN_SEED) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h ^= h >>> 13;
    h = Math.imul(h, 0x27d4eb2d);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295 * 2 - 1;
}

export function applyGrain(data, width, height, value) {
    if (!value) return;
    const amp = (value / 100) * 42;
    for (let y = 0; y < height; y++) {
        const rowBase = y * width * 4;
        for (let x = 0; x < width; x++) {
            const n = grainNoise(x, y) * amp;
            const i = rowBase + x * 4;
            data[i] += n;
            data[i + 1] += n;
            data[i + 2] += n;
        }
    }
}
