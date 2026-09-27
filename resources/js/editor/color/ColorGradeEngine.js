// Step 12: the color grading engine — ONE deterministic per-pixel pass for
// all twelve controls (§12.2, §12.6). A pure function of (pixels, grade):
// the identical grade always produces the identical output, and preview and
// full-resolution export run this exact code (no second algorithm exists).
//
// Design notes:
// * No extra buffers: every sub-effect is scaled by the master intensity and
//   folded into the same pass, so a 6000×4000 export allocates nothing new
//   (§12.7 scratch rule — the sharpness blur keeps its own reusable scratch).
// * Zone weighting: each pixel derives shadow/midtone/highlight weights from
//   its luminance (weights sum to 1), so "shadows hue" only turns pixels that
//   are actually in the shadows, and no zone ever needs its own mask buffer.
// * Hue rotations use a quantized matrix LUT (0.25° steps): no trig in the
//   inner loop, byte-stable across runs for the same input.

import { smoothstep } from '../pipeline/operations.js';
import { COLOR_GRADE_KEYS } from './ColorGradeState.js';

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// 100 → 45° of hue travel: strong enough to look intentional, bounded so the
// control can never spin a color all the way around the wheel.
const MAX_HUE_DEG = 45;
const HUE_STEP_DEG = 0.25;
const HUE_BUCKETS = Math.round((MAX_HUE_DEG * 2) / HUE_STEP_DEG) + 1;
const HUE_CENTER = Math.round(MAX_HUE_DEG / HUE_STEP_DEG);

// --- hue rotation LUT (built lazily, module-level memo) --------------------
// Standard SVG/CSS hue-rotate matrix (YIQ approximation). Memoized matrices
// are recognized by a non-zero middle entry: within ±45° that coefficient
// (0.715 + 0.285·cos + 0.14·sin) is always > 0.4, and a fresh buffer is all
// zeros — so the first call per bucket computes, every later call reuses the
// exact same floats. Quantizing the angle means float noise in the zone math
// can never change which matrix is used: rendering stays byte-deterministic.
let hueLut = null;

function hueMatrixAt(angleDeg) {
    if (!hueLut) hueLut = new Float64Array(HUE_BUCKETS * 9);
    let bucket = Math.round(angleDeg / HUE_STEP_DEG) + HUE_CENTER;
    if (bucket < 0) bucket = 0;
    else if (bucket >= HUE_BUCKETS) bucket = HUE_BUCKETS - 1;
    const at = bucket * 9;
    if (hueLut[at + 4]) return at;

    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    hueLut[at] = 0.213 + 0.787 * c - 0.213 * s;
    hueLut[at + 1] = 0.715 - 0.715 * c - 0.715 * s;
    hueLut[at + 2] = 0.072 - 0.072 * c + 0.928 * s;
    hueLut[at + 3] = 0.213 - 0.213 * c + 0.143 * s;
    hueLut[at + 4] = 0.715 + 0.285 * c + 0.14 * s;
    hueLut[at + 5] = 0.072 - 0.072 * c - 0.283 * s;
    hueLut[at + 6] = 0.213 - 0.213 * c - 0.787 * s;
    hueLut[at + 7] = 0.715 - 0.715 * c + 0.715 * s;
    hueLut[at + 8] = 0.072 + 0.928 * c + 0.072 * s;
    return at;
}

// Neutral = contributes nothing: intensity off, or every zone value at 0.
// The pipeline's identity fast path uses this so an untouched editor never
// re-renders through the grade (§12.2 "same image as before").
export function gradeIdle(grade) {
    if (!grade || typeof grade !== 'object') return true;
    if (!grade.intensity) return true;
    return COLOR_GRADE_KEYS.every((k) => !grade[k]);
}

// One pass. Alpha is never touched; Uint8ClampedArray rounding keeps output
// as integers (NaN/Infinity cannot leak into the image).
export function applyColorGrade(data, width, height, grade) {
    if (gradeIdle(grade)) return;

    const k = grade.intensity / 100;
    const sHue = grade.shadowsHue * 0.45;
    const mHue = grade.midtonesHue * 0.45;
    const hHue = grade.highlightsHue * 0.45;
    const sSat = grade.shadowsSat;
    const mSat = grade.midtonesSat;
    const hSat = grade.highlightsSat;
    const balance = (k * grade.colorBalance) / 100;
    const split = (k * grade.splitTone) / 100;
    const warmth = (k * grade.highlightWarmth) / 100;
    const cool = (k * grade.shadowCoolness) / 100;
    const vibe = (k * grade.vibrance) / 100;
    const hueOn = sHue !== 0 || mHue !== 0 || hHue !== 0;
    const satOn = sSat !== 0 || mSat !== 0 || hSat !== 0;

    for (let i = 0; i < data.length; i += 4) {
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];

        const l = (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
        const wS = 1 - smoothstep(l * 2);
        const wH = smoothstep((l - 0.5) * 2);
        const wM = 1 - wS - wH;

        if (hueOn) {
            const angle = k * (sHue * wS + mHue * wM + hHue * wH);
            if (angle) {
                const at = hueMatrixAt(angle);
                const nr = hueLut[at] * r + hueLut[at + 1] * g + hueLut[at + 2] * b;
                const ng = hueLut[at + 3] * r + hueLut[at + 4] * g + hueLut[at + 5] * b;
                const nb = hueLut[at + 6] * r + hueLut[at + 7] * g + hueLut[at + 8] * b;
                r = nr;
                g = ng;
                b = nb;
            }
        }

        if (satOn) {
            const sf = 1 + (k * (sSat * wS + mSat * wM + hSat * wH)) / 100;
            if (sf !== 1) {
                const lm = LUMA_R * r + LUMA_G * g + LUMA_B * b;
                r = lm + (r - lm) * sf;
                g = lm + (g - lm) * sf;
                b = lm + (b - lm) * sf;
            }
        }

        if (balance) {
            r *= 1 + 0.12 * balance;
            b *= 1 - 0.12 * balance;
        }

        if (split) {
            // Positive: warm highlights + cool shadows (classic split tone),
            // negative inverts the pairing. Zone weights keep it gradient-free.
            r *= 1 + 0.1 * split * wH;
            b *= 1 - 0.08 * split * wH;
            b *= 1 + 0.1 * split * wS;
            r *= 1 - 0.08 * split * wS;
        }

        if (warmth) {
            r *= 1 + 0.14 * warmth * wH;
            g *= 1 + 0.03 * warmth * wH;
            b *= 1 - 0.12 * warmth * wH;
        }

        if (cool) {
            b *= 1 + 0.14 * cool * wS;
            r *= 1 - 0.12 * cool * wS;
        }

        if (vibe) {
            const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
            const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
            if (mx > 0) {
                // Smart vibrance: push the least-saturated colors hardest so
                // already-rich areas never clip first.
                const sat = (mx - mn) / mx;
                const f = 1 + vibe * (1 - sat);
                if (f !== 1) {
                    const lm = LUMA_R * r + LUMA_G * g + LUMA_B * b;
                    r = lm + (r - lm) * f;
                    g = lm + (g - lm) * f;
                    b = lm + (b - lm) * f;
                }
            }
        }

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
    }
}
