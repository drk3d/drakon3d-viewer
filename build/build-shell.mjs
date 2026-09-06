// build/build-shell.mjs
// Produces www/viewer-shell.html — a fully self-contained, offline-capable
// Drakon3D Viewer with NO external dependencies (three.js, app modules,
// CSS, and coloris are all inlined). The Export Package feature fetches this
// shell at runtime and injects a base64 .rhv payload via window.__RHV_PACKAGE__.
//
// Run:  node build/build-shell.mjs
import { build, transform } from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const www = resolve(root, 'www');
const gemReflectionDataUrl = `data:image/png;base64,${readFileSync(resolve(www, 'assets/diamond-top-view.png')).toString('base64')}`;

// ── 1. Bundle the app (entry: app.js) into a single IIFE ─────────────────────
const result = await build({
  entryPoints: [resolve(www, 'app.js')],
  bundle: true,
  // ESM (not IIFE): inlined as <script type="module">, which is deferred like
  // the original app.js module — so the DOM is fully parsed before init() runs.
  // It also makes import.meta.url valid (used by the cloud OAuth modules).
  format: 'esm',
  minify: true,
  write: false,
  legalComments: 'none',
  alias: {
    // three-mesh-bvh is a local prebuilt module, not an npm dep
    'three-mesh-bvh': resolve(www, 'libs/three-mesh-bvh.js'),
  },
  define: {
    // Keep exported single-file viewer packages visually identical to the
    // hosted Viewer; the normal web app loads this asset as a separate file.
    __DRAKON_GEM_REFLECTION_URL__: JSON.stringify(gemReflectionDataUrl),
  },
  logLevel: 'info',
});

// A literal "</script>" anywhere in an inlined script body (inside a JS string
// or regex) makes the HTML parser close the <script> tag early, dumping the
// rest of the bundle as visible page text. Escaping the slash ("<\/script") is
// equivalent in JS but invisible to the HTML tokenizer. Same for "<!--".
const escapeForInlineScript = (s) =>
  s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const appBundle = escapeForInlineScript(result.outputFiles[0].text);
console.log(`[build] app bundle: ${(appBundle.length / 1024).toFixed(0)} KB`);

// ── 2. Inline assets (style.css is minified via esbuild; coloris is already min)
const css        = (await transform(readFileSync(resolve(www, 'style.css'), 'utf8'), { loader: 'css', minify: true })).code;
const colorisCss = readFileSync(resolve(www, 'libs/coloris.min.css'), 'utf8');
const colorisJs  = escapeForInlineScript(readFileSync(resolve(www, 'libs/coloris.min.js'), 'utf8'));

// ── 3. Transform index.html into the offline shell ───────────────────────────
let html = readFileSync(resolve(www, 'index.html'), 'utf8');

// Drop the Google Fonts <link> tags (offline → fall back to system fonts).
html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, '');
html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '');

// Drop Noto Sans local font links (offline -> fall back to system fonts)
html = html.replace(/<link href="css\/notosans_(?:multi|kr)\.css"[^>]*>\s*/g, '');

// IMPORTANT: every replacement below uses a FUNCTION replacement (() => value)
// rather than a string. String replacements interpret "$&", "$`", "$'", "$1"…
// patterns — and minified JS/CSS is full of "$&"/"$'" sequences, which would
// otherwise splice fragments of the matched HTML into the inlined asset and
// corrupt it. Function replacements return their value verbatim.

// Inline coloris CSS (replace its <link>)
html = html.replace(
  /<link rel="stylesheet" href="libs\/coloris\.min\.css">/,
  () => `<style id="coloris-css">${colorisCss}</style>`
);

// Inline main style.css (replace its <link>, ignore the ?v= cache buster)
html = html.replace(
  /<link rel="stylesheet" href="style\.css[^"]*">/,
  () => `<style id="app-css">${css}</style>`
);

// Inline coloris JS (replace its <script src>)
html = html.replace(
  /<script src="libs\/coloris\.min\.js"><\/script>/,
  () => `<script id="coloris-js">${colorisJs}</script>`
);

// Remove the rhino3dm script — the shell only ever loads embedded GLB,
// never raw .3dm, so the WASM parser is dead weight (and its local
// libs/rhino3dm.wasm wouldn't ship inside the single-file export anyway).
html = html.replace(
  /<script src="libs\/rhino3dm\.min\.js"><\/script>\s*/,
  ''
);

// Remove the importmap (all bare specifiers are now bundled away)
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');

// Replace the ES-module entry <script type="module" src="app.js"> with the
// inlined bundle. A __RHV_PACKAGE__ placeholder is injected just before it so
// the Export Package output can carry its model inline.
html = html.replace(
  /<script type="module" src="app\.js"><\/script>/,
  () => `<script id="rhv-package">/*__RHV_PACKAGE__*/</script>\n<script type="module" id="app-bundle">${appBundle}</script>`
);

// ── 4. Minify the HTML markup ────────────────────────────────────────────────
// Collapses indentation/newlines and strips HTML comments so the markup isn't
// trivially human-readable. minifyJS/minifyCSS are OFF: the inlined bundle is
// already esbuild-minified (and must NOT be re-touched — that could break the
// /*__RHV_PACKAGE__*/ placeholder), and the CSS was minified above.
// conservativeCollapse keeps a single space between inline elements so the UI
// layout (spacing between inline spans) is preserved.
const beforeKB = (html.length / 1024).toFixed(0);
html = await minifyHtml(html, {
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  minifyJS: false,
  minifyCSS: false,
  keepClosingSlash: true,
  caseSensitive: true,
});
html = html.trimEnd();

writeFileSync(resolve(www, 'viewer-shell.html'), html, 'utf8');
console.log(`[build] wrote www/viewer-shell.html (${beforeKB} KB → ${(html.length / 1024).toFixed(0)} KB minified)`);
