// Step 13: project workflow glue — download the serialized project (§13.2),
// import it safely (§13.3), hold it as `pending` until the user supplies an
// image (§13.4–13.5), session recovery + debounced autosave (§13.7). Each
// restore is ONE history transaction, so undo goes straight back to the
// pre-import session.

import { parseProject, projectFileName, serializeProject } from './ProjectSerializer.js';
import { historyState } from '../history/HistorySnapshot.js';
import { clearSession, loadSession, saveSession } from './SessionStore.js';

const AUTOSAVE_MS = 800;

export function createProjectController({ state, history, fonts }) {
    let pending = null;

    function applyState(next, msg, label = 'Import Project') {
        history.begin(label); // one txn — undo = pre-import session
        state.set(next);
        history.commit();
        fonts.ensureLayers(next.textLayers);
        state.setStatus(msg, 'info');
        pending = null;
    }

    // --- export (13.2): editing instructions only, never pixels ---------------

    function save() {
        const snap = state.get();
        const json = JSON.stringify(serializeProject(snap), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = projectFileName(snap.fileName);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        state.setStatus('Project saved — editing instructions only, no image.', 'info');
        return true;
    }

    // --- import (13.3–13.5) ---------------------------------------------------

    // Malformed files never touch the session: parse first, apply only on ok.
    async function importFile(file) {
        let text;
        try {
            text = await file.text();
        } catch {
            state.setStatus('That project file could not be read — nothing was changed.', 'error');
            return false;
        }
        const parsed = parseProject(text);
        if (!parsed.ok) {
            const msg = parsed.reason === 'version'
                ? 'That project file is from a different version — nothing was changed.'
                : 'That project file is not valid — nothing was changed.';
            state.setStatus(msg, 'error');
            return false;
        }
        if (state.get().originalImage) {
            applyState(parsed.state, 'Project restored — every control is back to this look.');
        } else {
            // §13.4: no image yet — hold the settings, never show a crash.
            pending = { state: parsed.state, label: 'Import Project' };
            state.setStatus('Project settings loaded — open an image to restore them.', 'info');
        }
        return true;
    }

    // Called when an image arrives (upload or drop): pending applies cleanly.
    function onImageReady() {
        if (!pending) return false;
        const msg = 'Project settings applied to your image — undo to step back.';
        applyState(pending.state, msg, pending.label);
        // The upload controller claims the status line right after load —
        // re-assert ours once it has finished speaking.
        setTimeout(() => state.setStatus(msg, 'info'), 0);
        return true;
    }

    // --- session recovery (13.7) ----------------------------------------------

    function hasSession() {
        return loadSession() !== null;
    }

    function restoreSession() {
        const saved = loadSession();
        if (!saved) return false;
        if (state.get().originalImage) {
            applyState(saved.state, 'Previous session restored.', 'Restore Session');
        } else {
            pending = { state: saved.state, label: 'Restore Session' };
            state.setStatus('Previous session held — open an image to restore it.', 'info');
        }
        return true;
    }

    function startFresh() {
        clearSession();
        state.setStatus('Started fresh — previous session cleared.', 'info');
        return true;
    }

    // --- autosave (13.7): debounced, state only, never the image --------------

    function attachAutosave() {
        let timer = null;
        state.subscribe((snap) => {
            if (!snap.originalImage) return;
            clearTimeout(timer);
            timer = setTimeout(() => saveSession(historyState(snap)), AUTOSAVE_MS);
        });
    }

    return {
        save,
        importFile,
        onImageReady,
        restoreSession,
        startFresh,
        hasSession,
        hasPending: () => Boolean(pending),
        attachAutosave,
    };
}
