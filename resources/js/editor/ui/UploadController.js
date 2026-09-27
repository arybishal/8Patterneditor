import { showBusy, hideBusy } from './busy.js';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 60_000_000;

export function createUploadController({ state, pipeline, zoom, refs }) {
    const { input, workspace } = refs;
    let opening = false;

    function fail(message) {
        state.setStatus(message, 'error');
    }

    async function handleFile(file) {
        workspace.classList.remove('is-dragover');
        if (!file || opening) return;

        if (!file.size) {
            fail('That file is empty.');
            return;
        }

        const typeOk = ACCEPTED_TYPES.includes(file.type)
            || (!file.type && ACCEPTED_EXTENSIONS.test(file.name));
        if (!typeOk) {
            fail('Unsupported file type. Please choose a JPG, PNG or WebP image.');
            return;
        }

        if (file.size > MAX_BYTES) {
            fail('That image is too large. The maximum is 40 MB.');
            return;
        }

        opening = true;
        // Small files decode instantly — only show the pill if it lingers.
        showBusy('Processing…', 60);
        try {
            let bitmap;
            try {
                bitmap = await createImageBitmap(file);
            } catch (error) {
                console.warn('Image decoding failed:', error);
                fail("We couldn't read that image. It may be corrupted.");
                return;
            }

            if (!bitmap.width || !bitmap.height) {
                bitmap.close?.();
                fail("We couldn't read that image. It may be corrupted.");
                return;
            }

            if (bitmap.width * bitmap.height > MAX_PIXELS) {
                bitmap.close?.();
                fail('That image has extremely large dimensions. The maximum is 60 megapixels.');
                return;
            }

            pipeline.setSource(bitmap);
            state.loadImage(bitmap, {
                width: bitmap.width,
                height: bitmap.height,
                fileName: file.name,
            });
            zoom.fit();
            state.setStatus(`${file.name} — ${bitmap.width} × ${bitmap.height} · edited locally, never uploaded`);
        } finally {
            hideBusy();
            opening = false;
        }
    }

    function openPicker() {
        input.value = '';
        input.click();
    }

    input.addEventListener('change', () => handleFile(input.files?.[0]));

    workspace.addEventListener('dragover', (event) => {
        event.preventDefault();
        workspace.classList.add('is-dragover');
    });
    workspace.addEventListener('dragleave', (event) => {
        if (event.target === workspace || !workspace.contains(event.relatedTarget)) {
            workspace.classList.remove('is-dragover');
        }
    });
    workspace.addEventListener('drop', (event) => {
        event.preventDefault();
        handleFile(event.dataTransfer?.files?.[0]);
    });

    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    return { handleFile, openPicker };
}
