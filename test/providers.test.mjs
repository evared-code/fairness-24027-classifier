// Tests request shapes for each provider (with a mocked fetch) and the runner with the simulated provider.
import assert from "node:assert/strict";
import { PROVIDERS, callModel } from "../providers.js";
import { runClassification } from "../runner.js";
import { flattenItems, aggregate, DEFAULT_DEFINITIONS, DEFAULT_CONTEXT, DEFAULT_SYSTEM_PROMPT } from "../core.js";
import { readFileSync } from "node:fs";

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const calls = [];
function mockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const { status = 200, json, headers = {} } = responder(url, init, calls.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      text: async () => JSON.stringify(json),
    };
  };
}

await t("Anthropic request has browser-access header and parses text", async () => {
  calls.length = 0;
  mockFetch(() => ({ json: { content: [{ type: "text", text: '{"label":"Data"}' }] } }));
  const out = await callModel({ providerId: "anthropic", key: "k", model: "m", system: "s", user: "u", temperature: 0.7 });
  assert.equal(out.text, '{"label":"Data"}');
  const c = calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(c.init.headers["x-api-key"], "k");
  assert.equal(c.body.temperature, 0.7);
  assert.equal(c.body.system, "s");
});

await t("OpenAI request uses bearer key and JSON mode", async () => {
  calls.length = 0;
  mockFetch(() => ({ json: { choices: [{ message: { content: '{"label":"None"}' } }] } }));
  const out = await callModel({ providerId: "openai", key: "k", model: "gpt-x", system: "s", user: "u", temperature: 0.7 });
  assert.equal(out.text, '{"label":"None"}');
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
});

await t("OpenAI model that rejects temperature is retried without it", async () => {
  calls.length = 0;
  mockFetch((url, init, n) =>
    n === 1
      ? { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0.7" } } }
      : { json: { choices: [{ message: { content: '{"label":"Data"}' } }] } }
  );
  const state = {};
  const out = await callModel({ providerId: "openai", key: "k", model: "o", system: "s", user: "u", temperature: 0.7, state });
  assert.equal(out.usedTemperature, null);
  assert.equal(state.dropTemperature, true);
  assert.equal("temperature" in calls[1].body, false);
});

await t("Gemini request uses key header and skips thought parts", async () => {
  calls.length = 0;
  mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ thought: true, text: "thinking" }, { text: '{"label":"Cognitive"}' }] } }] } }));
  const out = await callModel({ providerId: "gemini", key: "g", model: "models/gemini-x", system: "s", user: "u", temperature: 0.5 });
  assert.equal(out.text, '{"label":"Cognitive"}');
  assert.ok(calls[0].url.endsWith("/models/gemini-x:generateContent"));
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g");
  assert.equal(calls[0].body.generationConfig.temperature, 0.5);
});

const settings = {
  runs: 4, temperature: 0.7, shuffleLabels: true, concurrency: 3, rpm: 0, maxRetries: 2,
  context: DEFAULT_CONTEXT, definitions: DEFAULT_DEFINITIONS, systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

await t("OpenAI-compatible service: custom URL, optional key, JSON-mode fallback", async () => {
  calls.length = 0;
  mockFetch((url, init, n) =>
    n === 1
      ? { status: 400, json: { error: { message: "response_format json_object is not supported by this model" } } }
      : { json: { choices: [{ message: { content: '{"label":"Data","clause":"6.3.4"}' } }] } }
  );
  const state = {};
  const out = await callModel({ providerId: "compatible", key: "", model: "x", system: "s", user: "u", temperature: 0.5, baseUrl: "https://example.org/v1/", state });
  assert.equal(calls[0].url, "https://example.org/v1/chat/completions");
  assert.equal("authorization" in calls[0].init.headers, false);
  assert.equal(state.dropJsonMode, true);
  assert.equal("response_format" in calls[1].body, false);
  assert.match(out.text, /6\.3\.4/);
});

await t("Gemini invalid key (HTTP 400) stops the model instead of retrying", async () => {
  mockFetch(() => ({ status: 400, json: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } }));
  const items = flattenItems({ decisions: [{ id: "d", question: "q", options: ["a", "b"] }] });
  const res = await runClassification({
    items,
    models: [{ key: "gemini", providerId: "gemini", model: "m", apiKey: "bad" }],
    settings: { ...settings, runs: 3 },
  });
  assert.match(res.modelErrors.gemini, /API key not valid/);
  assert.equal(res.log.length, 0);
});


await t("runner retries 429 then succeeds; 401 stops only that model", async () => {
  calls.length = 0;
  const items = flattenItems({ decisions: [{ id: "d", question: "q", options: ["a", "b"] }] });
  let n429 = 0;
  mockFetch((url) => {
    if (url.includes("anthropic")) return { status: 401, json: { error: { message: "invalid x-api-key" } } };
    if (n429 < 2) { n429++; return { status: 429, json: { error: { message: "rate" } }, headers: { "retry-after": "0.01" } }; }
    return { json: { choices: [{ message: { content: '{"label":"Engineering"}' } }] } };
  });
  const res = await runClassification({
    items,
    models: [
      { key: "claude", providerId: "anthropic", model: "m", apiKey: "bad" },
      { key: "gpt", providerId: "openai", model: "m", apiKey: "k" },
    ],
    settings,
  });
  assert.match(res.modelErrors.claude, /401/);
  assert.equal(res.raw.gpt.a ?? res.raw.gpt["d-O1"].length, 4);
  assert.ok(res.raw.gpt["d-O2"].every((l) => l === "Engineering"));
});

await t("runner with simulated models on the full dataset, then resume after cancel", async () => {
  const data = JSON.parse(readFileSync(new URL("../data/ethical-ai-metaverse.json", import.meta.url)));
  const items = flattenItems(data);
  const models = ["sim-a", "sim-b", "sim-c"].map((m) => ({ key: m, providerId: "demo", model: m }));
  const ac = new AbortController();
  let seen = 0;
  const partial = await runClassification({
    items, models, settings: { ...settings, runs: 3, concurrency: 8 }, signal: ac.signal,
    onProgress: (p) => { seen = p.done; if (p.done >= 100) ac.abort(); },
  });
  assert.equal(partial.cancelled, true);
  const full = await runClassification({ items, models, settings: { ...settings, runs: 3, concurrency: 8 }, resume: partial });
  for (const m of models) for (const it of items) assert.equal(full.raw[m.key][it.item_id].length, 3);
  assert.equal(full.log.length, items.length * 3 * 3);
  const rows = aggregate(items, models.map((m) => m.key), full.raw, 0.8, full.clauses);
  assert.ok(rows.some((r) => r.final_clause), "simulated models should return bias types");
  assert.equal(rows.length, 74);
  console.log(`    cancelled at ${seen}, resumed to ${full.log.length} calls`);
});

console.log(`\n${passed} tests passed`);
