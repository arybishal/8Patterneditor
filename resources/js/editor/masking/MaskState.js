// Step 11: mask value helpers — a mask is a compact, fully serializable
// stroke list in NORMALIZED original-source coordinates (0..1 per axis).
// No Canvas, ImageData, Blob or base64 ever enters mask state, so masks ride
// inside history entries and project files like any other field (§11.1).
//
// Stroke shape: { r, h, o, e, pts }
//   r    radius as a fraction of min(sourceW, sourceH) — zoom/preview
//        independent, renders as a true circle at any resolution
//   h    hardness 0..1 (feather at the edge)
//   o    opacity 0..1 (per-stroke strength = the selective mask strength)
//   e    erase flag (destination-out when replayed)
//   pts  flat [x, y, x, y, …] normalized 0..1 — includes the first point

import { MASK_TARGET_GROUPS, MASKABLE_KEYS } from '../state/EditorState.js';

export const MAX_STROKES = 200;      // replay cost ceiling
export const MAX_POINTS = 6000;      // per stroke — bounds entry size
export const DEFAULT_BRUSH = Object.freeze({ size: 12, hardness: 60, opacity: 100 });

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

function num(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

// Empty mask bound to the current document. Targets default to every
// maskable operation; the "Apply to" select narrows them.
export function createMaskData() {
    return { strokes: [], inverted: false, targets: [...MASKABLE_KEYS] };
}

// Group name ('all' | 'adjustments' | 'effects'), a single operation key
// ('brightness' …) or an explicit key array → a validated, deduplicated key
// list (unknown keys dropped, order kept).
export function resolveTargets(spec) {
    if (typeof spec === 'string') {
        if (MASK_TARGET_GROUPS[spec]) return [...MASK_TARGET_GROUPS[spec]];
        if (MASKABLE_KEYS.includes(spec)) return [spec];
        return [...MASKABLE_KEYS];
    }
    if (Array.isArray(spec)) {
        const seen = new Set();
        const out = [];
        for (const key of spec) {
            if (MASKABLE_KEYS.includes(key) && !seen.has(key)) {
                seen.add(key);
                out.push(key);
            }
        }
        return out.length ? out : [...MASKABLE_KEYS];
    }
    return [...MASKABLE_KEYS];
}

// New stroke starting at a normalized point (first point lives in pts).
export function makeStroke(x, y, { r, hardness, opacity, erase }) {
    return {
        r: num(r, 0.002, 0.5, 0.05),
        h: num(hardness, 0, 1, 0.6),
        o: num(opacity, 0, 1, 1),
        e: Boolean(erase),
        pts: [num(x, 0, 1, 0), num(y, 0, 1, 0)],
    };
}

// Defensive validation for masks coming from history/project JSON: returns a
// clean mask or null. Never executes or trusts imported shapes (§11.8, §13.3).
export function sanitizeMask(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Array.isArray(raw.strokes)) return null;
    const strokes = [];
    for (const s of raw.strokes.slice(0, MAX_STROKES)) {
        if (!s || typeof s !== 'object' || !Array.isArray(s.pts)) continue;
        const pts = [];
        for (let i = 0; i + 1 < s.pts.length && pts.length < MAX_POINTS; i += 2) {
            const x = num(s.pts[i], 0, 1, NaN);
            const y = num(s.pts[i + 1], 0, 1, NaN);
            if (Number.isFinite(x) && Number.isFinite(y)) pts.push(x, y);
        }
        if (!pts.length) continue;
        strokes.push({
            r: num(s.r, 0.002, 0.5, 0.05),
            h: num(s.h, 0, 1, 0.6),
            o: num(s.o, 0, 1, 1),
            e: Boolean(s.e),
            pts,
        });
    }
    return {
        strokes,
        inverted: Boolean(raw.inverted),
        targets: resolveTargets(raw.targets),
    };
}

// One mask = one history step in the pipeline cache key (stable order so
// logically identical masks stringify identically).
export function maskSignature(mask) {
    if (!mask) return '';
    return `${mask.inverted ? 1 : 0}|${mask.targets.join(',')}|${mask.strokes.length}`
        + `|${mask.strokes.map((s) => `${s.r},${s.h},${s.o},${s.e ? 1 : 0}:${s.pts.join(',')}`).join(';')}`;
}
