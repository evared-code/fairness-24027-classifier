// Tests the API proxy (proxy/handler.js) and the browser transport (transport.js) against it.
import assert from "node:assert/strict";
import { handle } from "../proxy/handler.js";
import { createTransport, encodeRequest, decodeResponse, maskSecret } from "../transport.js";
import { callModel } from "../providers.js";

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { privateKey } = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]
);
const PRIVATE_KEY_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
const env = { PRIVATE_KEY_JWK, RATE_LIMIT_PER_MIN: "0" };

const upstreamCalls = [];
const upstream = async (url, init) => {
  upstreamCalls.push({ url, init });
  return new Response(JSON.stringify({ content: [{ type: "text", text: '{"label":"Data","clause":"6.3.4"}' }] }), { status: 200, headers: { "content-type": "application/json" } });
};
const req = (path, init = {}) => new Request(`https://proxy.example${path}`, init);
const post = (body, headers = {}) => req("/forward", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const anthropicSpec = {
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "sk-ant-secret-1234", "anthropic-version": "2023-06-01", cookie: "should-not-pass" },
  body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
};

await t("health reports encoding, allow-list and no logging", async () => {
  const r = await handle(req("/health"), env);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.encoding, true);
  assert.deepEqual(j.allowedHosts, ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"]);
  assert.equal(j.logging, "none");
  const off = await (await handle(req("/health"), {})).json();
  assert.equal(off.encoding, false);
});

await t("plain forward passes only allowed headers and returns the provider's answer", async () => {
  upstreamCalls.length = 0;
  const r = await handle(post(anthropicSpec), env, { fetchImpl: upstream });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /6\.3\.4/);
  const h = upstreamCalls[0].init.headers;
  assert.equal(h["x-api-key"], "sk-ant-secret-1234");
  assert.equal(h.cookie, undefined);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

await t("refuses hosts not on the allow-list, plain http, and other methods", async () => {
  for (const [spec, re] of [
    [{ ...anthropicSpec, url: "https://evil.example/steal" }, /allow-list/],
    [{ ...anthropicSpec, url: "http://api.anthropic.com/v1/messages" }, /https/],
    [{ ...anthropicSpec, method: "DELETE" }, /GET and POST/],
  ]) {
    const r = await handle(post(spec), env, { fetchImpl: upstream });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error.message, re);
  }
});

await t("encoded round trip: proxy decodes, forwards, and encodes the answer", async () => {
  upstreamCalls.length = 0;
  const key = await (await handle(req("/key"), env)).json();
  assert.equal(key.d, undefined, "private parts must never be served");
  const { envelope, aes } = await encodeRequest(anthropicSpec, key);
  assert.ok(!JSON.stringify(envelope).includes("sk-ant-secret"), "key must not be readable in the envelope");
  const r = await handle(post(envelope), env, { fetchImpl: upstream });
  const out = await decodeResponse(await r.json(), aes);
  assert.equal(out.status, 200);
  assert.match(out.body, /6\.3\.4/);
  assert.equal(upstreamCalls[0].init.headers["x-api-key"], "sk-ant-secret-1234");
});

await t("tampered or wrongly keyed requests are rejected", async () => {
  const key = await (await handle(req("/key"), env)).json();
  const { envelope } = await encodeRequest(anthropicSpec, key);
  const bad = { ...envelope, ct: envelope.ct.slice(0, -8) + "AAAAAAA=" };
  assert.equal((await handle(post(bad), env, { fetchImpl: upstream })).status, 400);
  assert.equal((await handle(post({ ...envelope, kid: "other" }), env, { fetchImpl: upstream })).status, 409);
  assert.equal((await handle(post(envelope), { RATE_LIMIT_PER_MIN: "0" }, { fetchImpl: upstream })).status, 400, "encoding off on proxy");
});

