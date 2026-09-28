import { ADJUSTMENT_CONTROLS, COLOR_GRADE_CONTROLS, DEFAULT_ADJUSTMENTS, DEFAULT_COLOR_GRADE, DEFAULT_EFFECTS, EFFECT_CONTROLS, MASKABLE_KEYS } from '../state/EditorState.js';
import { toolLabel } from '../tools/toolConfig.js';
import { EXPORT_FORMATS } from '../export/exporter.js';
import { PRESETS, findPreset } from '../presets.js';
import { deletePreset, getPreset, listPresets, renamePreset, savePreset } from '../project/SessionStore.js';
import { createCropController } from '../composition/CropController.js';
import { createTextController } from '../text/TextController.js';
import { createMaskController } from '../masking/MaskController.js';
import { resolveTargets } from '../masking/MaskState.js';
import { createColorGradeController } from '../color/ColorGradeController.js';
import {
    baseDimensions,
    composeKey,
    composedDimensions,
    resolveResize,
    validateResize,
} from '../composition/CompositionRenderer.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function formatValue(value, control) {
    if (control.min < 0 && value > 0) return `+${value}`;
    return String(value);
}

export function createEditorUI({ state, refs, onOpen, onReset, exporter, fonts, history, maskRenderer, project }) {
    const { toolrail, panel, status, fileMeta, fileName, fileDims, empty, app } = refs;
    const rows = new Map();

    // Export panel settings persist across tool switches.
    let exportFormat = 'jpg';
    let exportQuality = 90;
    let exportViews = null;
    // Task 04 (§19/§42): export button focus across the disabled window, and
    // the panel's scroll position across tool switches.
    let lastExporting = false;
    const panelScroll = new Map();

    // Crop overlay lives in the workspace (not the panel) and survives panel
    // rebuilds; only its tool activation changes.
    const cropCtl = createCropController({ state, workspace: refs.workspace });

    // Text tool: panel + selection overlay, text-specific logic stays in its
    // own controller (§1).
    const textCtl = createTextController({ state, workspace: refs.workspace, panel, fonts });

    // Step 11: mask brush interaction — overlay lives in the workspace and
    // shares the pipeline's mask renderer so tint and effect always agree.
    const maskCtl = createMaskController({
        state,
        workspace: refs.workspace,
        history,
        maskRenderer,
    });

    // Step 12: look application — presets and both resets, one transaction each.
    const gradeCtl = createColorGradeController({ state, history });

    // --- Step 10: history panel section (created once, prepended to every
    // panel build so it survives replaceChildren) ---
    const historySection = el('section', 'history');
    historySection.setAttribute('aria-label', 'History');
    historySection.hidden = true;
    const historyHead = el('div', 'panel__section history__head');
    historyHead.append(el('h2', 'panel__title', 'History'));
    const historyList = el('ol', 'history__list');
    historySection.append(historyHead, historyList);

    // Task 03: which look is currently applied — visual + aria state only.
    // Cleared the moment any control is edited (the look no longer matches).
    function clearActivePresets() {
        for (const b of panel.querySelectorAll('.preset.is-active')) {
            b.classList.remove('is-active');
            b.removeAttribute('aria-current');
        }
    }

    function renderHistory() {
        const canUndo = history.canUndo();
        const canRedo = history.canRedo();
        refs.undoButton.disabled = !canUndo;
        refs.redoButton.disabled = !canRedo;
        const all = history.labels();

        const undoLabel = canUndo ? `Undo: ${all[history.index()].label}` : 'Undo';
        refs.undoButton.setAttribute('aria-label', undoLabel);
        refs.undoButton.title = `${undoLabel} (Ctrl+Z)`;
        const redoLabel = canRedo ? `Redo: ${all[history.index() + 1].label}` : 'Redo';
        refs.redoButton.setAttribute('aria-label', redoLabel);
        refs.redoButton.title = `${redoLabel} (Ctrl+Shift+Z)`;

        historySection.hidden = all.length === 0;
        const frag = document.createDocumentFragment();
        for (let i = all.length - 1; i >= 0; i--) {
            const item = el('li', 'history__item');
            const button = el('button', 'history__entry', all[i].label);
            button.type = 'button';
            if (all[i].isCurrent) {
                button.classList.add('is-current');
                button.setAttribute('aria-current', 'step');
            } else if (all[i].isFuture) {
                button.classList.add('is-future');
            }
            button.addEventListener('click', () => history.jump(i));
            item.append(button);
            frag.append(item);
        }
        historyList.replaceChildren(frag);
    }

    history.onChange(renderHistory);
    refs.undoButton.addEventListener('click', () => history.undo());
    refs.redoButton.addEventListener('click', () => history.redo());
    renderHistory();

    // Composition panel views + change tracking.
    let rotationView = null;
    let resizeViews = null;
    let cropAspectButtons = [];
    let lastCompKey = composeKey(state.get().composition);

    function defaultValue(key) {
        if (key in DEFAULT_ADJUSTMENTS) return DEFAULT_ADJUSTMENTS[key];
        if (key in DEFAULT_EFFECTS) return DEFAULT_EFFECTS[key];
        return DEFAULT_COLOR_GRADE[key];
    }

    // One row builder for adjustments AND effects: label, live value, per-row
    // reset, bipolar fill — identical markup; sync drives both via `rows`.
    function buildControlRow(control, onChange) {
        const row = el('div', 'adjust');
        row.dataset.key = control.key;

        const headRow = el('div', 'adjust__head');
        const label = el('label', 'adjust__label', control.label);
        label.htmlFor = `adj-${control.key}`;
        const output = el('output', 'adjust__value');
        output.htmlFor = `adj-${control.key}`;
        const reset = el('button', 'adjust__reset', '↺');
        reset.type = 'button';
        reset.title = `Reset ${control.label.toLowerCase()}`;
        reset.setAttribute('aria-label', `Reset ${control.label}`);
        headRow.append(label, output, reset);

        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'adjust__range';
        input.id = `adj-${control.key}`;
        input.min = String(control.min);
        input.max = String(control.max);
        input.step = String(control.step);

        input.addEventListener('input', () => {
            clearActivePresets();
            onChange(Number(input.value));
        });
        reset.addEventListener('click', () => {
            clearActivePresets();
            onChange(defaultValue(control.key));
        });

        row.append(headRow, input);
        rows.set(control.key, { row, input, output, control });
        return row;
    }

    function buildAdjustPanel() {
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Basic'),
            el('p', 'panel__hint', 'Non-destructive adjustments, processed entirely in your browser.'),
        );
        panel.append(head);

        // Task 03: captions group the nine basics (Light / Color / Detail).
        const basicGroups = [
            { label: 'Light', from: 0 },
            { label: 'Color', from: 5 },
            { label: 'Detail', from: 8 },
        ];
        ADJUSTMENT_CONTROLS.forEach((control, index) => {
            const caption = basicGroups.find((g) => g.from === index);
            if (caption) panel.append(el('div', 'adjust__group', caption.label));
            panel.append(buildControlRow(control, (v) => state.setAdjustment(control.key, v)));
        });

        // Step 12 (§12.2): the grade reuses the same rows in three groups —
        // Color / Global / Cinematic. No new markup system, no second sync.
        const byKey = new Map(COLOR_GRADE_CONTROLS.map((control) => [control.key, control]));
        const groups = [
            {
                title: 'Color',
                hint: 'Zone grading — shadows, midtones and highlights, each with its own hue and saturation.',
                keys: ['shadowsHue', 'shadowsSat', 'midtonesHue', 'midtonesSat', 'highlightsHue', 'highlightsSat'],
            },
            {
                title: 'Global',
                hint: 'Whole-image look — intensity scales the whole grade, balance shifts it, vibrance lifts muted color.',
                keys: ['intensity', 'colorBalance', 'vibrance'],
            },
            {
                title: 'Cinematic',
                hint: 'Film-style pairing across the tonal range — split tone, warm highlights, cool shadows.',
                keys: ['splitTone', 'highlightWarmth', 'shadowCoolness'],
            },
        ];
        for (const group of groups) {
            const groupHead = el('div', 'panel__section');
            groupHead.append(
                el('h2', 'panel__title', group.title),
                el('p', 'panel__hint', group.hint),
            );
            panel.append(groupHead);
            for (const key of group.keys) {
                panel.append(buildControlRow(byKey.get(key), (v) => state.setColorGrade(key, v)));
            }
        }
        const gradeActions = el('div', 'panel__actions');
        const resetGrade = el('button', 'btn', 'Reset Color Grade');
        resetGrade.type = 'button';
        resetGrade.id = 'btn-reset-grade';
        resetGrade.addEventListener('click', () => gradeCtl.resetGrade());
        gradeActions.append(resetGrade);
        panel.append(gradeActions);
    }

    // Section headers over the same shared control rows (§10: Film / Texture /
    // Light) — no new markup system, just where the rows are grouped.
    function buildEffectsPanel() {
        const byKey = new Map(EFFECT_CONTROLS.map((control) => [control.key, control]));
        const groups = [
            {
                title: 'Film',
                hint: 'Cinematic effects, layered after your basic adjustments.',
                keys: ['fade', 'vignette', 'grain'],
            },
            {
                title: 'Texture',
                hint: 'Analog dust and scratches — seeded, deterministic, non-destructive.',
                keys: ['dust', 'scratches'],
            },
            {
                title: 'Light',
                hint: 'Cinematic light spill with a stable, seeded position.',
                keys: ['lightLeak'],
            },
        ];

        for (const group of groups) {
            const head = el('div', 'panel__section');
            head.append(
                el('h2', 'panel__title', group.title),
                el('p', 'panel__hint', group.hint),
            );
            panel.append(head);

            for (const key of group.keys) {
                const control = byKey.get(key);
                panel.append(buildControlRow(control, (v) => state.setEffect(key, v)));
            }
        }

        const presetHead = el('div', 'panel__section');
        presetHead.append(el('h2', 'panel__title', 'Presets'));
        panel.append(presetHead);

        const list = el('div', 'presets');
        for (const preset of PRESETS) {
            const button = el('button', 'btn preset', preset.name);
            button.type = 'button';
            button.dataset.preset = preset.name;
            list.append(button);
        }
        panel.append(list);

        // Step 13 (§13.6): custom presets — current look saved to this
        // browser only (adjustments/effects/grade, never pixels). Rendered
        // outside `.presets` so the nine built-ins keep their own container.
        const customBox = el('div', 'custom-presets');
        const customLabel = el('label', 'custom-presets__label', 'Save this look as');
        customLabel.htmlFor = 'custom-preset-name';
        const customName = document.createElement('input');
        customName.type = 'text';
        customName.id = 'custom-preset-name';
        customName.className = 'custom-presets__input';
        customName.maxLength = 40;
        customName.placeholder = 'My look name';
        customName.setAttribute('aria-label', 'Custom preset name');
        const saveLook = el('button', 'btn', 'Save Look');
        saveLook.type = 'button';
        saveLook.id = 'btn-save-look';
        customBox.append(customLabel, customName, saveLook);
        panel.append(customBox);

        const customList = el('div', 'custom-presets__list');
        panel.append(customList);

        function currentLook() {
            const snap = state.get();
            return {
                adjustments: { ...snap.adjustments },
                effects: { ...snap.effects },
                colorGrade: { ...snap.colorGrade },
            };
        }

        // Task 04 (§20): re-rendering the list detaches the focused row — send
        // focus back into the section instead of dropping it on <body>.
        // Only when nothing else claimed focus (Enter/Escape/Delete end on body;
        // a blur to another control must not be hijacked).
        function refocusCustomPresets() {
            if (document.activeElement !== document.body) return;
            const next = customList.querySelector('.custom-preset__delete');
            (next || customName).focus();
        }

        function renderCustomPresets() {
            customList.replaceChildren();
            for (const saved of listPresets()) {
                const row = el('div', 'custom-preset');
                row.dataset.custom = saved.name;
                const apply = el('button', 'btn preset preset--custom', saved.name);
                apply.type = 'button';
                apply.dataset.preset = saved.name;
                const rename = el('button', 'btn custom-preset__edit', 'Rename');
                rename.type = 'button';
                rename.setAttribute('aria-label', `Rename ${saved.name}`);
                const remove = el('button', 'btn custom-preset__delete', 'Delete');
                remove.type = 'button';
                remove.setAttribute('aria-label', `Delete ${saved.name}`);

                rename.addEventListener('click', () => {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'custom-preset__rename-input';
                    input.maxLength = 40;
                    input.value = saved.name;
                    input.setAttribute('aria-label', `New name for ${saved.name}`);
                    row.replaceChildren(input);
                    input.focus();
                    input.select();
                    let done = false;
                    const finish = (commit) => {
                        if (done) return;
                        done = true;
                        if (commit) {
                            const result = renamePreset(saved.name, input.value.trim());
                            if (result.ok) {
                                state.setStatus(`Renamed to “${result.preset.name}”.`, 'info');
                            } else if (result.reason === 'duplicate') {
                                state.setStatus('You already have a look with that name.', 'error');
                            } else if (result.reason === 'name') {
                                state.setStatus('Look names are 1 to 40 characters.', 'error');
                            }
                        }
                        renderCustomPresets();
                        refocusCustomPresets();
                    };
                    input.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            finish(true);
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            finish(false);
                        }
                    });
                    input.addEventListener('blur', () => finish(true));
                });

                remove.addEventListener('click', () => {
                    const result = deletePreset(saved.name);
                    if (result.ok) {
                        renderCustomPresets();
                        refocusCustomPresets();
                        state.setStatus(`“${saved.name}” deleted from this browser.`, 'info');
                    } else {
                        state.setStatus('That look could not be deleted.', 'error');
                    }
                });

                row.append(apply, rename, remove);
                customList.append(row);
            }
        }

        saveLook.addEventListener('click', () => {
            const name = customName.value.trim();
            if (!name || name.length > 40) {
                state.setStatus('Give your look a name — 1 to 40 characters.', 'error');
                return;
            }
            const builtin = PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase());
            if (builtin) {
                state.setStatus(`“${name}” is a built-in preset — pick another name.`, 'error');
                return;
            }
            const result = savePreset(name, currentLook());
            if (!result.ok) {
                const msgs = {
                    duplicate: `You already have a look called “${name}”.`,
                    full: '30 custom looks is the maximum — delete one to save another.',
                    storage: 'This browser refused to store the look — nothing was saved.',
                };
                state.setStatus(msgs[result.reason] || 'That look could not be saved.', 'error');
                return;
            }
            customName.value = '';
            renderCustomPresets();
            state.setStatus(`“${result.preset.name}” saved to this browser.`, 'info');
        });

        renderCustomPresets();

        // Step 12 (§12.5): full look reset lives with the presets it mirrors —
        // adjustments + effects + grade, exactly what a preset rewrites.
        const lookActions = el('div', 'panel__actions');
        const resetLook = el('button', 'btn', 'Reset All Look');
        resetLook.type = 'button';
        resetLook.id = 'btn-reset-look';
        resetLook.addEventListener('click', () => gradeCtl.resetAllLook());
        lookActions.append(resetLook);
        panel.append(lookActions);
    }

    function buildExportPanel() {
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Export'),
            el('p', 'panel__hint', 'Full resolution — rendered and downloaded in your browser, never uploaded.'),
        );
        panel.append(head);

        const box = el('div', 'export');

        // Format
        const rowFormat = el('div', 'export__row');
        const formatLabel = el('label', 'export__label', 'Format');
        formatLabel.htmlFor = 'export-format';
        const select = document.createElement('select');
        select.className = 'export__select';
        select.id = 'export-format';
        for (const format of EXPORT_FORMATS) {
            const option = document.createElement('option');
            option.value = format.id;
            option.textContent = format.id.toUpperCase();
            select.append(option);
        }
        select.value = exportFormat;
        rowFormat.append(formatLabel, select);

        // Quality (JPG / WebP only — PNG is lossless)
        const qualityBox = el('div', 'export__quality');
        const qualityHead = el('div', 'adjust__head');
        const qualityLabel = el('label', 'adjust__label', 'Quality');
        qualityLabel.htmlFor = 'export-quality';
        const qualityValue = el('output', 'adjust__value', `${exportQuality}%`);
        qualityValue.htmlFor = 'export-quality';
        qualityHead.append(qualityLabel, qualityValue);
        const qualityInput = document.createElement('input');
        qualityInput.type = 'range';
        qualityInput.className = 'adjust__range';
        qualityInput.id = 'export-quality';
        qualityInput.min = '10';
        qualityInput.max = '100';
        qualityInput.step = '1';
        qualityInput.value = String(exportQuality);
        const paintQualityFill = () => {
            const pct = ((Number(qualityInput.value) - 10) / 90) * 100;
            qualityInput.style.setProperty('--fill-a', '0%');
            qualityInput.style.setProperty('--fill-b', `${pct}%`);
        };
        qualityInput.addEventListener('input', () => {
            exportQuality = Number(qualityInput.value);
            qualityValue.textContent = `${exportQuality}%`;
            paintQualityFill();
        });
        qualityBox.append(qualityHead, qualityInput);
        paintQualityFill();

        // Output dimensions — always the original image size
        const rowDims = el('div', 'export__row');
        const dimsValue = el('span', 'export__dims', '—');
        dimsValue.id = 'export-dims';
        rowDims.append(el('span', 'export__label', 'Output'), dimsValue);

        // Export
        const go = el('button', 'btn btn--primary export__go', 'Export');
        go.type = 'button';
        go.id = 'btn-do-export';
        go.addEventListener('click', () => exporter.run(exportFormat, exportQuality));

        const statusLine = el('p', 'export__status');
        statusLine.id = 'export-status';

        box.append(rowFormat, qualityBox, rowDims, go, statusLine);
        panel.append(box);

        const format = EXPORT_FORMATS.find((f) => f.id === exportFormat);
        qualityBox.hidden = !format.quality;
        select.addEventListener('change', () => {
            exportFormat = select.value;
            const active = EXPORT_FORMATS.find((f) => f.id === exportFormat);
            qualityBox.hidden = !active.quality;
        });

        exportViews = { dims: dimsValue, status: statusLine, button: go };

        // Step 13 (§13.1–13.2): project = editing instructions only. The
        // serialized file carries state (sliders, effects, grade, crop, text,
        // mask) — never the image itself.
        const projHead = el('div', 'panel__section');
        projHead.append(
            el('h2', 'panel__title', 'Project'),
            el('p', 'panel__hint', 'Your look as a small .8pattern.json file — controls, text and masks only. The image itself is never included.'),
        );
        panel.append(projHead);

        const projActions = el('div', 'panel__actions');
        const saveProject = el('button', 'btn', 'Save Project');
        saveProject.type = 'button';
        saveProject.id = 'btn-save-project';
        saveProject.addEventListener('click', () => project.save());
        const loadProject = el('button', 'btn', 'Load Project');
        loadProject.type = 'button';
        loadProject.id = 'btn-load-project';
        projActions.append(saveProject, loadProject);
        panel.append(projActions);

        const projectInput = document.createElement('input');
        projectInput.type = 'file';
        projectInput.accept = '.json,application/json';
        projectInput.id = 'project-input';
        projectInput.hidden = true;
        projectInput.setAttribute('aria-label', 'Load a project file');
        projectInput.addEventListener('change', async () => {
            const file = projectInput.files && projectInput.files[0];
            projectInput.value = '';
            if (file) await project.importFile(file);
        });
        panel.append(projectInput);
        loadProject.addEventListener('click', () => projectInput.click());
    }

    function buildPlaceholder(tool) {
        const box = el('div', 'placeholder');
        box.append(
            el('span', 'placeholder__tool', toolLabel(tool)),
            el('p', 'placeholder__text', 'Coming next.'),
        );
        panel.append(box);
    }

    // --- Step 6: Crop panel (overlay interaction) -------------------------

    function buildCropPanel() {
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Crop'),
            el('p', 'panel__hint', 'Drag the frame over the image — Apply commits it, Cancel keeps everything as it was.'),
        );
        panel.append(head);

        const aspectRow = el('div', 'crop-aspect');
        aspectRow.append(el('span', 'crop-aspect__label', 'Aspect'));
        cropAspectButtons = [];
        for (const label of ['Free', 'Original', '1:1', '4:5', '3:4', '16:9']) {
            const button = el('button', 'btn crop-aspect__btn', label);
            button.type = 'button';
            button.dataset.aspect = label;
            if (label === cropCtl.aspectLabel()) button.classList.add('is-active');
            button.addEventListener('click', () => {
                cropCtl.setAspect(label);
                for (const b of cropAspectButtons) {
                    b.classList.toggle('is-active', b.dataset.aspect === label);
                }
            });
            cropAspectButtons.push(button);
            aspectRow.append(button);
        }
        panel.append(aspectRow);

        const actions = el('div', 'panel__actions');
        const apply = el('button', 'btn btn--primary', 'Apply Crop');
        apply.type = 'button';
        apply.id = 'btn-apply-crop';
        apply.addEventListener('click', () => cropCtl.apply());

        const cancel = el('button', 'btn', 'Cancel');
        cancel.type = 'button';
        cancel.id = 'btn-crop-cancel';
        cancel.addEventListener('click', () => cropCtl.cancel());

        const reset = el('button', 'btn', 'Reset Crop');
        reset.type = 'button';
        reset.id = 'btn-reset-crop';
        reset.addEventListener('click', () => {
            state.resetCrop();
            state.setStatus('Crop reset — full frame.');
        });

        actions.append(apply, cancel, reset);
        panel.append(actions);
    }

    // --- Step 6: Rotate & Composition panel (rotation + resize) ------------

    function composedNow() {
        const snap = state.get();
        if (!snap.originalImage) return null;
        return composedDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
    }

    function statusAfterComposition(message) {
        const d = composedNow();
        state.setStatus(d ? `${message} — ${d.width} × ${d.height}` : message);
    }

    function populateResize() {
        if (!resizeViews) return;
        const snap = state.get();
        if (!snap.originalImage) {
            resizeViews.w.value = '';
            resizeViews.h.value = '';
            return;
        }
        const base = baseDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
        const out = resolveResize(base.width, base.height, snap.composition.resize);
        resizeViews.w.value = String(out.width);
        resizeViews.h.value = String(out.height);
        resizeViews.aspect.checked = snap.composition.resize.maintainAspectRatio;
    }

    function linkResizeFrom(changed) {
        if (!resizeViews || !resizeViews.aspect.checked) return;
        const snap = state.get();
        if (!snap.originalImage) return;
        const base = baseDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
        const value = Number(changed.value);
        if (!Number.isFinite(value) || value < 1 || base.width < 1 || base.height < 1) return;
        const other = changed === resizeViews.w
            ? Math.max(1, Math.round((value * base.height) / base.width))
            : Math.max(1, Math.round((value * base.width) / base.height));
        (changed === resizeViews.w ? resizeViews.h : resizeViews.w).value = String(other);
    }

    function buildCompositionPanel() {
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Composition'),
            el('p', 'panel__hint', 'Crop, rotate and resize — applied to the source before any adjustments.'),
        );
        panel.append(head);

        // Rotation — ±90° steps only, four states, returns to original ×4.
        const rotRow = el('div', 'panel__actions');
        const left = el('button', 'btn', 'Rotate Left');
        left.type = 'button';
        left.id = 'btn-rot-left';
        left.addEventListener('click', () => {
            state.rotate(-90);
            statusAfterComposition(`Rotated to ${state.get().composition.rotation}°`);
        });

        const right = el('button', 'btn', 'Rotate Right');
        right.type = 'button';
        right.id = 'btn-rot-right';
        right.addEventListener('click', () => {
            state.rotate(90);
            statusAfterComposition(`Rotated to ${state.get().composition.rotation}°`);
        });

        rotationView = el('span', 'comp-rotation', '0°');
        rotationView.id = 'comp-rotation';

        const resetRot = el('button', 'btn', 'Reset Rotation');
        resetRot.type = 'button';
        resetRot.id = 'btn-reset-rotation';
        resetRot.addEventListener('click', () => {
            state.resetRotation();
            statusAfterComposition('Rotation reset');
        });

        rotRow.append(left, right, rotationView, resetRot);
        panel.append(rotRow);

        const cropRow = el('div', 'panel__actions');
        const resetCrop = el('button', 'btn', 'Reset Crop');
        resetCrop.type = 'button';
        resetCrop.id = 'btn-reset-crop';
        resetCrop.addEventListener('click', () => {
            state.resetCrop();
            state.setStatus('Crop reset — full frame.');
        });
        cropRow.append(resetCrop);
        panel.append(cropRow);

        // Resize — output pixels, validated against hard limits.
        const sizeHead = el('div', 'panel__section');
        sizeHead.append(
            el('h2', 'panel__title', 'Resize'),
            el('p', 'panel__hint', 'Output size in pixels — applied last, after crop and rotation.'),
        );
        panel.append(sizeHead);

        resizeViews = {};
        const wRow = el('div', 'export__row');
        const wLabel = el('label', 'export__label', 'Width');
        wLabel.htmlFor = 'resize-w';
        resizeViews.w = document.createElement('input');
        resizeViews.w.type = 'number';
        resizeViews.w.className = 'export__select resize-input';
        resizeViews.w.id = 'resize-w';
        resizeViews.w.min = '1';
        resizeViews.w.step = '1';
        resizeViews.w.addEventListener('input', () => linkResizeFrom(resizeViews.w));
        wRow.append(wLabel, resizeViews.w);

        const hRow = el('div', 'export__row');
        const hLabel = el('label', 'export__label', 'Height');
        hLabel.htmlFor = 'resize-h';
        resizeViews.h = document.createElement('input');
        resizeViews.h.type = 'number';
        resizeViews.h.className = 'export__select resize-input';
        resizeViews.h.id = 'resize-h';
        resizeViews.h.min = '1';
        resizeViews.h.step = '1';
        resizeViews.h.addEventListener('input', () => linkResizeFrom(resizeViews.h));
        hRow.append(hLabel, resizeViews.h);

        const aspectRow = el('div', 'resize-aspect');
        resizeViews.aspect = document.createElement('input');
        resizeViews.aspect.type = 'checkbox';
        resizeViews.aspect.id = 'resize-aspect';
        resizeViews.aspect.checked = true;
        const aspectLabel = el('label', 'resize-aspect__label', 'Maintain aspect ratio');
        aspectLabel.htmlFor = 'resize-aspect';
        resizeViews.aspect.addEventListener('change', () => linkResizeFrom(resizeViews.w));
        aspectRow.append(resizeViews.aspect, aspectLabel);

        const sizeActions = el('div', 'panel__actions');
        const applySize = el('button', 'btn btn--primary', 'Apply Resize');
        applySize.type = 'button';
        applySize.id = 'btn-apply-resize';
        applySize.addEventListener('click', () => {
            const snap = state.get();
            if (!snap.originalImage) {
                state.setStatus('Open a photo before resizing.', 'error');
                return;
            }
            const base = baseDimensions(snap.imageWidth, snap.imageHeight, snap.composition);
            const result = validateResize(base.width, base.height, {
                width: resizeViews.w.value,
                height: resizeViews.h.value,
                maintainAspectRatio: resizeViews.aspect.checked,
            });
            if (!result.ok) {
                state.setStatus(result.reason, 'error');
                return;
            }
            state.setResize(result.width, result.height, resizeViews.aspect.checked);
            statusAfterComposition('Resize applied');
        });

        const cancelSize = el('button', 'btn', 'Cancel');
        cancelSize.type = 'button';
        cancelSize.id = 'btn-resize-cancel';
        cancelSize.addEventListener('click', () => {
            populateResize();
            state.setStatus('Resize cancelled — nothing was changed.');
        });

        const resetSize = el('button', 'btn', 'Reset Resize');
        resetSize.type = 'button';
        resetSize.id = 'btn-reset-resize';
        resetSize.addEventListener('click', () => {
            state.resetResize();
            statusAfterComposition('Resize reset');
        });
        sizeActions.append(applySize, cancelSize, resetSize);

        const resetAll = el('button', 'btn', 'Reset Composition');
        resetAll.type = 'button';
        resetAll.id = 'btn-reset-composition';
        resetAll.addEventListener('click', () => {
            // Three notifications, one labeled entry (§35, §62).
            history.begin('Reset Composition');
            state.resetCrop();
            state.resetRotation();
            state.resetResize();
            history.commit();
            state.setStatus('Composition reset — crop, rotation and resize cleared.');
        });

        panel.append(wRow, hRow, aspectRow, sizeActions, resetAll);
        populateResize();
    }

    // --- Step 11: Mask panel ---------------------------------------------

    // Rebuild key: the mask panel's structure tracks image presence and mask
    // shape (create / delete / paint / invert / targets — including via
    // history). Brush slider values come from maskCtl.getBrush() on rebuild.
    let maskPanelKey = 'no-image';
    const maskPanelKeyOf = (snap) => (!snap.originalImage
        ? 'no-image'
        : (snap.mask
            ? `${snap.mask.strokes.length}:${snap.mask.inverted}:${snap.mask.targets.join(',')}`
            : 'none'));

    // Small labeled range row in the existing visual language (label, live
    // value, bipolar-free fill). Brush settings are UI state — no history.
    function maskRange(id, label, min, max, value, onInput) {
        const box = el('div', 'mask-range');
        const head = el('div', 'adjust__head');
        const lab = el('label', 'adjust__label', label);
        lab.htmlFor = id;
        const out = el('output', 'adjust__value', `${value}%`);
        out.htmlFor = id;
        head.append(lab, out);
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'adjust__range';
        input.id = id;
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.value = String(value);
        const paint = () => {
            const pct = ((Number(input.value) - min) / (max - min)) * 100;
            input.style.setProperty('--fill-a', '0%');
            input.style.setProperty('--fill-b', `${pct}%`);
        };
        input.addEventListener('input', () => {
            out.textContent = `${input.value}%`;
            paint();
            onInput(Number(input.value));
        });
        paint();
        box.append(head, input);
        return box;
    }

    function buildMaskPanel() {
        const snap = state.get();
        maskPanelKey = maskPanelKeyOf(snap);
        const head = el('div', 'panel__section');
        head.append(
            el('h2', 'panel__title', 'Mask'),
            el('p', 'panel__hint', 'Paint a region — masked adjustments and effects apply only inside it.'),
        );
        panel.append(head);

        if (!snap.originalImage) {
            panel.append(el('p', 'panel__hint', 'Open a photo to create a mask.'));
            return;
        }

        if (!snap.mask) {
            const actions = el('div', 'panel__actions');
            const create = el('button', 'btn btn--primary', 'New Mask');
            create.type = 'button';
            create.id = 'btn-new-mask';
            create.addEventListener('click', () => {
                if (state.createMask()) state.setStatus('Mask created — paint to select the area to edit.');
            });
            actions.append(create);
            panel.append(actions);
            return;
        }

        // Brush / Erase mode toggle.
        const brush = maskCtl.getBrush();
        const modeRow = el('div', 'panel__actions mask-mode');
        const brushBtn = el('button', 'btn mask-mode__btn', 'Brush');
        brushBtn.type = 'button';
        brushBtn.id = 'mask-brush';
        const eraseBtn = el('button', 'btn mask-mode__btn', 'Erase');
        eraseBtn.type = 'button';
        eraseBtn.id = 'mask-erase';
        const syncMode = () => {
            const mode = maskCtl.getBrush().mode;
            brushBtn.setAttribute('aria-pressed', String(mode === 'brush'));
            eraseBtn.setAttribute('aria-pressed', String(mode === 'erase'));
            brushBtn.classList.toggle('is-active', mode === 'brush');
            eraseBtn.classList.toggle('is-active', mode === 'erase');
        };
        brushBtn.addEventListener('click', () => { maskCtl.setMode('brush'); syncMode(); });
        eraseBtn.addEventListener('click', () => { maskCtl.setMode('erase'); syncMode(); });
        modeRow.append(brushBtn, eraseBtn);
        syncMode();
        panel.append(modeRow);

        panel.append(
            maskRange('mask-size', 'Size', 1, 100, brush.size, (v) => maskCtl.setBrush({ size: v })),
            maskRange('mask-hardness', 'Hardness', 0, 100, brush.hardness, (v) => maskCtl.setBrush({ hardness: v })),
            maskRange('mask-opacity', 'Opacity', 1, 100, brush.opacity, (v) => maskCtl.setBrush({ opacity: v })),
        );

        // Apply-to: group names or a single operation (all serializable).
        const targetRow = el('div', 'export__row');
        const targetLabel = el('label', 'export__label', 'Apply to');
        targetLabel.htmlFor = 'mask-targets';
        const targetSelect = document.createElement('select');
        targetSelect.className = 'export__select';
        targetSelect.id = 'mask-targets';
        const groups = [
            ['all', 'All adjustments + effects'],
            ['adjustments', 'Adjustments only'],
            ['effects', 'Effects only'],
        ];
        for (const [value, text] of groups) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            targetSelect.append(option);
        }
        const singleGroup = document.createElement('optgroup');
        singleGroup.label = 'Single operation';
        const labelFor = new Map([...ADJUSTMENT_CONTROLS, ...EFFECT_CONTROLS].map((c) => [c.key, c.label]));
        for (const key of MASKABLE_KEYS) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = labelFor.get(key) || key;
            singleGroup.append(option);
        }
        targetSelect.append(singleGroup);
        const matches = (name) => {
            const resolved = resolveTargets(name);
            return resolved.length === snap.mask.targets.length
                && resolved.every((k, i) => snap.mask.targets[i] === k);
        };
        targetSelect.value = ['all', 'adjustments', 'effects'].find(matches)
            || MASKABLE_KEYS.find((k) => matches(k))
            || '';
        if (!targetSelect.value) {
            const custom = document.createElement('option');
            custom.value = '';
            custom.textContent = 'Custom selection';
            targetSelect.prepend(custom);
            targetSelect.value = '';
        }
        targetSelect.addEventListener('change', () => {
            if (!targetSelect.value) return;
            const current = state.get().mask;
            if (!current) return;
            state.updateMask({ ...current, targets: resolveTargets(targetSelect.value) });
        });
        targetRow.append(targetLabel, targetSelect);
        panel.append(targetRow);

        const actions = el('div', 'panel__actions');
        const invert = el('button', 'btn', 'Invert');
        invert.type = 'button';
        invert.id = 'btn-mask-invert';
        invert.addEventListener('click', () => {
            const current = state.get().mask;
            if (!current) return;
            state.updateMask({ ...current, inverted: !current.inverted });
            state.setStatus(current.inverted ? 'Mask inverted — nothing is selected.' : 'Mask inverted — the painted area is selected again.');
        });

        const clear = el('button', 'btn', 'Clear');
        clear.type = 'button';
        clear.id = 'btn-mask-clear';
        clear.addEventListener('click', () => {
            const current = state.get().mask;
            if (!current) return;
            state.updateMask({ ...current, strokes: [], inverted: false });
            state.setStatus('Mask cleared — paint a new region.');
        });

        const remove = el('button', 'btn btn--danger', 'Delete Mask');
        remove.type = 'button';
        remove.id = 'btn-delete-mask';
        remove.addEventListener('click', () => {
            if (state.deleteMask()) state.setStatus('Mask deleted — edits apply to the whole image again.');
        });
        actions.append(invert, clear, remove);
        panel.append(actions);

        // Show/hide the tint overlay (view state — creates no history).
        const showRow = el('div', 'resize-aspect');
        const show = document.createElement('input');
        show.type = 'checkbox';
        show.id = 'mask-show';
        show.checked = snap.maskVisible;
        const showLabel = el('label', 'resize-aspect__label', 'Show mask overlay');
        showLabel.htmlFor = 'mask-show';
        show.addEventListener('change', () => state.setMaskVisible(show.checked));
        showRow.append(show, showLabel);
        panel.append(showRow);
    }

    function buildPanel(tool) {
        rows.clear();
        exportViews = null;
        rotationView = null;
        resizeViews = null;
        cropAspectButtons = [];
        panel.replaceChildren();
        if (tool === 'adjust') {
            buildAdjustPanel();
        } else if (tool === 'effects') {
            buildEffectsPanel();
        } else if (tool === 'mask') {
            buildMaskPanel();
        } else if (tool === 'crop') {
            buildCropPanel();
        } else if (tool === 'rotate') {
            buildCompositionPanel();
        } else if (tool === 'text') {
            textCtl.buildPanel();
        } else if (tool === 'export') {
            buildExportPanel();
        } else {
            buildPlaceholder(tool);
        }
        // History section rides along on every panel (§39).
        panel.prepend(historySection);
        // Task 03: first content section becomes the panel header treatment.
        panel.querySelector(':scope > .panel__section')?.classList.add('panel__section--lead');
    }

    function syncAdjustments(snapshot) {
        for (const [key, view] of rows) {
            const value = key in snapshot.adjustments
                ? snapshot.adjustments[key]
                : key in snapshot.effects
                    ? snapshot.effects[key]
                    : snapshot.colorGrade[key];
            if (Number(view.input.value) !== value) {
                view.input.value = String(value);
            }
            view.output.textContent = formatValue(value, view.control);
            view.row.classList.toggle('is-dirty', value !== defaultValue(key));

            const span = view.control.max - view.control.min;
            const pct = ((value - view.control.min) / span) * 100;
            const zero = ((0 - view.control.min) / span) * 100;
            view.input.style.setProperty('--fill-a', `${Math.min(zero, pct)}%`);
            view.input.style.setProperty('--fill-b', `${Math.max(zero, pct)}%`);
        }
    }

    function sync(snapshot) {
        for (const button of toolrail.querySelectorAll('[data-tool]')) {
            const active = button.dataset.tool === snapshot.activeTool;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }

        if (panel.dataset.tool !== snapshot.activeTool) {
            // Task 04 (§9/§42): remember where the outgoing tool was scrolled,
            // restore it for the incoming tool, and play a subtle panel entrance.
            if (panel.dataset.tool) panelScroll.set(panel.dataset.tool, panel.scrollTop);
            panel.dataset.tool = snapshot.activeTool;
            buildPanel(snapshot.activeTool);
            panel.scrollTop = panelScroll.get(snapshot.activeTool) || 0;
            panel.classList.remove('panel--enter');
            void panel.offsetWidth; // restart the animation on every switch
            panel.classList.add('panel--enter');
        } else if (snapshot.activeTool === 'mask'
            && maskPanelKeyOf(snapshot) !== maskPanelKey) {
            // Mask structure changed while the panel is open (image loaded,
            // create, delete, paint, invert, targets — any path, incl. history).
            buildPanel('mask');
        }

        status.textContent = snapshot.status.text;
        status.classList.toggle('is-error', snapshot.status.type === 'error');
        status.classList.toggle('is-success', snapshot.status.type === 'success');

        // Composed dimensions are what the user sees and exports.
        const composed = snapshot.originalImage
            ? composedDimensions(snapshot.imageWidth, snapshot.imageHeight, snapshot.composition)
            : null;

        fileMeta.hidden = !snapshot.originalImage;
        if (snapshot.originalImage) {
            fileName.textContent = snapshot.fileName;
            fileDims.textContent = `${composed.width} × ${composed.height}`;
        }
        empty.hidden = Boolean(snapshot.originalImage);

        if (exportViews && snapshot.activeTool === 'export') {
            exportViews.dims.textContent = composed
                ? `${composed.width} × ${composed.height} px`
                : 'Open a photo first';
            exportViews.status.textContent = snapshot.status.text;
            exportViews.status.classList.toggle('is-error', snapshot.status.type === 'error');
            exportViews.status.classList.toggle('is-success', snapshot.status.type === 'success');
            exportViews.button.disabled = Boolean(snapshot.exporting) || !snapshot.originalImage;
            exportViews.button.textContent = snapshot.exporting ? 'Exporting…' : 'Export';
            // Task 04 (§19): disabling the button during export blurs it — put
            // focus back only if nothing else claimed it meanwhile.
            if (lastExporting && !snapshot.exporting && document.activeElement === document.body) {
                exportViews.button.focus();
            }
            lastExporting = Boolean(snapshot.exporting);
        }

        if (rotationView) {
            rotationView.textContent = `${snapshot.composition.rotation}°`;
        }

        const compKey = composeKey(snapshot.composition);
        if (compKey !== lastCompKey) {
            lastCompKey = compKey;
            if (resizeViews) populateResize();
        }

        // Crop overlay: active only on the crop tool with an image loaded;
        // follows every zoom/size/composition change.
        cropCtl.setActive(snapshot.activeTool === 'crop' && Boolean(snapshot.originalImage));
        cropCtl.refresh();

        // Text overlay: active only on the text tool with an image loaded.
        textCtl.setActive(snapshot.activeTool === 'text' && Boolean(snapshot.originalImage));
        if (snapshot.activeTool === 'text') textCtl.sync(snapshot);
        textCtl.refresh();

        // Mask overlay: active only on the mask tool with an image loaded;
        // repaints tint/cursor on every state, zoom or resize change.
        maskCtl.setActive(snapshot.activeTool === 'mask' && Boolean(snapshot.originalImage));
        maskCtl.refresh();

        syncAdjustments(snapshot);
    }

    toolrail.addEventListener('click', (event) => {
        const button = event.target.closest('[data-tool]');
        if (!button) return;
        state.set({ activeTool: button.dataset.tool });
    });

    // Presets rewrite EditorState only — sliders, preview and export all follow,
    // and every control stays editable afterwards (non-destructive). The look
    // controller owns the transaction so presets and resets stay in one place.
    panel.addEventListener('click', (event) => {
        const button = event.target.closest('[data-preset]');
        if (!button) return;
        // Step 13: built-ins first, browser-saved custom looks second.
        const preset = findPreset(button.dataset.preset) || getPreset(button.dataset.preset);
        if (!preset) return;
        gradeCtl.applyPreset(preset);
        // Task 03: mark the applied look (state only — apply is unchanged).
        clearActivePresets();
        button.classList.add('is-active');
        button.setAttribute('aria-current', 'true');
    });

    refs.openButton.addEventListener('click', onOpen);
    refs.resetButton.addEventListener('click', onReset);
    refs.panelButton.addEventListener('click', () => app.classList.toggle('panel-open'));
    refs.exportButton.addEventListener('click', () => state.set({ activeTool: 'export' }));

    // --- Step 10: undo/redo shortcuts (§56). Text-entry targets keep their
    // native undo — only the editor's own controls trigger history.
    const FREE_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'color', 'file', 'button', 'submit', 'reset', 'image']);

    function isTextEntry(target) {
        if (!(target instanceof Element)) return false;
        if (target.isContentEditable) return true;
        const tag = target.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !FREE_INPUT_TYPES.has((target.type || 'text').toLowerCase());
        return false;
    }

    document.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const undo = key === 'z' && !event.shiftKey;
        const redo = (key === 'z' && event.shiftKey) || key === 'y';
        if (!undo && !redo) return;
        if (isTextEntry(event.target)) return;
        event.preventDefault();
        if (undo) history.undo();
        else history.redo();
    });

    return {
        sync,

        // Step 11: brush handle (debug/tests, same contract as __history).
        mask: maskCtl,

        // Catalog finished loading → refresh a text panel that is open now.
        refreshFonts() {
            if (panel.dataset.tool === 'text') textCtl.rebuildFonts();
        },
    };
}
