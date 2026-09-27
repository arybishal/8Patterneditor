// Step 12: color grading state — serializable controls only, no pixels.
// Defaults are identity: every value 0 except intensity 100, so a fresh
// (or untouched) grade produces exactly the pre-Step-12 image.

export const DEFAULT_COLOR_GRADE = Object.freeze({
    shadowsHue: 0,
    shadowsSat: 0,
    midtonesHue: 0,
    midtonesSat: 0,
    highlightsHue: 0,
    highlightsSat: 0,
    intensity: 100,
    colorBalance: 0,
    vibrance: 0,
    splitTone: 0,
    highlightWarmth: 0,
    shadowCoolness: 0,
});

// Safe ranges only — no extreme defaults, every control bipolar except
// intensity (a master strength, 0 = grade off, 100 = full grade).
export const COLOR_GRADE_CONTROLS = Object.freeze([
    { key: 'shadowsHue', label: 'Shadows Hue', min: -100, max: 100, step: 1 },
    { key: 'shadowsSat', label: 'Shadows Saturation', min: -100, max: 100, step: 1 },
    { key: 'midtonesHue', label: 'Midtones Hue', min: -100, max: 100, step: 1 },
    { key: 'midtonesSat', label: 'Midtones Saturation', min: -100, max: 100, step: 1 },
    { key: 'highlightsHue', label: 'Highlights Hue', min: -100, max: 100, step: 1 },
    { key: 'highlightsSat', label: 'Highlights Saturation', min: -100, max: 100, step: 1 },
    { key: 'intensity', label: 'Grade Intensity', min: 0, max: 100, step: 1 },
    { key: 'colorBalance', label: 'Color Balance', min: -100, max: 100, step: 1 },
    { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
    { key: 'splitTone', label: 'Split Tone', min: -100, max: 100, step: 1 },
    { key: 'highlightWarmth', label: 'Highlight Warmth', min: -100, max: 100, step: 1 },
    { key: 'shadowCoolness', label: 'Shadow Coolness', min: -100, max: 100, step: 1 },
]);

// Zone keys (everything the engine reads as a pixel transform — intensity is
// the master dial, not a zone value).
export const COLOR_GRADE_KEYS = Object.freeze(
    COLOR_GRADE_CONTROLS.map((c) => c.key).filter((k) => k !== 'intensity'),
);

// Clamp + validate one control write; returns null when the update is invalid.
export function sanitizeGradeValue(key, value) {
    const control = COLOR_GRADE_CONTROLS.find((c) => c.key === key);
    if (!control) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(control.max, Math.max(control.min, n));
}
