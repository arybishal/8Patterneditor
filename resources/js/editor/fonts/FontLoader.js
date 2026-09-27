// Font loading — lazy FontFace creation keyed family + weight + style, with an
// in-memory cache so a variant is fetched/decoded at most once per session.
// Failures resolve to 'fallback' (never throw at callers): the renderer's
// fallback stack keeps drawing while the caller shows the fallback hint (§16).

function key(family, weight, style) {
    return `${family}|${weight}|${style}`;
}

export function createFontLoader() {
    const cache = new Map(); // key → Promise<'ready' | 'fallback'>

    async function loadVariant(entry, variant) {
        const faces = variant.files.map((file) => new FontFace(
            entry.label,
            `url("${file.file}") format("woff2")`,
            {
                weight: String(variant.weight),
                style: variant.style,
                unicodeRange: file.unicodeRange || undefined,
                display: 'swap',
            },
        ));
        await Promise.all(faces.map((face) => face.load()));
        for (const face of faces) document.fonts.add(face);
    }

    function ensure(entry, weight, style) {
        const cacheKey = key(entry.label, weight, style);
        const hit = cache.get(cacheKey);
        if (hit) return hit;

        const variant = (entry.variants || []).find(
            (v) => v.weight === weight && v.style === style,
        );
        if (!variant) {
            // Requested combo does not exist for this family — caller falls back.
            console.warn('Font variant unavailable:', entry.label, weight, style);
            const absent = Promise.resolve('fallback');
            cache.set(cacheKey, absent);
            return absent;
        }

        const promise = loadVariant(entry, variant)
            .then(() => 'ready')
            .catch((err) => {
                console.warn('Font load failed:', entry.label, weight, style, err && err.message);
                return 'fallback';
            });
        cache.set(cacheKey, promise);
        return promise;
    }

    return {
        ensure,
        has: (family, weight, style) => cache.has(key(family, weight, style)),
    };
}
