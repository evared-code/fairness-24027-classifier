// providers.js — builds each provider's request and reads its answer. How the request travels
// (directly, or via the API proxy, encoded or not) is decided by the transport (transport.js).

import { directTransport } from "./transport.js";

export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, fatal = false, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable; // try again later (rate limit, overload, network)
    this.fatal = fatal; // stop this model entirely (bad key, unknown model)
    this.retryAfterMs = retryAfterMs;
  }
}

async function httpJSON(url, init, signal, transport = directTransport) {
  let res;
  try {
    res = await transport.request(url, init, signal);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ProviderError(`Network error: ${e.message}`, { retryable: true });
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body && (body.error?.message || body.error?.status || body.message)) || text.slice(0, 300) || res.statusText;
    const ra = Number(res.headers.get("retry-after"));
    throw new ProviderError(`HTTP ${res.status}: ${msg}`, {
      status: res.status,
      retryable: res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500,
      // Gemini reports an invalid key as HTTP 400 ("API key not valid"), so match the message too.
      fatal: res.status === 401 || res.status === 403 || res.status === 404 || /api[ _]key[ _]not[ _]valid|API_KEY_INVALID/i.test(msg),
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null,
    });
  }
  return body;
}

const mentionsTemperature = (e) => e instanceof ProviderError && e.status === 400 && /temperature/i.test(e.message);

// ---------------- Anthropic (Claude) ----------------
const anthropic = {
  id: "anthropic",
  name: "Claude (Anthropic)",
  defaultModel: "claude-sonnet-5-5",
  keyHelp: "https://console.anthropic.com/settings/keys",
  headers(key) {
    return {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Required by Anthropic for calls made directly from a browser page.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  },
  buildRequest({ key, model, system, user, temperature }) {
    const body = { model, max_tokens: 200, system, messages: [{ role: "user", content: user }] };
    if (temperature != null) body.temperature = temperature;
    return { url: "https://api.anthropic.com/v1/messages", init: { method: "POST", headers: this.headers(key), body: JSON.stringify(body) } };
  },
  extract(body) {
    return (body?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  },
  async listModels(key, signal, _baseUrl, transport) {
    const b = await httpJSON("https://api.anthropic.com/v1/models?limit=100", { headers: this.headers(key) }, signal, transport);
    return (b?.data || []).map((m) => m.id);
  },
};

// ---------------- OpenAI (GPT) ----------------
const openai = {
  id: "openai",
  name: "GPT (OpenAI)",
  defaultModel: "gpt-5-mini",
  keyHelp: "https://platform.openai.com/api-keys",
  buildRequest({ key, model, system, user, temperature }) {
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    };
    if (temperature != null) body.temperature = temperature;
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) },
    };
  },
  extract(body) {
    return body?.choices?.[0]?.message?.content || "";
  },
  async listModels(key, signal, _baseUrl, transport) {
    const b = await httpJSON("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } }, signal, transport);
    return (b?.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding/i.test(id))
      .sort();
  },
};

