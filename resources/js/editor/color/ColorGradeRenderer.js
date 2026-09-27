// Step 12: pipeline glue for the grade — a stable cache signature and a
// guarded apply. Preview and export both call through here, so the cache key
// and the render can never disagree about what "the grade" contains (§12.6).

import { applyColorGrade, gradeIdle } from './ColorGradeEngine.js';
import { COLOR_GRADE_CONTROLS } from './ColorGradeState.js';

// Deterministic cache key contribution: control order is fixed by config,
// so two grades stringify alike exactly when they render alike.
export function gradeSignature(grade) {
    if (gradeIdle(grade)) return '';
    return COLOR_GRADE_CONTROLS.map((c) => grade[c.key] ?? 0).join(',');
}

// The single entry point both pipeline paths use (preview getProcessedImage
// and full-resolution renderFull). Idle grades are a no-op — zero cost.
export function renderGrade(data, width, height, grade) {
    if (gradeIdle(grade)) return;
    applyColorGrade(data, width, height, grade);
}
