// app.js — wires the page together: input files, keys, settings, running, dashboard and downloads.

import {
  LABELS, DEFAULT_DEFINITIONS, DEFAULT_SYSTEM_PROMPT, DEFAULT_CONTEXT, DEFAULT_TAXONOMY,
  validateInput, validateTaxonomy, flattenItems, buildUserPrompt, toCSV,
} from "./core.js";
import { PROVIDERS } from "./providers.js";
import { createTransport } from "./transport.js";
import { runClassification } from "./runner.js";
import {
  TOOL, renderDashboard, enhanceDashboard, buildReportHTML, computeResults, resultFromReportHTML, modelDisplayName,
} from "./report.js";

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
};
const KEYS_KEY = "tr24027:keys";
const RUN_KEY = "tr24027:lastRun";
const ROUTE_KEY = "tr24027:route"; // route choice and proxy address (never keys)

const MODELS_KEY = "tr24027:models"; // names, providers, model IDs and URLs (never keys)
const SHORT = { anthropic: "Claude", openai: "GPT", gemini: "Gemini", compatible: "Custom model", demo: "Simulated" };
const MAX_ROWS = 6;
const DEFAULT_ROWS = [
  { id: "m1", enabled: true, name: "Claude", providerId: "anthropic", model: PROVIDERS.anthropic.defaultModel, baseUrl: "" },
  { id: "m2", enabled: true, name: "GPT", providerId: "openai", model: PROVIDERS.openai.defaultModel, baseUrl: "" },
  { id: "m3", enabled: true, name: "Gemini", providerId: "gemini", model: PROVIDERS.gemini.defaultModel, baseUrl: "" },
];
const DEMO_ROWS = [
  { id: "sim-a", enabled: true, name: "Sim A", providerId: "demo", model: "sim-a", baseUrl: "" },
  { id: "sim-b", enabled: true, name: "Sim B", providerId: "demo", model: "sim-b", baseUrl: "" },
  { id: "sim-c", enabled: true, name: "Sim C", providerId: "demo", model: "sim-c", baseUrl: "" },
];
let modelRows = (() => {
  const saved = store.get(MODELS_KEY);
  return Array.isArray(saved) && saved.length && saved.every((r) => r.id && PROVIDERS[r.providerId]) ? saved : structuredClone(DEFAULT_ROWS);
})();
let demoRows = structuredClone(DEMO_ROWS);

let input = null; // { title, context, notes, decisions }
let items = [];
let result = null; // current result object (running, finished or loaded)
let controller = null;

// ---------------- data ----------------

function mergeInputs(list) {
  const decisions = [];
  let title = null, context = null;
  const notes = [];
  for (const { name, data } of list) {
    title = title || data.title || name;
    context = context || data.context || null;
    if (data.notes) notes.push(data.notes);
    decisions.push(...data.decisions);
  }
  if (list.length > 1) title = `${list.length} files: ${list.map((x) => x.name).join(", ")}`;
  return { title, context, notes: notes.join("\n"), decisions };
}

function setInput(merged) {
  const errs = validateInput(merged);
  const box = $("#data-errors");
  if (errs.length) {
    box.hidden = false;
    box.innerHTML = `<b>Please fix the input:</b><ul>${errs.slice(0, 20).map((e) => `<li>${escapeHTML(e)}</li>`).join("")}</ul>${errs.length > 20 ? `<p>…and ${errs.length - 20} more.</p>` : ""}`;
    return;
  }
  box.hidden = true;
  input = merged;
  items = flattenItems(merged);
  const dupes = items.map((i) => i.item_id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) {
    box.hidden = false;
    box.innerHTML = `<b>Duplicate option IDs:</b> ${escapeHTML([...new Set(dupes)].join(", "))}. Give each option a unique "id".`;
    input = null; items = [];
    updateEstimate();
    return;
  }
  if (merged.context) $("#context").value = merged.context;
  const bySource = {};
  for (const it of items) bySource[it.source || "—"] = (bySource[it.source || "—"] || 0) + 1;
  const q = items.filter((i) => i.level === "question").length;
  $("#data-summary").hidden = false;
  const withDrivers = items.filter((i) => i.drivers?.length).length;
  $("#data-summary").innerHTML = `<b>${escapeHTML(merged.title || "Input")}</b>: ${merged.decisions.length} decisions → <b>${items.length} items</b> (${items.length - q} options${q ? `, ${q} question-level` : ""}). ${Object.entries(bySource).map(([k, v]) => `${escapeHTML(k)} ${v}`).join(", ")}. ${withDrivers ? `${withDrivers} items have decision drivers.` : "No decision drivers given."}`;
  updateEstimate();
  updatePreview();
}

