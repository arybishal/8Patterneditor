// Composition layer — Crop → Rotation → Resize, applied to the ORIGINAL source
// BEFORE the tonal/effects pipeline. Full rendering architecture:
//
//   Original ImageBitmap (never mutated)
//       ↓  CompositionRenderer.composeSource()      ← this module
//       ├── crop     (normalized rect on the original, zoom-independent)
//       ├── rotation (canonical 0/90/180/270)
//       └── resize   (output pixels, applied last)
//       ↓  composed source canvas
//       ↓  AdjustmentPipeline OPERATIONS (unchanged: 9 adjustments → fade →
//          vignette → grain → dust → scratches → light leak → sharpness)
//       ↓  Preview canvas / full-resolution export Blob
//
// Preview and export call the SAME composeSource() with the SAME
// CompositionState — only maxEdge differs (preview downscales, export never
// does). Adjustment/effect mathematics is not duplicated anywhere here.
//
// Crop coordinates are stored NORMALIZED to the original source (0..1), so a
// crop is identical at any zoom level, window size or display scale.

export const DEFAULT_CROP = Object.freeze({
    enabled: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
});

export const DEFAULT_RESIZE = Object.freeze({
    enabled: false,
    width: null,
    height: null,
    maintainAspectRatio: true,
});

// Identity composition = full source, no rotation, no resize.
export function makeComposition() {
    return {
        crop: { ...DEFAULT_CROP },
        rotation: 0,
        resize: { ...DEFAULT_RESIZE },
    };
}

// Output validation ceiling — keeps canvases far below Chrome's limits and
// matches the 60-megapixel upload cap (UploadController.MAX_PIXELS).
export const MAX_OUTPUT_DIM = 16384;
export const MAX_OUTPUT_PIXELS = 60_000_000;

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

// Integer crop rectangle in original-source pixels (≥ 1 px, always in bounds).
export function cropRect(srcW, srcH, crop) {
    if (!crop || !crop.enabled) return { x: 0, y: 0, w: srcW, h: srcH };
    const x = clamp(Math.round(crop.x * srcW), 0, Math.max(0, srcW - 1));
    const y = clamp(Math.round(crop.y * srcH), 0, Math.max(0, srcH - 1));
    const w = clamp(Math.round(crop.width * srcW), 1, srcW - x);
    const h = clamp(Math.round(crop.height * srcH), 1, srcH - y);
    return { x, y, w, h };
}

// Resolve resize intent against the pre-resize (crop + rotate) dimensions.
// With aspect ratio on, height is always derived from width so rotation or
// crop changes stay consistent; with aspect off, the typed pair is used.
export function resolveResize(preW, preH, resize) {
    if (!resize || !resize.enabled) return { width: preW, height: preH };
    const w = Math.round(Number(resize.width));
    if (resize.maintainAspectRatio) {
        if (Number.isFinite(w) && w >= 1 && preW >= 1 && preH >= 1) {
            return { width: w, height: Math.max(1, Math.round((w * preH) / preW)) };
        }
        return { width: preW, height: preH };
    }
    const h = Math.round(Number(resize.height));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1) {
        return { width: w, height: h };
    }
    return { width: preW, height: preH };
}

// Form validation for the Resize panel. Returns typed dims or a reason.
export function validateResize(preW, preH, { width, height, maintainAspectRatio }) {
    const w = Number(width);
    const h = maintainAspectRatio
        ? Math.round((w * preH) / preW)
        : Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
        return { ok: false, reason: 'Enter a valid width and height.' };
    }
    if (w < 1 || h < 1) {
        return { ok: false, reason: 'Width and height must be at least 1 pixel.' };
    }
    if (w > MAX_OUTPUT_DIM || h > MAX_OUTPUT_DIM) {
        return { ok: false, reason: `Maximum dimension is ${MAX_OUTPUT_DIM} px.` };
    }
    if (w * h > MAX_OUTPUT_PIXELS) {
        return { ok: false, reason: 'That would exceed the 60 megapixel output limit.' };
    }
    return { ok: true, width: Math.round(w), height: Math.round(h) };
}

// Dimensions AFTER crop + rotation only (the pre-resize canvas).
export function baseDimensions(srcW, srcH, composition) {
    const rect = cropRect(srcW, srcH, composition.crop);
    const swapped = composition.rotation === 90 || composition.rotation === 270;
    return { width: swapped ? rect.h : rect.w, height: swapped ? rect.w : rect.h };
}

// Final composed (export/preview) dimensions.
export function composedDimensions(srcW, srcH, composition) {
    const base = baseDimensions(srcW, srcH, composition);
    return resolveResize(base.width, base.height, composition.resize);
}

