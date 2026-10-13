// Local preview of the Vercel deployment: serves the static tool and runs api/proxy.js at /api/proxy,
// with the same rewrite and security headers as vercel.json. No Vercel account needed.
//
//   npm start                 → http://localhost:3000
//   PORT=4000 npm start
//
// If proxy/private-key.json exists (npm run proxy:keygen), encoded requests are available.
// Like the deployed proxy, it writes nothing about requests to the console or to disk.

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const keyFile = path.join(ROOT, "proxy/private-key.json");
if (!process.env.PRIVATE_KEY_JWK && existsSync(keyFile)) process.env.PRIVATE_KEY_JWK = readFileSync(keyFile, "utf8");

const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const { default: proxy } = await import("./api/proxy.js");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
const HIDDEN = [/^\/\./, /^\/proxy\/private-key\.json$/, /^\/node_modules\//, /^\/test\//];

// Headers from vercel.json whose source matches the path (supports the patterns used there).
function headersFor(p) {
  const out = {};
  for (const rule of vercel.headers || []) {
    const re = new RegExp("^" + rule.source.replace(/\(\.\*\)/g, ".*").replace(/\/\?$/, "/?") + "$");
    if (re.test(p)) for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  try {
    if (url.pathname === "/api/proxy" || url.pathname.startsWith("/api/proxy/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const sub = url.pathname.slice("/api/proxy/".length);
      const target = new URL(url.pathname === "/api/proxy" ? url.href : `/api/proxy?path=${sub}`, url.origin); // = vercel.json rewrite
      const r = await proxy.fetch(new Request(target, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
        body: chunks.length && !["GET", "HEAD", "OPTIONS"].includes(req.method) ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, path.normalize(p));
    if (!file.startsWith(ROOT) || HIDDEN.some((re) => re.test(p)) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", ...headersFor(url.pathname) });
    res.end(readFileSync(file));
  } catch (_) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Server error");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`TR 24027 classifier on http://localhost:${PORT}  (API proxy at /api/proxy, encoding ${process.env.PRIVATE_KEY_JWK ? "on" : "off"})`);
});