async function readFiles(fileList) {
  const list = [];
  for (const f of fileList) {
    try {
      list.push({ name: f.name, data: JSON.parse(await f.text()) });
    } catch (e) {
      $("#data-errors").hidden = false;
      $("#data-errors").textContent = `${f.name}: not valid JSON (${e.message})`;
      return;
    }
  }
  if (list.length) setInput(mergeInputs(list));
}

// ---------------- models ----------------
// Each row: tick box, a name you choose, provider, model ID, API key, and a base URL for OpenAI-compatible services.

const isDemo = () => $("#demo-mode").checked;
const rowsNow = () => (isDemo() ? demoRows : modelRows);
const saveRows = () => !isDemo() && store.set(MODELS_KEY, modelRows);
const savedKeys = () => store.get(KEYS_KEY) || {};

function providerOptions(selected, demo) {
  const ids = demo ? ["demo"] : ["anthropic", "openai", "gemini", "compatible"];
  return ids.map((id) => `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHTML(PROVIDERS[id].name)}</option>`).join("");
}

function renderModelRows() {
  const demo = isDemo();
  const keys = savedKeys();
  $("#model-rows").innerHTML = rowsNow()
    .map((r) => {
      const p = PROVIDERS[r.providerId];
      const keyField = p.noKey
        ? `<span class="muted small">No key needed</span>`
        : `<input type="password" class="key" data-row="${r.id}" autocomplete="off" spellcheck="false" placeholder="${p.optionalKey ? "API key (if the service needs one)" : "API key"}" value="${escapeHTML(keys[r.id] || "")}" aria-label="API key for ${escapeHTML(r.name)}">`;
      return `<div class="model-row" data-row="${r.id}">
        <input type="checkbox" class="enabled" data-row="${r.id}" ${r.enabled ? "checked" : ""} aria-label="Use ${escapeHTML(r.name)}">
        <label class="mfield"><span>Name in the report</span><input type="text" class="mname" data-row="${r.id}" value="${escapeHTML(r.name)}" maxlength="40" spellcheck="false"></label>
        <label class="mfield"><span>Provider</span><select class="mprov" data-row="${r.id}" ${demo ? "disabled" : ""}>${providerOptions(r.providerId, demo)}</select></label>
        <label class="mfield"><span>Model ID</span><input type="text" class="model" data-row="${r.id}" list="dl-${r.id}" value="${escapeHTML(r.model)}" placeholder="${p.needsBaseUrl ? "e.g. deepseek-chat" : ""}" spellcheck="false" ${demo ? "readonly" : ""}></label>
        <datalist id="dl-${r.id}"></datalist>
        ${p.needsBaseUrl ? `<label class="mfield mfield-url"><span>Base URL of the service</span><input type="url" class="burl" data-row="${r.id}" value="${escapeHTML(r.baseUrl || "")}" placeholder="https://openrouter.ai/api/v1" spellcheck="false"></label>` : ""}
        <div class="mkey">${keyField}</div>
        <div class="mact">
          ${demo ? "" : `<button type="button" class="btn btn-small btn-ghost" data-load="${r.id}">Check key</button>`}
          ${p.keyHelp ? `<a class="small" href="${p.keyHelp}" target="_blank" rel="noopener">Get a key</a>` : ""}
          ${!demo && modelRows.length > 1 ? `<button type="button" class="btn btn-small btn-ghost btn-remove" data-remove="${r.id}" aria-label="Remove ${escapeHTML(r.name)}">Remove</button>` : ""}
        </div>
        <span class="model-msg small muted" data-msg="${r.id}"></span>
      </div>`;
    })
    .join("");
  $("#add-model").hidden = demo || modelRows.length >= MAX_ROWS;
  updateEstimate();
}

