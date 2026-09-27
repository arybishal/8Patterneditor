#!/usr/bin/env node
// Google Fonts → local WOFF2 importer (development-time only).
//
//   npm run fonts:import -- Inter Roboto "Playfair Display"   import families
//   npm run fonts:import -- --list [--search=term]            browse catalog
//
// Sources (all official, all documented):
//   • css2 API  — @font-face metadata + local-delivery WOFF2 file URLs (keyless)
//   • google/fonts repo METADATA.pb / OFL.txt — category + license (keyless)
//   • webfonts Developer API — catalog browsing for --list (GOOGLE_FONTS_API_KEY)
//
// The API key is read from the environment (or the project .env) and is NEVER
// written to any file in the repository. The editor runtime never sees it.
//
// Idempotent: stable filenames, valid existing files are skipped, manifest is
// rebuilt deterministically (no timestamps) so repeated runs produce identical
// output. Downloads are allowlisted to fonts.gstatic.com and validated as
// WOFF2 before they ever replace an existing file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'fonts');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CSS2 = 'https://fonts.googleapis.com/css2';
const GFONTS_RAW = 'https://raw.githubusercontent.com/google/fonts/main';
const GSTATIC_PREFIX = 'https://fonts.gstatic.com/';

// §8 — only these variants are ever requested/kept, and only when the source
// actually offers them (css2 answers 400 for unavailable combinations).
const VARIANT_ATTEMPTS = [
    'ital,wght@0,400;0,500;0,600;0,700;1,400;1,700',
    'ital,wght@0,400;0,700;1,400;1,700',
    'wght@400;500;600;700',
    'wght@400;700',
    'wght@400',
    '',
];
const ALLOWED_WEIGHTS = new Set([400, 500, 600, 700]);
const ALLOWED_STYLES = new Set(['normal', 'italic']);
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,49}$/;
const CATEGORY_MAP = {
    SANS_SERIF: 'sans-serif',
    SERIF: 'serif',
    DISPLAY: 'display',
    HANDWRITING: 'handwriting',
    MONOSPACE: 'monospace',
};

function fail(msg) {
    console.error(`Font import failed. ${msg}`);
    process.exitCode = 1;
}

function slug(family) {
    // google/fonts stores folders without separators: "Playfair Display" → playfairdisplay
    return family.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function get(url, as = 'text') {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const ok = res.ok;
    const body = as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { ok, status: res.status, body, type: res.headers.get('content-type') || '' };
}

// raw.githubusercontent occasionally flaps on bursts — one short retry keeps
// license probes from silently dropping files. retry404 is only passed where a
// 404 could be a flap (existing file); expected misses stay fast.
async function getRetry(url, as = 'text', retry404 = false) {
    let res = await get(url, as);
    if (!res.ok && (res.status >= 500 || res.status === 429 || (retry404 && res.status === 404))) {
        await new Promise((r) => setTimeout(r, 400));
        res = await get(url, as);
    }
    return res;
}

function isWoff2(buf) {
    return buf.length > 512 && buf.slice(0, 4).toString('ascii') === 'wOF2';
}

// --- official google/fonts metadata (category + license) --------------------
async function fetchMetadata(family) {
    const id = slug(family);
    for (const folder of ['ofl', 'apache', 'ufl']) {
        const base = `${GFONTS_RAW}/${folder}/${id}`;
        const meta = await getRetry(`${base}/METADATA.pb`);
        if (!meta.ok) continue;
        const categoryRaw = /^category:\s*"([A-Z_]+)"/m.exec(meta.body)?.[1] || '';
        const license = /^license:\s*"([^"]+)"/m.exec(meta.body)?.[1] || '';
        const category = CATEGORY_MAP[categoryRaw] || 'sans-serif';
        let licenseText = '';
        for (const lic of ['OFL.txt', 'Apache.txt', 'UFL.txt']) {
            const txt = await getRetry(`${base}/${lic}`, 'text', true);
            if (txt.ok && txt.body.trim()) {
                licenseText = txt.body;
                break;
            }
        }
        return { ok: true, folder, category, license: license || 'requires-verification', licenseText };
    }
    return { ok: false };
}

