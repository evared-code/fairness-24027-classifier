// report.js — turns a result object into the results page, written like the results section of a paper.
// The same renderer produces the live dashboard and the downloadable HTML report, so they are identical.

import {
  LABELS, SOURCE_LABELS, aggregate, agreementReport, modelSummary, buildUserPrompt,
  DEFAULT_TAXONOMY, CLAUSE_HEADINGS, clauseIndex, clauseChecklist, driverCrosstab, driverText,
} from "./core.js";

export const TOOL = { name: "TR 24027 Fairness Classifier", version: "1.5.0" };
export const BOOTSTRAP = { B: 2000, seed: 24027 };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const fixed = (x, d = 2) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(d));
// APA style: no leading zero for statistics that cannot exceed 1 (kappa, proportions); true minus sign.
const apa = (x, d = 2) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(d).replace(/^(-?)0\./, "$1.").replace(/^-/, "−"));
const ciText = (ci) => (ci ? `[${apa(ci.lo)}, ${apa(ci.hi)}]` : "");
const labelClass = (l) => `lab-${String(l || "none").toLowerCase()}`;
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const listJoin = (a) => (a.length <= 1 ? a.join("") : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(", ")}, and ${a.at(-1)}`);

// Short name (Claude, GPT, Gemini) in text and tables; exact model IDs appear in the Methods table.
export function modelDisplayName(m) {
  return m.short || m.label || m.key;
}

export function computeResults(result, { bootstrap = true } = {}) {
  const keys = result.models.map((m) => m.key);
  const names = Object.fromEntries(result.models.map((m) => [m.key, modelDisplayName(m)]));
  const th = result.settings.threshold;
  const taxonomy = result.settings.taxonomy || DEFAULT_TAXONOMY;
  const rows = aggregate(result.items, keys, result.raw || {}, th, result.clauses || {});
  const agreement = agreementReport(rows, keys, names, { bootstrap: bootstrap ? BOOTSTRAP.B : 0, seed: BOOTSTRAP.seed, taxonomy });
  const checklist = clauseChecklist(rows, taxonomy);
  const clauses = clauseIndex(taxonomy);
  const summaries = modelSummary(rows, keys, th);
  const total = result.items.length * keys.length * result.settings.runs;
  const done = keys.reduce((s, k) => s + result.items.reduce((t, it) => t + ((result.raw?.[k]?.[it.item_id] || []).length), 0), 0);
  const failed = summaries.reduce((s, x) => s + x.failed_runs, 0);
  return { keys, names, rows, agreement, summaries, total, done, failed, threshold: th, bootstrap, taxonomy, checklist, clauses };
}

// ---------- figures (HTML/CSS marks: crisp text, responsive, hover tips) ----------

function stackedBars(groups, labels = LABELS) {
  const legend = `<div class="legend" aria-hidden="true">${labels
    .map((l) => `<span class="legend-item"><i class="sw ${labelClass(l)}"></i>${esc(l)}</span>`)
    .join("")}</div>`;
  const bars = groups
    .map((g) => {
      const n = labels.reduce((s, l) => s + (g.counts[l] || 0), 0);
      const denom = g.total ?? n;
      const segs = labels
        .filter((l) => g.counts[l])
        .map((l) => {
          const c = g.counts[l];
          const share = denom ? c / denom : 0;
          const tip = `${g.name}, ${l}: ${c} of ${denom} (${pct(share)})`;
          return `<div class="seg ${labelClass(l)}" style="flex-grow:${c}" data-tip="${esc(tip)}" role="img" aria-label="${esc(tip)}">${share >= 0.07 ? `<span>${c}</span>` : ""}</div>`;
        })
        .join("");
      const missing = g.total != null ? g.total - n : 0;
      const rest = missing > 0 ? `<div class="seg seg-empty" style="flex-grow:${missing}" data-tip="${esc(`${g.name}, no final label: ${missing}`)}"></div>` : "";
      return `<div class="bar-row"><div class="bar-name">${esc(g.name)}</div><div class="bar">${segs}${rest || (n ? "" : '<div class="seg seg-empty" style="flex-grow:1"></div>')}</div><div class="bar-n">${denom}</div></div>`;
    })
    .join("");
  return `${legend}<div class="bars">${bars}</div>`;
}

function confidenceHistogram(name, values, threshold) {
  const bins = [
    { key: "<.4", lo: 0, hi: 0.4 },
    ...[0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((v) => ({ key: apa(v, 1), lo: v - 1e-9, hi: v + 0.1 - 1e-9 })),
    { key: "1", lo: 1 - 1e-9, hi: 1.01 },
  ];
  const counts = bins.map((b) => values.filter((v) => v >= b.lo && v < b.hi).length);
  const max = Math.max(1, ...counts);
  const cols = bins
    .map((b, i) => {
      const above = b.lo + 1e-9 >= threshold - 1e-9;
      const tip = `${name}, confidence ${b.key}: ${plural(counts[i], "item")}`;
      return `<div class="hcol" data-tip="${esc(tip)}"><div class="hval">${counts[i] || ""}</div><div class="hbar ${above ? "hbar-on" : "hbar-off"}" style="height:${(counts[i] / max) * 100}%"></div><div class="hlab">${b.key}</div></div>`;
    })
    .join("");
  return `<div class="hist"><div class="hist-name">${esc(name)}</div><div class="hplot">${cols}</div></div>`;
}

// ---------- numbering ----------

function numberer() {
  let f = 0, t = 0;
  return {
    fig: (caption, body) => `<figure class="fig"><div class="fig-body">${body}</div><figcaption><b>Figure ${++f}.</b> ${caption}</figcaption></figure>`,
    tab: (caption, body, extra = "") => `<div class="tab"><p class="tab-cap"><b>Table ${++t}.</b> ${caption}</p>${extra}<div class="table-wrap">${body}</div></div>`,
  };
}

// ---------- pieces ----------

function statusBadge(status) {
  const map = {
    "Accepted (full agreement)": ["good", "✓", "Full agreement"],
    "Accepted (majority)": ["warning", "◐", "Majority"],
    "Accepted (single model)": ["warning", "◐", "Single model"],
    Contested: ["critical", "✕", "Contested"],
  };
  const [cls, icon, short] = map[status] || ["muted", "", status];
  return `<span class="status status-${cls}" data-tip="${esc(status)}"><span aria-hidden="true">${icon}</span> ${esc(short)}</span>`;
}

function labelChip(l, conf, tie, clause = null, clauses = {}) {
  if (tie) return `<span class="chip chip-muted" data-tip="Tie between labels">tie</span>`;
  if (!l) return `<span class="chip chip-muted">–</span>`;
  const cl = clause ? ` <span class="chip-cl" data-tip="${esc(`${clause} ${clauses[clause]?.name || ""}`)}">${esc(clause)}</span>` : "";
  return `<span class="chip"><i class="sw ${labelClass(l)}"></i>${esc(l)}${cl}${conf != null ? ` <span class="chip-c">${apa(conf, 1)}</span>` : ""}</span>`;
}

function resultsParagraph(result, c, final) {
  const s = result.settings;
  const nItems = c.rows.length;
  const nQ = c.rows.filter((r) => r.level === "question").length;
  const nDec = new Set(c.rows.map((r) => r.decision_id)).size;
  const names = c.keys.map((k) => c.names[k]);
  const relevant = SOURCE_LABELS.reduce((t, l) => t + final[l], 0);
  const contested = c.rows.filter((r) => r.status === "Contested").length;
  const conf = c.summaries.filter((x) => x.mean_confidence != null).map((x) => `${apa(x.mean_confidence)} for ${esc(c.names[x.model])}`);
  const kStat = (v) =>
    v?.fleiss?.kappa != null
      ? `Fleiss' <i>κ</i> = ${apa(v.fleiss.kappa)}${v.fleiss.ci ? `, 95% CI ${ciText(v.fleiss.ci)}` : ""}`
      : v?.pairwise?.[0]?.kappa != null
        ? `Cohen's <i>κ</i> = ${apa(v.pairwise[0].kappa)}${v.pairwise[0].ci ? `, 95% CI ${ciText(v.pairwise[0].ci)}` : ""}`
        : null;
  const lk = (v) => (v?.fleiss?.kappa != null ? v.fleiss.interpretation : v?.pairwise?.[0]?.interpretation);
  const [all, step1, step2, step3] = c.agreement;
  const sentences = [];
  sentences.push(
    `We classified ${plural(nItems, "item")} from ${plural(nDec, "decision")}${nQ ? ` (${nItems - nQ} options and ${plural(nQ, "decision")} without options, classified at question level)` : ""} by their primary source of potential bias following ISO/IEC TR 24027:2021, using ${c.keys.length === 1 ? "one model" : `${c.keys.length} models`} (${esc(listJoin(names))}). Each item was sampled <i>N</i> = ${s.runs} times per model at temperature ${s.temperature}${s.shuffleLabels ? ", with the order of labels shuffled on every run" : ""}.`
  );
  if (conf.length) sentences.push(`Mean self-consistency confidence (<i>M</i>) was ${listJoin(conf)}.`);
  if (c.keys.length >= 2 && kStat(all)) {
    let t = `Agreement between models on the majority label was ${esc(lk(all))} across all four labels, ${kStat(all)}`;
    if (kStat(step1)) t += `, and ${esc(lk(step1))} on whether an item is fairness-relevant, ${kStat(step1)}`;
    t += ".";
    if (kStat(step2)) t += ` For the ${plural(step2.items, "item")} that every model judged relevant, agreement on the bias source was ${esc(lk(step2))}, ${kStat(step2)}.`;
    if (kStat(step3)) t += ` Where all models chose the same source (${plural(step3.items, "item")}), agreement on the TR 24027 bias type was ${esc(lk(step3))}, ${kStat(step3)}.`;
    sentences.push(t);
  }
  const bySrc = SOURCE_LABELS.filter((l) => final[l]).sort((a, b) => final[b] - final[a]).map((l) => `${l} ${final[l]}`);
  sentences.push(
    `With an acceptance threshold of ${apa(c.threshold)}, ${plural(relevant, "item")} (${pct(nItems ? relevant / nItems : null)}) received a fairness-relevant final label${bySrc.length ? ` (${listJoin(bySrc)})` : ""}, ${final.None} ${final.None === 1 ? "was" : "were"} labelled None, and ${contested} (${pct(nItems ? contested / nItems : null)}) ${contested === 1 ? "was" : "were"} contested.`
  );
  const types = c.checklist.filter((x) => !x.unspecified);
  const covered = types.filter((x) => x.count > 0);
  if (relevant) {
    const gaps = types.filter((x) => x.count === 0);
    const gapText = gaps.length === 0 ? "every listed bias type was addressed by at least one item" : gaps.length <= 6 ? `no item addressed ${listJoin(gaps.map((g) => `${g.name.toLowerCase()} (${g.id})`))}` : `${gaps.length} bias types were not addressed by any item (see the checklist)`;
    sentences.push(`Mapped to the bias types of ISO/IEC TR 24027:2021 clause 6, the fairness-relevant items addressed ${covered.length} of ${types.length} types; ${gapText}.`);
  }
  const voices = [...new Set(c.rows.map((r) => r.source).filter(Boolean))];
  if (voices.length > 1) {
    const v = voices.map((name) => {
      const rs = c.rows.filter((r) => r.source === name);
      const rel = rs.filter((r) => SOURCE_LABELS.includes(r.final_label)).length;
      return `${rel} of ${rs.length} ${esc(name.toLowerCase())} items (${pct(rel / rs.length)})`;
    });
    sentences.push(`By voice, ${listJoin(v)} were fairness-relevant.`);
  }
  return sentences.join(" ");
}