function addModelRow() {
  if (modelRows.length >= MAX_ROWS) return;
  let n = 1;
  while (modelRows.some((r) => r.id === `m${n}`)) n++;
  modelRows.push({ id: `m${n}`, enabled: true, name: `Model ${modelRows.length + 1}`, providerId: "compatible", model: "", baseUrl: "" });
  saveRows();
  renderModelRows();
  document.querySelector(`.mname[data-row="m${n}"]`)?.focus();
}

function onModelRowsInput(e) {
  const el = e.target;
  const row = rowsNow().find((r) => r.id === el.dataset.row);
  if (!row) return;
  if (el.classList.contains("enabled")) row.enabled = el.checked;
  else if (el.classList.contains("mname")) row.name = el.value;
  else if (el.classList.contains("model")) row.model = el.value.trim();
  else if (el.classList.contains("burl")) row.baseUrl = el.value.trim();
  else if (el.classList.contains("mprov")) {
    const wasDefaultName = !row.name.trim() || row.name === SHORT[row.providerId];
    const wasDefaultModel = !row.model || row.model === PROVIDERS[row.providerId].defaultModel;
    row.providerId = el.value;
    if (wasDefaultName) row.name = SHORT[row.providerId];
    if (wasDefaultModel) row.model = PROVIDERS[row.providerId].defaultModel;
    saveRows();
    return renderModelRows();
  } else if (el.classList.contains("key")) return saveKeysIfWanted();
  saveRows();
  updateEstimate();
}

function selectedModels() {
  return rowsNow()
    .filter((r) => r.enabled)
    .map((r) => {
      const p = PROVIDERS[r.providerId];
      const apiKey = p.noKey ? "" : (document.querySelector(`.key[data-row="${r.id}"]`)?.value || "").trim();
      const name = r.name.trim() || SHORT[r.providerId];
      return { key: r.id, providerId: r.providerId, provider_name: p.name, model: r.model.trim(), apiKey, baseUrl: r.baseUrl || "", short: name, label: `${name} (${r.model.trim()})` };
    });
}

function saveKeysIfWanted() {
  if (!$("#remember-keys").checked) return store.del(KEYS_KEY);
  const o = savedKeys();
  document.querySelectorAll(".key").forEach((el) => (o[el.dataset.row] = el.value.trim()));
  store.set(KEYS_KEY, o);
}

async function loadModels(rowId) {
  const r = rowsNow().find((x) => x.id === rowId);
  const p = PROVIDERS[r.providerId];
  const msg = document.querySelector(`[data-msg="${rowId}"]`);
  const key = p.noKey ? "" : (document.querySelector(`.key[data-row="${rowId}"]`)?.value || "").trim();
  if (!p.noKey && !p.optionalKey && !key) return (msg.textContent = "Enter the API key first.");
  if (p.needsBaseUrl && !r.baseUrl) return (msg.textContent = "Enter the base URL of the service first.");
  msg.className = "model-msg small muted";
  msg.textContent = "Checking…";
  const route = readRoute();
  const problem = route.route === "proxy" ? proxyUrlProblem(route.proxyUrl) : "";
  if (problem) { msg.textContent = problem; msg.className = "model-msg small err"; return; }
  try {
    const ids = await p.listModels(key, undefined, r.baseUrl, currentTransport());
    document.querySelector(`#dl-${rowId}`).innerHTML = ids.map((id) => `<option value="${escapeHTML(id)}">`).join("");
    msg.textContent = `Key works. ${ids.length} models available: click the Model ID field to choose one.`;
    msg.className = "model-msg small ok";
  } catch (e) {
    const cors = e instanceof TypeError || /network error|failed to fetch/i.test(e.message);
    msg.textContent = cors && p.needsBaseUrl
      ? `Could not reach the service. It may not accept calls from a browser (CORS), or the URL is wrong. (${e.message})`
      : `Could not list models: ${e.message}`;
    msg.className = "model-msg small err";
  }
}

// ---------------- settings ----------------

function renderDefs(defs = DEFAULT_DEFINITIONS) {
  $("#defs").innerHTML = LABELS.map(
    (l) => `<label class="field">${l}<textarea rows="2" data-def="${l}">${escapeHTML(defs[l])}</textarea></label>`
  ).join("");
}

