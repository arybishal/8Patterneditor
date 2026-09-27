import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from '../state/EditorState.js';

// Manual zoom stays within 25%–400%, but fit-to-screen may dip below the manual
// floor so a huge photo still fits the workspace. Upgrade path: panning at <25%.
const FIT_MIN = 0.05;

export function createZoomController({ state, renderer, elements }) {
    const { value, out, zoomIn, fit } = elements;
    let followFit = true;

    function apply(z, fitMode) {
        followFit = fitMode;
        const current = state.get().zoom;
        const lower = fitMode ? FIT_MIN : Math.min(ZOOM_MIN, current);
        const next = Math.min(ZOOM_MAX, Math.max(lower, z));
        if (next !== current) {
            state.set({ zoom: next });
        }
    }

    function setZoom(z) {
        apply(z, false);
    }

    function fitToScreen() {
        const zoom = renderer.getFitZoom();
        if (zoom != null) apply(zoom, true);
    }

    out.addEventListener('click', () => setZoom(state.get().zoom - ZOOM_STEP));
    zoomIn.addEventListener('click', () => setZoom(state.get().zoom + ZOOM_STEP));
    fit.addEventListener('click', fitToScreen);

    renderer.onResize(() => {
        if (followFit) fitToScreen();
    });

    return {
        fit: fitToScreen,
        setZoom,
        sync(snapshot) {
            value.textContent = `${Math.round(snapshot.zoom * 100)}%`;
        },
    };
}