// --- css2: variant discovery + woff2 URLs -----------------------------------
async function fetchCss2(family) {
    for (const variantQuery of VARIANT_ATTEMPTS) {
        const familyParam = variantQuery ? `${family}:${variantQuery}` : family;
        const url = `${CSS2}?family=${encodeURIComponent(familyParam)}&display=swap`;
        const res = await get(url);
        if (res.ok && res.body.includes('@font-face')) return res.body;
    }
    return null;
}

function parseCss2(css) {
    const variants = new Map(); // key `weight-style` -> { weight, style, files: [] }
    const blockRe = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let m;
    while ((m = blockRe.exec(css))) {
        const subset = m[1];
        const block = m[2];
        if (!KEEP_SUBSETS.has(subset)) continue;
        const weight = Number(/(?:^|\n)\s*font-weight:\s*(\d+)/.exec(block)?.[1]);
        const style = /(?:^|\n)\s*font-style:\s*(\w+)/.exec(block)?.[1];
        const fileUrl = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1];
        const unicodeRange = /(?:^|\n)\s*unicode-range:\s*(.+)/.exec(block)?.[1]?.trim().replace(/;+\s*$/, '') || '';
        if (!ALLOWED_WEIGHTS.has(weight) || !ALLOWED_STYLES.has(style) || !fileUrl) continue;
        const key = `${weight}-${style}`;
        if (!variants.has(key)) variants.set(key, { weight, style, files: [] });
        variants.get(key).files.push({ subset, fileUrl, unicodeRange });
    }
    return [...variants.values()]
        .sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style));
}

async function downloadWoff2(fileUrl, dest) {
    if (!fileUrl.startsWith(GSTATIC_PREFIX)) return 'blocked-url';
    if (fs.existsSync(dest)) {
        const existing = fs.readFileSync(dest);
        if (isWoff2(existing)) return 'exists';
        fs.unlinkSync(dest); // corrupt → replace
    }
    const res = await get(fileUrl, 'buffer');
    if (!res.ok || !isWoff2(res.body)) return 'invalid';
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, res.body);
    fs.renameSync(tmp, dest);
    return 'downloaded';
}

// --- manifest ----------------------------------------------------------------
function loadManifest() {
    try {
        const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
        return Array.isArray(parsed.fonts) ? parsed.fonts : [];
    } catch {
        return [];
    }
}

function writeManifest(fonts) {
    const deduped = new Map();
    for (const f of fonts) {
        const filesOk = f.variants.every((v) => v.files.every((file) => fs.existsSync(path.join(ROOT, 'public', file.file))));
        if (filesOk) deduped.set(f.id, f);
    }
    const ordered = [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const f of ordered) {
        f.variants.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style));
    }
    const manifest = { version: 1, fonts: ordered };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    return ordered;
}

