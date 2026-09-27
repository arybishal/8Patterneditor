// Step 13: browser-local persistence for recovery and custom presets (§13.6,
// §13.7). localStorage holds small JSON strings of STATE ONLY — never pixels,
// never the image. Every read is re-validated through the project sanitizer
// (corrupted or hostile storage degrades to "nothing saved"), every write is
// size-capped so a pathological session can never smuggle a large payload.

import { sanitizeLook, sanitizeProjectState } from './ProjectSerializer.js';

export const SESSION_KEY = '8pattern.session';
export const PRESETS_KEY = '8pattern.presets';
// ponytail: 90KB ceiling keeps values far below the storage privacy scans
// (which flag >100KB blobs) — raise deliberately if sessions outgrow it.
const MAX_VALUE = 90000;
const MAX_PRESETS = 30;

function write(key, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text || text.length > MAX_VALUE) return false;
    try {
        localStorage.setItem(key, text);
        return true;
    } catch {
        return false; // quota / private mode — recovery is best-effort
    }
}

function read(key) {
    try {
        const text = localStorage.getItem(key);
        if (!text || text.length > MAX_VALUE) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// --------------------------------------------------------- session (13.7)

// Best-effort save of the 7-key serializable state. Returns false when the
// payload is too large or storage refuses — the editor never breaks over it.
export function saveSession(state) {
    return write(SESSION_KEY, {
        format: '8pattern.session',
        formatVersion: 1,
        at: new Date().toISOString(),
        state,
    });
}

// Validated load — anything unexpected reads as "no previous session".
export function loadSession() {
    const data = read(SESSION_KEY);
    if (!data || data.format !== '8pattern.session' || data.formatVersion !== 1) return null;
    const state = sanitizeProjectState(data.state);
    if (!state) return null;
    return { at: typeof data.at === 'string' ? data.at : '', state };
}

export function clearSession() {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch { /* nothing to clear */ }
}

export function sessionExists() {
    return loadSession() !== null;
}

// --------------------------------------------------- custom presets (13.6)

function readPresetList() {
    const data = read(PRESETS_KEY);
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const item of data) {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue;
        const name = item.name.trim().slice(0, 40);
        if (!name) continue;
        out.push({ name, ...sanitizeLook(item) });
    }
    return out;
}

export function listPresets() {
    return readPresetList();
}

export function getPreset(name) {
    return readPresetList().find((p) => p.name === name) || null;
}

export function savePreset(name, look) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return { ok: false, reason: 'name' };
    const presets = readPresetList();
    if (presets.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
        return { ok: false, reason: 'duplicate' };
    }
    if (presets.length >= MAX_PRESETS) return { ok: false, reason: 'full' };
    const shaped = { name: clean, ...sanitizeLook(look) };
    if (!write(PRESETS_KEY, [...presets, shaped])) return { ok: false, reason: 'storage' };
    return { ok: true, preset: shaped };
}

export function renamePreset(fromName, toName) {
    const clean = String(toName || '').trim().slice(0, 40);
    if (!clean) return { ok: false, reason: 'name' };
    const presets = readPresetList();
    const from = presets.find((p) => p.name === fromName);
    if (!from) return { ok: false, reason: 'missing' };
    if (presets.some((p) => p !== from && p.name.toLowerCase() === clean.toLowerCase())) {
        return { ok: false, reason: 'duplicate' };
    }
    from.name = clean;
    if (!write(PRESETS_KEY, presets)) return { ok: false, reason: 'storage' };
    return { ok: true, preset: from };
}

export function deletePreset(name) {
    const presets = readPresetList();
    const next = presets.filter((p) => p.name !== name);
    if (next.length === presets.length) return { ok: false, reason: 'missing' };
    if (!write(PRESETS_KEY, next)) return { ok: false, reason: 'storage' };
    return { ok: true };
}
