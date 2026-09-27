// Font catalog — merges the5 built-in system fonts with the locally imported
// manifest families into one searchable list. Inter appears once: the system
// entry gains the local manifest's variants (§11, §14).

import { SYSTEM_FONTS, SYSTEM_VARIANTS } from './fontConfig.js';

export function createFontCatalog(manifest) {
    const entries = SYSTEM_FONTS.map((font) => ({
        ...font,
        local: false,
        variants: [...SYSTEM_VARIANTS],
        source: 'system',
    }));

    for (const family of (manifest && manifest.fonts) || []) {
        const label = family.family;
        const merged = entries.find((e) => e.id.toLowerCase() === family.id);
        if (merged) {
            // Manifest overrides the built-in's variants (real local files).
            merged.local = true;
            merged.variants = family.variants;
            merged.source = family.source;
            merged.license = family.license;
            continue;
        }
        entries.push({
            id: label,
            label,
            category: family.category,
            local: true,
            variants: family.variants,
            source: family.source,
            license: family.license,
        });
    }

    // Built-ins keep their original order (backwards-compatible picker),
    // imported families follow alphabetically.
    const builtinCount = SYSTEM_FONTS.length;
    const imported = entries.slice(builtinCount)
        .sort((a, b) => a.label.localeCompare(b.label));
    const ordered = [...entries.slice(0, builtinCount), ...imported];

    return {
        list: () => ordered,
        find: (label) => ordered.find((e) => e.label === label) || null,
        families: () => ordered.map((e) => e.label),
        search(query, category) {
            const needle = String(query || '').trim().toLowerCase();
            return ordered.filter((e) => (category === 'all' || !category || e.category === category)
                && (!needle || e.label.toLowerCase().includes(needle)));
        },
    };
}