function readSettings() {
  const n = (id, d) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : d;
  };
  const definitions = {};
  document.querySelectorAll("[data-def]").forEach((el) => (definitions[el.dataset.def] = el.value.trim()));
  return {
    runs: Math.max(1, Math.round(n("#runs", 10))),
    temperature: n("#temperature", 0.7),
    threshold: n("#threshold", 0.8),
    concurrency: Math.max(1, Math.round(n("#concurrency", 4))),
    rpm: Math.max(0, n("#rpm", 0)),
    maxRetries: Math.max(0, Math.round(n("#retries", 5))),
    shuffleLabels: $("#shuffle").checked,
    context: $("#context").value.trim() || DEFAULT_CONTEXT,
    systemPrompt: $("#system-prompt").value.trim() || DEFAULT_SYSTEM_PROMPT,
    definitions,
    taxonomy: readTaxonomy() || DEFAULT_TAXONOMY,
    includeDrivers: $("#include-drivers").checked,
    ...readRoute(),
  };
}

// Bias-type list (TR 24027 clause 6), editable as JSON. Returns null when the JSON is invalid.
function readTaxonomy() {
  const el = $("#taxonomy");
  if (!el) return DEFAULT_TAXONOMY;
  const box = $("#taxonomy-error");
  try {
    const t = JSON.parse(el.value);
    const errs = validateTaxonomy(t);
    if (errs.length) throw new Error(errs.join(" "));
    box.hidden = true;
    return t;
  } catch (e) {
    box.hidden = false;
    box.textContent = `The bias-type list is not valid: ${e.message}`;
    return null;
  }
}

function updateEstimate() {
  const m = selectedModels().length;
  const s = readSettings();
  const calls = items.length * m * s.runs;
  $("#estimate").innerHTML = items.length
    ? `${items.length} items × ${m} model${m === 1 ? "" : "s"} × ${s.runs} runs = <b>${calls.toLocaleString()} API calls</b>. Each call is short (about 400 input and 20 output tokens).${m < 3 ? " <b>Fleiss' κ needs 3 models</b>; pairwise κ needs 2." : ""}`
    : "Load decisions first (step 1).";
}

function updatePreview() {
  if (!items.length) return ($("#prompt-preview").textContent = "Load decisions first.");
  const s = readSettings();
  $("#prompt-preview").textContent = `SYSTEM:\n${s.systemPrompt}\n\nUSER:\n${buildUserPrompt(items[0], { context: s.context, definitions: s.definitions, taxonomy: s.taxonomy, includeDrivers: s.includeDrivers })}`;
}

// ---------------- route (direct or via API proxy) ----------------

function readRoute() {
  const route = document.querySelector('input[name="route"]:checked')?.value || "direct";
  return { route, proxyUrl: route === "proxy" ? $("#proxy-url").value.trim() : "", encode: route === "proxy" && $("#encode").checked };
}

function currentTransport() {
  return createTransport({ ...readRoute(), onRecord: addRecord });
}

function onRouteChange() {
  const r = readRoute();
  $("#proxy-settings").hidden = r.route !== "proxy";
  store.set(ROUTE_KEY, { route: r.route, proxyUrl: $("#proxy-url").value.trim(), encode: $("#encode").checked });
  updatePreview();
}

// A proxy address is a full https URL, http on this computer, or a path on this site such as /api/proxy.
function proxyUrlProblem(u) {
  if (!u) return "Enter the API proxy address in step 2, or choose Direct.";
  if (u.startsWith("/")) return location.protocol.startsWith("http") ? "" : "A path such as /api/proxy works only when this page is served from a website, not opened as a file.";
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return "";
    if (x.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname)) return "";
    return "The API proxy address must start with https:// (http:// only for localhost).";
  } catch { return "The API proxy address is not a valid address. Use https://… or a path such as /api/proxy."; }
}

async function checkProxy() {
  const msg = $("#proxy-msg");
  msg.className = "small muted";
  msg.textContent = "Checking…";
  const problem = proxyUrlProblem($("#proxy-url").value.trim());
  if (problem) { msg.textContent = problem; msg.className = "small err"; return; }
  try {
    const h = await createTransport({ route: "proxy", proxyUrl: $("#proxy-url").value }).checkProxy();
    const enc = $("#encode").checked && !h.encoding ? " Encoding is not set up on this proxy: turn off Encode requests, or ask its owner to add a key." : "";
    msg.textContent = `Proxy ${h.version} reachable. Encoding ${h.encoding ? `available (key ${h.keyId})` : "not available"}. Forwards only to: ${(h.allowedHosts || []).join(", ")}. Logging: ${h.logging}.${enc}`;
    msg.className = enc ? "small warn-text" : "small ok";
  } catch (e) {
    msg.textContent = `Could not reach the proxy: ${e.message}`;
    msg.className = "small err";
  }
}

