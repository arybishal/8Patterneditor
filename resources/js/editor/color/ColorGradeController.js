// Step 12: application-side color grade behavior — the one place that turns
// look changes into history transactions (§12.4, §12.5). UI buttons and the
// shared preset handler both go through this controller, so applying a look
// is always exactly one labeled entry and a no-op reset never records one
// (HistoryManager.commit() drops entries whose key did not change).

export function createColorGradeController({ state, history }) {
    function applyPreset(preset) {
        // One labeled history entry per preset (§62), not one per changed key.
        history.begin(`Preset: ${preset.name}`);
        state.applyPreset(preset);
        history.commit();
        state.setStatus(`Preset “${preset.name}” applied — every slider stays editable.`);
    }

    function resetGrade() {
        history.begin('Reset Color Grade');
        state.resetColorGrade();
        history.commit();
        state.setStatus('Color grade reset — adjustments and effects are untouched.');
    }

    function resetAllLook() {
        history.begin('Reset All Look');
        state.resetLook();
        history.commit();
        state.setStatus('Look reset — adjustments, effects and color grade are back to defaults.');
    }

    return { applyPreset, resetGrade, resetAllLook };
}
