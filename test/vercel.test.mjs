// Tests the Vercel wrapper (api/proxy.js) around the shared proxy code.
import assert from "node:assert/strict";
import { encodeRequest, decodeResponse } from "../transport.js";

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { privateKey } = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]
);
process.env.PRIVATE_KEY_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
process.env.RATE_LIMIT_PER_MIN = "0";
process.env.ALLOWED_ORIGINS = "https://eve.github.io,https://tool.vercel.app";

const upstreamCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), init });
  return new Response('{"choices":[{"message":{"content":"{\\"label\\":\\"Engineering\\",\\"clause\\":\\"6.4.3\\"}"}}]}', { status: 200, headers: { "content-type": "application/json" } });
};

const { default: fn } = await import("../api/proxy.js");
const BASE = "https://tool.vercel.app";

await t("health through the rewrite (?path=health) and through a direct sub-path", async () => {
  const a = await (await fn.fetch(new Request(`${BASE}/api/proxy?path=health`))).json();
  assert.equal(a.name, "tr24027-proxy");
  assert.equal(a.encoding, true);
  const b = await (await fn.fetch(new Request(`${BASE}/api/proxy/health`))).json();
  assert.equal(b.ok, true);
  const c = await (await fn.fetch(new Request(`${BASE}/api/proxy`))).json();
  assert.equal(c.ok, true, "bare /api/proxy answers like /health");
});

await t("plain forward with CORS for an allowed origin", async () => {
  upstreamCalls.length = 0;
  const spec = { url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: { authorization: "Bearer sk-visitor-1234", "content-type": "application/json" }, body: "{}" };
  const r = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", headers: { "content-type": "application/json", origin: "https://eve.github.io" }, body: JSON.stringify(spec) }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://eve.github.io");
  assert.equal(upstreamCalls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(upstreamCalls[0].init.headers.authorization, "Bearer sk-visitor-1234");
});

await t("encoded round trip on Vercel", async () => {
  const key = await (await fn.fetch(new Request(`${BASE}/api/proxy?path=key`))).json();
  const spec = { url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: { authorization: "Bearer sk-visitor-1234" }, body: "{}" };
  const { envelope, aes } = await encodeRequest(spec, key);
  const r = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }));
  const out = await decodeResponse(await r.json(), aes);
  assert.equal(out.status, 200);
  assert.match(out.body, /6\.4\.3/);
});

await t("refuses other web origins and other hosts", async () => {
  const spec = { url: "https://api.openai.com/v1/models", method: "GET", headers: {} };
  const r1 = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", headers: { origin: "https://someone-else.site" }, body: JSON.stringify(spec) }));
  assert.equal(r1.status, 403);
  const r2 = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", body: JSON.stringify({ ...spec, url: "https://example.org/" }) }));
  assert.equal(r2.status, 403);
});

await t("without ALLOWED_ORIGINS only the deployment's own address may call it", async () => {
  const saved = process.env.ALLOWED_ORIGINS;
  delete process.env.ALLOWED_ORIGINS;
  const spec = { url: "https://api.openai.com/v1/models", method: "GET", headers: {} };
  const own = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", headers: { origin: BASE }, body: JSON.stringify(spec) }));
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("access-control-allow-origin"), BASE);
  const other = await fn.fetch(new Request(`${BASE}/api/proxy?path=forward`, { method: "POST", headers: { origin: "https://eve.github.io" }, body: JSON.stringify(spec) }));
  assert.equal(other.status, 403);
  process.env.ALLOWED_ORIGINS = saved;
});

globalThis.fetch = realFetch;
console.log(`\n${passed} tests passed`);
