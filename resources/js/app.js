import { createEditorState } from './editor/state/EditorState.js';
import { registerFamilies } from './editor/text/TextState.js';
import { createAdjustmentPipeline } from './editor/pipeline/AdjustmentPipeline.js';
import { createCanvasRenderer } from './editor/canvas/CanvasRenderer.js';
import { createZoomController } from './editor/ui/ZoomController.js';
import { createUploadController } from './editor/ui/UploadController.js';
import { createEditorUI } from './editor/ui/EditorUI.js';
import { createExporter } from './editor/export/exporter.js';
import { createFontManager } from './editor/fonts/FontManager.js';
import { createHistoryManager } from './editor/history/HistoryManager.js';
import { createMaskRenderer } from './editor/masking/MaskRenderer.js';
import { createProjectController } from './editor/project/ProjectController.js';

function byId(id) {
    return document.getElementById(id);
}

function boot() {
    const refs = {
        app: byId('app'),
        workspace: byId('workspace'),
        canvas: byId('editor-canvas'),
        empty: byId('empty-state'),
        input: byId('file-input'),
        toolrail: byId('toolrail'),
        panel: byId('panel'),
        status: byId('status'),
        fileMeta: byId('file-meta'),
        fileName: byId('file-name'),
        fileDims: byId('file-dims'),
        openButton: byId('btn-open'),
        resetButton: byId('btn-reset'),
        undoButton: byId('btn-undo'),
        redoButton: byId('btn-redo'),
        panelButton: byId('btn-panel'),
        exportButton: byId('btn-export'),
        uploadButton: byId('btn-upload'),
        zoomValue: byId('zoom-value'),
        zoomOut: byId('zoom-out'),
        zoomIn: byId('zoom-in'),
        zoomFit: byId('zoom-fit'),
    };

    if (!refs.canvas || !refs.workspace) return;

    const state = createEditorState();
    // Debug handle for the automated test suites — read via .get() only.
    window.__editorState = state;
    // Step 11: one mask renderer shared by the pipeline (selective blend) and
    // the overlay (tint) — preview, overlay and export agree by construction.
    const maskRenderer = createMaskRenderer();
    const pipeline = createAdjustmentPipeline(maskRenderer);

    const renderer = createCanvasRenderer({
        canvas: refs.canvas,
        workspace: refs.workspace,
        state,
        pipeline,
        onError: () => state.setStatus('The canvas hit a rendering problem. Try a smaller image.', 'error'),
    });

    const zoom = createZoomController({
        state,
        renderer,
        elements: { value: refs.zoomValue, out: refs.zoomOut, zoomIn: refs.zoomIn, fit: refs.zoomFit },
    });

    const upload = createUploadController({ state, pipeline, zoom, refs });

    // Local font catalog: manifest + lazy FontFace loading, no runtime
    // requests to Google (§15).
    const fonts = createFontManager();
    fonts.onChange(() => renderer.requestRender());

    const exporter = createExporter({ state, pipeline, fonts });

    // Step 10: non-destructive undo/redo over serializable state only.
    const history = createHistoryManager({
        state,
        onRestore: (snapshot) => {
            // Restored text may reference fonts that were never loaded.
            fonts.ensureLayers(snapshot.textLayers);
        },
    });
    // Debug handle for the automated test suites — same contract as
    // window.__editorState.
    window.__history = history;

    // Step 13: project files, session recovery and debounced autosave —
    // state only, never the image (§13.1–13.7).
    const project = createProjectController({ state, history, fonts });
    window.__project = project;
    project.attachAutosave();

    const ui = createEditorUI({
        state,
        refs,
        exporter,
        fonts,
        history,
        maskRenderer,
        project,
        onOpen: upload.openPicker,
        onReset: () => {
            // One labeled entry for the whole reset (§35), no matter how many
            // state notifications it fires.
            history.begin('Reset');
            state.resetAdjustments();
            history.commit();
            zoom.fit();
            // Task 04 (§16): say what the button actually clears — it resets
            // edits of every kind, not just the adjustment sliders.
            state.setStatus('Reset — every edit is back to its default; your photo stays open.');
        },
    });
    // Step 11: brush settings handle (UI state — never part of history).
    window.__mask = ui.mask;

    fonts.init().then(() => {
        registerFamilies(fonts.families());
        ui.refreshFonts();
    });

    refs.uploadButton.addEventListener('click', upload.openPicker);

    // Step 13 (§13.4): a project imported before an image was open applies
    // the moment the user supplies one — in the same load notification.
    let hadImage = Boolean(state.get().originalImage);
    state.subscribe((snapshot) => {
        ui.sync(snapshot);
        zoom.sync(snapshot);
        renderer.requestRender();
        const hasImage = Boolean(snapshot.originalImage);
        const becameReady = hasImage && !hadImage;
        hadImage = hasImage;
        if (becameReady) project.onImageReady();
    });

    // Step 13 (§13.7): offer recovery only when a session actually exists.
    const recovery = byId('recovery');
    if (recovery && project.hasSession()) recovery.hidden = false;
    const restoreButton = byId('btn-restore-session');
    const freshButton = byId('btn-start-fresh');
    if (restoreButton) {
        restoreButton.addEventListener('click', () => {
            project.restoreSession();
            if (recovery) recovery.hidden = true;
        });
    }
    if (freshButton) {
        freshButton.addEventListener('click', () => {
            project.startFresh();
            if (recovery) recovery.hidden = true;
        });
    }

    renderer.observe();
    ui.sync(state.get());
    zoom.sync(state.get());
    renderer.requestRender();
}

boot();