// --- import one family -------------------------------------------------------
async function importFamily(family) {
    family = family.trim();
    if (!FAMILY_RE.test(family) || family.includes('..')) {
        fail(`"${family}" is not a valid family name.`);
        return null;
    }
    console.log(`\n→ ${family}`);

    const meta = await fetchMetadata(family);
    if (!meta.ok) {
        fail(`${family}: no metadata found in the official google/fonts repository.`);
        return null;
    }
    const css = await fetchCss2(family);
    if (!css) {
        fail(`${family}: no supported variants available from the Google Fonts css2 API.`);
        return null;
    }
    const variants = parseCss2(css);
    if (!variants.length) {
        fail(`${family}: no supported 400–700 normal/italic latin variants found.`);
        return null;
    }

    const id = slug(family);
    const dirName = family; // validated by FAMILY_RE (no path separators)
    const dir = path.join(OUT_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });

    if (meta.licenseText && !fs.existsSync(path.join(dir, 'LICENSE.txt'))) {
        fs.writeFileSync(path.join(dir, 'LICENSE.txt'), meta.licenseText);
    }

    let downloaded = 0;
    let existing = 0;
    const outVariants = [];
    for (const variant of variants) {
        const files = [];
        for (const file of [...variant.files].sort((a, b) => a.subset.localeCompare(b.subset))) {
            const suffix = file.subset === 'latin' ? '' : `-${file.subset}`;
            const name = `${id}-${variant.weight}-${variant.style}${suffix}.woff2`;
            const dest = path.join(dir, name);
            const result = await downloadWoff2(file.fileUrl, dest);
            if (result === 'downloaded') downloaded++;
            else if (result === 'exists') existing++;
            else {
                fail(`${family}: ${result} for ${name} — existing file kept untouched.`);
                return null;
            }
            files.push({ subset: file.subset, file: `/fonts/${dirName}/${name}`, unicodeRange: file.unicodeRange });
        }
        outVariants.push({ weight: variant.weight, style: variant.style, files });
    }

    const entry = {
        id,
        family,
        category: meta.category,
        source: 'google-fonts',
        license: meta.license,
        variants: outVariants,
    };
    if (fs.existsSync(path.join(dir, 'LICENSE.txt'))) entry.licenseFile = `/fonts/${dirName}/LICENSE.txt`;

    console.log(`  ${outVariants.length} variants, ${downloaded} downloaded, ${existing} reused`);
    return entry;
}

// --- catalog listing (Developer API, key from env only) ----------------------
function apiKey() {
    if (process.env.GOOGLE_FONTS_API_KEY) return process.env.GOOGLE_FONTS_API_KEY.trim();
    try {
        const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
        const m = /^GOOGLE_FONTS_API_KEY\s*=\s*(.+)$/m.exec(env);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* no .env */ }
    return '';
}

async function listCatalog(search) {
    const key = apiKey();
    if (!key) {
        fail('--list needs GOOGLE_FONTS_API_KEY (in the environment or .env). '
            + 'Direct import by family name works without a key: fonts:import Inter Roboto');
        return;
    }
    const url = `https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${encodeURIComponent(key)}`;
    const res = await get(url);
    if (!res.ok) {
        fail(`catalog request rejected (${res.status}).`);
        return;
    }
    let items;
    try {
        items = JSON.parse(res.body).items || [];
    } catch {
        fail('catalog response was not valid JSON.');
        return;
    }
    const q = (search || '').toLowerCase();
    const hits = items
        .filter((f) => !q || f.family.toLowerCase().includes(q) || (f.category || '').toLowerCase().includes(q))
        .slice(0, 60);
    console.log(`${hits.length} families${q ? ` matching "${search}"` : ''}:\n`);
    for (const f of hits) console.log(`  ${f.family}  [${f.category}]`);
    console.log('\nImport with: npm run fonts:import -- "Family Name" …');
}

// --- cli ---------------------------------------------------------------------
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
    console.log('Usage:\n  npm run fonts:import -- Inter Roboto "Playfair Display"\n  npm run fonts:import -- --list [--search=term]');
} else if (args[0] === '--list') {
    const searchArg = args.find((a) => a.startsWith('--search='));
    await listCatalog(searchArg ? searchArg.slice('--search='.length) : '');
} else {
    const previous = loadManifest();
    const imported = [];
    for (const name of args) {
        const entry = await importFamily(name);
        if (entry) {
            imported.push(entry);
            previous.push(entry);
        }
    }
    if (imported.length) {
        const ordered = writeManifest(previous);
        console.log(`\nManifest: ${ordered.length} families in ${path.relative(ROOT, MANIFEST)}`);
        console.log(`Imported ${imported.length}/${args.length} families.`);
    } else if (!process.exitCode) {
        fail('nothing was imported.');
    }
}
