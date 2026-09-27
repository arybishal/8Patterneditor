// Step 11: mask rendering. Strokes are replayed directly into COMPOSED space
// at the exact dimensions of the image path's buffer (preview base or
// full-resolution export), so the mask is always pixel-aligned with the
// pixels it scopes — crop, rotation and resize are applied per point through
// the same originalToComposed mapping the image uses (§11.3, §11.7).
//
// One instance is shared by the pipeline (selective blend alpha) and the
// overlay (tint preview): same canvas, same cache, preview/export parity.

import { baseDimensions, composeKey, originalToComposed } from '../composition/CompositionRenderer.js';
import { maskSignature } from './MaskState.js';

const SPRITE = 96; // dab sprite resolution (drawn scaled — cheap, smooth)

// Radial-gradient dab sprite, one per hardness bucket (20 steps). Building
// gradients per dab would dominate stroke replay cost.
const sprites = new Map();
function dabSprite(hardness) {
    const bucket = Math.round(Math.min(1, Math.max(0, hardness)) * 20);
    let canvas = sprites.get(bucket);
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.width = SPRITE;
    canvas.height = SPRITE;
    const ctx = canvas.getContext('2d');
    const t = bucket / 20;
    const grad = ctx.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(Math.min(t, 1), 'rgba(255,255,255,1)');
    grad.addColorStop(1, t >= 1 ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SPRITE, SPRITE);
    sprites.set(bucket, canvas);
    return canvas;
}

// Replay every stroke onto a width×height canvas. Geometry:
//   point  original (x,y) → composed (u,v) → pixel (u·width, v·height)
//   radius r·min(srcW,srcH) source px → ·sx / ·sy composed px (anisotropic
//   resize stays correct; rotation/crop keep the pre-resize scale of 1)
function paintMask(mask, srcW, srcH, composition, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!mask || (!mask.strokes.length && !mask.inverted)) return canvas;

    const base = baseDimensions(srcW, srcH, composition);
    const sx = width / Math.max(1, base.width);
    const sy = height / Math.max(1, base.height);

    // Per-stroke scratch layer: opacity is applied when the layer is
    // composited, so dabs inside one stroke build toward solid, not beyond.
    const layer = document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    const lctx = layer.getContext('2d');

    for (const stroke of mask.strokes) {
        if (stroke.pts.length < 2) continue;
        const rx = Math.max(0.75, stroke.r * Math.min(srcW, srcH) * sx);
        const ry = Math.max(0.75, stroke.r * Math.min(srcW, srcH) * sy);
        const spacing = Math.max(0.75, Math.min(rx, ry) * 0.4);
        const sprite = dabSprite(stroke.h);

        lctx.clearRect(0, 0, width, height);
        let px = null;
        let py = null;
        for (let i = 0; i + 1 < stroke.pts.length; i += 2) {
            const composed = originalToComposed(stroke.pts[i], stroke.pts[i + 1], composition);
            const x = composed.x * width;
            const y = composed.y * height;
            if (px !== null) {
                // Space dabs along the segment so fast strokes stay continuous.
                const dx = x - px;
                const dy = y - py;
                const dist = Math.hypot(dx, dy);
                const steps = Math.max(1, Math.ceil(dist / spacing));
                for (let s = 1; s <= steps; s++) {
                    const ix = px + (dx * s) / steps;
                    const iy = py + (dy * s) / steps;
                    lctx.drawImage(sprite, ix - rx, iy - ry, rx * 2, ry * 2);
                }
            } else {
                lctx.drawImage(sprite, x - rx, y - ry, rx * 2, ry * 2);
            }
            px = x;
            py = y;
        }

        ctx.globalAlpha = Math.min(1, Math.max(0, stroke.o));
        ctx.globalCompositeOperation = stroke.e ? 'destination-out' : 'source-over';
        ctx.drawImage(layer, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (mask.inverted) {
        // Invert is a render-time flag: alpha → 255 − alpha, color stays white.
        const img = ctx.getImageData(0, 0, width, height);
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
        ctx.putImageData(img, 0, 0);
    }
    return canvas;
}

export function createMaskRenderer() {
    // Small bounded caches (current mask at a few sizes: preview base, export,
    // overlay) — keyed by mask content plus document geometry, so the three
    // consumers share work and a new image can never reuse a stale render.
    const canvasCache = new Map();
    const alphaCache = new Map();
    const LIMIT = 6;

    function put(cache, key, value) {
        cache.set(key, value);
        if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
        return value;
    }

    function keyFor(mask, srcW, srcH, composition, width, height) {
        if (!mask) return '';
        return `${width}x${height}@${srcW}x${srcH}|${composeKey(composition)}|${maskSignature(mask)}`;
    }

    function render(mask, srcW, srcH, composition, width, height) {
        const key = keyFor(mask, srcW, srcH, composition, width, height);
        if (!key) return null;
        let canvas = canvasCache.get(key);
        if (!canvas) canvas = put(canvasCache, key, paintMask(mask, srcW, srcH, composition, width, height));
        return canvas;
    }

    // Per-pixel mask strength (0..255) aligned with the target buffer.
    function alpha(mask, srcW, srcH, composition, width, height) {
        const key = keyFor(mask, srcW, srcH, composition, width, height);
        if (!key) return null;
        let value = alphaCache.get(key);
        if (!value) {
            const canvas = render(mask, srcW, srcH, composition, width, height);
            const img = canvas.getContext('2d').getImageData(0, 0, width, height);
            const out = new Uint8ClampedArray(width * height);
            for (let i = 0, p = 3; i < out.length; i++, p += 4) out[i] = img.data[p];
            value = put(alphaCache, key, out);
        }
        return value;
    }

    function reset() {
        canvasCache.clear();
        alphaCache.clear();
    }

    return { render, alpha, reset };
}
