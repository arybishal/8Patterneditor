// Step 11: mask interaction — a tint overlay in the workspace (same
// display-rect math as the crop overlay, so painting stays aligned with the
// image at any zoom, 25%–400%). Points are stored in normalized ORIGINAL
// coordinates at paint time; rendering maps them back through
// composition, so crop/rotate/resize never move a stroke off its pixels (§11.2).
//
// One gesture = one history transaction: pointerdown begins 'Paint Mask' or
// 'Erase Mask', pointerup commits — a continuous stroke can never flood the
// 50-entry history (§11.6).

import { baseDimensions, composedDimensions, composedToOriginal, displayRect } from '../composition/CompositionRenderer.js';
import { DEFAULT_BRUSH, makeStroke } from './MaskState.js';

// Tint for the overlay (accent gold, readable on dark and light images).
const TINT = 'rgba(245, 158, 11, 0.45)';
// Ignore pointer jitter below a quarter source pixel — an accidental hold
// still paints one dab, but a stationary drag does not grow the stroke.
const MOVE_EPS = 0.25;

export function createMaskController({ state, workspace, history, maskRenderer }) {
    let active = false;
    let overlay = null;
    let tint = null;
    let cursor = null;
    let observer = null;
    let painting = null; // current stroke object (mutated as points arrive)
    let started = false; // transaction opened for the gesture
    let lastPointer = null;

    // Brush settings are UI state, not editor state: they never enter history.
    const brush = { mode: 'brush', ...DEFAULT_BRUSH };

    // size is a DIAMETER percent of min(sourceW, sourceH) → renderer radius
    // fraction. History-independent, zoom-independent, resolution-independent.
    function radiusNorm() {
        return (brush.size / 100) * 0.5;
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

    // Pointer (client px) → normalized original-source coordinates.
    function toOriginal(clientX, clientY, rect) {
        const ws = workspace.getBoundingClientRect();
        const u = (clientX - ws.left - rect.x) / rect.w;
        const v = (clientY - ws.top - rect.y) / rect.h;
        const snap = state.get();
        return composedToOriginal(u, v, snap.composition);
    }

    function ensureOverlay() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'mask-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        tint = document.createElement('canvas');
        tint.className = 'mask-overlay__tint';
        cursor = document.createElement('span');
        cursor.className = 'mask-overlay__cursor';
        cursor.hidden = true;

        overlay.append(tint, cursor);
        workspace.append(overlay);
        overlay.addEventListener('pointerdown', onPointerDown);
        overlay.addEventListener('pointermove', onHover);

        observer = new ResizeObserver(() => refresh());
        observer.observe(workspace);
    }

    function destroyOverlay() {
        if (!overlay) return;
        observer?.disconnect();
        observer = null;
        overlay.remove();
        overlay = null;
        tint = null;
        cursor = null;
        painting = null;
        started = false;
        lastPointer = null;
    }

    function onPointerDown(event) {
        const snap = state.get();
        if (!snap.originalImage || !snap.mask || event.button !== 0) return;
        const rect = imageRect(snap);
        if (!rect) return;
        event.preventDefault();

        const point = toOriginal(event.clientX, event.clientY, rect);
        const erase = brush.mode === 'erase';
        const stroke = makeStroke(point.x, point.y, {
            r: radiusNorm(),
            hardness: brush.hardness / 100,
            opacity: brush.opacity / 100,
            erase,
        });
        // Buffered until commit: the whole gesture becomes one entry.
        started = history.begin(erase ? 'Erase Mask' : 'Paint Mask');
        const mask = state.get().mask;
        state.updateMask({ ...mask, strokes: [...mask.strokes, stroke] });
        painting = stroke;
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
        window.addEventListener('blur', onPointerUp, { once: true });
    }

    // Window-level move: owns the active stroke (survives leaving the image).
    function onPointerMove(event) {
        if (!painting) return;
        const snap = state.get();
        const rect = imageRect(snap);
        if (!rect) return;
        const point = toOriginal(event.clientX, event.clientY, rect);
        const pts = painting.pts;
        const dx = point.x - pts[pts.length - 2];
        const dy = point.y - pts[pts.length - 1];
        if (Math.abs(dx) < MOVE_EPS / Math.max(1, snap.imageWidth)
            && Math.abs(dy) < MOVE_EPS / Math.max(1, snap.imageHeight)) return;
        pts.push(point.x, point.y);
        state.updateMask({ ...snap.mask });
    }

    // Overlay-level move: brush cursor feedback while not painting.
    function onHover(event) {
        if (painting || !active || !state.get().mask) return;
        lastPointer = { x: event.clientX, y: event.clientY };
        refreshCursor();
    }

    function onPointerUp() {
        window.removeEventListener('pointermove', onPointerMove);
        if (painting) {
            painting = null;
            if (started) history.commit();
            started = false;
        }
    }

    // Brush circle follows the pointer in display space — same geometry math
    // as the renderer (source px → composed px), so what you see is painted.
    function refreshCursor() {
        if (!cursor || !tint) return;
        const snap = state.get();
        const rect = imageRect(snap);
        if (!rect || !lastPointer || !snap.mask) {
            if (cursor) cursor.hidden = true;
            return;
        }
        const ws = workspace.getBoundingClientRect();
        const localX = lastPointer.x - ws.left;
        const localY = lastPointer.y - ws.top;
        const inside = localX >= rect.x && localY >= rect.y
            && localX <= rect.x + rect.w && localY <= rect.y + rect.h;
        cursor.hidden = !inside;
        if (!inside) return;
        const base = baseDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
        const sx = rect.w / Math.max(1, base.width);
        const sy = rect.h / Math.max(1, base.height);
        const rx = radiusNorm() * Math.min(snap.imageWidth, snap.imageHeight) * sx;
        const ry = radiusNorm() * Math.min(snap.imageWidth, snap.imageHeight) * sy;
        cursor.style.width = `${rx * 2}px`;
        cursor.style.height = `${ry * 2}px`;
        cursor.style.left = `${localX - rect.x}px`;
        cursor.style.top = `${localY - rect.y}px`;
    }

    // Position + tint the overlay; called from UI sync on every state change.
    function refresh() {
        if (!overlay || !tint) return;
        const snap = state.get();
        const rect = imageRect(snap);
        if (!active || !rect || !snap.originalImage) {
            overlay.hidden = true;
            return;
        }
        overlay.hidden = false;
        overlay.style.left = `${rect.x}px`;
        overlay.style.top = `${rect.y}px`;
        overlay.style.width = `${rect.w}px`;
        overlay.style.height = `${rect.h}px`;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(rect.w * dpr));
        const h = Math.max(1, Math.round(rect.h * dpr));
        if (tint.width !== w || tint.height !== h) {
            tint.width = w;
            tint.height = h;
        }
        const ctx = tint.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        if (snap.mask && snap.maskVisible) {
            // Same composed mask the pipeline blends with — overlay and effect
            // can never disagree about where the mask is.
            const mask = maskRenderer.render(
                snap.mask, snap.imageWidth, snap.imageHeight, snap.composition, w, h,
            );
            if (mask) {
                ctx.drawImage(mask, 0, 0);
                ctx.globalCompositeOperation = 'source-in';
                ctx.fillStyle = TINT;
                ctx.fillRect(0, 0, w, h);
                ctx.globalCompositeOperation = 'source-over';
            }
        }
        refreshCursor();
    }

    return {
        isActive: () => active,

        setActive(next) {
            if (next === active) return;
            active = next;
            if (next) {
                if (!state.get().originalImage) {
                    active = false;
                    return;
                }
                ensureOverlay();
                refresh();
            } else {
                onPointerUp();
                destroyOverlay();
            }
        },

        refresh,

        // --- panel-facing controls (UI-only, never historic by themselves) ---
        setMode(mode) {
            brush.mode = mode === 'erase' ? 'erase' : 'brush';
        },
        setBrush(patch) {
            if ('size' in patch) brush.size = Math.min(100, Math.max(1, Number(patch.size) || DEFAULT_BRUSH.size));
            if ('hardness' in patch) brush.hardness = Math.min(100, Math.max(0, Number(patch.hardness) || 0));
            if ('opacity' in patch) brush.opacity = Math.min(100, Math.max(1, Number(patch.opacity) || DEFAULT_BRUSH.opacity));
        },
        getBrush: () => ({ ...brush, radius: radiusNorm() }),
    };
}
