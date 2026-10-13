// scripts/vercel-public.mjs — copies the static site into public/ for Vercel (vercel.json: outputDirectory "public").
// The API proxy is not copied: Vercel builds api/proxy.js as a function from the repository root.
// The proxy secret key is never copied.
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";

const OUT = "public";
const FILES = ["index.html", "styles.css", "app.js", "core.js", "transport.js", "providers.js", "runner.js", "report.js",
  "README.md", "LICENSE", "proxy/handler.js"];
const DIRS = ["data", "docs", "dist"];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT + "/proxy", { recursive: true });
for (const f of FILES) cpSync(f, `${OUT}/${f}`);
for (const d of DIRS) if (existsSync(d)) cpSync(d, `${OUT}/${d}`, { recursive: true });
if (existsSync(`${OUT}/proxy/private-key.json`)) throw new Error("private key must not be published");
console.log(`public/ ready: ${FILES.length} files, ${DIRS.join(", ")}`);
