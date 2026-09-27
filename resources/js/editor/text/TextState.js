// Text layer state — pure data helpers. Layers are stored normalized to the
// CURRENT composed image (x,y 0..1 of the composed frame, y = vertical center
// of the block) and fontSize is in composed-image pixels, so export at any
// resolution is deterministic (§12).
//
// When the composition changes (crop/rotate/resize), every layer is
// transformed exactly like the image pixels are: position via the same
// composed↔original mapping the crop math uses, and fontSize via the pure
// resize factor — so text stays pinned to its image pixels (§18).

import {
    baseDimensions,
    composedToOriginal,
    originalToComposed,
    resolveResize,
} from '../composition/CompositionRenderer.js';
import { ALLOWED_STYLES, ALLOWED_WEIGHTS } from '../fonts/fontConfig.js';

export const FONT_LIST = Object.freeze([
    { id: 'Inter', label: 'Inter' },
    { id: 'Arial', label: 'Arial' },
    { id: 'Georgia', label: 'Georgia' },
    { id: 'Times New Roman', label: 'Times New Roman' },
    { id: 'Courier New', label: 'Courier New' },
]);

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 300;
export const TEXT_MAX_LENGTH = 1000;

// Layer font whitelist: the5 built-ins plus every catalog family registered
// after the manifest loads (§11 — no layer can carry an unknown family).
let knownFamilies = new Set(FONT_LIST.map((f) => f.id));

export function registerFamilies(names) {
    for (const name of names) knownFamilies.add(name);
}

export function knownFontFamilies() {
    return [...knownFamilies];
}

export const DEFAULT_TEXT = Object.freeze({
    text: 'Your Text',
    fontFamily: 'Inter',
    fontSize: 48,
    fontWeight: 400,
    fontStyle: 'normal',
    color: '#ffffff',
    align: 'center',
    opacity: 1,
});

let seq = 0;

// Monotonic counter ids — never array indices, never reused (§2).
export function nextTextId() {
    seq += 1;
    return `text-${seq}`;
}

export function createTextLayer() {
    return {
        id: nextTextId(),
        text: DEFAULT_TEXT.text,
        x: 0.5,
        y: 0.5,
        fontFamily: DEFAULT_TEXT.fontFamily,
        fontSize: DEFAULT_TEXT.fontSize,
        fontWeight: DEFAULT_TEXT.fontWeight,
        fontStyle: DEFAULT_TEXT.fontStyle,
        color: DEFAULT_TEXT.color,
        align: DEFAULT_TEXT.align,
        opacity: DEFAULT_TEXT.opacity,
    };
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// Sanitize a partial update — only known fields, ranges enforced at the state
// boundary so no UI path can commit invalid layer data.
export function sanitizePatch(layer, patch) {
    const out = {};
    if ('text' in patch) out.text = String(patch.text).slice(0, TEXT_MAX_LENGTH);
    if ('fontFamily' in patch) {
        out.fontFamily = knownFamilies.has(patch.fontFamily)
            ? patch.fontFamily : layer.fontFamily;
    }
    if ('fontWeight' in patch) {
        const w = Number(patch.fontWeight);
        out.fontWeight = ALLOWED_WEIGHTS.includes(w) ? w : layer.fontWeight;
    }
    if ('fontStyle' in patch) {
        out.fontStyle = ALLOWED_STYLES.includes(patch.fontStyle)
            ? patch.fontStyle : layer.fontStyle;
    }
    if ('fontSize' in patch) {
        out.fontSize = Math.round(clampNumber(patch.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, layer.fontSize));
    }
    if ('color' in patch && /^#[0-9a-fA-F]{6}$/.test(String(patch.color))) {
        out.color = String(patch.color).toLowerCase();
    }
    if ('align' in patch && ['left', 'center', 'right'].includes(patch.align)) {
        out.align = patch.align;
    }
    if ('opacity' in patch) {
        out.opacity = clampNumber(patch.opacity, 0, 1, layer.opacity);
    }
    if ('x' in patch) out.x = clampNumber(patch.x, -0.5, 1.5, layer.x);
    if ('y' in patch) out.y = clampNumber(patch.y, -0.5, 1.5, layer.y);
    return out;
}

// Pure resize factor (out.width / base.width) — rotation alone leaves it at 1,
// so fontSize never changes from a rotation with no resize.
function resizeFactor(composition, srcW, srcH) {
    const base = baseDimensions(srcW, srcH, composition);
    const out = resolveResize(base.width, base.height, composition.resize);
    return base.width > 0 ? out.width / base.width : 1;
}

// Rewrite every layer across a composition change so text keeps its place on
// the image pixels: position composed→original→newly-composed, size scaled by
// the ratio of the two resize factors (§18).
export function transformLayers(layers, compOld, compNew, srcW, srcH) {
    if (!layers.length) return;
    const rfOld = resizeFactor(compOld, srcW, srcH);
    const rfNew = resizeFactor(compNew, srcW, srcH);
    const sizeScale = rfOld > 0 ? rfNew / rfOld : 1;
    for (const layer of layers) {
        const orig = composedToOriginal(layer.x, layer.y, compOld);
        const next = originalToComposed(orig.x, orig.y, compNew);
        layer.x = next.x;
        layer.y = next.y;
        if (sizeScale !== 1) {
            layer.fontSize = Math.round(
                Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, layer.fontSize * sizeScale)),
            );
        }
    }
}