function agreementTable(c) {
  const rows = c.agreement
    .map((v) => {
      const head = `<tr class="group"><th colspan="7" scope="colgroup">${esc(v.view)}</th></tr>`;
      const fl =
        c.keys.length >= 3
          ? `<tr><td>All models (Fleiss)</td><td class="num"><b>${apa(v.fleiss.kappa)}</b></td><td class="num">${ciText(v.fleiss.ci) || "–"}</td><td class="num">${apa(v.fleiss.pbar)}</td><td class="num">${apa(v.fleiss.pe)}</td><td class="num">${v.fleiss.n}</td><td>${esc(v.fleiss.interpretation)}</td></tr>`
          : "";
      const pairs = v.pairwise
        .map((p) => `<tr><td>${esc(p.pair)} (Cohen)</td><td class="num">${apa(p.kappa)}</td><td class="num">${ciText(p.ci) || "–"}</td><td class="num">${apa(p.po)}</td><td class="num">${apa(p.pe)}</td><td class="num">${p.n}</td><td>${esc(p.interpretation)}</td></tr>`)
        .join("");
      return head + fl + (pairs || '<tr><td colspan="7" class="muted">Needs at least two models.</td></tr>');
    })
    .join("");
  return `<table class="t"><thead><tr><th scope="col">Comparison</th><th scope="col" class="num"><i>κ</i></th><th scope="col" class="num">95% CI</th><th scope="col" class="num"><i>p</i><sub>o</sub></th><th scope="col" class="num"><i>p</i><sub>e</sub></th><th scope="col" class="num"><i>n</i></th><th scope="col">Landis and Koch</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function decisionTable(c) {
  const byDec = new Map();
  for (const r of c.rows) {
    if (!byDec.has(r.decision_id)) byDec.set(r.decision_id, []);
    byDec.get(r.decision_id).push(r);
  }
  const body = [...byDec.entries()]
    .map(([id, rs]) => {
      const relevant = rs.filter((r) => SOURCE_LABELS.includes(r.final_label));
      const counts = Object.fromEntries(SOURCE_LABELS.map((l) => [l, relevant.filter((r) => r.final_label === l).length]));
      const cells = SOURCE_LABELS.map((l) => `<td class="num">${counts[l] ? `<span class="dot ${labelClass(l)}" aria-hidden="true"></span>${counts[l]}` : '<span class="muted">·</span>'}</td>`).join("");
      const contested = rs.filter((r) => r.status === "Contested").length;
      return `<tr><td class="id">${esc(id)}</td><td>${esc(rs[0].source)}</td><td class="wide">${esc(rs[0].question)}</td><td class="num">${rs.length}${rs[0].level === "question" ? "<sup>a</sup>" : ""}</td><td class="num">${relevant.length}</td>${cells}<td class="num">${contested || '<span class="muted">·</span>'}</td></tr>`;
    })
    .join("");
  return `<table class="t"><thead><tr><th scope="col">Decision</th><th scope="col">Voice</th><th scope="col">Question</th><th scope="col" class="num">Items</th><th scope="col" class="num">Relevant</th><th scope="col" class="num">Data</th><th scope="col" class="num">Cognitive</th><th scope="col" class="num">Engineering</th><th scope="col" class="num">Contested</th></tr></thead><tbody>${body}</tbody></table>`;
}

function driverTable(c) {
  const xt = driverCrosstab(c.rows);
  if (!xt.length) return "";
  const cols = [...LABELS, "Contested"];
  const body = xt
    .map((d) => {
      const eff = Object.entries(d.effects).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(", ");
      const cells = cols.map((l) => `<td class="num">${d.counts[l] ? (l === "Contested" ? d.counts[l] : `<span class="dot ${labelClass(l)}" aria-hidden="true"></span>${d.counts[l]}`) : '<span class="muted">·</span>'}</td>`).join("");
      const rel = SOURCE_LABELS.reduce((t, l) => t + d.counts[l], 0);
      return `<tr><td><b>${esc(d.name)}</b></td><td class="num">${d.total}</td>${cells}<td class="num">${apa(d.total ? rel / d.total : null)}</td><td class="muted">${esc(eff)}</td></tr>`;
    })
    .join("");
  return `<table class="t"><thead><tr><th scope="col">Decision driver</th><th scope="col" class="num">Items</th>${cols.map((l) => `<th scope="col" class="num">${esc(l)}</th>`).join("")}<th scope="col" class="num">Share relevant</th><th scope="col">Effects</th></tr></thead><tbody>${body}</tbody></table>`;
}

function itemTable(c) {
  const head = c.keys.map((k) => `<th scope="col">${esc(c.names[k])}</th>`).join("");
  const body = c.rows
    .map((r) => {
      const cells = c.keys.map((k) => `<td>${labelChip(r.per[k].majority, r.per[k].confidence, r.per[k].tie, r.per[k].clause, c.clauses)}</td>`).join("");
      const votes = c.keys
        .map((k) => {
          const p = r.per[k];
          const v = LABELS.filter((l) => p.counts[l]).map((l) => `${l} ${p.counts[l]}`).join(", ") || "no answers";
          return `<div><b>${esc(c.names[k])}</b>: ${esc(v)}${p.failed ? `; failed ${p.failed}` : ""}${p.entropy != null ? `; entropy ${apa(p.entropy)}` : ""}</div>`;
        })
        .join("");
      const subject = r.option == null ? "<i>Question-level item</i>" : esc(r.option);
      const drv = (r.drivers || []).length ? `<div class="drivers">${r.drivers.map((d) => `<span class="drv">${esc(driverText(d))}</span>`).join("")}</div>` : "";
      return `<tr data-source="${esc(r.source)}" data-status="${esc(r.status)}" data-final="${esc(r.final_label || "none-final")}" data-text="${esc(`${r.item_id} ${r.category} ${r.question} ${r.option || ""}`.toLowerCase())}">
        <td class="id">${esc(r.item_id)}</td><td>${esc(r.source)}</td>
        <td class="wide"><details><summary>${subject}</summary><div class="q">${esc(r.question)}</div><div class="votes">${votes}</div></details>${drv}</td>
        ${cells}<td class="num">${esc(r.agreement)}</td><td>${r.final_label ? labelChip(r.final_label, null, false, r.final_clause, c.clauses) : '<span class="muted">–</span>'}</td><td>${statusBadge(r.status)}</td></tr>`;
    })
    .join("");
  return `<table class="t items"><thead><tr><th scope="col">ID</th><th scope="col">Voice</th><th scope="col">Option</th>${head}<th scope="col" class="num">Agree</th><th scope="col">Final</th><th scope="col">Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

function itemFilters(c) {
  const sources = [...new Set(c.rows.map((r) => r.source).filter(Boolean))];
  const statuses = [...new Set(c.rows.map((r) => r.status))];
  const opt = (v, t = v) => `<option value="${esc(v)}">${esc(t)}</option>`;
  return `<div class="filters" role="group" aria-label="Filter items">
    <label>Voice <select data-filter="source"><option value="">All</option>${sources.map((s) => opt(s)).join("")}</select></label>
    <label>Status <select data-filter="status"><option value="">All</option>${statuses.map((s) => opt(s)).join("")}</select></label>
    <label>Final label <select data-filter="final"><option value="">All</option>${LABELS.map((l) => opt(l)).join("")}${opt("none-final", "No final label")}</select></label>
    <label class="grow">Search <input type="search" data-filter="text" placeholder="ID, question or option"></label>
    <span class="filter-count muted" data-count></span>
  </div>`;
}

function methods(result, c) {
  const s = result.settings;
  const example = result.items[0] ? buildUserPrompt(result.items[0], { context: s.context, definitions: s.definitions, taxonomy: c.taxonomy, includeDrivers: s.includeDrivers !== false }) : "";
  const tempUsed = (k) => {
    const used = (result.log || []).filter((e) => e.model === k && e.text != null);
    return used.some((e) => e.temperature == null) ? "provider default" : String(s.temperature);
  };
  const models = result.models
    .map((m) => `<tr><td>${esc(modelDisplayName(m))}</td><td>${esc(m.provider_name)}</td><td class="id">${esc(m.model)}</td><td class="num">${esc(tempUsed(m.key))}</td><td>${result.modelErrors?.[m.key] ? `<span class="status status-critical">✕ ${esc(result.modelErrors[m.key])}</span>` : "Completed"}</td></tr>`)
    .join("");
  const defs = LABELS.map((l) => `<dt><i class="sw ${labelClass(l)}"></i>${esc(l)}</dt><dd>${esc(s.definitions[l])}</dd>`).join("");
  return `
  <h3>Models</h3>
  <div class="table-wrap"><table class="t"><thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Model ID</th><th scope="col" class="num">Temperature</th><th scope="col">Status</th></tr></thead><tbody>${models}</tbody></table></div>

  <h3>Label definitions</h3>
  <dl class="defs">${defs}</dl>

  <h3>Measures</h3>
  <div class="eqs">
    <p class="eq"><span class="eq-l">Self-consistency confidence</span><span class="eq-r"><i>c</i> = max<sub><i>k</i></sub> <i>n</i><sub><i>k</i></sub> / <i>N</i><sub>valid</sub></span></p>
    <p class="eq-note">where <i>n<sub>k</sub></i> is the number of runs that returned label <i>k</i>. The majority label is undefined when two labels tie.</p>
    <p class="eq"><span class="eq-l">Cohen's kappa (two models)</span><span class="eq-r"><i>κ</i> = (<i>p</i><sub>o</sub> − <i>p</i><sub>e</sub>) / (1 − <i>p</i><sub>e</sub>)</span></p>
    <p class="eq-note">where <i>p</i><sub>o</sub> is observed agreement and <i>p</i><sub>e</sub> = Σ<sub><i>k</i></sub> <i>p</i><sub><i>k</i>,A</sub> <i>p</i><sub><i>k</i>,B</sub> is agreement expected by chance.</p>
    <p class="eq"><span class="eq-l">Fleiss' kappa (three or more models)</span><span class="eq-r"><i>κ</i> = (<i>P̄</i> − <i>P̄</i><sub>e</sub>) / (1 − <i>P̄</i><sub>e</sub>)</span></p>
    <p class="eq-note">Confidence intervals are percentile bootstrap intervals over items (${c.bootstrap ? `${BOOTSTRAP.B} resamples, seed ${BOOTSTRAP.seed}` : "computed when the run finishes"}). Interpretation follows Landis and Koch (1977).</p>
  </div>

  <h3>Procedure</h3>
  <dl class="kv">
    <dt>Runs per item and model</dt><dd><i>N</i> = ${s.runs}</dd>
    <dt>Acceptance threshold</dt><dd>${apa(s.threshold)}: a model's label counts towards the final label only when its confidence is at least this value</dd>
    <dt>Final label</dt><dd>All counted models agree (full agreement) or a majority of them agree; otherwise the item is contested</dd>
    <dt>Step 1 and step 2</dt><dd>Step 1 compares fairness-relevant against None; step 2 compares the bias source on items every model judged relevant</dd>
    <dt>Label order</dt><dd>${s.shuffleLabels ? "Shuffled on every run" : "Fixed"}</dd>
    <dt>Decision drivers</dt><dd>${c.rows.some((r) => r.drivers?.length) ? (s.includeDrivers !== false ? "Given in the input and included in the prompt" : "Given in the input but not included in the prompt (used only for analysis)") : "None given in the input"}</dd>
    <dt>Route</dt><dd>${s.route === "proxy" ? `Via API proxy${s.proxyUrl ? ` (${esc(s.proxyUrl)})` : ""}, ${s.encode ? "requests encoded (RSA-OAEP and AES-GCM) between browser and proxy" : "requests not encoded beyond HTTPS"}` : "Direct from the browser to each provider"}</dd>
    <dt>Bias type</dt><dd>With each label, models choose one bias type from the clause 6 list (see the checklist). A model's bias type is its most frequent choice among runs that returned its majority label; the final bias type pools the votes of the models that support the final label</dd>
    <dt>Step 3</dt><dd>Agreement on the bias type, for items where every model chose the same source</dd>
    <dt>Run started</dt><dd>${esc(result.created_at || "")}</dd>
    <dt>Run finished</dt><dd>${esc(result.finished_at || "Not finished")}</dd>
    <dt>Software</dt><dd>${esc(TOOL.name)}, version ${esc(TOOL.version)}</dd>
  </dl>
  <details class="prompt"><summary>System prompt and the prompt for the first item</summary><pre>${esc(s.systemPrompt)}</pre><pre>${esc(example)}</pre></details>

  <h3>Limitations</h3>
  <ul class="notes">
    <li>Agreement between models measures reliability, not correctness: models trained on similar data can share the same errors. No human validation is included.</li>
    <li>The label definitions paraphrase the bias sources in ISO/IEC TR 24027:2021. Check them against the standard before publication.</li>
    <li>Each item receives one primary source; items with several sources lose information.</li>
  </ul>`;
}

function checklistSection(result, c) {
  const textOf = Object.fromEntries(c.rows.map((r) => [r.item_id, r.option ?? r.question]));
  const groups = ["Cognitive", "Data", "Engineering"]
    .map((src) => {
      const list = c.checklist.filter((x) => x.source === src);
      const typed = list.filter((x) => !x.unspecified);
      const addressed = typed.filter((x) => x.count > 0).length;
      const head = `<tr class="group"><th colspan="5" scope="colgroup"><i class="sw ${labelClass(src)}" aria-hidden="true"></i> ${esc(CLAUSE_HEADINGS[src])} <span class="group-note">${addressed} of ${typed.length} bias types addressed</span></th></tr>`;
      const body = list
        .map((x) => {
          const st = x.unspecified
            ? `<span class="status status-muted">Source only</span>`
            : x.count
              ? `<span class="status status-good"><span aria-hidden="true">✓</span> Addressed</span>`
              : `<span class="status status-critical"><span aria-hidden="true">✕</span> Gap</span>`;
          const opts = x.items.length
            ? x.items.map((id) => `<div class="opt"><span class="id">${esc(id)}</span> ${esc(textOf[id] || "")}</div>`).join("")
            : '<span class="muted">No item</span>';
          const key = `${x.source}|${x.id || "unspecified"}`;
          return `<tr${x.count ? "" : ' class="gap"'}><td class="id">${esc(x.id || "–")}</td><td class="type"><b>${esc(x.name)}</b>${x.hint ? `<div class="hint-sm">${esc(x.hint)}</div>` : ""}</td><td>${st}</td><td class="opts">${opts}</td>
            <td class="rev"><label class="rev-check"><input type="checkbox" data-review="${esc(key)}"> <span>Reviewed</span></label><input type="text" class="note" data-note="${esc(key)}" placeholder="Note" aria-label="Note for ${esc(x.name)}"></td></tr>`;
        })
        .join("");
      return head + body;
    })
    .join("");
  const types = c.checklist.filter((x) => !x.unspecified);
  return `<section class="checklist" aria-labelledby="h-checklist" data-run="${esc(result.created_at || "run")}">
    <h2 id="h-checklist">Checklist: ISO/IEC TR 24027 bias types</h2>
    <p class="check-lead">Each bias type in clause 6 of the standard, with the items whose final label and agreed bias type match it. A <b>gap</b> means no decision option in this study addresses that type. Tick <i>Reviewed</i> and add notes as you check each row; ticks and notes are kept in this browser and appear when you print.</p>
    <p class="check-count muted" data-review-count>${types.filter((x) => x.count > 0).length} of ${types.length} bias types addressed</p>
    <div class="table-wrap"><table class="t check-table"><thead><tr><th scope="col">Clause</th><th scope="col">Bias type</th><th scope="col">Status</th><th scope="col">Items</th><th scope="col">Your review</th></tr></thead><tbody>${groups}</tbody></table></div>
    <p class="table-note-in">Clause numbers and descriptions follow the tool author's reading of ISO/IEC TR 24027:2021 and can be edited in the tool. Verify them against the standard before publication. "Source only": items whose models agreed on the source but not on a bias type.</p>
  </section>`;
}

// ---------- page ----------

export function renderDashboard(result, opts = {}) {
  const c = computeResults(result, opts);
  const n = numberer();
  const final = Object.fromEntries(LABELS.map((l) => [l, c.rows.filter((r) => r.final_label === l).length]));
  const voices = [...new Set(c.rows.map((r) => r.source).filter(Boolean))];
  const finalGroups = [
    ...voices.map((v) => {
      const rs = c.rows.filter((r) => r.source === v);
      return { name: v, counts: Object.fromEntries(LABELS.map((l) => [l, rs.filter((r) => r.final_label === l).length])), total: rs.length };
    }),
    ...(voices.length > 1 ? [{ name: "All items", counts: final, total: c.rows.length }] : voices.length ? [] : [{ name: "All items", counts: final, total: c.rows.length }]),
  ];
  const modelGroups = c.summaries.map((s) => ({ name: c.names[s.model], counts: s.distribution }));
  const hists = c.keys.map((k) => confidenceHistogram(c.names[k], c.rows.map((r) => r.per[k].confidence).filter((v) => v != null), c.threshold)).join("");
  const sumRows = c.summaries
    .map((s) => `<tr><td>${esc(c.names[s.model])}</td><td class="num">${apa(s.mean_confidence)}</td><td class="num">${s.above_threshold} of ${c.rows.length}</td><td class="num">${s.ties}</td><td class="num">${s.failed_runs} of ${s.total_runs}</td></tr>`)
    .join("");
  const isDemo = result.models.some((m) => m.providerId === "demo");
  const complete = c.done >= c.total;
  const state = complete
    ? `<span class="status status-good">✓ Complete</span>`
    : `<span class="status status-warning">◐ ${result.status === "running" ? "Running" : "Partial"}: ${c.done} of ${c.total} calls</span>`;

  return `<article class="paper" data-dashboard>
  ${isDemo ? '<p class="banner banner-warn"><b>Simulated data.</b> These results come from the built-in demo models (keyword rules plus noise). They show how the tool works and are not research data.</p>' : ""}
  <header class="paper-head">
    <h2>${esc(result.input?.title || "Classification results")}</h2>
    <p class="paper-meta">${state}<span>${plural(c.keys.length, "model")}, ${result.settings.runs} runs each, ${plural(c.rows.length, "item")}</span></p>
  </header>

  <section class="abstract" aria-labelledby="h-summary">
    <div class="abstract-head"><h3 id="h-summary">Summary</h3><button type="button" class="btn btn-small btn-ghost" data-copy="#results-text">Copy text</button></div>
    <p id="results-text">${resultsParagraph(result, c, final)}</p>
    ${complete ? "" : '<p class="muted small">Figures update while the run continues. Confidence intervals are added when it finishes.</p>'}
  </section>

  ${n.fig(`Final label per item${voices.length > 1 ? ", by voice" : ""}. Hatched: no final label (contested). Numbers at right are item counts.`, stackedBars(finalGroups))}

  <div class="pair">
    ${n.fig("Majority label per model across its <i>N</i> runs. Ties are excluded.", stackedBars(modelGroups))}
    ${n.tab(`Self-consistency per model. Confidence is the share of runs that returned the majority label.`, `<table class="t"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Mean <i>c</i></th><th scope="col" class="num"><i>c</i> ≥ ${apa(c.threshold)}</th><th scope="col" class="num">Ties</th><th scope="col" class="num">Failed runs</th></tr></thead><tbody>${sumRows}</tbody></table>`)}
  </div>

  ${n.fig(`Distribution of self-consistency confidence per model. Dark bars are at or above the acceptance threshold (${apa(c.threshold)}).`, `<div class="hists">${hists}</div>`)}

  ${n.tab("Agreement between models on the majority label, with bootstrap 95% confidence intervals.", agreementTable(c))}

  ${n.tab("Fairness-relevant options per decision, by final bias source.", decisionTable(c), "")}
  <p class="table-note"><sup>a</sup> Decision without options, classified at question level.</p>

  ${driverTable(c) ? n.tab("Decision drivers by final bias source. Counts of items that carry each driver; effects as given in the input (++ strongly supports, + supports, N neutral, - hurts).", driverTable(c)) : ""}

  ${n.tab("All items. Select an option to see every model's votes. Values after labels are confidence.", itemTable(c), itemFilters(c))}

  <section class="methods" aria-labelledby="h-methods">
    <h2 id="h-methods">Methods</h2>
    ${methods(result, c)}
  </section>

  ${checklistSection(result, c)}
</article>`;
}

// Interactive behaviour. Self-contained (no imports) so it can be embedded verbatim in the standalone report.
export function enhanceDashboard(root) {
  if (!root) return;
  const rows = Array.from(root.querySelectorAll("table.items tbody tr"));
  const fields = Array.from(root.querySelectorAll("[data-filter]"));
  const count = root.querySelector("[data-count]");
  const apply = () => {
    const f = {};
    fields.forEach((el) => (f[el.dataset.filter] = el.value.trim().toLowerCase()));
    let shown = 0;
    rows.forEach((tr) => {
      const ok =
        (!f.source || tr.dataset.source.toLowerCase() === f.source) &&
        (!f.status || tr.dataset.status.toLowerCase() === f.status) &&
        (!f.final || tr.dataset.final.toLowerCase() === f.final) &&
        (!f.text || tr.dataset.text.includes(f.text));
      tr.hidden = !ok;
      if (ok) shown++;
    });
    if (count) count.textContent = `${shown} of ${rows.length} items`;
  };
  fields.forEach((el) => el.addEventListener("input", apply));
  apply();

  root.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const el = root.querySelector(b.dataset.copy);
      const text = el ? el.innerText : "";
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
      } catch (_) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        b.textContent = "Text selected, press Ctrl+C";
      }
      setTimeout(() => (b.textContent = "Copy text"), 2000);
    })
  );

  // Checklist review: ticks and notes are kept per run in this browser (if storage is available).
  const sec = root.querySelector("[data-run]");
  if (sec) {
    const prefix = `tr24027-review:${sec.dataset.run}:`;
    const get = (k) => { try { return localStorage.getItem(prefix + k); } catch (_) { return null; } };
    const set = (k, v) => { try { v == null ? localStorage.removeItem(prefix + k) : localStorage.setItem(prefix + k, v); } catch (_) { /* storage unavailable */ } };
    const boxes = Array.from(sec.querySelectorAll("[data-review]"));
    const counter = sec.querySelector("[data-review-count]");
    const base = counter ? counter.textContent.split(";")[0] : "";
    const update = () => counter && (counter.textContent = `${base}; ${boxes.filter((b) => b.checked).length} of ${boxes.length} rows reviewed`);
    boxes.forEach((b) => {
      b.checked = get(`c:${b.dataset.review}`) === "1";
      b.closest("tr")?.classList.toggle("reviewed", b.checked);
      b.addEventListener("change", () => (set(`c:${b.dataset.review}`, b.checked ? "1" : null), b.closest("tr")?.classList.toggle("reviewed", b.checked), update()));
    });
    sec.querySelectorAll("[data-note]").forEach((n) => {
      n.value = get(`n:${n.dataset.note}`) || "";
      n.addEventListener("input", () => set(`n:${n.dataset.note}`, n.value || null));
    });
    update();
  }

  let tip = document.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  const move = (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t || !root.contains(t)) return (tip.style.opacity = "0");
    tip.textContent = t.getAttribute("data-tip");
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${e.clientY + 14}px)`;
    tip.style.opacity = "1";
  };
  root.addEventListener("mousemove", move);
  root.addEventListener("mouseleave", () => (tip.style.opacity = "0"));
}

export function buildReportHTML(result, css) {
  const json = JSON.stringify(result).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(result.input?.title || "Classification report")}: report</title>
<style>${css}</style></head>
<body class="report">
<main class="wrap">
<p class="report-note">Report generated ${esc(new Date().toISOString())} with ${esc(TOOL.name)} ${esc(TOOL.version)}. Every model response is embedded in this file; load it into the tool to inspect or resume the run.</p>
${renderDashboard(result)}
</main>
<script type="application/json" id="result-data">${json}</script>
<script>(${enhanceDashboard.toString()})(document.querySelector("[data-dashboard]"));</script>
</body></html>`;
}

// Extracts the embedded result JSON from a downloaded report, so reports can be re-loaded too.
export function resultFromReportHTML(html) {
  const m = html.match(/<script type="application\/json" id="result-data">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}
