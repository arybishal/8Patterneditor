// Cinematic presets — technical starter set (Step 12 look system).
// Shape: { name, adjustments, effects, colorGrade }. Values are full
// snapshots merged over the defaults at apply time; application goes through
// EditorState.applyPreset (one history transaction, §12.4) so the UI, preview
// and export all follow the same single source of truth.

import { DEFAULT_ADJUSTMENTS, DEFAULT_EFFECTS } from './state/EditorState.js';
import { DEFAULT_COLOR_GRADE } from './color/ColorGradeState.js';

function preset(name, adjustments, effects, colorGrade) {
    return Object.freeze({
        name,
        adjustments: Object.freeze({ ...DEFAULT_ADJUSTMENTS, ...adjustments }),
        effects: Object.freeze({ ...DEFAULT_EFFECTS, ...effects }),
        colorGrade: Object.freeze({ ...DEFAULT_COLOR_GRADE, ...colorGrade }),
    });
}

export const PRESETS = Object.freeze([
    preset('Clean', {}, {}),
    preset('Faded Film', { contrast: -15 }, { fade: 35, vignette: 25, grain: 20, dust: 10, scratches: 6 }),
    preset('Vintage', { saturation: -30, temperature: 35 },
        { fade: 40, vignette: 30, grain: 30, dust: 25, scratches: 20, lightLeak: 15 }),
    // Step 12 (§12.4): a small set of useful cinematic looks — every value
    // serializable state, no extreme settings.
    preset('Neutral', {}, {}, { intensity: 100 }),
    preset('Warm Film', { temperature: 18, contrast: 8, saturation: -8 },
        { fade: 18, grain: 14 },
        { highlightWarmth: 35, midtonesHue: 6, shadowCoolness: -10 }),
    preset('Cool Film', { temperature: -20, contrast: 6, saturation: -5 },
        { fade: 14, grain: 12 },
        { shadowCoolness: 40, highlightWarmth: -15, midtonesHue: -8 }),
    preset('Vintage Print', { saturation: -22, temperature: 25, contrast: -8 },
        { fade: 30, vignette: 28, grain: 22, dust: 18, scratches: 10 },
        { highlightsHue: 12, shadowsSat: -18, highlightWarmth: 30, intensity: 90 }),
    preset('Cinematic Contrast', { contrast: 28, saturation: -6, exposure: -4 },
        { vignette: 35 },
        { colorBalance: -10, splitTone: 35, shadowCoolness: 25, midtonesSat: 8 }),
    preset('Faded Cinema', { contrast: -12, saturation: -12 },
        { fade: 45, vignette: 18, grain: 16 },
        { intensity: 70, colorBalance: 10, splitTone: 20, shadowsSat: -15 }),
]);

export function findPreset(name) {
    return PRESETS.find((p) => p.name === name) || null;
}
