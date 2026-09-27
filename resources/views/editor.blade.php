<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>8Pattern Editor | Version 1.0 Beta</title>
    <meta name="description" content="8Pattern Editor is a free browser-based photo editor for cinematic, film, vintage, and creative image editing.">
    <meta name="theme-color" content="#0b0b0d">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="alternate icon" href="/favicon.ico" sizes="32x32">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    @vite(['resources/css/app.css', 'resources/css/editor.css', 'resources/js/app.js'])
</head>
<body>
<div class="app" id="app">

    <header class="topbar">
        <div class="brand">
            <span class="brand__mark" aria-hidden="true"></span>
            <span class="brand__name">8Pattern Editor</span>
        </div>

        <div class="topbar__file" id="file-meta" hidden>
            <span id="file-name"></span>
            <span class="topbar__dims" id="file-dims"></span>
        </div>

        <div class="topbar__actions">
            <button type="button" class="btn topbar__hist" id="btn-undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled><span class="topbar__hist-icon" aria-hidden="true">↶</span><span class="topbar__hist-label">Undo</span></button>
            <button type="button" class="btn topbar__hist" id="btn-redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled><span class="topbar__hist-icon" aria-hidden="true">↷</span><span class="topbar__hist-label">Redo</span></button>
            <button type="button" class="btn btn--ghost" id="btn-open">Open photo</button>
            <button type="button" class="btn btn--ghost" id="btn-reset">Reset</button>
            <button type="button" class="btn btn--ghost panel-toggle" id="btn-panel">Panel</button>
        </div>
    </header>

    <div class="shell">
        <nav class="toolrail" id="toolrail" aria-label="Tools">
            <button type="button" class="tool is-active" data-tool="adjust">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>
                <span class="tool__label">Adjust</span>
            </button>
            <button type="button" class="tool" data-tool="film">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/></svg>
                <span class="tool__label">Film</span>
            </button>
            <button type="button" class="tool" data-tool="effects">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.9L19 9.7l-4.6 2.6L13.6 18 12 14.9 10.4 18l-.8-5.7L5 9.7l5.2-1.8z"/><path d="M18.5 15.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7z"/></svg>
                <span class="tool__label">Effects</span>
            </button>
            <button type="button" class="tool" data-tool="mask">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3.5l6 6L9 21H3v-6z"/><path d="M11.5 6.5l6 6"/></svg>
                <span class="tool__label">Mask</span>
            </button>
            <button type="button" class="tool" data-tool="crop">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/></svg>
                <span class="tool__label">Crop</span>
            </button>
            <button type="button" class="tool" data-tool="rotate">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>
                <span class="tool__label">Rotate</span>
            </button>
            <button type="button" class="tool" data-tool="text">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M12 6v13M9 19h6"/></svg>
                <span class="tool__label">Text</span>
            </button>
            <button type="button" class="tool" data-tool="export">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11M8 10.5l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                <span class="tool__label">Export</span>
            </button>
        </nav>

        <main class="workspace" id="workspace">
            <canvas id="editor-canvas"></canvas>

            <div class="empty" id="empty-state">
                <div class="empty__drop">
                    <svg class="empty__icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4 17l4.5-4.5 3 3L15 11l5 5"/></svg>
                    <p class="empty__title">8Pattern Editor</p>
                    <p class="empty__sub">Create your cinematic look directly in your browser.</p>
                    <button type="button" class="btn btn--primary" id="btn-upload">Upload Image</button>
                    <p class="empty__hint">JPG, PNG, WebP</p>
                    <p class="empty__privacy">Your image stays in your browser while you edit.</p>
                </div>

                <!-- Step 13 (§13.7): recovery offer lives outside the drop zone
                     so the empty-state geometry stays untouched. Hidden until
                     a saved session is detected. -->
                <div class="recovery" id="recovery" hidden>
                    <p class="recovery__text">Pick up where you left off.</p>
                    <div class="recovery__actions">
                        <button type="button" class="btn btn--primary" id="btn-restore-session">Restore previous session</button>
                        <button type="button" class="btn" id="btn-start-fresh">Start fresh</button>
                    </div>
                </div>
            </div>

            <div class="busy" id="busy" hidden role="status" aria-live="polite">
                <span class="busy__label" id="busy-text">Processing&hellip;</span>
            </div>

            <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" aria-label="Choose an image to edit" hidden>
        </main>

        <aside class="panel" id="panel" aria-label="Tool options"></aside>
    </div>

    <footer class="statusbar">
        <div class="statusbar__status" id="status" role="status" aria-live="polite">Ready &mdash; open a photo to start editing.</div>

        <div class="zoom" id="zoom-controls">
            <button type="button" class="zoom__btn" id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
            <span class="zoom__value" id="zoom-value">100%</span>
            <button type="button" class="zoom__btn" id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
            <button type="button" class="zoom__btn zoom__btn--wide" id="zoom-fit" title="Fit to screen">Fit</button>
        </div>
    </footer>

    {{-- Branding footer — page chrome only, outside the canvas, never exported. --}}
    <footer class="appfoot">
        <span class="appfoot__name">8Pattern Editor</span>
        <span class="appfoot__motto" aria-label="Proudly built with love &#9829; in Nepal">
            <span>Proudly built with love</span>
            <svg class="appfoot__heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5S3.5 15 2 9.8C.9 6.2 3.2 3.5 6.4 3.5c2.2 0 3.9 1.4 4.7 3 .8-1.6 2.5-3 4.7-3 3.2 0 5.5 2.7 4.4 6.3-1.5 5.2-10.2 10.7-10.2 10.7z"/></svg>
            <span>in Nepal</span>
        </span>
        <span class="appfoot__ver">Version 1.0 Beta</span>
    </footer>

</div>
</body>
</html>
