// Font subsystem constants — single source of truth for weight/style choices,
// categories and the manifest location (§7, §8).

export const MANIFEST_URL = '/fonts/manifest.json';

// Supported weight/style combos. Only these are ever offered, and only when
// the family actually has them (§8).
export const WEIGHT_CHOICES = Object.freeze([
    { weight: 400, style: 'normal', label: 'Regular' },
    { weight: 500, style: 'normal', label: 'Medium' },
    { weight: 600, style: 'normal', label: 'SemiBold' },
    { weight: 700, style: 'normal', label: 'Bold' },
    { weight: 400, style: 'italic', label: 'Italic' },
    { weight: 700, style: 'italic', label: 'Bold Italic' },
]);

export const ALLOWED_WEIGHTS = Object.freeze([400, 500, 600, 700]);
export const ALLOWED_STYLES = Object.freeze(['normal', 'italic']);

// Built-in system fonts — always present, no files, no loading (§11).
export const SYSTEM_FONTS = Object.freeze([
    { id: 'Inter', label: 'Inter', category: 'sans-serif' },
    { id: 'Arial', label: 'Arial', category: 'sans-serif' },
    { id: 'Georgia', label: 'Georgia', category: 'serif' },
    { id: 'Times New Roman', label: 'Times New Roman', category: 'serif' },
    { id: 'Courier New', label: 'Courier New', category: 'monospace' },
]);

// System fonts ship Regular/Bold/Italic/Bold Italic on every platform; 500/600
// do not exist as real faces, so they are never offered (§8).
export const SYSTEM_VARIANTS = Object.freeze([
    { weight: 400, style: 'normal' },
    { weight: 700, style: 'normal' },
    { weight: 400, style: 'italic' },
    { weight: 700, style: 'italic' },
]);

export const FONT_CATEGORIES = Object.freeze([
    { id: 'all', label: 'All' },
    { id: 'sans-serif', label: 'Sans Serif' },
    { id: 'serif', label: 'Serif' },
    { id: 'display', label: 'Display' },
    { id: 'handwriting', label: 'Handwriting' },
    { id: 'monospace', label: 'Monospace' },
]);
