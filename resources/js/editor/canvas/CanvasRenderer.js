import { composedDimensions } from '../composition/CompositionRenderer.js';
import { drawText } from '../text/TextRenderer.js';

export function createCanvasRenderer({ canvas, workspace, state, pipeline, onError }) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        onError?.(new Error('Canvas 2D context is unavailable.'));
    }

    let cssWidth = 0;
    let cssHeight = 0;
    let dpr = 1;
    let frame = 0;
    let observer = null;

    const resizeListeners = new Set();

    function measure() {
        const width = workspace.clientWidth;
        const height = workspace.clientHeight;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        if (width === cssWidth && height === cssHeight && ratio === dpr) return false;

        cssWidth = width;
        cssHeight = height;
        dpr = ratio;
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        return true;
    }

    function render() {
        if (!ctx) return;

        try {
            const snapshot = state.get();

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssWidth, cssHeight);

            if (!snapshot.originalImage) return;

            const processed = pipeline.getProcessedImage(snapshot);
            if (!processed) return;

            // Display in COMPOSED dimensions (crop/rotate/resize applied by
            // the pipeline; the processed canvas may be preview-downscaled but
            // is always drawn at composed size × zoom, matching file-dims).
            const composed = composedDimensions(
                snapshot.imageWidth, snapshot.imageHeight, snapshot.composition,
            );
            const width = composed.width * snapshot.zoom;
            const height = composed.height * snapshot.zoom;

            ctx.save();
            ctx.translate(cssWidth / 2, cssHeight / 2);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(processed, -width / 2, -height / 2, width, height);
            // Text drawn AFTER the photographic pipeline — preview shares the
            // exact draw path with export (scaled by display zoom).
            drawText(
                ctx,
                snapshot.textLayers,
                { x: -width / 2, y: -height / 2, w: width, h: height },
                composed.width,
            );
            ctx.restore();
        } catch (error) {
            console.error(error);
            onError?.(error);
        }
    }

    function requestRender() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            render();
        });
    }

    function resize() {
        if (measure()) {
            requestRender();
            resizeListeners.forEach((fn) => fn());
        }
    }

    return {
        observe() {
            observer = new ResizeObserver(resize);
            observer.observe(workspace);
            window.addEventListener('resize', resize);
            resize();
        },

        onResize(fn) {
            resizeListeners.add(fn);
        },

        requestRender,

        getFitZoom() {
            const snapshot = state.get();
            if (!snapshot.originalImage || !cssWidth || !cssHeight) return null;
            const composed = composedDimensions(
                snapshot.imageWidth, snapshot.imageHeight, snapshot.composition,
            );
            return Math.min(cssWidth / composed.width, cssHeight / composed.height);
        },
    };
}
