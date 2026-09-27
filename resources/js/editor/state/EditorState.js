import { DEFAULT_CROP, DEFAULT_RESIZE, makeComposition, copyComposition } from '../composition/CompositionRenderer.js';
import { createTextLayer, sanitizePatch, transformLayers } from '../text/TextState.js';
import { DEFAULT_COLOR_GRADE, COLOR_GRADE_CONTROLS, COLOR_GRADE_KEYS, sanitizeGradeValue } from '../color/ColorGradeState.js';

// Step 12: color grade state lives with the state config so every consumer
// (history, presets, pipeline, UI) reads one definition.
export { DEFAULT_COLOR_GRADE, COLOR_GRADE_CONTROLS, COLOR_GRADE_KEYS };

export const DEFAULT_ADJUSTMENTS = Object.freeze({
    brightness: 0,
    contrast: 0,
    exposure: 0,
    highlights: 0,
    shadows: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    sharpness: 0,
});

export const DEFAULT_EFFECTS = Object.freeze({
    fade: 0,
    vignette: 0,
    grain: 0,
    dust: 0,
    scratches: 0,
    lightLeak: 0,
});

export const ADJUSTMENT_CONTROLS = Object.freeze([
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
    { key: 'exposure', label: 'Exposure', min: -100, max: 100, step: 1 },
    { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
    { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
    { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1 },
    { key: 'tint', label: 'Tint', min: -100, max: 100, step: 1 },
    { key: 'sharpness', label: 'Sharpness', min: -100, max: 100, step: 1 },
]);

export const EFFECT_CONTROLS = Object.freeze([
    { key: 'fade', label: 'Fade', min: -100, max: 100, step: 1 },
    { key: 'vignette', label: 'Vignette', min: 0, max: 100, step: 1 },
    { key: 'grain', label: 'Film Grain', min: 0, max: 100, step: 1 },
    { key: 'dust', label: 'Dust', min: 0, max: 100, step: 1 },
    { key: 'scratches', label: 'Scratches', min: 0, max: 100, step: 1 },
    { key: 'lightLeak', label: 'Light Leak', min: 0, max: 100, step: 1 },
]);

// Step 11: which pipeline operations a mask can scope (all 15). Owned here so
// masking, state and the pipeline share one key list with no import cycles.
export const MASKABLE_KEYS = Object.freeze([
    ...ADJUSTMENT_CONTROLS.map((c) => c.key),
    ...EFFECT_CONTROLS.map((c) => c.key),
]);

// Named target groups for the "Apply to" select — expand to key arrays.
export const MASK_TARGET_GROUPS = Object.freeze({
    all: Object.freeze([...MASKABLE_KEYS]),
    adjustments: Object.freeze(ADJUSTMENT_CONTROLS.map((c) => c.key)),
    effects: Object.freeze(EFFECT_CONTROLS.map((c) => c.key)),
});

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.1;

export function createEditorState() {
    const state = {
        // imageWidth/imageHeight always describe the ORIGINAL uploaded source.
        // What is displayed/exported is composedDimensions(imageWidth,
        // imageHeight, composition) — crop/rotation/resize never mutate the
        // source, they are resolved by CompositionRenderer for preview+export.
        originalImage: null,
        imageWidth: 0,
        imageHeight: 0,
        fileName: '',
        zoom: 1,
        adjustments: { ...DEFAULT_ADJUSTMENTS },
        effects: { ...DEFAULT_EFFECTS },
        // Step 12: cinematic color grading — serializable state like every
        // other look control; defaults produce exactly the pre-grade image.
        colorGrade: { ...DEFAULT_COLOR_GRADE },
        composition: makeComposition(),
        // Text layers live AFTER the photographic pipeline — see TextRenderer.
        // Positioned normalized to the composed image; ids are stable and
        // never array indices.
        textLayers: [],
        selectedTextId: null,
        // Step 11: ONE optional brush mask, serializable stroke list in
        // normalized ORIGINAL-source coordinates — never pixels/hosts, so it
        // rides inside history and project files like every other state field.
        mask: null,
        // View state for the mask tint overlay (like zoom/activeTool): never
        // part of historyKey, so showing/hiding creates no history entry.
        maskVisible: true,
        activeTool: 'adjust',
        exporting: false,
        status: { text: 'Ready — open a photo to start editing.', type: 'info' },
    };

    const listeners = new Set();

    const notify = () => listeners.forEach((fn) => fn(state));

    return {
        get() {
            return state;
        },

        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        set(patch) {
            Object.assign(state, patch);
            notify();
        },

        setAdjustment(key, value) {
            if (!(key in state.adjustments)) return;
            state.adjustments[key] = value;
            notify();
        },

        setEffect(key, value) {
            if (!(key in state.effects)) return;
            state.effects[key] = value;
            notify();
        },

        // Step 12: one validated write per grade control (unknown keys and
        // non-numeric input are rejected; values clamp to their safe range).
        setColorGrade(key, value) {
            const clean = sanitizeGradeValue(key, value);
            if (clean === null || state.colorGrade[key] === clean) return;
            state.colorGrade[key] = clean;
            notify();
        },

        // Presets only rewrite state — pixels are never touched directly, so
        // every slider stays editable afterwards (non-destructive).
        applyPreset(preset) {
            state.adjustments = { ...DEFAULT_ADJUSTMENTS, ...preset.adjustments };
            state.effects = { ...DEFAULT_EFFECTS, ...preset.effects };
            state.colorGrade = { ...DEFAULT_COLOR_GRADE, ...preset.colorGrade };
            notify();
        },

        setStatus(text, type = 'info') {
            state.status = { text, type };
            notify();
        },

        resetAdjustments() {
            state.adjustments = { ...DEFAULT_ADJUSTMENTS };
            state.effects = { ...DEFAULT_EFFECTS };
            state.colorGrade = { ...DEFAULT_COLOR_GRADE };
            state.composition = makeComposition();
            state.textLayers = [];
            state.selectedTextId = null;
            state.mask = null;
            notify();
        },

        // Step 12 (§12.5): grade-only reset — adjustments/effects/composition
        // stay exactly as they are. Undoable through the normal history path.
        resetColorGrade() {
            state.colorGrade = { ...DEFAULT_COLOR_GRADE };
            notify();
        },

        // Step 12 (§12.5): "the look" = adjustments + effects + grade.
        // Composition, text and the mask are structure, not look — untouched.
        resetLook() {
            state.adjustments = { ...DEFAULT_ADJUSTMENTS };
            state.effects = { ...DEFAULT_EFFECTS };
            state.colorGrade = { ...DEFAULT_COLOR_GRADE };
            notify();
        },

        loadImage(bitmap, { width, height, fileName }) {
            if (state.originalImage && state.originalImage.close) {
                state.originalImage.close();
            }
            state.originalImage = bitmap;
            state.imageWidth = width;
            state.imageHeight = height;
            state.fileName = fileName;
            state.adjustments = { ...DEFAULT_ADJUSTMENTS };
            state.effects = { ...DEFAULT_EFFECTS };
            state.colorGrade = { ...DEFAULT_COLOR_GRADE };
            state.composition = makeComposition();
            state.textLayers = [];
            state.selectedTextId = null;
            state.mask = null;
            notify();
        },

        // --- Step 11: selective mask -------------------------------------
        // Mutations replace the mask object so history snapshots stay
        // independent copies; every call notifies for history + render.

        createMask() {
            if (!state.originalImage || state.mask) return false;
            state.mask = { strokes: [], inverted: false, targets: [...MASKABLE_KEYS] };
            notify();
            return true;
        },

        deleteMask() {
            if (!state.mask) return false;
            state.mask = null;
            notify();
            return true;
        },

        // Generic replace — MaskController builds the next mask value.
        updateMask(next) {
            state.mask = next;
            notify();
        },

        setMaskVisible(visible) {
            const next = Boolean(visible);
            if (state.maskVisible === next) return;
            state.maskVisible = next;
            notify();
        },

        // --- Text layers (drawn after the photographic pipeline) ---

        // New layers land at the center of the CURRENT composed view (layers
        // live in composed-normalized coordinates; composition changes
        // transform them alongside the image pixels).
        addText() {
            if (!state.originalImage) return null;
            const layer = createTextLayer();
            state.textLayers.push(layer);
            state.selectedTextId = layer.id;
            notify();
            return layer.id;
        },

        updateText(id, patch) {
            const layer = state.textLayers.find((l) => l.id === id);
            if (!layer) return;
            Object.assign(layer, sanitizePatch(layer, patch));
            notify();
        },

        removeText(id) {
            const before = state.textLayers.length;
            state.textLayers = state.textLayers.filter((l) => l.id !== id);
            if (state.textLayers.length === before) return;
            if (state.selectedTextId === id) state.selectedTextId = null;
            notify();
        },

        duplicateText(id) {
            const source = state.textLayers.find((l) => l.id === id);
            if (!source) return null;
            const copy = createTextLayer(); // fresh stable id
            Object.assign(copy, source, { id: copy.id });
            copy.x = Math.min(1, source.x + 0.04);
            copy.y = Math.min(1, source.y + 0.04);
            state.textLayers.push(copy);
            state.selectedTextId = copy.id;
            notify();
            return copy.id;
        },

        clearText() {
            if (!state.textLayers.length) return;
            state.textLayers = [];
            state.selectedTextId = null;
            notify();
        },

        selectText(id) {
            if (state.selectedTextId === id) return;
            state.selectedTextId = state.textLayers.some((l) => l.id === id) ? id : null;
            notify();
        },

        // --- Composition (crop → rotate → resize), all non-destructive ---
        // Every mutation rewrites text layers first (state captured before the
        // change) so text stays pinned to its image pixels (§18).

        // ±90 only: 360° total coverage via four canonical states, always
        // returns to the original after four steps, no interpolation.
        rotate(delta) {
            const before = copyComposition(state.composition);
            const rotation = (((state.composition.rotation + delta) % 360) + 360) % 360;
            state.composition.rotation = rotation;
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },

        resetRotation() {
            const before = copyComposition(state.composition);
            state.composition.rotation = 0;
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },

        // Crop is a normalized rect on the ORIGINAL source (0..1).
        setCrop(x, y, width, height) {
            const before = copyComposition(state.composition);
            const w = Math.min(1, Math.max(0.001, Number(width)));
            const h = Math.min(1, Math.max(0.001, Number(height)));
            const cx = Math.min(Math.max(0, Number(x)), 1 - w);
            const cy = Math.min(Math.max(0, Number(y)), 1 - h);
            state.composition.crop = { enabled: true, x: cx, y: cy, width: w, height: h };
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },

        resetCrop() {
            const before = copyComposition(state.composition);
            state.composition.crop = { ...DEFAULT_CROP };
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },

        setResize(width, height, maintainAspectRatio) {
            const before = copyComposition(state.composition);
            state.composition.resize = {
                enabled: true,
                width: Math.round(Number(width)),
                height: Math.round(Number(height)),
                maintainAspectRatio: Boolean(maintainAspectRatio),
            };
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },

        resetResize() {
            const before = copyComposition(state.composition);
            state.composition.resize = { ...DEFAULT_RESIZE };
            transformLayers(state.textLayers, before, state.composition,
                state.imageWidth, state.imageHeight);
            notify();
        },
    };
}
