import {
    applyExposure,
    applyTemperature,
    applyTint,
    applyBrightness,
    applyContrast,
    applyHighlights,
    applyShadows,
    applySaturation,
    applySharpness,
} from './operations.js';
import { applyFade, applyVignette, applyGrain } from './effects.js';
import { applyDust, applyScratches, applyLightLeak } from './texture.js';
import { composeKey, composeSource } from '../composition/CompositionRenderer.js';
import { createMaskRenderer } from '../masking/MaskRenderer.js';
import { renderGrade, gradeSignature } from '../color/ColorGradeRenderer.js';
import { gradeIdle } from '../color/ColorGradeEngine.js';

// Interactive preview resolution. The source ImageBitmap always keeps its full
// resolution (full-resolution export runs the same operations on the original
// dimensions); only the interactive preview path is downscaled here.
const PREVIEW_MAX_EDGE = 2048;

// Deterministic processing order — do not reorder without updating tests:
//   Basic adjustments
//     1. Exposure  2. Temperature  3. Tint  4. Brightness  5. Contrast
//     6. Highlights  7. Shadows  8. Saturation
//   Color grading (Step 12)
//     9. Color grade — zone hue/saturation, intensity, color balance,
//        vibrance, split tone, highlight warmth, shadow coolness (one pass,
//        runs after tonal work so it grades the finished exposure/contrast;
//        text is composited afterwards by the renderer and never sees it)
//   Cinematic effects layer
//     10. Fade  11. Vignette  12. Grain
//   Analog texture layer (Step 5)
//     13. Dust  14. Scratches  15. Light Leak
//       — after all tonal work so specks/lines sit ON TOP of the graded image
//       (that is how dust and emulsion scratches read on a print), and the
//       leak screens over the finished grade rather than being graded itself.
//   Finishing
//     16. Sharpness (kept last so it sharpens the fully graded result —
//         including grain and texture — which is how a printed frame reads;
//         documented here per spec rather than silently moved)
//
// This ONE table drives both the interactive preview and the full-resolution
// export — there is no second implementation of any formula anywhere.
// Future operations are appended as ['key', applyFn] pairs in their layer's
// position (the grade is the one entry whose value is an object, not a number).
const OPERATIONS = [
    ['exposure', applyExposure],
    ['temperature', applyTemperature],
    ['tint', applyTint],
    ['brightness', applyBrightness],
    ['contrast', applyContrast],
    ['highlights', applyHighlights],
    ['shadows', applyShadows],
    ['saturation', applySaturation],
    ['colorGrade', renderGrade],
    ['fade', applyFade],
    ['vignette', applyVignette],
    ['grain', applyGrain],
    ['dust', applyDust],
    ['scratches', applyScratches],
    ['lightLeak', applyLightLeak],
    ['sharpness', applySharpness],
];

// Adjustments, effects and the color grade live in separate state maps but
// share one flat key space for the pipeline (keys never collide).
function valuesOf(snapshot) {
    return { ...snapshot.adjustments, ...snapshot.effects, colorGrade: snapshot.colorGrade ?? null };
}

// An operation is idle (costs nothing, restores nothing) when its value is
// falsy — or, for the grade object, when every zone is neutral (§12.2).
function opIdle(values, key) {
    const v = values[key];
    if (v == null) return true;
    if (typeof v === 'object') return gradeIdle(v);
    return !v;
}

// Step 11: selective editing. A masked op runs normally, then blends back to
// its pre-op values wherever the mask is transparent:
//   output = blend(effect, original, maskStrength)   (§11.4)
// The unmasked area is byte-identical to what the op would have produced
// without the mask. No formula is duplicated — the same op runs either way.
function blendMasked(data, before, alpha) {
    for (let i = 0, p = 0; p < alpha.length; i += 4, p++) {
        const t = alpha[p];
        if (t === 0) {
            data[i] = before[i];
            data[i + 1] = before[i + 1];
            data[i + 2] = before[i + 2];
        } else if (t < 255) {
            data[i] = before[i] + ((data[i] - before[i]) * t) / 255;
            data[i + 1] = before[i + 1] + ((data[i + 1] - before[i + 1]) * t) / 255;
            data[i + 2] = before[i + 2] + ((data[i + 2] - before[i + 2]) * t) / 255;
        }
    }
}

// Only pay for mask rendering when a targeted op actually has work to do.
function maskAlphaFor(mask, values, source, composition, width, height, renderer) {
    if (!mask) return null;
    let work = false;
    for (const key of mask.targets) {
        if (values[key]) { work = true; break; }
    }
    if (!work) return null;
    return renderer.alpha(mask, source.width, source.height, composition, width, height);
}

