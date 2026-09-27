// Step 10: snapshot capture, deterministic serialization and label inference.
// A history snapshot is a deep clone of {adjustments, effects, colorGrade,
// composition, textLayers, selectedTextId, mask} — never pixels, the original
// image or any other non-serializable state (§21, §23). The Step 11 mask is a
// stroke list and the Step 12 grade twelve small numbers, so both are just as
// serializable as the rest.

import { ADJUSTMENT_CONTROLS, COLOR_GRADE_CONTROLS, EFFECT_CONTROLS } from '../state/EditorState.js';
import { HISTORY_VERSION } from './historyConfig.js';

export function cloneState(value) {
    return structuredClone(value);
}

// Key-sorted JSON so logically identical states always stringify identically.
export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function historyState(snapshot) {
    return {
        adjustments: cloneState(snapshot.adjustments),
        effects: cloneState(snapshot.effects),
        // Step 12: twelve small numbers — same rules as every other field.
        colorGrade: cloneState(snapshot.colorGrade ?? {}),
        composition: cloneState(snapshot.composition),
        textLayers: cloneState(snapshot.textLayers),
        selectedTextId: snapshot.selectedTextId ?? null,
        // Step 11: mask rides along as plain serializable data (null = none).
        mask: snapshot.mask ? cloneState(snapshot.mask) : null,
    };
}

// Comparison key excludes selectedTextId: selecting a layer is not a history
// action (§24) and must never create an entry. maskVisible is view state (like
// zoom) and is never part of a snapshot, so overlay toggles create no entries.
export function historyKey(st) {
    const { adjustments, effects, colorGrade, composition, textLayers, mask } = st;
    return stableStringify({
        adjustments,
        effects,
        colorGrade: colorGrade ?? {},
        composition,
        textLayers,
        mask: mask ?? null,
    });
}

// Only continuous edits coalesce (§10, §62): slider drags, typing, layer moves
// and programmatic mask strokes (pointer strokes additionally use a explicit
// transaction so one gesture is always exactly one entry — §11.6).
const COALESCE_LABELS = new Set([
    ...ADJUSTMENT_CONTROLS.map((c) => c.label),
    ...EFFECT_CONTROLS.map((c) => c.label),
    // Step 12: grade sliders are continuous edits like every other slider.
    ...COLOR_GRADE_CONTROLS.map((c) => c.label),
    'Edit Text',
    'Move Text',
    'Paint Mask',
    'Erase Mask',
]);

export function canCoalesce(label) {
    return COALESCE_LABELS.has(label);
}

function diffKeys(prev, next) {
    const keys = [];
    for (const k of Object.keys(next)) {
        if (prev[k] !== next[k]) keys.push(k);
    }
    return keys;
}

const ADJ_LABEL = new Map(ADJUSTMENT_CONTROLS.map((c) => [c.key, c.label]));
const EFF_LABEL = new Map(EFFECT_CONTROLS.map((c) => [c.key, c.label]));
const CG_LABEL = new Map(COLOR_GRADE_CONTROLS.map((c) => [c.key, c.label]));

function textLabel(prev, next) {
    if (next.textLayers.length > prev.textLayers.length) {
        const prevIds = new Set(prev.textLayers.map((l) => l.id));
        return next.textLayers.some((l) => !prevIds.has(l.id)) ? 'Add Text' : 'Edit Text';
    }
    if (next.textLayers.length < prev.textLayers.length) {
        return next.textLayers.length === 0 && prev.textLayers.length > 1 ? 'Clear Text' : 'Delete Text';
    }
    const prevById = new Map(prev.textLayers.map((l) => [l.id, l]));
    for (const layer of next.textLayers) {
        const before = prevById.get(layer.id);
        if (!before) continue;
        if (before.fontFamily !== layer.fontFamily) return `Font: ${layer.fontFamily}`;
        if (before.fontWeight !== layer.fontWeight) return `Font Weight: ${layer.fontWeight}`;
        if (before.fontStyle !== layer.fontStyle) return `Font Style: ${layer.fontStyle === 'italic' ? 'Italic' : 'Regular'}`;
        if (before.text !== layer.text) return 'Edit Text';
        if (before.fontSize !== layer.fontSize) return 'Text Size';
        if (before.color !== layer.color) return 'Text Color';
        if (before.opacity !== layer.opacity) return 'Text Opacity';
        if (before.align !== layer.align) return 'Text Alignment';
        if (before.x !== layer.x || before.y !== layer.y) return 'Move Text';
    }
    return 'Edit Text';
}

