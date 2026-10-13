// TR 24027 Fairness Classifier — API proxy
//
// Forwards requests from the browser tool to the model providers, using the visitor's own API key.
// Deployed as a Vercel Function through ../api/proxy.js; run locally with ../dev-server.mjs.
// This file is also served as a plain static file (/proxy/handler.js), so anyone can compare
// its SHA-256 fingerprint with the one published for the deployment.
//
// What it does, and nothing else:
//   GET  /health    status, version, allow-list, whether encoding is available
//   GET  /key       public key (RSA-OAEP, SHA-256) for encoded requests
//   POST /forward   forward one request to an allowed provider and return the provider's answer
//
// Guarantees, visible in this file:
//   * It only forwards to hosts in ALLOWED_HOSTS (not an open proxy).
//   * It only passes a fixed list of request headers (API keys, content type, API version).
//   * It never writes request or response content, or keys, to any log or storage.
//   * Encoded requests are decoded in memory only; the answer is encoded with the same one-time key.
//
// Settings (Vercel environment variables):
//   PRIVATE_KEY_JWK     RSA private key (JSON Web Key) for encoded requests. Without it, encoding is off.
//   ALLOWED_HOSTS       comma-separated hosts; default: the three providers below
//   ALLOWED_ORIGINS     comma-separated web origins allowed to call the proxy, or * (default)
//   MAX_BODY_BYTES      largest request accepted (default 200000)
//   RATE_LIMIT_PER_MIN  requests per minute per client address (default 120; 0 = off)

export const PROXY_VERSION = "1.5.0";
export const DEFAULT_ALLOWED_HOSTS = ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"];
const FORWARD_HEADERS = ["content-type", "x-api-key", "anthropic-version", "anthropic-beta", "authorization", "x-goog-api-key", "openai-organization", "openai-project"];
const RESPONSE_HEADERS = ["content-type", "retry-after"];

const b64 = {
  enc(bytes) {
    let s = "";
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  },
};

function settings(env = {}) {
  const list = (v, d) => (v ? String(v).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : d);
  return {
    hosts: list(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    origins: list(env.ALLOWED_ORIGINS, ["*"]),
    maxBody: Number(env.MAX_BODY_BYTES) || 200000,
    rate: env.RATE_LIMIT_PER_MIN === undefined ? 120 : Number(env.RATE_LIMIT_PER_MIN),
    privateJwk: env.PRIVATE_KEY_JWK ? (typeof env.PRIVATE_KEY_JWK === "string" ? JSON.parse(env.PRIVATE_KEY_JWK) : env.PRIVATE_KEY_JWK) : null,
  };
}

function cors(request, cfg) {
  const origin = request.headers.get("origin");
  const allow = cfg.origins.includes("*") ? "*" : origin && cfg.origins.includes(origin.toLowerCase()) ? origin : null;
  const h = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "retry-after, x-proxy",
    "access-control-max-age": "600",
    vary: "Origin",
    "x-proxy": `tr24027-proxy/${PROXY_VERSION}`,
  };
  if (allow) h["access-control-allow-origin"] = allow;
  return { headers: h, allowed: !!allow || !origin };
}

const json = (obj, status, extra) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const proxyError = (status, message, extra) => json({ error: { type: "proxy_error", message } }, status, extra);

// Per-address request counter, kept in memory only (resets when the process restarts).
const hits = new Map();
function rateLimited(ip, perMin) {
  if (!perMin) return false;
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > 60000) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 10000) hits.clear();
    return false;
  }
  return ++h.n > perMin;
}