await t("limits: rate, size, and web origin", async () => {
  const lim = { RATE_LIMIT_PER_MIN: "2" };
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await handle(post(anthropicSpec), lim, { fetchImpl: upstream, clientIp: "1.2.3.4" })).status);
  assert.deepEqual(codes, [200, 200, 429]);
  const big = { ...anthropicSpec, body: "x".repeat(300000) };
  assert.equal((await handle(post(big), env, { fetchImpl: upstream })).status, 413);
  const only = { ...env, ALLOWED_ORIGINS: "https://eve.github.io" };
  assert.equal((await handle(post(anthropicSpec, { origin: "https://other.site" }), only, { fetchImpl: upstream })).status, 403);
  const ok = await handle(post(anthropicSpec, { origin: "https://eve.github.io" }), only, { fetchImpl: upstream });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://eve.github.io");
  const pre = await handle(req("/forward", { method: "OPTIONS", headers: { origin: "https://eve.github.io" } }), only);
  assert.equal(pre.status, 204);
});

await t("the proxy writes nothing to the console", async () => {
  const orig = {};
  const used = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) (orig[m] = console[m]), (console[m] = (...a) => used.push(m));
  try {
    const key = await (await handle(req("/key"), env)).json();
    const { envelope } = await encodeRequest(anthropicSpec, key);
    await handle(post(envelope), env, { fetchImpl: upstream });
    await handle(post({ ...anthropicSpec, url: "https://evil.example" }), env, { fetchImpl: upstream });
    await handle(post(envelope), env, { fetchImpl: async () => { throw new Error("down"); } });
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(used, []);
});

// Browser side: route global fetch to the proxy handler (proxy URLs) or to the fake provider.
function wireFetch() {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("https://proxy.example")) return handle(new Request(url, init), env, { fetchImpl: upstream });
    return upstream(url, init);
  };
}

await t("transport via proxy, encoded: classification works and the inspector shows both views", async () => {
  wireFetch();
  const records = [];
  const tr = createTransport({ route: "proxy", proxyUrl: "https://proxy.example/", encode: true, onRecord: (r) => records.push(r) });
  const out = await callModel({ providerId: "anthropic", key: "sk-ant-secret-1234", model: "m", system: "s", user: "u", temperature: 0.7, transport: tr });
  assert.match(out.text, /6\.3\.4/);
  const rec = records.at(-1);
  assert.equal(rec.route, "Via proxy, encoded");
  assert.equal(rec.status, 200);
  assert.equal(rec.decoded.headers["x-api-key"], maskSecret("sk-ant-secret-1234"));
  assert.ok(!JSON.stringify(rec).includes("sk-ant-secret-1234"), "inspector must never hold the full key");
  assert.equal(rec.sent.body.enc, "v1");
  assert.equal(rec.decoded.body.model, "m");
});

await t("transport via proxy, not encoded, and direct", async () => {
  wireFetch();
  const records = [];
  const plain = createTransport({ route: "proxy", proxyUrl: "https://proxy.example", encode: false, onRecord: (r) => records.push(r) });
  assert.match((await callModel({ providerId: "anthropic", key: "sk-ant-secret-1234", model: "m", system: "s", user: "u", transport: plain })).text, /Data/);
  assert.equal(records.at(-1).sent.url, "https://proxy.example/forward");
  assert.equal(records.at(-1).sent.body.url, "https://api.anthropic.com/v1/messages");
  const direct = createTransport({ onRecord: (r) => records.push(r) });
  assert.match((await callModel({ providerId: "anthropic", key: "k-direct-9999", model: "m", system: "s", user: "u", transport: direct })).text, /Data/);
  assert.equal(records.at(-1).route, "Direct");
  assert.equal(records.at(-1).sent.url, "https://api.anthropic.com/v1/messages");
  const health = await plain.checkProxy();
  assert.equal(health.name, "tr24027-proxy");
});

await t("proxy refusal reaches the tool as a clear, non-retryable error", async () => {
  wireFetch();
  const tr = createTransport({ route: "proxy", proxyUrl: "https://proxy.example", encode: true });
  await assert.rejects(
    callModel({ providerId: "compatible", key: "", model: "m", system: "s", user: "u", baseUrl: "https://evil.example/v1", transport: tr }),
    (e) => e.status === 403 && /allow-list/.test(e.message) && e.fatal === true
  );
});

console.log(`\n${passed} tests passed`);
