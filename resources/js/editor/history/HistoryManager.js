// Step 10: non-destructive undo/redo over serializable editor state.
// Every state notification is auto-recorded (with coalescing so one drag or
// typing burst is one entry); multi-notify actions can be wrapped in a
// begin/commit transaction for a single labeled entry (§35, §62).
//
// History NEVER stores pixels: restoring re-runs the existing pipeline from
// the canonical original image (§21, §23).

import { COALESCE_MS, HISTORY_VERSION, MAX_HISTORY } from './historyConfig.js';
import { cloneState, canCoalesce, historyKey, historyState, inferLabel, validateEntry } from './HistorySnapshot.js';
import { DEFAULT_COLOR_GRADE } from '../state/EditorState.js';

export function createHistoryManager({ state, max = MAX_HISTORY, onRestore }) {
    // Live array — the debug/test handle (window.__history) reads it to audit
    // stored entries; production code only mutates it through this manager.
    const entries = [];
    let index = -1;
    let txn = null;        // pending transaction label (§35)
    let restoring = false; // true while undo/redo writes state back
    let docRef = null;     // originalImage identity — a new document resets history (§28)
    let lastAuto = { i: -1, label: '', at: 0 };
    const listeners = new Set();

    function emit() {
        for (const fn of listeners) fn();
    }

    function pushEntry(label, st, key) {
        const now = Date.now();
        // Coalesce continuous edits into the current entry (§10, §62).
        if (canCoalesce(label) && index === entries.length - 1 && lastAuto.i === index
            && lastAuto.label === label && now - lastAuto.at < COALESCE_MS) {
            entries[index] = { version: HISTORY_VERSION, label, state: st, key, at: now };
            lastAuto = { i: index, label, at: now };
            emit();
            return;
        }
        entries.splice(index + 1); // drop the redo tail — new action branches (§10)
        entries.push({ version: HISTORY_VERSION, label, state: st, key, at: now });
        if (entries.length > max) entries.splice(0, entries.length - max); // §34
        index = entries.length - 1;
        lastAuto = { i: index, label, at: now };
        emit();
    }

    function record() {
        if (restoring) return;
        const snap = state.get();
        if (!snap.originalImage) return;
        if (snap.originalImage !== docRef) {
            // New document: history starts over from its untouched state (§7, §28).
            docRef = snap.originalImage;
            txn = null;
            entries.length = 0;
            index = -1;
            lastAuto = { i: -1, label: '', at: 0 };
            const st = historyState(snap);
            entries.push({ version: HISTORY_VERSION, label: 'Original', state: st, key: historyKey(st), at: Date.now() });
            index = 0;
            emit();
            return;
        }
        if (txn) return; // buffered — the transaction commit records one entry
        const st = historyState(snap);
        const key = historyKey(st);
        if (index >= 0 && entries[index].key === key) return; // no-op or non-historic change (§24, §25)
        pushEntry(inferLabel(index >= 0 ? entries[index].state : null, st), st, key);
    }

    function moveTo(target, verb, label) {
        const entry = entries[target];
        const valid = validateEntry(entry);
        if (!valid.ok) {
            state.setStatus('Unable to restore that editing state.', 'error');
            emit();
            return false;
        }
        restoring = true;
        try {
            state.set({
                adjustments: cloneState(entry.state.adjustments),
                effects: cloneState(entry.state.effects),
                // Step 12: grade restores too; entries older than color
                // grading restore as the identity grade (§12.5 backward path).
                colorGrade: entry.state.colorGrade
                    ? cloneState(entry.state.colorGrade)
                    : { ...DEFAULT_COLOR_GRADE },
                composition: cloneState(entry.state.composition),
                textLayers: cloneState(entry.state.textLayers),
                selectedTextId: entry.state.selectedTextId ?? null,
                // Step 11: mask restores with everything else (entries older
                // than masking simply restore "no mask").
                mask: entry.state.mask ? cloneState(entry.state.mask) : null,
            });
            index = target;
            lastAuto = { i: -1, label: '', at: 0 };
        } catch (err) {
            console.warn('History restore failed:', err);
            state.setStatus('Unable to restore that editing state.', 'error');
            emit();
            return false;
        } finally {
            restoring = false;
        }
        if (verb) state.setStatus(`${verb}: ${label}`);
        if (onRestore) onRestore(state.get());
        emit();
        return true;
    }

    state.subscribe(record);

    return {
        undo() {
            if (txn) txn = null;
            if (index <= 0) return false;
            return moveTo(index - 1, 'Undo', entries[index].label);
        },

        redo() {
            if (txn) txn = null;
            if (index >= entries.length - 1) return false;
            return moveTo(index + 1, 'Redo', entries[index + 1].label);
        },

        // Jump directly to a history panel entry (§39).
        jump(i) {
            if (txn) return false;
            if (!Number.isInteger(i) || i < 0 || i >= entries.length || i === index) return false;
            return moveTo(i, 'History', entries[i].label);
        },

        // Explicit transaction (§35): begin() → state changes → commit().
        // Nested transactions are rejected — the outer one owns the entry.
        begin(label) {
            if (txn || typeof label !== 'string' || !label.trim()) return false;
            txn = label;
            return true;
        },

        commit() {
            if (!txn) return false;
            const label = txn;
            txn = null;
            const snap = state.get();
            if (!snap.originalImage) return false;
            const st = historyState(snap);
            const key = historyKey(st);
            if (index >= 0 && entries[index].key === key) return false; // action changed nothing
            pushEntry(label, st, key);
            return true;
        },

        cancel() {
            if (!txn) return false;
            txn = null;
            return true;
        },

        canUndo() {
            return index > 0;
        },

        canRedo() {
            return index >= 0 && index < entries.length - 1;
        },

        index() {
            return index;
        },

        length() {
            return entries.length;
        },

        labels() {
            return entries.map((e, i) => ({
                index: i,
                label: e.label,
                isCurrent: i === index,
                isFuture: i > index,
            }));
        },

        entry(i) {
            const e = entries[i];
            if (!e) return null;
            return { version: e.version, label: e.label, state: cloneState(e.state) };
        },

        // Live entries (debug/test handle) — used to audit §46 (no pixel
        // buffers) and to fabricate a corrupt entry for §44.
        entries,

        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
