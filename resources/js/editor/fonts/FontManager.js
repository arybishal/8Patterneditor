// Font manager — facade the app wires once: fetches the local manifest at
// boot (no network beyond this origin, no API keys, no Google requests at
// runtime), owns catalog + loader, tracks the loading/failure hint state, and
// notifies listeners so the preview re-renders when a face lands (§15, §16).

import { MANIFEST_URL } from './fontConfig.js';
import { createFontCatalog } from './FontCatalog.js';
import { createFontLoader } from './FontLoader.js';
import { registerFontStack } from '../text/TextRenderer.js';

export function createFontManager() {
    const loader = createFontLoader();
    let catalog = createFontCatalog(null);
    let hint = ''; // '' | 'Loading font…' | "Couldn't load this font. Using a fallback."
    let inFlight = 0; // fresh loads still pending — the hint must not clear while one runs
    const listeners = new Set();

    function emit() {
        for (const cb of listeners) cb();
    }

    function setHint(next) {
        if (hint === next) return;
        hint = next;
        emit();
    }

    async function init() {
        try {
            const res = await fetch(MANIFEST_URL, { cache: 'default' });
            if (!res.ok) throw new Error(`manifest ${res.status}`);
            const manifest = await res.json();
            catalog = createFontCatalog(manifest);
            for (const entry of catalog.list()) {
                registerFontStack(entry.label, entry.category);
            }
        } catch {
            // Offline / missing manifest → built-ins only, editor stays usable.
            catalog = createFontCatalog(null);
        }
        emit();
        return catalog;
    }

    async function ensure(family, weight = 400, style = 'normal') {
        const entry = catalog.find(family);
        if (!entry || !entry.local) return 'ready';
        const fresh = !loader.has(family, weight, style);
        const pending = loader.ensure(entry, weight, style);
        if (fresh) {
            inFlight += 1;
            setHint('Loading font…');
        }
        const result = await pending;
        if (fresh) inFlight = Math.max(0, inFlight - 1);
        if (result === 'fallback') {
            setHint("Couldn't load this font. Using a fallback.");
        } else if (inFlight === 0) {
            setHint(''); // only the last load out may clear the hint
        }
        return result;
    }

    async function ensureLayers(layers) {
        const seen = new Set();
        for (const layer of layers || []) {
            const k = `${layer.fontFamily}|${layer.fontWeight || 400}|${layer.fontStyle || 'normal'}`;
            if (seen.has(k)) continue;
            seen.add(k);
            await ensure(layer.fontFamily, layer.fontWeight || 400, layer.fontStyle || 'normal');
        }
    }

    return {
        init,
        ensure,
        ensureLayers,
        hint: () => hint,
        onChange: (cb) => listeners.add(cb),
        catalog: () => catalog,
        find: (family) => catalog.find(family),
        families: () => catalog.families(),
        search: (query, category) => catalog.search(query, category),
        // Combos actually available for a family (§8 — never fabricate variants).
        hasVariant(family, weight, style) {
            const entry = catalog.find(family);
            if (!entry) return true;
            return entry.variants.some((v) => v.weight === weight && v.style === style);
        },
    };
}