// ---------------- Any OpenAI-compatible service ----------------
// For services that offer the OpenAI chat-completions interface (e.g. OpenRouter, DeepSeek, Groq,
// Together, Mistral, a local Ollama or LM Studio server). The base URL is entered by the user.
// Whether a service accepts calls from a browser (CORS) depends on that service.
const compatible = {
  id: "compatible",
  name: "OpenAI-compatible (custom URL)",
  defaultModel: "",
  keyHelp: null,
  needsBaseUrl: true,
  optionalKey: true,
  base(baseUrl) {
    return String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  },
  buildRequest({ key, model, system, user, temperature, baseUrl, jsonMode = true }) {
    const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (jsonMode) body.response_format = { type: "json_object" };
    if (temperature != null) body.temperature = temperature;
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    return { url: `${this.base(baseUrl)}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
  },
  extract(body) {
    return body?.choices?.[0]?.message?.content || "";
  },
  async listModels(key, signal, baseUrl, transport) {
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const b = await httpJSON(`${this.base(baseUrl)}/models`, { headers }, signal, transport);
    return (b?.data || b?.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  },
};

// ---------------- Google (Gemini) ----------------
const gemini = {
  id: "gemini",
  name: "Gemini (Google)",
  defaultModel: "gemini-2.5-flash",
  keyHelp: "https://aistudio.google.com/apikey",
  buildRequest({ key, model, system, user, temperature }) {
    const generationConfig = { responseMimeType: "application/json" };
    if (temperature != null) generationConfig.temperature = temperature;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig,
    };
    const m = encodeURIComponent(model.replace(/^models\//, ""));
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      init: { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) },
    };
  },
  extract(body) {
    const parts = body?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n");
  },
  async listModels(key, signal, _baseUrl, transport) {
    const b = await httpJSON(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": key } },
      signal,
      transport
    );
    return (b?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => /gemini/i.test(id))
      .sort();
  },
};

// ---------------- Simulated provider (demo only) ----------------
// Lets people try the interface without a key. Answers are generated by keyword rules plus noise,
// so results are NOT research data.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return h >>> 0;
}
function rng(seed) {
  let x = seed || 1;
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0), (x % 100000) / 100000);
}
const demo = {
  id: "demo",
  name: "Simulated (demo, no key)",
  defaultModel: "sim-a",
  keyHelp: null,
  noKey: true,
  simulate({ model, user, runIndex }) {
    const subject = (user.match(/Option being classified: (.*)/) || user.match(/Design decision \(question\): (.*)/) || [, ""])[1];
    const t = subject.toLowerCase();
    let base = "None";
    if (/data|training|label|listing|target/.test(t)) base = "Data";
    else if (/human|team|oversight|guideline|value|education|personnel|consensus|cultur|parent/.test(t)) base = "Cognitive";
    else if (/ai|algorithm|filter|avatar|verification|biometric|fingerprint|assistive|multilingual|locali|interaction|gamif|3d|age|crypto|nft|infrastructure|automat/.test(t)) base = "Engineering";
    const labels = ["Data", "Cognitive", "Engineering", "None"];
    // Each simulated model consistently "disagrees" on some items (model-level opinion) ...
    const opinion = { "sim-a": 0.05, "sim-b": 0.12, "sim-c": 0.2 }[model] ?? 0.1;
    if (rng(hash(`${model}|${subject}|opinion`))() < opinion) base = labels[hash(`${model}${subject}`) % 4];
    // ... and is noisy from run to run (self-consistency below 1).
    const r = rng(hash(`${model}|${subject}|${runIndex}`))();
    const noise = { "sim-a": 0.1, "sim-b": 0.18, "sim-c": 0.28 }[model] ?? 0.2;
    const label = r < noise ? labels[hash(`${model}${subject}${runIndex}x`) % 4] : base;
    if (label === "None") return JSON.stringify({ label, clause: null });
    // pick a bias type listed under the chosen label in the prompt (stable per item, some run-to-run noise)
    const block = (user.match(new RegExp(`\\n${label}:\\n((?:  .*\\n?)+)`)) || [, ""])[1];
    const ids = [...block.matchAll(/^\s+(\d+(?:\.\d+)+)/gm)].map((x) => x[1]);
    const own = rng(hash(`${model}|${subject}|copinion`))() < opinion * 1.5 ? hash(`${model}${subject}`) : hash(subject); // models sometimes differ
    const pick = rng(hash(`${model}|${subject}|${runIndex}|c`))() < noise ? hash(`${subject}${runIndex}`) : own;
    return JSON.stringify({ label, clause: ids.length ? ids[pick % ids.length] : null });
  },
  async listModels() {
    return ["sim-a", "sim-b", "sim-c"];
  },
};

export const PROVIDERS = { anthropic, openai, gemini, compatible, demo };

// Calls one provider once. Handles "temperature not supported" by retrying once without it.
// state: per-model object that remembers whether temperature must be dropped.
export async function callModel({ providerId, key, model, system, user, temperature, signal, state = {}, runIndex = 0, baseUrl = "", transport = directTransport }) {
  const p = PROVIDERS[providerId];
  if (!p) throw new ProviderError(`Unknown provider ${providerId}`, { fatal: true });
  if (p.simulate) {
    await new Promise((r) => setTimeout(r, 15 + (hash(user + runIndex) % 60)));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const text = p.simulate({ model, user, runIndex });
    transport.record?.({ model, user, system, text });
    return { text, usedTemperature: temperature };
  }
  // Retry once without an option the model rejects: a custom temperature, or JSON mode on some compatible services.
  for (let attempt = 0; ; attempt++) {
    const temp = state.dropTemperature ? null : temperature;
    const req = p.buildRequest({ key, model, system, user, temperature: temp, baseUrl, jsonMode: !state.dropJsonMode });
    try {
      const body = await httpJSON(req.url, req.init, signal, transport);
      return { text: p.extract(body), usedTemperature: temp };
    } catch (e) {
      if (attempt < 2 && temp != null && mentionsTemperature(e)) { state.dropTemperature = true; continue; }
      if (attempt < 2 && !state.dropJsonMode && e instanceof ProviderError && e.status === 400 && /response_format|json_object|json mode/i.test(e.message)) { state.dropJsonMode = true; continue; }
      throw e;
    }
  }
}