// Step 11: mask diffs get their own labels (most specific first).
function maskLabel(a, b) {
    if (!a && b) return 'Create Mask';
    if (a && !b) return 'Delete Mask';
    if (!a) return 'Mask';
    // Clear wipes the strokes AND resets the inversion flag — it wins over
    // the flag diff so the button always records "Clear Mask".
    if (a.strokes.length && !b.strokes.length) return 'Clear Mask';
    if (Boolean(a.inverted) !== Boolean(b.inverted)) return 'Invert Mask';
    if (b.strokes.length !== a.strokes.length) {
        const last = b.strokes[b.strokes.length - 1] || a.strokes[a.strokes.length - 1];
        return last && last.e ? 'Erase Mask' : 'Paint Mask';
    }
    if (stableStringify(a.targets) !== stableStringify(b.targets)) return 'Mask Targets';
    if (a.strokes.length) {
        const la = a.strokes[a.strokes.length - 1];
        const lb = b.strokes[b.strokes.length - 1];
        if (la !== lb && lb.pts.length !== la.pts.length) return lb.e ? 'Erase Mask' : 'Paint Mask';
    }
    return 'Mask';
}

// Label for the change between two snapshots — checked most-specific first:
// composition, mask, text, adjustments/effects (§62 examples). Full resets
// arrive through an explicit transaction labeled 'Reset', so no inference is
// needed.
export function inferLabel(prev, next) {
    if (!prev) return 'Original';
    if (prev.composition.rotation !== next.composition.rotation) return 'Rotate';
    if (stableStringify(prev.composition.crop) !== stableStringify(next.composition.crop)) return 'Crop';
    if (stableStringify(prev.composition.resize) !== stableStringify(next.composition.resize)) return 'Resize';
    if (stableStringify(prev.mask ?? null) !== stableStringify(next.mask ?? null)) {
        return maskLabel(prev.mask ?? null, next.mask ?? null);
    }
    if (stableStringify(prev.textLayers) !== stableStringify(next.textLayers)) return textLabel(prev, next);
    const adj = diffKeys(prev.adjustments, next.adjustments);
    const eff = diffKeys(prev.effects, next.effects);
    const cg = diffKeys(prev.colorGrade ?? {}, next.colorGrade ?? {});
    // More than one look map changed together = a preset-style rewrite
    // (presets themselves carry explicit transactions; this is the fallback).
    if ([adj, eff, cg].filter((a) => a.length).length > 1) return 'Preset';
    if (cg.length === 1) return CG_LABEL.get(cg[0]) || 'Color Grade';
    if (cg.length > 1) return 'Color Grade';
    if (adj.length === 1) return ADJ_LABEL.get(adj[0]) || 'Edit';
    if (adj.length > 1) return 'Adjustments';
    if (eff.length === 1) return EFF_LABEL.get(eff[0]) || 'Edit';
    if (eff.length > 1) return 'Effects';
    return 'Edit';
}

// Version/shape guard before restoring (§43, §44): a stale or corrupt entry
// is reported safely instead of being applied.
export function validateEntry(entry) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'entry' };
    if (entry.version !== HISTORY_VERSION) return { ok: false, reason: 'version' };
    const st = entry.state;
    if (!st || typeof st !== 'object') return { ok: false, reason: 'state' };
    if (!st.adjustments || typeof st.adjustments !== 'object' || Array.isArray(st.adjustments)) return { ok: false, reason: 'adjustments' };
    if (!st.effects || typeof st.effects !== 'object' || Array.isArray(st.effects)) return { ok: false, reason: 'effects' };
    // Step 12: color grade is optional (entries predating it restore as
    // defaults) but must be a plain object of small numbers when present.
    if (st.colorGrade != null
        && (typeof st.colorGrade !== 'object' || Array.isArray(st.colorGrade))) {
        return { ok: false, reason: 'colorGrade' };
    }
    if (!st.composition || typeof st.composition !== 'object') return { ok: false, reason: 'composition' };
    if (!Array.isArray(st.textLayers)) return { ok: false, reason: 'textLayers' };
    if (st.textLayers.some((l) => !l || typeof l.id !== 'string')) return { ok: false, reason: 'layer' };
    if (st.selectedTextId != null && typeof st.selectedTextId !== 'string') return { ok: false, reason: 'selectedTextId' };
    // Step 11: mask must be null or a plain stroke-list shape (never a host
    // object or pixel buffer); entries predating masks read as null.
    if (st.mask != null) {
        if (typeof st.mask !== 'object' || Array.isArray(st.mask) || !Array.isArray(st.mask.strokes)) {
            return { ok: false, reason: 'mask' };
        }
    }
    return { ok: true };
}
