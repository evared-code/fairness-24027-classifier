// runner.js — runs N self-consistency samples per item for each model, in parallel across models,
// with per-model concurrency, optional requests-per-minute limit, retries and cancellation.

import { callModel, ProviderError } from "./providers.js";
import { buildUserPrompt, parseResponse, shuffled, LABELS, DEFAULT_TAXONOMY } from "./core.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });

function makeLimiter(rpm) {
  if (!rpm || rpm <= 0) return async () => {};
  const gap = 60000 / rpm;
  let next = 0;
  return async (signal) => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await sleep(wait, signal);
  };
}

/**
 * models: [{ key, providerId, model, apiKey, baseUrl, label }]
 * settings: { runs, temperature, shuffleLabels, concurrency, rpm, maxRetries, context, definitions, systemPrompt }
 * resume: optional previous { raw, clauses, log } to continue an interrupted run
 * returns { raw: {modelKey: {item_id: [label|null,...]}}, clauses: same shape with clause ids, log: [...], modelErrors }
 */
export async function runClassification({ items, models, settings, onProgress = () => {}, signal, resume, transport }) {
  const raw = resume?.raw ? structuredClone(resume.raw) : {};
  const clauses = resume?.clauses ? structuredClone(resume.clauses) : {};
  const taxonomy = settings.taxonomy || DEFAULT_TAXONOMY;
  const log = resume?.log ? resume.log.slice() : [];
  const modelErrors = {};
  const total = items.length * models.length * settings.runs;
  let done = 0;
  for (const m of models) {
    raw[m.key] = raw[m.key] || {};
    clauses[m.key] = clauses[m.key] || {};
    for (const it of items) {
      raw[m.key][it.item_id] = raw[m.key][it.item_id] || [];
      // keep clause arrays aligned with label arrays (older runs had no clauses)
      const cl = (clauses[m.key][it.item_id] = clauses[m.key][it.item_id] || []);
      while (cl.length < raw[m.key][it.item_id].length) cl.push(null);
      done += raw[m.key][it.item_id].length;
    }
  }
  // raw/log/modelErrors are live references so the caller can autosave or show partial results.
  const progress = (extra = {}) => onProgress({ done, total, raw, clauses, log, modelErrors, ...extra });
  progress();

  await Promise.all(
    models.map(async (m) => {
      const limiter = makeLimiter(settings.rpm);
      const state = {};
      const jobs = [];
      for (const it of items) {
        const have = raw[m.key][it.item_id].length;
        for (let r = have; r < settings.runs; r++) jobs.push({ it, r });
      }
      let idx = 0;
      let stopped = false;
      const worker = async () => {
        while (!stopped && idx < jobs.length) {
          if (signal?.aborted) return;
          const { it, r } = jobs[idx++];
          const order = settings.shuffleLabels ? shuffled(LABELS) : LABELS;
          const user = buildUserPrompt(it, { context: settings.context, definitions: settings.definitions, labelOrder: order, taxonomy, includeDrivers: settings.includeDrivers !== false });
          const entry = { model: m.key, item_id: it.item_id, run: r + 1, label_order: order.join("|"), label: null, clause: null, text: null, error: null, ms: 0, temperature: null, at: new Date().toISOString() };
          const t0 = performance.now();
          let attempt = 0;
          for (;;) {
            try {
              await limiter(signal);
              const out = await callModel({
                providerId: m.providerId, key: m.apiKey, model: m.model, system: settings.systemPrompt,
                user, temperature: settings.temperature, signal, state, runIndex: r, baseUrl: m.baseUrl, transport,
              });
              entry.text = out.text;
              entry.temperature = out.usedTemperature;
              const parsed = parseResponse(out.text, taxonomy);
              entry.label = parsed.label;
              entry.clause = parsed.clause;
              if (!entry.label) entry.error = "Could not parse a label from the response";
              break;
            } catch (e) {
              if (e.name === "AbortError") return;
              const pe = e instanceof ProviderError ? e : new ProviderError(String(e.message || e));
              if (pe.fatal) {
                stopped = true;
                modelErrors[m.key] = pe.message;
                progress({ error: { model: m.key, message: pe.message, fatal: true } });
                return;
              }
              if (pe.retryable && attempt < settings.maxRetries) {
                const backoff = pe.retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt) * (0.75 + Math.random() / 2);
                attempt++;
                progress({ retry: { model: m.key, message: pe.message, waitMs: Math.round(backoff) } });
                try { await sleep(backoff, signal); } catch (_) { return; }
                continue;
              }
              entry.error = pe.message;
              break;
            }
          }
          entry.ms = Math.round(performance.now() - t0);
          raw[m.key][it.item_id].push(entry.label);
          clauses[m.key][it.item_id].push(entry.clause);
          log.push(entry);
          done++;
          progress({ last: entry });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, worker));
    })
  );
  return { raw, clauses, log, modelErrors, cancelled: !!signal?.aborted };
}