let keyCache = null;
async function keys(cfg) {
  if (!cfg.privateJwk) return null;
  if (keyCache && keyCache.n === cfg.privateJwk.n) return keyCache;
  const { d, p, q, dp, dq, qi, ...pub } = cfg.privateJwk;
  const publicJwk = { kty: "RSA", n: pub.n, e: pub.e, alg: "RSA-OAEP-256", ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", { ...cfg.privateJwk, alg: "RSA-OAEP-256", key_ops: ["decrypt"] }, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const kid = b64.enc(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pub.n))).slice(0, 16);
  keyCache = { n: cfg.privateJwk.n, publicJwk: { ...publicJwk, kid }, privateKey, kid };
  return keyCache;
}

function checkTarget(spec, cfg) {
  if (!spec || typeof spec.url !== "string") return "Missing target URL.";
  let u;
  try {
    u = new URL(spec.url);
  } catch (_) {
    return "Target URL is not valid.";
  }
  if (u.protocol !== "https:") return "Only https targets are allowed.";
  if (!cfg.hosts.includes(u.hostname.toLowerCase())) return `Host ${u.hostname} is not on this proxy's allow-list.`;
  const m = (spec.method || "POST").toUpperCase();
  if (m !== "GET" && m !== "POST") return "Only GET and POST are allowed.";
  return null;
}

async function forward(spec, fetchImpl) {
  const headers = {};
  for (const [k, v] of Object.entries(spec.headers || {})) if (FORWARD_HEADERS.includes(k.toLowerCase()) && typeof v === "string") headers[k.toLowerCase()] = v;
  const method = (spec.method || "POST").toUpperCase();
  const res = await fetchImpl(spec.url, { method, headers, body: method === "POST" ? (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {})) : undefined });
  const out = { status: res.status, headers: {}, body: await res.text() };
  for (const h of RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) out.headers[h] = v;
  }
  return out;
}

async function readBody(request, cfg) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > cfg.maxBody) return { error: "Request too large." };
  const text = await request.text();
  if (text.length > cfg.maxBody) return { error: "Request too large." };
  try {
    return { value: JSON.parse(text) };
  } catch (_) {
    return { error: "Request body is not JSON." };
  }
}

export async function handle(request, env = {}, { fetchImpl = fetch, clientIp = null } = {}) {
  const cfg = settings(env);
  const c = cors(request, cfg);
  if (!c.allowed) return proxyError(403, "This web origin may not use this proxy.", c.headers);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && (path === "/health" || path === "/")) {
    const k = await keys(cfg).catch(() => null);
    return json({ ok: true, name: "tr24027-proxy", version: PROXY_VERSION, encoding: !!k, keyId: k?.kid || null, allowedHosts: cfg.hosts, logging: "none" }, 200, c.headers);
  }
  if (request.method === "GET" && path === "/key") {
    const k = await keys(cfg).catch(() => null);
    if (!k) return proxyError(404, "Encoding is not set up on this proxy.", c.headers);
    return json(k.publicJwk, 200, c.headers);
  }
  if (request.method !== "POST" || path !== "/forward") return proxyError(404, "Not found. Use GET /health, GET /key or POST /forward.", c.headers);

  const ip = clientIp || request.headers.get("cf-connecting-ip") || "unknown";
  if (rateLimited(ip, cfg.rate)) return proxyError(429, "Too many requests to the proxy. Wait a minute.", { ...c.headers, "retry-after": "20" });

  const body = await readBody(request, cfg);
  if (body.error) return proxyError(413, body.error, c.headers);
  const env1 = body.value;

  // Encoded request: { enc: "v1", kid, wk, iv, ct }
  if (env1 && env1.enc === "v1") {
    const k = await keys(cfg).catch(() => null);
    if (!k) return proxyError(400, "Encoding is not set up on this proxy. Send the request without encoding.", c.headers);
    if (env1.kid && env1.kid !== k.kid) return proxyError(409, "The proxy's key has changed. Reload the proxy key in the tool.", c.headers);
    let aes, spec;
    try {
      const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, k.privateKey, b64.dec(env1.wk));
      aes = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(env1.iv) }, aes, b64.dec(env1.ct));
      spec = JSON.parse(new TextDecoder().decode(plain));
    } catch (_) {
      return proxyError(400, "Could not decode the request.", c.headers);
    }
    const bad = checkTarget(spec, cfg);
    if (bad) return proxyError(403, bad, c.headers);
    let out;
    try {
      out = await forward(spec, fetchImpl);
    } catch (_) {
      return proxyError(502, "The provider could not be reached.", c.headers);
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(out)));
    return json({ enc: "v1", iv: b64.enc(iv), ct: b64.enc(ct) }, 200, c.headers);
  }

  // Plain request: { url, method, headers, body }
  const bad = checkTarget(env1, cfg);
  if (bad) return proxyError(403, bad, c.headers);
  let out;
  try {
    out = await forward(env1, fetchImpl);
  } catch (_) {
    return proxyError(502, "The provider could not be reached.", c.headers);
  }
  return new Response(out.body, { status: out.status, headers: { "cache-control": "no-store", ...out.headers, ...c.headers } });
}

