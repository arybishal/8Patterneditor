// Step 13: project files — editing INSTRUCTIONS only, never the image (§13.1).
// serializeProject() reuses the history snapshot clone (one definition of
// "serializable state"); parseProject() rebuilds every field through the same
// sanitizers the live editor uses, so a hostile file can at worst produce
// clamped defaults (§13.3). JSON.parse is the only parser — imported content
// is never executed, never treated as code, never injected as HTML.

import {
    ADJUSTMENT_CONTROLS, COLOR_GRADE_CONTROLS, DEFAULT_ADJUSTMENTS,
    DEFAULT_COLOR_GRADE, DEFAULT_EFFECTS, EFFECT_CONTROLS,
} from '../state/EditorState.js';
import { sanitizeGradeValue } from '../color/ColorGradeState.js';
import { makeComposition, MAX_OUTPUT_DIM } from '../composition/CompositionRenderer.js';
import { createTextLayer, sanitizePatch } from '../text/TextState.js';
import { sanitizeMask } from '../masking/MaskState.js';
import { historyState } from '../history/HistorySnapshot.js';

export const PROJECT_FORMAT = '8pattern';
export const PROJECT_FORMAT_VERSION = 1;
const APP_NAME = '8Pattern Editor';
const APP_VERSION = 'Version 1.0 Beta';
const MAX_LAYERS = 50;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v) => Number(v);

// ------------------------------------------------------------ serialize (13.2)

export function serializeProject(snapshot) {
    const st = historyState(snapshot); // deep clone of the 7 serializable keys
    return {
        format: PROJECT_FORMAT,
        formatVersion: PROJECT_FORMAT_VERSION,
        app: APP_NAME,
        appVersion: APP_VERSION,
        savedAt: new Date().toISOString(),
        state: st,
        // Fonts travel as referenced family names only — font binaries are
        // never embedded; missing families fall back on restore (§13.2).
        fonts: [...new Set(st.textLayers.map((l) => l.fontFamily))],
    };
}

// `${base}.8pattern.json` derived from the open image name (never user-typed
// path segments — stripped to safe filename characters).
export function projectFileName(fileName) {
    const base = String(fileName || 'project')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return `${base || 'project'}.8pattern.json`;
}

// ------------------------------------------------------------- sanitize (13.3)

function sanitizeNumericMap(raw, controls, defaults) {
    const src = isObj(raw) ? raw : {};
    const out = {};
    for (const c of controls) {
        const n = num(src[c.key]);
        out[c.key] = Number.isFinite(n)
            ? Math.min(c.max, Math.max(c.min, n))
            : defaults[c.key];
    }
    return out;
}

// One look = adjustments + effects + grade, each rebuilt from its control
// table (unknown keys dropped, ranges enforced, missing keys defaulted).
export function sanitizeLook(raw) {
    const src = isObj(raw) ? raw : {};
    const gradeSrc = isObj(src.colorGrade) ? src.colorGrade : {};
    const colorGrade = { ...DEFAULT_COLOR_GRADE };
    for (const c of COLOR_GRADE_CONTROLS) {
        const clean = sanitizeGradeValue(c.key, gradeSrc[c.key]);
        colorGrade[c.key] = clean === null ? DEFAULT_COLOR_GRADE[c.key] : clean;
    }
    return {
        adjustments: sanitizeNumericMap(src.adjustments, ADJUSTMENT_CONTROLS, DEFAULT_ADJUSTMENTS),
        effects: sanitizeNumericMap(src.effects, EFFECT_CONTROLS, DEFAULT_EFFECTS),
        colorGrade,
    };
}

