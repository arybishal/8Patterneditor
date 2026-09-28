// Crop interaction — a TEMPORARY draft selection in composed-display space,
// overlaid on the processed preview. Nothing touches EditorState until Apply;
// Cancel simply discards the draft. The draft is converted to normalized
// original-source coordinates only at apply time (zoom/window independent).

import { composedDimensions, displayRect, selectionToCrop } from './CompositionRenderer.js';

const MIN_FRACTION = 0.01; // smallest selection: 1% of the composed image
const HANDLES = ['nw', 'ne', 'sw', 'se'];

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

export function createCropController({ state, workspace }) {
    let active = false;
    let overlay = null;
    let box = null;
    let aspect = null; // width/height ratio in composed px, or null = Free
    let aspectLabel = 'Free';
    let draft = { u: 0, v: 0, w: 1, h: 1 };
    let drag = null;
    let observer = null;
    let lastImage = null;

    function snapshot() {
        return state.get();
    }

    function dims(snap) {
        if (!snap.originalImage) return null;
        return composedDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
    }

    function imageRect(snap) {
        const d = dims(snap);
        if (!d) return null;
        return displayRect(workspace.clientWidth, workspace.clientHeight, d.width, d.height, snap.zoom);
    }

    // Pointer (workspace-relative px) → composed-normalized 0..1
    function toNorm(clientX, clientY, rect) {
        const ws = workspace.getBoundingClientRect();
        return {
            u: (clientX - ws.left - rect.x) / rect.w,
            v: (clientY - ws.top - rect.y) / rect.h,
        };
    }

    function applyAspectToDraft() {
        if (!aspect) return;
        const d = dims(snapshot());
        if (!d) return;
        draft.w = clamp(draft.w, MIN_FRACTION, 1);
        draft.h = (draft.w * d.width) / (aspect * d.height);
        if (draft.v + draft.h > 1) {
            draft.h = 1 - draft.v;
            draft.w = (draft.h * aspect * d.height) / d.width;
        }
        if (draft.u + draft.w > 1) {
            draft.w = 1 - draft.u;
            draft.h = (draft.w * d.width) / (aspect * d.height);
        }
        clampDraft();
    }

    function clampDraft() {
        draft.w = clamp(draft.w, MIN_FRACTION, 1);
        draft.h = clamp(draft.h, MIN_FRACTION, 1);
        draft.u = clamp(draft.u, 0, 1 - draft.w);
        draft.v = clamp(draft.v, 0, 1 - draft.h);
    }

    function ensureOverlay() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'crop-overlay';

        box = document.createElement('div');
        box.className = 'crop-box';
        box.tabIndex = 0;
        box.setAttribute('aria-label', 'Crop selection — arrow keys move, Enter applies, Escape cancels');

        for (const handle of HANDLES) {
            const el = document.createElement('span');
            el.className = `crop-handle crop-handle--${handle}`;
            el.dataset.handle = handle;
            box.append(el);
        }
        overlay.append(box);
        workspace.append(overlay);

        overlay.addEventListener('pointerdown', onPointerDown);
        box.addEventListener('keydown', onKeyDown);

        observer = new ResizeObserver(() => refresh());
        observer.observe(workspace);
    }

    function destroyOverlay() {
        if (!overlay) return;
        observer?.disconnect();
        observer = null;
        overlay.remove();
        overlay = null;
        box = null;
        drag = null;
    }

    function onPointerDown(event) {
        const snap = snapshot();
        if (!snap.originalImage) return;
        const rect = imageRect(snap);
        if (!rect) return;
        event.preventDefault();

        const handleEl = event.target.closest('[data-handle]');
        const mode = handleEl ? handleEl.dataset.handle : 'move';
        const p = toNorm(event.clientX, event.clientY, rect);

        drag = { mode, startU: p.u, startV: p.v, orig: { ...draft }, rect };
        box.focus({ preventScroll: true });
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(event) {
        if (!drag) return;
        const snap = snapshot();
        const d = dims(snap);
        if (!d) return;
        const p = toNorm(event.clientX, event.clientY, drag.rect);

        if (drag.mode === 'move') {
            draft.u = drag.orig.u + (p.u - drag.startU);
            draft.v = drag.orig.v + (p.v - drag.startV);
            clampDraft();
        } else {
            resizeDraft(drag.mode, p, d, drag.orig);
        }
        refreshBox();
    }

    function onPointerUp() {
        drag = null;
        window.removeEventListener('pointermove', onPointerMove);
    }

    // Corner resize: the opposite corner is the fixed anchor. Aspect ratio is
    // enforced in composed px, then the whole rect scales uniformly to fit
    // bounds — a uniform scale can never break the ratio.
    function resizeDraft(mode, p, d, orig) {
        const movesLeft = mode.includes('w');
        const movesTop = mode.includes('n');
        const anchorU = movesLeft ? orig.u + orig.w : orig.u;
        const anchorV = movesTop ? orig.v + orig.h : orig.v;

        const pu = clamp(p.u, 0, 1);
        const pv = clamp(p.v, 0, 1);

        let du = Math.abs(pu - anchorU);
        let dv = Math.abs(pv - anchorV);

        if (aspect) {
            const dw = du * d.width;
            const dh = dv * d.height;
            if (dw / Math.max(dh, 1e-9) > aspect) dv = (du * d.width) / (aspect * d.height);
            else du = (dv * aspect * d.height) / d.width;
        }

        const maxDU = pu > anchorU ? 1 - anchorU : anchorU;
        const maxDV = pv > anchorV ? 1 - anchorV : anchorV;
        const minDU = MIN_FRACTION;
        const minDV = MIN_FRACTION;
        let k = 1;
        if (du > maxDU) k = Math.min(k, maxDU / du);
        if (dv > maxDV) k = Math.min(k, maxDV / dv);
        du *= k;
        dv *= k;
        if (du < minDU) {
            du = minDU;
            if (aspect) dv = (du * d.width) / (aspect * d.height);
        }
        if (dv < minDV) {
            dv = minDV;
            if (aspect) du = (dv * aspect * d.height) / d.width;
        }

        const u = pu > anchorU ? anchorU : anchorU - du;
        const v = pv > anchorV ? anchorV : anchorV - dv;
        draft.u = u;
        draft.v = v;
        draft.w = du;
        draft.h = dv;
        clampDraft();
    }

    function onKeyDown(event) {
        const snap = snapshot();
        const d = dims(snap);
        if (!d) return;
        const step = (event.shiftKey ? 10 : 1);
        const du = step / d.width;
        const dv = step / d.height;
        let handled = true;
        if (event.key === 'ArrowLeft') draft.u -= du;
        else if (event.key === 'ArrowRight') draft.u += du;
        else if (event.key === 'ArrowUp') draft.v -= dv;
        else if (event.key === 'ArrowDown') draft.v += dv;
        else if (event.key === 'Escape') cancel();
        // Task 04 (§23): the aria-label promises "Enter applies" — make it true.
        else if (event.key === 'Enter') apply();
        else handled = false;
        if (handled) {
            event.preventDefault();
            clampDraft();
            refreshBox();
        }
    }

    function refreshBox() {
        if (!box || !overlay) return;
        const snap = snapshot();
        const rect = imageRect(snap);
        if (!rect || !snap.originalImage) {
            overlay.hidden = true;
            return;
        }
        overlay.hidden = false;
        box.style.left = `${rect.x + draft.u * rect.w}px`;
        box.style.top = `${rect.y + draft.v * rect.h}px`;
        box.style.width = `${Math.max(2, draft.w * rect.w)}px`;
        box.style.height = `${Math.max(2, draft.h * rect.h)}px`;
    }

    function refresh() {
        if (!active) return;
        const snap = snapshot();
        // A new image arrived while the overlay was open (e.g. reopened file):
        // the old draft belongs to the old photo — restart at full frame.
        if (snap.originalImage !== lastImage) {
            lastImage = snap.originalImage;
            draft = { u: 0, v: 0, w: 1, h: 1 };
        }
        refreshBox();
    }

    function apply() {
        const snap = snapshot();
        if (!snap.originalImage) return false;
        const rect = selectionToCrop(draft.u, draft.v, draft.w, draft.h, snap.composition);
        if (rect.width <= 0 || rect.height <= 0) return false;
        state.setCrop(rect.x, rect.y, rect.width, rect.height);
        draft = { u: 0, v: 0, w: 1, h: 1 };
        refreshBox();
        const after = snapshot();
        const d = composedDimensions(after.imageWidth, after.imageHeight, after.composition);
        state.setStatus(`Crop applied — ${d.width} × ${d.height}`);
        return true;
    }

    function cancel() {
        draft = { u: 0, v: 0, w: 1, h: 1 };
        refreshBox();
        state.setStatus('Crop cancelled — nothing was changed.');
    }

    function setAspect(label) {
        const snap = snapshot();
        aspectLabel = label;
        if (label === 'Free') aspect = null;
        else if (label === 'Original') aspect = snap.originalImage ? snap.imageWidth / snap.imageHeight : null;
        else if (label === '1:1') aspect = 1;
        else if (label === '4:5') aspect = 4 / 5;
        else if (label === '3:4') aspect = 3 / 4;
        else if (label === '16:9') aspect = 16 / 9;
        if (aspect) applyAspectToDraft();
        clampDraft();
        refreshBox();
    }

    return {
        isActive: () => active,
        aspectLabel: () => aspectLabel,

        setActive(next) {
            if (next === active) return;
            active = next;
            if (next) {
                const snap = snapshot();
                if (!snap.originalImage) {
                    active = false;
                    return;
                }
                // Draft starts as the full current image (re-crop of what you see).
                draft = { u: 0, v: 0, w: 1, h: 1 };
                aspect = null;
                aspectLabel = 'Free';
                ensureOverlay();
                refreshBox();
                // Task 04 (§19/§23): the box explains its keyboard flow in its
                // aria-label — put focus there so the flow is actually usable.
                if (box) box.focus({ preventScroll: true });
            } else {
                // Task 04 (§23): abandoning an unapplied selection must not be
                // silent. apply()/cancel() reset the draft first, so a modified
                // draft here means the user is leaving with pending work.
                if (draft.u !== 0 || draft.v !== 0 || draft.w !== 1 || draft.h !== 1) {
                    state.setStatus('Crop discarded — nothing was applied.');
                }
                destroyOverlay();
            }
        },

        refresh,
        apply,
        cancel,
        setAspect,
    };
}
