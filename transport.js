// transport.js — how requests leave the browser: directly to the provider, or via the API proxy,
// with or without encoding. Every request is recorded for the inspector, with API keys masked.

const SECRET_HEADERS = ["x-api-key", "authorization", "x-goog-api-key"];

export function maskSecret(v) {
  const s = String(v || "");
  const bearer = s.startsWith("Bearer ") ? "Bearer " : "";
  const k = s.slice(bearer.length);
  if (!k) return s;
  return `${bearer}${k.slice(0, Math.min(4, Math.floor(k.length / 4)))}…${k.slice(-4)}`;
}

export function maskHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADERS.includes(k.toLowerCase()) ? maskSecret(v) : v;
  return out;
}

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

// Encodes { url, method, headers, body } for the proxy: a one-time AES-GCM key encrypts the request,
// and the proxy's RSA-OAEP public key encrypts that one-time key. Only the proxy can decode it.
export async function encodeRequest(spec, publicJwk) {
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: publicJwk.n, e: publicJwk.e, alg: "RSA-OAEP-256", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", aes);
  const wk = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(spec)));
  return { envelope: { enc: "v1", kid: publicJwk.kid || null, wk: b64.enc(wk), iv: b64.enc(iv), ct: b64.enc(ct) }, aes };
}

export async function decodeResponse(envelope, aes) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(envelope.iv) }, aes, b64.dec(envelope.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}… (${s.length.toLocaleString()} characters)` : s);

// A small response object with the parts the providers module uses.
const responseLike = (status, headers, text) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => text });

/**
 * options: { route: "direct" | "proxy", proxyUrl, encode, onRecord(record), keepBodies }
 * returns { request(url, init, signal), record(entry), describe() }
 */
export function createTransport({ route = "direct", proxyUrl = "", encode = false, onRecord = () => {} } = {}) {
  const base = String(proxyUrl || "").trim().replace(/\/+$/, "");
  let publicJwk = null;
  let seq = 0;

  async function proxyKey(signal) {
    if (publicJwk) return publicJwk;
    const r = await fetch(`${base}/key`, { signal });
    if (!r.ok) throw new Error(`The proxy has no key for encoding (HTTP ${r.status}). Turn encoding off or set up the proxy key.`);
    publicJwk = await r.json();
    return publicJwk;
  }

  function parseBody(init) {
    try {
      return init.body ? JSON.parse(init.body) : null;
    } catch (_) {
      return init.body || null;
    }
  }

  async function request(url, init = {}, signal) {
    const t0 = performance.now();
    const method = (init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const body = parseBody(init);
    const rec = {
      id: ++seq,
      at: new Date().toISOString(),
      route: route === "proxy" ? (encode ? "Via proxy, encoded" : "Via proxy, not encoded") : "Direct",
      target: url,
      method,
      model: body?.model || (url.match(/models\/([^:/?]+)/) || [])[1] || null,
      decoded: { url, method, headers: maskHeaders(headers), body },
      sent: null,
      status: null,
      response: null,
      responseSent: null,
      ms: 0,
      error: null,
    };
    try {
      let res;
      if (route !== "proxy") {
        rec.sent = { url, method, headers: maskHeaders(headers), body };
        const r = await fetch(url, { ...init, signal });
        const text = await r.text();
        res = responseLike(r.status, { "retry-after": r.headers.get("retry-after"), "content-type": r.headers.get("content-type") }, text);
        rec.responseSent = short(text, 400);
      } else {
        if (!base) throw new Error("Enter the API proxy address in step 2.");
        const spec = { url, method, headers, body: init.body };
        if (encode) {
          const key = await proxyKey(signal);
          const { envelope, aes } = await encodeRequest(spec, key);
          rec.sent = { url: `${base}/forward`, method: "POST", headers: { "content-type": "application/json" }, body: { enc: envelope.enc, kid: envelope.kid, wk: short(envelope.wk, 48), iv: envelope.iv, ct: short(envelope.ct, 64) } };
          const r = await fetch(`${base}/forward`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal });
          const text = await r.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (_) { /* not JSON */ }
          if (r.ok && parsed?.enc === "v1") {
            rec.responseSent = JSON.stringify({ enc: "v1", iv: parsed.iv, ct: short(parsed.ct, 64) });
            const out = await decodeResponse(parsed, aes);
            res = responseLike(out.status, out.headers || {}, out.body);
          } else {
            // Proxy-level error (not encoded; contains no secrets)
            if (r.status === 409) publicJwk = null;
            rec.responseSent = short(text, 400);
            res = responseLike(r.status, { "retry-after": r.headers.get("retry-after") }, text);
          }
        } else {
          rec.sent = { url: `${base}/forward`, method: "POST", headers: { "content-type": "application/json" }, body: { ...spec, headers: maskHeaders(headers), body } };
          const r = await fetch(`${base}/forward`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec), signal });
          const text = await r.text();
          rec.responseSent = short(text, 400);
          res = responseLike(r.status, { "retry-after": r.headers.get("retry-after") }, text);
        }
      }
      rec.status = res.status;
      rec.response = short(await res.text(), 2000);
      return res;
    } catch (e) {
      rec.error = e.name === "AbortError" ? "Cancelled" : e.message;
      throw e;
    } finally {
      rec.ms = Math.round(performance.now() - t0);
      onRecord(rec);
    }
  }

  // Simulated models do not leave the browser; they are still recorded so the inspector can be tried.
  function record({ model, user, system, text }) {
    onRecord({
      id: ++seq, at: new Date().toISOString(), route: "Simulated (stays in the browser)", target: `simulated://${model}`, method: "POST", model,
      decoded: { url: `simulated://${model}`, method: "POST", headers: {}, body: { model, system, user } },
      sent: null, status: 200, response: text, responseSent: null, ms: 0, error: null,
    });
  }

  async function checkProxy(signal) {
    if (!base) throw new Error("Enter the API proxy address first.");
    const r = await fetch(`${base}/health`, { signal });
    if (!r.ok) throw new Error(`The proxy answered HTTP ${r.status}.`);
    return r.json();
  }

  return { request, record, checkProxy, describe: () => ({ route, proxyUrl: base, encode: route === "proxy" && encode }) };
}

export const directTransport = createTransport();