// Stable cache key for the composition (pipeline invalidates on change).
export function composeKey(composition) {
    const { crop, rotation, resize } = composition;
    return `${crop.enabled ? 1 : 0}:${crop.x},${crop.y},${crop.width},${crop.height}`
        + `|${rotation}`
        + `|${resize.enabled ? 1 : 0}:${resize.width},${resize.height},${resize.maintainAspectRatio ? 1 : 0}`;
}

// Composed-display rectangle in CSS pixels, centered in the workspace —
// shared by CanvasRenderer drawing and the crop overlay so they can never
// disagree about where the image sits.
export function displayRect(cssWidth, cssHeight, compWidth, compHeight, zoom) {
    const w = compWidth * zoom;
    const h = compHeight * zoom;
    return { x: (cssWidth - w) / 2, y: (cssHeight - h) / 2, w, h };
}

// --- Normalized point mapping (for crop selection) -------------------------
// composed (u,v) ↔ original (x,y), normalized 0..1.
// forward: original → crop-space → rotation → composed.

function rotateForward(u, v, rotation) {
    if (rotation === 90) return [1 - v, u];
    if (rotation === 180) return [1 - u, 1 - v];
    if (rotation === 270) return [v, 1 - u];
    return [u, v];
}

function rotateInverse(u, v, rotation) {
    if (rotation === 90) return [v, 1 - u];
    if (rotation === 180) return [1 - u, 1 - v];
    if (rotation === 270) return [1 - v, u];
    return [u, v];
}

export function composedToOriginal(u, v, composition) {
    const [cu, cv] = rotateInverse(u, v, composition.rotation);
    const { crop } = composition;
    if (!crop.enabled) return { x: cu, y: cv };
    return {
        x: crop.x + clamp(cu, 0, 1) * crop.width,
        y: crop.y + clamp(cv, 0, 1) * crop.height,
    };
}

// Forward direction: original-source normalized → composed normalized.
// Positions that fall outside the current crop map outside 0..1 — correct,
// those image pixels are simply not in frame.
export function originalToComposed(x, y, composition) {
    const { crop } = composition;
    let u = x;
    let v = y;
    if (crop.enabled) {
        u = (x - crop.x) / crop.width;
        v = (y - crop.y) / crop.height;
    }
    const [cu, cv] = rotateForward(u, v, composition.rotation);
    return { x: cu, y: cv };
}

// Snapshot deep enough to read the composition AFTER an in-place mutation.
export function copyComposition(composition) {
    return {
        crop: { ...composition.crop },
        rotation: composition.rotation,
        resize: { ...composition.resize },
    };
}

// A composed-space selection rectangle → NEW crop in original coordinates.
// Axis-aligned under 90°-multiple rotation; min/max normalizes flipped corners.
export function selectionToCrop(u, v, w, h, composition) {
    const a = composedToOriginal(u, v, composition);
    const b = composedToOriginal(u + w, v + h, composition);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(0, b.x - a.x),
        height: Math.max(0, b.y - a.y),
    };
}

// --- Rendering -------------------------------------------------------------

// Draw the original source through crop → rotation → resize into a canvas.
// maxEdge (preview) downscales proportionally after composition; export passes
// null and renders at full resolution. Smoothing only turns OFF when the draw
// is a pure integer remap (crop/rotation at native resolution) so pixels move
// exactly; any resize or preview downscale always resamples smoothly.
export function composeSource(source, composition, maxEdge) {
    const srcW = source.width;
    const srcH = source.height;
    const rect = cropRect(srcW, srcH, composition.crop);
    const base = baseDimensions(srcW, srcH, composition);
    const out = resolveResize(base.width, base.height, composition.resize);

    let dw = out.width;
    let dh = out.height;
    if (maxEdge && Math.max(dw, dh) > maxEdge) {
        const k = maxEdge / Math.max(dw, dh);
        dw = Math.max(1, Math.round(dw * k));
        dh = Math.max(1, Math.round(dh * k));
    }

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    const s = dw / out.width;
    ctx.imageSmoothingEnabled = composition.resize.enabled || s !== 1;
    ctx.imageSmoothingQuality = 'high';

    const rotation = composition.rotation;
    if (rotation === 90) {
        ctx.translate(dw, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w * s, rect.h * s);
    } else if (rotation === 180) {
        ctx.translate(dw, dh);
        ctx.rotate(Math.PI);
        ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh);
    } else if (rotation === 270) {
        ctx.translate(0, dh);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w * s, rect.h * s);
    } else {
        ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh);
    }
    return canvas;
}
