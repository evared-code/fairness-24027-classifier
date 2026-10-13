// build.mjs — bundles the tool into one self-contained HTML file: dist/tr24027-classifier.html
// The single file opens by double-click (no web server needed) and includes the example datasets.
// Usage: node build.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const ORDER = ["core.js", "transport.js", "providers.js", "runner.js", "report.js", "app.js"]; // dependency order
const EXAMPLES = ["data/ethical-ai-metaverse.json", "data/sample-small.json"];

// Wraps each ES module in its own function scope and wires imports to the earlier modules' exports.
function wrapModule(file, src) {
  const exported = [];
  let code = src.replace(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\/([\w-]+)\.js";/g, (_, names, mod) => `const {${names}} = __mod_${mod};`);
  if (/\bimport\s/.test(code.replace(/\/\/.*$/gm, ""))) throw new Error(`${file}: unsupported import form`);
  code = code.replace(/^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\s/m.test(code)) throw new Error(`${file}: unsupported export form`);
  const id = file.replace(/\.js$/, "").replace(/[^\w]/g, "_");
  return `// ---- ${file} ----\nconst __mod_${id} = (() => {\n${code}\nreturn { ${exported.join(", ")} };\n})();\n`;
}

const js = ORDER.map((f) => wrapModule(f, read(f))).join("\n");
const examples = Object.fromEntries(EXAMPLES.map((f) => [f, JSON.parse(read(f))]));
const css = read("styles.css");
const safe = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");

let html = read("index.html");
html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style id="app-css">\n${css}\n</style>`);
html = html.replace(
  '<script type="module" src="app.js"></script>',
  () => `<script>globalThis.__TR24027_EXAMPLES__ = ${safe(JSON.stringify(examples))};</script>\n<script type="module">\n${safe(js)}\n</script>`
);
if (html.includes('src="app.js"') || html.includes('href="styles.css"')) throw new Error("Build failed: references left in HTML");

mkdirSync(new URL("dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("dist/tr24027-classifier.html", import.meta.url), html);
console.log(`dist/tr24027-classifier.html (${(html.length / 1024).toFixed(0)} KB)`);