// ---------------- request inspector ----------------

const records = [];
const MAX_RECORDS = 300;
let inspTimer = null;

function addRecord(rec) {
  records.push(rec);
  if (records.length > MAX_RECORDS) records.shift();
  $("#insp-count").textContent = `(${records.length}${records.length === MAX_RECORDS ? ", newest kept" : ""})`;
  if ($("#inspector").open && !inspTimer) inspTimer = setTimeout(() => ((inspTimer = null), renderInspector()), 400);
}

function pretty(v, readable) {
  if (v == null) return "";
  let s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (typeof v === "string") {
    try {
      s = JSON.stringify(JSON.parse(v), null, 2);
    } catch (_) { /* plain text */ }
  }
  // In the decoded view, show prompt line breaks as real line breaks.
  return readable ? s.replace(/\\n/g, "\n") : s;
}

function renderInspector() {
  const view = document.querySelector('input[name="insp-view"]:checked')?.value || "decoded";
  const list = $("#insp-list");
  if (!records.length) return (list.innerHTML = '<p class="muted small">No requests yet. Run a classification or check a key.</p>');
  const open = new Set([...list.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  list.innerHTML = records
    .slice()
    .reverse()
    .map((r) => {
      const req = view === "decoded" ? r.decoded : r.sent;
      const res = view === "decoded" ? r.response : r.responseSent;
      const status = r.error ? `<span class="err">${escapeHTML(r.error)}</span>` : `HTTP ${r.status}`;
      const reqText = req ? pretty(req, view === "decoded") : "This request did not travel over the network (simulated model).";
      return `<details class="insp-item" data-id="${r.id}" ${open.has(String(r.id)) ? "open" : ""}>
        <summary><span class="insp-n">#${r.id}</span> <span>${escapeHTML(r.route)}</span> <span class="mono-s">${escapeHTML(r.model || r.target)}</span> <span class="insp-st">${status}, ${r.ms} ms</span></summary>
        <div class="insp-body">
          <div class="insp-h">Request ${view === "decoded" ? "(decoded)" : "(as it left the browser)"}</div><pre>${escapeHTML(reqText)}</pre>
          <div class="insp-h">Response ${view === "decoded" ? "(decoded)" : "(as received)"}</div><pre>${escapeHTML(res == null ? "" : pretty(res, view === "decoded"))}</pre>
        </div>
      </details>`;
    })
    .join("");
}

// ---------------- run ----------------

function newResult(models, settings) {
  return {
    tool: TOOL,
    created_at: new Date().toISOString(),
    finished_at: null,
    status: "running",
    input,
    items,
    models: models.map(({ apiKey, ...m }) => m), // keys are never stored in results
    settings,
    raw: {},
    clauses: {},
    log: [],
    modelErrors: {},
  };
}

function renderProgress(perModel, total) {
  $("#progress").hidden = false;
  $("#progress").innerHTML = result.models
    .map((m) => {
      const d = perModel[m.key] || 0;
      const err = result.modelErrors?.[m.key];
      return `<div class="prog-row"><span class="prog-name">${escapeHTML(modelDisplayName(m))}</span><div class="prog-bar"><div style="width:${(100 * d) / total}%" class="${err ? "prog-err" : ""}"></div></div><span class="prog-n">${d} of ${total}${err ? ", stopped" : ""}</span></div>`;
    })
    .join("");
}

function logLine(text, cls = "") {
  const el = $("#run-log");
  el.hidden = false;
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  el.prepend(line);
  while (el.childElementCount > 80) el.lastChild.remove();
}

async function start({ resume = false } = {}) {
  let models = selectedModels();
  if (resume) {
    // Resume needs the same models; keys come from the current inputs.
    const byKey = Object.fromEntries(selectedModels().map((m) => [m.key, m]));
    models = result.models.map((m) => ({ ...m, apiKey: byKey[m.key]?.apiKey || "" }));
    items = result.items;
    input = result.input;
  } else {
    if (!items.length) return alert("Load decisions first (step 1).");
    if (!models.length) return alert("Enable at least one model (step 2).");
  }
  const need = (pred) => models.filter(pred).map((m) => m.short || m.provider_name);
  const missing = need((m) => !PROVIDERS[m.providerId].noKey && !PROVIDERS[m.providerId].optionalKey && !m.apiKey);
  if (missing.length) return alert(`Missing API key for: ${missing.join(", ")}`);
  const noModel = need((m) => !m.model);
  if (noModel.length) return alert(`Missing model ID for: ${noModel.join(", ")}`);
  const noUrl = need((m) => PROVIDERS[m.providerId].needsBaseUrl && !m.baseUrl);
  if (noUrl.length) return alert(`Missing base URL for: ${noUrl.join(", ")}`);
  const names = models.map((m) => m.short.toLowerCase());
  if (new Set(names).size !== names.length) return alert("Give each model a different name; the names label the results.");
  if (!resume && !readTaxonomy()) return alert("The bias-type list in step 3 is not valid JSON. Fix it or restore the defaults.");
  const routeNow = resume ? { route: result.settings.route || "direct", proxyUrl: result.settings.proxyUrl || "", encode: !!result.settings.encode } : readRoute();
  if (routeNow.route === "proxy") { const p = proxyUrlProblem(routeNow.proxyUrl); if (p) return alert(p); }
  saveKeysIfWanted();

  const settings = resume ? result.settings : readSettings();
  if (!resume) {
    result = newResult(models, settings);
    $("#run-log").innerHTML = "";
  }
  result.status = "running";
  controller = new AbortController();
  setRunning(true);

  const perTotal = result.items.length * settings.runs;
  const perModel = {};
  for (const m of result.models) perModel[m.key] = result.items.reduce((s, it) => s + ((result.raw[m.key]?.[it.item_id] || []).length), 0);
  renderProgress(perModel, perTotal);
  let lastDraw = 0, lastDash = 0;

  const out = await runClassification({
    items: result.items,
    models,
    settings,
    signal: controller.signal,
    transport: createTransport({ ...routeNow, onRecord: addRecord }),
    resume: resume ? { raw: result.raw, clauses: result.clauses, log: result.log } : null,
    onProgress: (p) => {
      result.raw = p.raw; // live references: autosave and the live dashboard see partial results
      result.clauses = p.clauses;
      result.log = p.log;
      if (p.last) {
        perModel[p.last.model] = (perModel[p.last.model] || 0) + 1;
        if (p.last.error) logLine(`${p.last.model}, ${p.last.item_id}, run ${p.last.run}: ${p.last.error}`, "warn");
      }
      if (p.retry) logLine(`${p.retry.model}: ${p.retry.message} — retrying in ${(p.retry.waitMs / 1000).toFixed(1)} s`, "muted");
      if (p.error?.fatal) {
        result.modelErrors[p.error.model] = p.error.message;
        logLine(`${p.error.model} stopped: ${p.error.message}`, "err");
      }
      const now = performance.now();
      if (now - lastDraw > 150 || p.done === p.total) (renderProgress(perModel, perTotal), (lastDraw = now));
      if (now - lastDash > 4000) (showDashboard(), (lastDash = now)); // live partial results
    },
  });

  result.raw = out.raw;
  result.clauses = out.clauses;
  result.log = out.log;
  result.modelErrors = { ...result.modelErrors, ...out.modelErrors };
  const c = computeResults(result, { bootstrap: false });
  result.status = out.cancelled ? "cancelled" : c.done >= c.total ? "complete" : "incomplete";
  if (result.status === "complete") result.finished_at = new Date().toISOString();
  renderProgress(perModel, perTotal);
  logLine(
    result.status === "complete" ? "Finished." : result.status === "cancelled" ? "Cancelled. You can resume later." : "Stopped with some calls missing. Fix the problem (e.g. key or model ID) and resume.",
    result.status === "complete" ? "ok" : "warn"
  );
  persistRun();
  setRunning(false);
  showDashboard();
}

// Saves the run (without keys) so it survives a closed tab. Large runs may exceed browser storage.
function persistRun() {
  if (!result) return;
  if (result.status === "complete") return store.del(RUN_KEY);
  if (!store.set(RUN_KEY, result)) logLine("Could not save progress in this browser (storage full). Download the JSON to keep it.", "warn");
}

let running = false;
function setRunning(on) {
  running = on;
  updateButtons();
}
function updateButtons() {
  $("#start").disabled = running;
  $("#cancel").hidden = !running;
  $("#resume").hidden = running || !result || result.status === "complete";
  for (const b of ["#dl-html", "#dl-csv", "#dl-json"]) $(b).disabled = running || !result;
}

// Autosave every 5 s while running
setInterval(() => {
  if (result?.status === "running") persistRun();
}, 5000);

// ---------------- dashboard + downloads ----------------

function showDashboard() {
  if (!result) return;
  // keep the user's item filters when the live dashboard refreshes
  const prev = {};
  document.querySelectorAll("#dashboard [data-filter]").forEach((el) => (prev[el.dataset.filter] = el.value));
  // confidence intervals (2,000 bootstrap resamples) are computed once the run is no longer in progress
  $("#dashboard").innerHTML = renderDashboard(result, { bootstrap: result.status !== "running" });
  document.querySelectorAll("#dashboard [data-filter]").forEach((el) => prev[el.dataset.filter] != null && (el.value = prev[el.dataset.filter]));
  enhanceDashboard($("#dashboard [data-dashboard]"));
  updateButtons();
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

function baseName() {
  const d = (result?.created_at || new Date().toISOString()).slice(0, 16).replace(/[:T]/g, "-");
  return `tr24027-results-${d}`;
}

async function downloadReport() {
  download(`${baseName()}.html`, buildReportHTML(result, await appCSS()), "text/html");
}

// CSS for the report: from the inline style in the single-file build, or from styles.css.
async function appCSS() {
  const inline = document.getElementById("app-css");
  if (inline) return inline.textContent;
  return (await fetch("styles.css")).text();
}

function downloadCSV() {
  const c = computeResults(result, { bootstrap: false });
  download(`${baseName()}.csv`, "﻿" + toCSV(c.rows, c.keys, c.names), "text/csv");
}

function downloadJSON() {
  download(`${baseName()}.json`, JSON.stringify(result, null, 1), "application/json");
}

async function loadResultsFile(file) {
  try {
    const text = await file.text();
    const r = /^\s*</.test(text) ? resultFromReportHTML(text) : JSON.parse(text);
    if (!r || !Array.isArray(r.items) || !Array.isArray(r.models) || !r.raw || !r.settings) throw new Error("This file is not a results file from this tool.");
    result = r;
    if (result.status === "running") result.status = "incomplete";
    showDashboard();
    document.getElementById("results-section").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    alert(`Could not load results: ${e.message}`);
  }
}

// ---------------- helpers + wiring ----------------

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function init() {
  $("#context").value = DEFAULT_CONTEXT;
  $("#system-prompt").value = DEFAULT_SYSTEM_PROMPT;
  renderDefs();
  $("#taxonomy").value = JSON.stringify(DEFAULT_TAXONOMY, null, 2);
  $("#remember-keys").checked = !!store.get(KEYS_KEY);
  const savedRoute = store.get(ROUTE_KEY);
  if (savedRoute) {
    $("#proxy-url").value = savedRoute.proxyUrl || "";
    $("#encode").checked = savedRoute.encode !== false;
    const radio = document.querySelector(`input[name="route"][value="${savedRoute.route}"]`);
    if (radio) radio.checked = true;
  }
  $("#proxy-settings").hidden = readRoute().route !== "proxy";
  renderModelRows();
  updatePreview();

  // Link to the source code: set once in index.html, <meta name="repository" content="https://github.com/…">
  const repo = document.querySelector('meta[name="repository"]')?.content || "";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repo) && !repo.includes("/OWNER/")) $("#repo-link").href = repo;
  else $("#repo-link").hidden = true;

  // Served from the Vercel deployment: the proxy of this same site is the natural default.
  if (location.protocol.startsWith("http") && !$("#proxy-url").value) $("#proxy-url").value = "/api/proxy";

  // Single-file build: examples are embedded, so point the download link at the embedded copy.
  const ex = globalThis.__TR24027_EXAMPLES__?.["data/ethical-ai-metaverse.json"];
  if (ex) $("#example-download").href = URL.createObjectURL(new Blob([JSON.stringify(ex, null, 2)], { type: "application/json" }));
  $("#example-download").setAttribute("download", "ethical-ai-metaverse.json");

  $("#file-input").addEventListener("change", (e) => readFiles(e.target.files));
  document.querySelectorAll("[data-example]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const embedded = globalThis.__TR24027_EXAMPLES__?.[b.dataset.example];
        const data = embedded ? structuredClone(embedded) : await (await fetch(b.dataset.example)).json();
        setInput(mergeInputs([{ name: b.dataset.example.split("/").pop(), data }]));
      } catch (e) {
        alert(`Could not load the example (${e.message}). If you opened index.html directly from disk, serve the folder instead — see README.`);
      }
    })
  );
  $("#demo-mode").addEventListener("change", renderModelRows);
  $("#model-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-load]");
    if (b) return loadModels(b.dataset.load);
    const rm = e.target.closest("[data-remove]");
    if (rm && modelRows.length > 1) {
      modelRows = modelRows.filter((r) => r.id !== rm.dataset.remove);
      saveRows();
      renderModelRows();
    }
  });
  $("#model-rows").addEventListener("input", onModelRowsInput);
  $("#model-rows").addEventListener("change", onModelRowsInput);
  $("#add-model").addEventListener("click", addModelRow);
  $("#reset-models").addEventListener("click", () => {
    modelRows = structuredClone(DEFAULT_ROWS);
    saveRows();
    renderModelRows();
  });
  $("#remember-keys").addEventListener("change", saveKeysIfWanted);
  document.querySelectorAll(".settings input, #shuffle").forEach((el) => el.addEventListener("input", updateEstimate));
  document.querySelector(".advanced").addEventListener("input", updatePreview);
  $("#context").addEventListener("input", updatePreview);
  $("#reset-prompt").addEventListener("click", () => {
    $("#system-prompt").value = DEFAULT_SYSTEM_PROMPT;
    renderDefs();
    $("#taxonomy").value = JSON.stringify(DEFAULT_TAXONOMY, null, 2);
    readTaxonomy();
    updatePreview();
  });

  document.querySelectorAll('input[name="route"], #encode').forEach((el) => el.addEventListener("change", onRouteChange));
  $("#proxy-url").addEventListener("change", onRouteChange);
  $("#check-proxy").addEventListener("click", checkProxy);
  // On a web host (for example a Vercel project that also runs api/proxy.js), offer the site's own proxy.
  if (location.protocol.startsWith("http")) {
    $("#same-site-proxy").hidden = false;
    $("#same-site-proxy").addEventListener("click", () => { $("#proxy-url").value = "/api/proxy"; onRouteChange(); checkProxy(); });
  }
  $("#include-drivers").addEventListener("change", updatePreview);
  $("#inspector").addEventListener("toggle", () => $("#inspector").open && renderInspector());
  document.querySelectorAll('input[name="insp-view"]').forEach((el) => el.addEventListener("change", renderInspector));
  $("#insp-clear").addEventListener("click", () => {
    records.length = 0;
    $("#insp-count").textContent = "";
    renderInspector();
  });

  $("#start").addEventListener("click", () => start());
  $("#cancel").addEventListener("click", () => controller?.abort());
  $("#resume").addEventListener("click", () => start({ resume: true }));
  $("#dl-html").addEventListener("click", downloadReport);
  $("#dl-csv").addEventListener("click", downloadCSV);
  $("#dl-json").addEventListener("click", downloadJSON);
  $("#load-results").addEventListener("change", (e) => e.target.files[0] && loadResultsFile(e.target.files[0]));

  const saved = store.get(RUN_KEY);
  if (saved && saved.status !== "complete") {
    $("#resume-banner").hidden = false;
    $("#resume-open").addEventListener("click", () => {
      result = saved;
      if (result.status === "running") result.status = "incomplete";
      $("#resume-banner").hidden = true;
      if (result.models.some((m) => m.providerId === "demo") !== $("#demo-mode").checked) {
        $("#demo-mode").checked = result.models.some((m) => m.providerId === "demo");
        renderModelRows();
      }
      showDashboard();
      logLine("Loaded the unfinished run. Enter the same API keys, then press Resume.", "muted");
    });
    $("#resume-discard").addEventListener("click", () => {
      store.del(RUN_KEY);
      $("#resume-banner").hidden = true;
    });
  }
}

init();
