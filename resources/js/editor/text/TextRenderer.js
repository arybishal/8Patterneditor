// Text rendering — canvas fillText only, drawn AFTER the photographic
// pipeline (never through adjustments/effects). One module owns both
// measurement (bounds for selection/hit-testing) and drawing so the two can
// never disagree about layout (§13, §16).

// Local system fonts only — no remote font requests ever (§22). The5 built-in
// stacks are exact and never rewritten; catalog families register their own
// stack (family first, system fallback for the category) when the manifest
// loads, so rendering works before/without any local file.
const FONT_STACKS = {
    Inter: '"Inter", Arial, sans-serif',
    Arial: 'Arial, sans-serif',
    Georgia: 'Georgia, serif',
    'Times New Roman': '"Times New Roman", serif',
    'Courier New': '"Courier New", monospace',
};

export function registerFontStack(family, category) {
    if (family in FONT_STACKS) return;
    const generic = category === 'serif' ? 'serif'
        : category === 'monospace' ? 'monospace' : 'sans-serif';
    const fallback = generic === 'serif' ? 'Georgia, serif'
        : generic === 'monospace' ? '"Courier New", monospace' : 'Arial, sans-serif';
    FONT_STACKS[family] = `"${family}", ${fallback}`;
}

const LINE_HEIGHT = 1.2; // lineHeight = fontSize × 1.2 (§14)

let measureCtx = null;
function getMeasureCtx() {
    if (!measureCtx) {
        const canvas = document.createElement('canvas');
        measureCtx = canvas.getContext('2d');
    }
    return measureCtx;
}

function stack(family) {
    return FONT_STACKS[family] || FONT_STACKS.Arial;
}

function setFont(ctx, layer, px) {
    const style = layer.fontStyle === 'italic' ? 'italic' : 'normal';
    const weight = Number(layer.fontWeight) || 400;
    ctx.font = `${style} ${weight} ${px}px ${stack(layer.fontFamily)}`;
}

function linesOf(layer) {
    return String(layer.text).split('\n');
}

// Bounds in COMPOSED-image pixels: block vertically centered on layer.y,
// horizontally anchored per align (canvas textAlign semantics) (§13).
export function measureLayer(layer, composedW, composedH) {
    const ctx = getMeasureCtx();
    const px = layer.fontSize;
    setFont(ctx, layer, px);
    const lines = linesOf(layer);
    let maxW = 0;
    for (const line of lines) {
        maxW = Math.max(maxW, ctx.measureText(line || ' ').width);
    }
    const lineHeight = px * LINE_HEIGHT;
    const ax = layer.x * composedW;
    const ay = layer.y * composedH;
    const x0 = layer.align === 'left' ? ax
        : layer.align === 'right' ? ax - maxW
            : ax - maxW / 2;
    return {
        x: x0,
        y: ay - (lines.length * lineHeight) / 2,
        w: maxW,
        h: lines.length * lineHeight,
    };
}

export function hitTest(layer, composedW, composedH, px, py) {
    const b = measureLayer(layer, composedW, composedH);
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

// Draw every layer onto a canvas whose coordinates place the composed image
// at `rect`. scale (rect.w / composedW) converts composed-image pixels —
// font sizes, line heights — into target-canvas pixels: 1 for a full-resolution
// export, the display zoom for the preview (§10, §12).
export function drawText(ctx, layers, rect, composedW) {
    if (!layers || !layers.length || !composedW) return;
    const scale = rect.w / composedW;
    for (const layer of layers) {
        const px = layer.fontSize * scale;
        if (px <= 0) continue;
        const lines = linesOf(layer);
        const lineHeight = px * LINE_HEIGHT;
        const anchorX = rect.x + layer.x * rect.w;
        const firstY = rect.y + layer.y * rect.h - ((lines.length - 1) * lineHeight) / 2;
        ctx.save();
        setFont(ctx, layer, px);
        ctx.textAlign = layer.align;
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity));
        ctx.fillStyle = layer.color;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], anchorX, firstY + i * lineHeight);
        }
        ctx.restore();
    }
}