// maskRenderer is injected so the overlay can share the same cache instance;
// a default keeps the pipeline self-contained for isolated use.
export function createAdjustmentPipeline(maskRenderer = createMaskRenderer()) {
    let source = null;

    // Composed base (crop → rotate → resize, preview-downscaled) — rebuilt
    // whenever the composition changes, shared by preview and identity path.
    let baseCanvas = null;
    let baseData = null;
    let baseKey = null;
    // Reusable working copy: base → ops → display. Never fed back into the base.
    let workData = null;
    // Pre-op snapshot for the masked blend (same size as the working copy).
    let beforeBuf = null;
    let outCanvas = null;

    let cacheKey = null;
    let cachedCanvas = null;

    function setSource(bitmap) {
        source = bitmap;
        baseCanvas = null;
        baseData = null;
        baseKey = null;
        workData = null;
        beforeBuf = null;
        outCanvas = null;
        cacheKey = null;
        cachedCanvas = null;
        maskRenderer.reset();
    }

    function ensureBase(composition) {
        const key = composeKey(composition);
        if (baseData && key === baseKey) return;

        baseCanvas = composeSource(source, composition, PREVIEW_MAX_EDGE);
        const ctx = baseCanvas.getContext('2d');
        baseData = ctx.getImageData(0, 0, baseCanvas.width, baseCanvas.height);
        workData = new ImageData(new Uint8ClampedArray(baseData.data.length),
            baseCanvas.width, baseCanvas.height);
        beforeBuf = new Uint8ClampedArray(baseData.data.length);
        outCanvas = null;
        baseKey = key;
    }

    function keyFor(values, mask) {
        let key = '';
        for (const [k] of OPERATIONS) {
            const v = values[k];
            // The grade is an object — a stable control-order signature
            // instead of "[object Object]" so different grades miss the cache.
            key += `${v && typeof v === 'object' ? gradeSignature(v) : v}|`;
        }
        // Mask signature carries strokes/inversion/targets — a restore that
        // changes any of them must invalidate this cache (§11.6).
        if (mask) key += `m:${mask.strokes.length},${mask.inverted ? 1 : 0},${mask.targets.join('-')}`;
        return key;
    }

    function getProcessedImage(state) {
        if (!source) return null;

        const values = valuesOf(state);
        const composition = state.composition;
        const key = `${composeKey(composition)}|${keyFor(values, state.mask)}`;
        if (key === cacheKey) return cachedCanvas;

        ensureBase(composition);

        const identity = OPERATIONS.every(([k]) => opIdle(values, k));
        if (identity) {
            // All adjustments at defaults: the exact composed base, no reprocessing.
            cacheKey = key;
            cachedCanvas = baseCanvas;
            return baseCanvas;
        }

        const { width, height } = baseData;
        if (!outCanvas) outCanvas = document.createElement('canvas');
        if (outCanvas.width !== width || outCanvas.height !== height) {
            outCanvas.width = width;
            outCanvas.height = height;
        }

        const alpha = maskAlphaFor(state.mask, values, { width: state.imageWidth, height: state.imageHeight },
            composition, width, height, maskRenderer);
        const targets = alpha && state.mask ? new Set(state.mask.targets) : null;

        workData.data.set(baseData.data);
        for (const [k, op] of OPERATIONS) {
            if (targets && targets.has(k) && !opIdle(values, k)) {
                beforeBuf.set(workData.data);
                op(workData.data, width, height, values[k]);
                blendMasked(workData.data, beforeBuf, alpha);
            } else {
                op(workData.data, width, height, values[k]);
            }
        }
        outCanvas.getContext('2d').putImageData(workData, 0, 0);

        cacheKey = key;
        cachedCanvas = outCanvas;
        return outCanvas;
    }

    // Full-resolution one-shot render for export. Separate canvas from the
    // preview caches (preview may be downscaled; export never is) but runs the
    // exact same composition step and the exact same OPERATIONS in the exact
    // same order — including the mask blend. Reads only from `source`; the
    // original ImageBitmap is never modified.
    function renderFull(source, composition, adjustments, effects, colorGrade, mime, mask) {
        const values = { ...adjustments, ...effects, colorGrade: colorGrade ?? null };
        const composed = composeSource(source, composition, null);
        const width = composed.width;
        const height = composed.height;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // JPG has no alpha channel — composite over white instead of letting
        // transparent pixels fall to black during encoding (§14).
        if (mime === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(composed, 0, 0);

        const identity = OPERATIONS.every(([k]) => opIdle(values, k));
        if (identity) return canvas;

        const img = ctx.getImageData(0, 0, width, height);
        const alpha = maskAlphaFor(mask, values, source, composition, width, height, maskRenderer);
        const targets = alpha && mask ? new Set(mask.targets) : null;
        let before = null;
        for (const [k, op] of OPERATIONS) {
            if (targets && targets.has(k) && !opIdle(values, k)) {
                if (!before) before = new Uint8ClampedArray(img.data.length);
                before.set(img.data);
                op(img.data, width, height, values[k]);
                blendMasked(img.data, before, alpha);
            } else {
                op(img.data, width, height, values[k]);
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    return { setSource, getProcessedImage, renderFull };
}
