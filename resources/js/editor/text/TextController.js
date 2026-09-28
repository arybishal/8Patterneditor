// Text tool controller — owns the Text panel AND the selection overlay
// (hit-testing, dragging). EditorUI only wires lifecycle (build/sync/setActive),
// keeping text-specific logic out of the shared UI module (§1).

import { FONT_SIZE_MIN, FONT_SIZE_MAX } from './TextState.js';
import { measureLayer, hitTest } from './TextRenderer.js';
import { composedDimensions, displayRect } from '../composition/CompositionRenderer.js';
import { FONT_CATEGORIES, WEIGHT_CHOICES } from '../fonts/fontConfig.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function createTextController({ state, workspace, panel, fonts }) {
    let active = false;
    let overlay = null;
    let selBox = null;
    let observer = null;
    let drag = null;
    let lastAdd = 0;

    const views = {};
    let cursor = 0;
    let previewObserver = null;
    let knownCount = -1;

    // --- Font picker -------------------------------------------------------

    function comboKey(weight, style) {
        return `${weight}:${style}`;
    }

    function weightChoices(family) {
        const entry = fonts.find(family);
        const variants = entry ? entry.variants : null;
        if (!variants) return WEIGHT_CHOICES.filter((c) => c.weight !== 500 && c.weight !== 600);
        return WEIGHT_CHOICES.filter((c) => variants.some(
            (v) => v.weight === c.weight && v.style === c.style,
        ));
    }

    function buildWeightOptions(family) {
        views.weight.replaceChildren();
        for (const choice of weightChoices(family)) {
            const option = document.createElement('option');
            option.value = comboKey(choice.weight, choice.style);
            option.textContent = choice.label;
            views.weight.append(option);
        }
        views.weight.dataset.family = family;
    }

    function options() {
        return views.list ? [...views.list.querySelectorAll('[role="option"]')] : [];
    }

    function markCursor() {
        const opts = options();
        opts.forEach((opt, i) => opt.classList.toggle('is-cursor', i === cursor));
        const active = opts[cursor];
        if (active) {
            views.search.setAttribute('aria-activedescendant', active.id);
            active.scrollIntoView({ block: 'nearest' });
        } else {
            views.search.removeAttribute('aria-activedescendant');
        }
    }

    function renderList() {
        const results = fonts.search(views.search.value, views.category.value);
        views.list.replaceChildren();
        if (previewObserver) previewObserver.disconnect();
        // Lazy preview loading: only options actually scrolled into view get
        // their font file loaded — never the whole catalog (§15).
        previewObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                previewObserver.unobserve(entry.target);
                const family = entry.target.dataset.family;
                if (fonts.find(family)?.local) fonts.ensure(family, 400, 'normal');
            }
        });
        if (!results.length) {
            const empty = el('div', 'font-empty', 'No fonts found.');
            empty.id = 'font-empty';
            views.list.append(empty);
            views.search.removeAttribute('aria-activedescendant');
            return;
        }
        const layer = selectedLayer(snapshot());
        results.forEach((entry, index) => {
            const opt = el('div', 'font-opt');
            opt.setAttribute('role', 'option');
            opt.id = `font-opt-${index}`;
            opt.dataset.family = entry.label;
            if (layer && layer.fontFamily === entry.label) opt.classList.add('is-selected');
            const name = el('span', 'font-opt__name', entry.label);
            const sample = el('span', 'font-opt__preview', 'Ag');
            sample.style.fontFamily = `'${entry.label}', Arial, sans-serif`;
            opt.append(name, sample);
            opt.addEventListener('click', () => commitFamily(entry.label));
            views.list.append(opt);
            previewObserver.observe(opt);
        });
        cursor = 0;
        markCursor();
    }

    function openMenu() {
        views.menu.hidden = false;
        views.trigger.setAttribute('aria-expanded', 'true');
        views.search.value = '';
        views.category.value = 'all';
        renderList();
        views.search.focus();
        document.addEventListener('pointerdown', onOutsidePointer, true);
    }

    function closeMenu() {
        if (!views.menu || views.menu.hidden) return;
        views.menu.hidden = true;
        views.trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutsidePointer, true);
    }

    function onOutsidePointer(event) {
        if (views.picker && !views.picker.contains(event.target)) closeMenu();
    }

    function onListKeydown(event) {
        const opts = options();
        if (event.key === 'ArrowDown' && opts.length) {
            event.preventDefault();
            cursor = (cursor + 1) % opts.length;
            markCursor();
        } else if (event.key === 'ArrowUp' && opts.length) {
            event.preventDefault();
            cursor = (cursor - 1 + opts.length) % opts.length;
            markCursor();
        } else if (event.key === 'Home' && opts.length) {
            event.preventDefault();
            cursor = 0;
            markCursor();
        } else if (event.key === 'End' && opts.length) {
            event.preventDefault();
            cursor = opts.length - 1;
            markCursor();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const active = opts[cursor];
            if (active) commitFamily(active.dataset.family);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
            views.trigger.focus();
        }
    }

    function commitFamily(family) {
        const layer = selectedLayer(snapshot());
        if (!layer) return;
        let weight = layer.fontWeight || 400;
        let style = layer.fontStyle || 'normal';
        if (!fonts.hasVariant(family, weight, style)) {
            weight = 400;
            style = 'normal';
        }
        state.updateText(layer.id, { fontFamily: family, fontWeight: weight, fontStyle: style });
        fonts.ensure(family, weight, style);
        closeMenu();
        views.trigger.focus();
    }

    function onWeightChange() {
        const layer = selectedLayer(snapshot());
        if (!layer) return;
        const [weight, style] = views.weight.value.split(':');
        state.updateText(layer.id, { fontWeight: Number(weight), fontStyle: style });
        fonts.ensure(layer.fontFamily, Number(weight), style);
    }

    function syncHint() {
        if (!views.hint) return;
        const hint = fonts.hint();
        views.hint.textContent = hint;
        views.hint.dataset.state = hint === 'Loading font…' ? 'loading'
            : hint ? 'failure' : '';
    }

    function rebuildFonts() {
        if (!views.add) return;
        syncHint();
        const count = fonts.families().length;
        if (views.menu && !views.menu.hidden && count !== knownCount) renderList();
        knownCount = count;
        views.weight.dataset.family = ''; // catalog arrival may add variants
        sync(snapshot());
    }

    fonts.onChange(() => {
        if (!views.hint) return;
        syncHint();
        const count = fonts.families().length;
        if (views.menu && !views.menu.hidden && count !== knownCount) renderList();
        knownCount = count;
    });

    function snapshot() {
        return state.get();
    }

    function selectedLayer(snap) {
        return snap.textLayers.find((l) => l.id === snap.selectedTextId) || null;
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

    // Client point → composed-image normalized (0..1 of the composed frame).
    function toComposed(clientX, clientY, rect) {
        const ws = workspace.getBoundingClientRect();
        return {
            nx: (clientX - ws.left - rect.x) / rect.w,
            ny: (clientY - ws.top - rect.y) / rect.h,
        };
    }

    // --- Overlay -----------------------------------------------------------

    function ensureOverlay() {
        if (overlay) return;
        overlay = el('div', 'text-overlay');
        selBox = el('div', 'text-sel');
        overlay.append(selBox);
        workspace.append(overlay);
        overlay.addEventListener('pointerdown', onPointerDown);
        observer = new ResizeObserver(() => refresh());
        observer.observe(workspace);
    }

    function destroyOverlay() {
        if (!overlay) return;
        observer?.disconnect();
        observer = null;
        overlay.remove();
        overlay = null;
        selBox = null;
        drag = null;
    }

    function onPointerDown(event) {
        const snap = snapshot();
        const rect = imageRect(snap);
        if (!rect || !snap.originalImage) return;
        event.preventDefault();

        const p = toComposed(event.clientX, event.clientY, rect);
        // Topmost first: layers render in array order, last is on top.
        const d = dims(snap);
        let hitId = null;
        for (let i = snap.textLayers.length - 1; i >= 0; i--) {
            const layer = snap.textLayers[i];
            if (hitTest(layer, d.width, d.height, p.nx * d.width, p.ny * d.height)) {
                hitId = layer.id;
                break;
            }
        }

        if (!hitId) {
            state.selectText(null); // clicking empty image deselects (§5)
            return;
        }
        state.selectText(hitId);
        const layer = state.get().textLayers.find((l) => l.id === hitId);
        drag = {
            id: hitId,
            startX: event.clientX,
            startY: event.clientY,
            origX: layer.x,
            origY: layer.y,
            rectW: rect.w,
            rectH: rect.h,
        };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(event) {
        if (!drag) return;
        const dx = (event.clientX - drag.startX) / drag.rectW;
        const dy = (event.clientY - drag.startY) / drag.rectH;
        state.updateText(drag.id, { x: drag.origX + dx, y: drag.origY + dy });
    }

    function onPointerUp() {
        drag = null;
        window.removeEventListener('pointermove', onPointerMove);
    }

    function refresh() {
        if (!active || !selBox) return;
        const snap = snapshot();
        const layer = selectedLayer(snap);
        const d = dims(snap);
        const rect = imageRect(snap);
        if (!layer || !d || !rect || !snap.originalImage) {
            selBox.hidden = true;
            return;
        }
        const b = measureLayer(layer, d.width, d.height);
        selBox.hidden = false;
        selBox.style.left = `${rect.x + b.x * snap.zoom}px`;
        selBox.style.top = `${rect.y + b.y * snap.zoom}px`;
        selBox.style.width = `${Math.max(4, b.w * snap.zoom)}px`;
        selBox.style.height = `${Math.max(4, b.h * snap.zoom)}px`;
    }

    // --- Panel -------------------------------------------------------------

    function buildPanel() {
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Text'),
            el('p', 'panel__hint', 'Type on your photo — rendered after all effects, crisp at full resolution.'),
        );
        panel.append(head);

        const addRow = el('div', 'panel__actions');
        views.add = el('button', 'btn btn--primary', '+ Add Text');
        views.add.type = 'button';
        views.add.id = 'btn-add-text';
        views.add.addEventListener('click', () => {
            if (!snapshot().originalImage) return;
            const now = Date.now();
            if (now - lastAdd < 250) return; // debounce double-clicks (§4)
                lastAdd = now;
                state.addText();
                state.setStatus('Text layer added — edit it below or drag it on the image.');
                // Task 04 (§21): the next step is typing — put the caret in the
                // new layer's content field with the default text selected.
                if (views.content) {
                    views.content.focus();
                    views.content.select();
                }
            });
        addRow.append(views.add);
        panel.append(addRow);

        // Selected-layer section ------------------------------------------------
        views.selected = el('div', 'text-selected');
        views.selected.hidden = true;

        const selHead = el('div', 'panel__section');
        selHead.append(el('h2', 'panel__title', 'Selected Text'));
        views.selected.append(selHead);

        views.content = document.createElement('textarea');
        views.content.className = 'text-content';
        views.content.id = 'text-content';
        views.content.rows = 2;
        views.content.placeholder = 'Your Text';
        views.content.setAttribute('aria-label', 'Text content');
        views.content.addEventListener('input', () => {
            const id = snapshot().selectedTextId;
            if (id) state.updateText(id, { text: views.content.value });
        });
        views.selected.append(views.content);

        const fontRow = el('div', 'export__row');
        const fontLabel = el('label', 'export__label', 'Font');
        fontLabel.htmlFor = 'font-trigger';
        views.picker = el('div', 'font-picker');
        views.trigger = el('button', 'font-picker__trigger', 'Inter');
        views.trigger.type = 'button';
        views.trigger.id = 'font-trigger';
        views.trigger.dataset.family = 'Inter';
        views.trigger.setAttribute('aria-haspopup', 'listbox');
        views.trigger.setAttribute('aria-expanded', 'false');
        views.trigger.addEventListener('click', () => {
            if (views.menu.hidden) openMenu();
            else closeMenu();
        });

        views.menu = el('div', 'font-picker__menu');
        views.menu.id = 'font-menu';
        views.menu.hidden = true;

        views.search = document.createElement('input');
        views.search.type = 'search';
        views.search.className = 'font-search';
        views.search.id = 'font-search';
        views.search.placeholder = 'Search fonts…';
        views.search.setAttribute('aria-label', 'Search fonts');
        views.search.setAttribute('role', 'combobox');
        views.search.setAttribute('aria-controls', 'font-list');
        views.search.setAttribute('aria-expanded', 'true');
        views.search.addEventListener('input', renderList);
        views.search.addEventListener('keydown', onListKeydown);

        views.category = document.createElement('select');
        views.category.className = 'export__select font-category';
        views.category.id = 'font-category';
        views.category.setAttribute('aria-label', 'Font category');
        for (const category of FONT_CATEGORIES) {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = category.label;
            views.category.append(option);
        }
        views.category.addEventListener('change', renderList);

        views.list = el('div', 'font-list');
        views.list.id = 'font-list';
        views.list.setAttribute('role', 'listbox');
        views.list.setAttribute('aria-label', 'Fonts');

        views.menu.append(views.search, views.category, views.list);
        views.picker.append(views.trigger, views.menu);
        fontRow.append(fontLabel, views.picker);
        views.selected.append(fontRow);

        views.hint = el('div', 'font-hint');
        views.hint.id = 'font-hint';
        views.hint.setAttribute('role', 'status');
        views.hint.setAttribute('aria-live', 'polite');
        knownCount = fonts.families().length;
        views.selected.append(views.hint);

        const weightRow = el('div', 'export__row');
        const weightLabel = el('label', 'export__label', 'Weight');
        weightLabel.htmlFor = 'text-weight';
        views.weight = document.createElement('select');
        views.weight.className = 'export__select';
        views.weight.id = 'text-weight';
        views.weight.addEventListener('change', onWeightChange);
        weightRow.append(weightLabel, views.weight);
        views.selected.append(weightRow);
        buildWeightOptions('Inter');
        syncHint();

        const sizeRow = el('div', 'export__row');
        const sizeLabel = el('label', 'export__label', 'Size');
        sizeLabel.htmlFor = 'text-size';
        views.size = document.createElement('input');
        views.size.type = 'number';
        views.size.className = 'export__select resize-input';
        views.size.id = 'text-size';
        views.size.min = String(FONT_SIZE_MIN);
        views.size.max = String(FONT_SIZE_MAX);
        views.size.step = '1';
        views.size.addEventListener('input', () => {
            const id = snapshot().selectedTextId;
            if (id) state.updateText(id, { fontSize: views.size.value });
        });
        sizeRow.append(sizeLabel, views.size);
        views.selected.append(sizeRow);

        const colorRow = el('div', 'export__row');
        const colorLabel = el('label', 'export__label', 'Color');
        colorLabel.htmlFor = 'text-hex';
        views.color = document.createElement('input');
        views.color.type = 'color';
        views.color.className = 'text-color';
        views.color.id = 'text-color';
        views.color.setAttribute('aria-label', 'Text color picker');
        views.color.addEventListener('input', () => {
            const id = snapshot().selectedTextId;
            if (id) state.updateText(id, { color: views.color.value });
        });
        views.hex = document.createElement('input');
        views.hex.type = 'text';
        views.hex.className = 'text-hex';
        views.hex.id = 'text-hex';
        views.hex.maxLength = 7;
        views.hex.placeholder = '#ffffff';
        views.hex.setAttribute('aria-label', 'Text color hex');
        views.hex.addEventListener('input', () => {
            const raw = views.hex.value.trim();
            const m = raw.match(/^(?:#?)([0-9a-fA-F]{6})$/);
            if (!m) return;
            const id = snapshot().selectedTextId;
            if (id) state.updateText(id, { color: `#${m[1].toLowerCase()}` });
        });
        colorRow.append(colorLabel, views.color, views.hex);
        views.selected.append(colorRow);

        const opacityRow = el('div', 'export__row');
        const opacityLabel = el('label', 'export__label', 'Opacity');
        opacityLabel.htmlFor = 'text-opacity';
        views.opacity = document.createElement('input');
        views.opacity.type = 'number';
        views.opacity.className = 'export__select resize-input';
        views.opacity.id = 'text-opacity';
        views.opacity.min = '0';
        views.opacity.max = '100';
        views.opacity.step = '1';
        views.opacity.addEventListener('input', () => {
            const id = snapshot().selectedTextId;
            if (id) state.updateText(id, { opacity: Number(views.opacity.value) / 100 });
        });
        const opacityUnit = el('span', 'text-unit', '%');
        opacityRow.append(opacityLabel, views.opacity, opacityUnit);
        views.selected.append(opacityRow);

        const alignRow = el('div', 'crop-aspect');
        alignRow.append(el('span', 'crop-aspect__label', 'Align'));
        views.alignButtons = [];
        for (const align of ['left', 'center', 'right']) {
            const button = el('button', 'btn crop-aspect__btn', align[0].toUpperCase() + align.slice(1));
            button.type = 'button';
            button.dataset.align = align;
            button.id = `btn-align-${align}`;
            button.addEventListener('click', () => {
                const id = snapshot().selectedTextId;
                if (id) state.updateText(id, { align });
            });
            views.alignButtons.push(button);
            alignRow.append(button);
        }
        views.selected.append(alignRow);

        const layerActions = el('div', 'panel__actions');
        views.duplicate = el('button', 'btn', 'Duplicate');
        views.duplicate.type = 'button';
        views.duplicate.id = 'btn-duplicate-text';
        views.duplicate.addEventListener('click', () => {
            const id = snapshot().selectedTextId;
            if (!id) return;
            state.duplicateText(id);
            state.setStatus('Text layer duplicated.');
        });
        views.delete = el('button', 'btn', 'Delete');
        views.delete.type = 'button';
        views.delete.id = 'btn-delete-text';
        views.delete.addEventListener('click', () => {
            const id = snapshot().selectedTextId;
            if (!id) return;
            state.removeText(id);
            state.setStatus('Text layer deleted.');
        });
        layerActions.append(views.duplicate, views.delete);
        views.selected.append(layerActions);

        panel.append(views.selected);

        const clearRow = el('div', 'panel__actions');
        views.clear = el('button', 'btn', 'Clear All Text');
        views.clear.type = 'button';
        views.clear.id = 'btn-clear-text';
        views.clear.addEventListener('click', () => {
            if (!snapshot().textLayers.length) return;
            state.clearText();
            state.setStatus('All text cleared.');
        });
        clearRow.append(views.clear);
        panel.append(clearRow);
    }

    function sync(snapshot) {
        if (!views.add) return;
        views.add.disabled = !snapshot.originalImage;
        views.clear.disabled = snapshot.textLayers.length === 0;

        const layer = selectedLayer(snapshot);
        views.selected.hidden = !layer;
        if (!layer) return;

        const typing = (el2) => document.activeElement === el2;
        if (!typing(views.content) && views.content.value !== layer.text) {
            views.content.value = layer.text;
        }
        if (views.trigger.dataset.family !== layer.fontFamily) {
            views.trigger.textContent = layer.fontFamily;
            views.trigger.dataset.family = layer.fontFamily;
            views.weight.dataset.family = ''; // weight options follow the family
        }
        if (views.weight.dataset.family !== layer.fontFamily) {
            buildWeightOptions(layer.fontFamily);
        }
        const combo = comboKey(layer.fontWeight || 400, layer.fontStyle || 'normal');
        if (!typing(views.weight) && views.weight.value !== combo
            && [...views.weight.options].some((o) => o.value === combo)) {
            views.weight.value = combo;
        }
        if (!typing(views.size) && Number(views.size.value) !== layer.fontSize) {
            views.size.value = String(layer.fontSize);
        }
        const hex = layer.color.toLowerCase();
        if (!typing(views.color) && views.color.value !== hex) views.color.value = hex;
        if (!typing(views.hex) && views.hex.value !== hex) views.hex.value = hex;
        const opacityPct = Math.round(layer.opacity * 100);
        if (!typing(views.opacity) && Number(views.opacity.value) !== opacityPct) {
            views.opacity.value = String(opacityPct);
        }
        for (const button of views.alignButtons) {
            button.classList.toggle('is-active', button.dataset.align === layer.align);
        }
    }

    return {
        buildPanel,
        sync,
        rebuildFonts,

        setActive(next) {
            if (next === active) return;
            active = next;
            if (next) {
                if (!snapshot().originalImage) {
                    active = false;
                    return;
                }
                ensureOverlay();
                refresh();
            } else {
                destroyOverlay();
            }
        },

        refresh,
    };
}