function sanitizeComposition(raw) {
    // Structure violation → null (caller fails the whole file, §13.3).
    if (raw != null && !isObj(raw)) return null;
    const out = makeComposition();
    if (!isObj(raw)) return out;

    if (raw.crop != null) {
        if (!isObj(raw.crop)) return null;
        const c = raw.crop;
        const x = Number.isFinite(num(c.x)) ? Math.min(1, Math.max(0, num(c.x))) : 0;
        const y = Number.isFinite(num(c.y)) ? Math.min(1, Math.max(0, num(c.y))) : 0;
        const w = Number.isFinite(num(c.width)) ? Math.min(1, Math.max(0, num(c.width))) : 1;
        const h = Number.isFinite(num(c.height)) ? Math.min(1, Math.max(0, num(c.height))) : 1;
        out.crop = {
            enabled: c.enabled === true,
            x,
            y,
            width: w <= 0 ? 1 : Math.min(w, 1 - x),
            height: h <= 0 ? 1 : Math.min(h, 1 - y),
        };
        if (out.crop.width <= 0 || out.crop.height <= 0) out.crop = { ...out.crop, width: 1, height: 1, enabled: false };
    }

    if (raw.rotation != null) {
        const r = num(raw.rotation);
        if (!Number.isFinite(r)) return null;
        out.rotation = ((Math.round(r) % 360) + 360) % 360;
    }

    if (raw.resize != null) {
        if (!isObj(raw.resize)) return null;
        const r = raw.resize;
        const dim = (v) => {
            if (v == null) return null;
            const n = num(v);
            if (!Number.isFinite(n)) return null;
            return Math.min(MAX_OUTPUT_DIM, Math.max(1, Math.round(n)));
        };
        out.resize = {
            enabled: r.enabled === true,
            width: dim(r.width),
            height: dim(r.height),
            maintainAspectRatio: r.maintainAspectRatio !== false,
        };
    }
    return out;
}

function sanitizeLayers(raw) {
    // Structure violation → null (caller fails the whole file).
    if (raw != null && !Array.isArray(raw)) return null;
    const items = Array.isArray(raw) ? raw.slice(0, MAX_LAYERS) : [];
    const layers = [];
    const seen = new Set();
    for (const item of items) {
        if (!isObj(item)) continue;
        const base = createTextLayer();
        // Ids must be unique strings — anything else gets a fresh id.
        const id = typeof item.id === 'string' && item.id.length <= 40 && !seen.has(item.id)
            ? item.id : base.id;
        const patch = sanitizePatch(base, item); // ranges/fields via live rules
        const layer = { ...base, ...patch, id };
        seen.add(layer.id);
        layers.push(layer);
    }
    return layers;
}

// Full state sanitizer used by project import AND session recovery — returns
// the exact 7-key state object, or null when the input is structurally wrong.
export function sanitizeProjectState(raw) {
    if (!isObj(raw)) return null;

    const look = sanitizeLook(raw);
    const composition = sanitizeComposition(raw.composition);
    if (composition === null) return null;
    const textLayers = sanitizeLayers(raw.textLayers);
    if (textLayers === null) return null;

    let mask = null;
    if (raw.mask != null) {
        mask = sanitizeMask(raw.mask);
        if (mask === null) return null; // structural garbage fails the file
    }

    const selectedTextId = typeof raw.selectedTextId === 'string'
        && textLayers.some((l) => l.id === raw.selectedTextId)
        ? raw.selectedTextId : null;

    return {
        adjustments: look.adjustments,
        effects: look.effects,
        colorGrade: look.colorGrade,
        composition,
        textLayers,
        selectedTextId,
        mask,
    };
}

// ------------------------------------------------------------ import (13.3)
// Malformed or hostile files fail safely: a reason string, never a throw,
// never a partial apply — the current session stays exactly as it was (§13.5).

export function parseProject(text) {
    let data;
    try {
        data = JSON.parse(String(text));
    } catch {
        return { ok: false, reason: 'json' };
    }
    if (!isObj(data)) return { ok: false, reason: 'format' };
    if (data.format !== PROJECT_FORMAT) return { ok: false, reason: 'format' };
    if (typeof data.formatVersion !== 'number' || data.formatVersion !== PROJECT_FORMAT_VERSION) {
        return { ok: false, reason: 'version' };
    }
    if (!isObj(data.state)) return { ok: false, reason: 'state' };
    const state = sanitizeProjectState(data.state);
    if (!state) return { ok: false, reason: 'state' };
    return { ok: true, state, fonts: Array.isArray(data.fonts) ? data.fonts.filter((f) => typeof f === 'string') : [] };
}
