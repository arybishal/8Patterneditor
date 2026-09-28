import { releaseScratch } from '../pipeline/operations.js';
import { composedDimensions } from '../composition/CompositionRenderer.js';
import { drawText } from '../text/TextRenderer.js';
import { showBusy, hideBusy } from '../ui/busy.js';

export const EXPORT_FORMATS = Object.freeze([
    { id: 'jpg', mime: 'image/jpeg', ext: 'jpg', quality: true },
    { id: 'png', mime: 'image/png', ext: 'png', quality: false },
    { id: 'webp', mime: 'image/webp', ext: 'webp', quality: true },
]);

const DEFAULT_QUALITY = 90;

// Filesystem-safe export name: "IMG_2026_001.jpg" → "IMG_2026_001-edited.jpg";
// falls back to "cinematic-photo-edited.<ext>" when nothing usable remains.
export function exportFileName(originalName, ext) {
    const base = String(originalName || '')
        .replace(/\.[^.]+$/, '')
        .replace(/[\\/:*?"<>|]+/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 80)
        .trim();
    return base ? `${base}-edited.${ext}` : `cinematic-photo-edited.${ext}`;
}

// Double rAF: resolves only after the frame that paints the pending status
// message, so progress text is visible before heavy synchronous work starts.
function painted() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

function encode(canvas, format, quality) {
    return new Promise((resolve, reject) => {
        let called = false;
        const done = (fn, arg) => {
            if (called) return;
            called = true;
            fn(arg);
        };
        try {
            canvas.toBlob(
                (blob) => (blob && blob.size ? done(resolve, blob) : done(reject, new Error('encode failed'))),
                format.mime,
                format.quality ? quality / 100 : undefined,
            );
        } catch (error) {
            done(reject, error);
        }
    });
}

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createExporter({ state, pipeline, fonts }) {
    let busy = false;

    async function run(formatId, quality) {
        if (busy) return;

        const format = EXPORT_FORMATS.find((f) => f.id === formatId) || EXPORT_FORMATS[0];
        const snapshot = state.get();

        if (!snapshot.originalImage) {
            state.setStatus('Open a photo before exporting.', 'error');
            return;
        }

        busy = true;
        state.set({ exporting: true });
        state.setStatus('Preparing export…');
        showBusy('Exporting…');
        await painted();

        let canvas = null;
        try {
            state.setStatus('Rendering full resolution…');
            await painted();
            canvas = pipeline.renderFull(
                snapshot.originalImage, snapshot.composition,
                snapshot.adjustments, snapshot.effects, snapshot.colorGrade,
                format.mime, snapshot.mask,
            );

            // Export draws text with the same faces as the preview: wait for
            // any pending local font so the full-res output is never measured
            // against a fallback (§15). A failed load falls back silently.
            await fonts.ensureLayers(snapshot.textLayers);

            // Text renders AFTER the pipeline, at full export resolution
            // (scale = canvas / composed = 1), then encodes — the pipeline
            // file itself is never touched by text (§10).
            const out = composedDimensions(
                snapshot.imageWidth, snapshot.imageHeight, snapshot.composition,
            );
            drawText(
                canvas.getContext('2d'),
                snapshot.textLayers,
                { x: 0, y: 0, w: canvas.width, h: canvas.height },
                out.width,
            );

            state.setStatus('Preparing download…');
            await painted();
            const blob = await encode(canvas, format, quality);

            download(blob, exportFileName(snapshot.fileName, format.ext));
            state.setStatus(
                `Export complete — ${format.ext.toUpperCase()} ${out.width} × ${out.height}`,
                'success',
            );
        } catch (error) {
            console.warn('Export failed:', error);
            const encodeFailed = error && error.message === 'encode failed';
            state.setStatus(
                encodeFailed
                    ? `Couldn't create the ${format.ext.toUpperCase()} file. Try a different format or a smaller image.`
                    : 'Unable to export this image at full resolution. Try a smaller image or a different format.',
                'error',
            );
        } finally {
            canvas = null;
            releaseScratch();
            hideBusy();
            busy = false;
            state.set({ exporting: false });
        }
    }

    return {
        run,
        isBusy: () => busy,
        defaultQuality: DEFAULT_QUALITY,
    };
}
