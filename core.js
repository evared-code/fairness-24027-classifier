// core.js — pure logic (no network, no DOM). Usable in the browser and in Node for tests.
// Prompt building, response parsing, self-consistency aggregation, and agreement metrics.

export const LABELS = ["Data", "Cognitive", "Engineering", "None"];
export const SOURCE_LABELS = ["Data", "Cognitive", "Engineering"];

// Default definitions are the tool author's paraphrase of the three bias sources
// discussed in ISO/IEC TR 24027:2021. Users should check and edit them against the standard.
export const DEFAULT_DEFINITIONS = {
  Data:
    "Bias originating in the data used to build, test or operate an AI-aided feature, e.g. non-representative or skewed samples, missing data for some groups, or biased labelling processes.",
  Cognitive:
    "Bias originating in the human judgement of the people who design, build, label, operate or oversee the system, e.g. automation bias, in-group bias, confirmation bias, or assumptions about who the 'typical' user is.",
  Engineering:
    "Bias introduced by technical and design decisions about the system, e.g. choice of algorithm or optimisation objective, feature selection, thresholds, platform or device requirements, or architectural choices that work worse for some groups of people.",
  None:
    "The option has no plausible pathway to systematically different treatment of certain people or groups compared with others.",
};

export const DEFAULT_SYSTEM_PROMPT =
  "You are an expert in AI fairness and software architecture. You classify architectural design decision options by the primary source of potential unwanted bias, following the bias sources described in ISO/IEC TR 24027:2021 (Bias in AI systems and AI aided decision making). Answer with JSON only.";

export const DEFAULT_CONTEXT =
  "The system is an eCommerce metaverse: an immersive 3D virtual world (web and native mobile apps) where users shop, interact through avatars, use AI-aided features such as recommendations, moderation and monitoring, and complete secure transactions.";

// Bias types under each source, following the structure of ISO/IEC TR 24027:2021 clause 6
// ("Sources of unwanted bias in AI systems"). Clause numbers and the short descriptions are the
// tool author's reading of the standard: verify them against the standard before publication.
// The taxonomy is stored with every run, so reports show exactly which list was used.
export const DEFAULT_TAXONOMY = {
  Data: [
    { id: "6.3.2", name: "Statistical bias", hint: "selection, sampling, coverage or non-response bias; confounding variables" },
    { id: "6.3.3", name: "Data labels and labelling process", hint: "biased, subjective or inconsistent annotation" },
    { id: "6.3.4", name: "Non-representative sampling", hint: "some groups missing or under-represented in the data" },
    { id: "6.3.5", name: "Missing features and labels", hint: "attributes or labels absent more often for some groups" },
    { id: "6.3.6", name: "Data processing", hint: "cleaning, filtering or transformation that treats groups differently" },
    { id: "6.3.7", name: "Simpson's paradox", hint: "a trend that reverses when groups are combined" },
    { id: "6.3.8", name: "Data aggregation", hint: "combining data hides differences between groups" },
    { id: "6.3.9", name: "Distributed training", hint: "uneven data across federated or distributed sources" },
    { id: "6.3.10", name: "Other sources of data bias", hint: "any other data-related source" },
  ],
  Cognitive: [
    { id: "6.2.2", name: "Automation bias", hint: "people over-rely on automated outputs" },
    { id: "6.2.3", name: "Group attribution bias", hint: "assuming individuals share the traits of their group" },
    { id: "6.2.4", name: "Implicit bias", hint: "unconscious associations of designers or operators" },
    { id: "6.2.5", name: "Confirmation bias", hint: "favouring information that confirms existing beliefs" },
    { id: "6.2.6", name: "In-group bias", hint: "favouring people like the team itself" },
    { id: "6.2.7", name: "Out-group homogeneity bias", hint: "seeing members of other groups as all alike" },
    { id: "6.2.8", name: "Societal bias", hint: "historical or social inequities carried into the system" },
    { id: "6.2.9", name: "Rule-based system design", hint: "biased hand-written rules, policies or guidelines" },
    { id: "6.2.10", name: "Requirements bias", hint: "biased or incomplete requirements and specifications" },
    { id: "6.2.1", name: "Other human cognitive bias", hint: "general clause, when no specific type fits" },
  ],
  Engineering: [
    { id: "6.4.2", name: "Feature engineering", hint: "chosen inputs or proxy variables that disadvantage groups" },
    { id: "6.4.3", name: "Algorithm selection", hint: "choice of model, algorithm or optimisation objective" },
    { id: "6.4.4", name: "Hyperparameter tuning", hint: "thresholds and tuning that work worse for some groups" },
    { id: "6.4.5", name: "Informativeness", hint: "inputs that are less informative for some groups" },
    { id: "6.4.6", name: "Model bias", hint: "the model's structural tendency to favour some groups" },
    { id: "6.4.7", name: "Model interaction", hint: "feedback loops between the system, users and other models" },
    { id: "6.4.1", name: "Other engineering decision", hint: "general clause, e.g. platform, device or architecture choices" },
  ],
};

export const CLAUSE_HEADINGS = { Cognitive: "6.2 Human cognitive biases", Data: "6.3 Data bias", Engineering: "6.4 Bias introduced by engineering decisions" };

// Flat lookup: clause id -> { id, name, hint, source }
export function clauseIndex(taxonomy = DEFAULT_TAXONOMY) {
  const idx = {};
  for (const src of SOURCE_LABELS) for (const c of taxonomy[src] || []) idx[c.id] = { ...c, source: src };
  return idx;
}

export function validateTaxonomy(t) {
  const errs = [];
  if (!t || typeof t !== "object") return ["The bias-type list must be a JSON object."];
  const seen = new Set();
  for (const src of SOURCE_LABELS) {
    if (!Array.isArray(t[src]) || !t[src].length) errs.push(`"${src}" must be a non-empty list.`);
    else t[src].forEach((c, i) => {
      if (!c || !c.id || !c.name) errs.push(`${src}[${i}] needs "id" and "name".`);
      else if (seen.has(c.id)) errs.push(`Clause id "${c.id}" appears twice.`);
      else seen.add(c.id);
    });
  }
  return errs;
}

// ---------- decision drivers (optional input) ----------
// Drivers are the quality attributes (forces) a decision option affects, as in QOC analysis.
// Accepted forms: "Transparency (+)", "Bias", { "name": "Privacy", "effect": "++" }.
// Effects: ++ strongly supports, + supports, N neutral, - hurts, -- strongly hurts, "" not stated.
export const DRIVER_EFFECTS = ["++", "+", "N", "-", "--", ""];

export function parseDriver(d) {
  if (d == null) return null;
  if (typeof d === "string") {
    const m = d.trim().match(/^(.*?)\s*\(\s*(\+\+|\+|N|n|-|--|−|−−)\s*\)\s*$/);
    const name = (m ? m[1] : d).trim();
    const effect = m ? m[2].replace(/−/g, "-").toUpperCase() : "";
    return name ? { name, effect } : null;
  }
  if (typeof d === "object" && d.name) {
    const effect = String(d.effect ?? "").trim().replace(/−/g, "-").toUpperCase();
    return { name: String(d.name).trim(), effect: DRIVER_EFFECTS.includes(effect) ? effect : "" };
  }
  return null;
}

export function normalizeDrivers(list) {
  if (!Array.isArray(list)) return [];
  const out = new Map();
  for (const d of list) {
    const p = parseDriver(d);
    if (p) out.set(p.name.toLowerCase(), p);
  }
  return [...out.values()];
}

export const driverText = (d) => (d.effect ? `${d.name} (${d.effect})` : d.name);

function validateDrivers(list, where, errors) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return errors.push(`${where}.drivers must be a list.`);
  list.forEach((d, k) => {
    if (!parseDriver(d)) errors.push(`${where}.drivers[${k}] needs a name, e.g. "Transparency (+)".`);
    else if (typeof d === "object" && d.effect != null && !DRIVER_EFFECTS.includes(String(d.effect).trim().replace(/−/g, "-").toUpperCase()))
      errors.push(`${where}.drivers[${k}].effect must be one of ++, +, N, -, --.`);
  });
}

// ---------- input handling ----------

export function validateInput(data) {
  const errors = [];
  if (!data || typeof data !== "object") return ["File is not a JSON object."];
  if (!Array.isArray(data.decisions)) errors.push('Missing "decisions" array.');
  else {
    const seen = new Set();
    data.decisions.forEach((d, i) => {
      if (!d || typeof d !== "object") return errors.push(`decisions[${i}] is not an object.`);
      if (!d.id) errors.push(`decisions[${i}] has no "id".`);
      if (!d.question) errors.push(`decisions[${i}] has no "question".`);
      if (d.id && seen.has(d.id)) errors.push(`Duplicate decision id "${d.id}".`);
      seen.add(d.id);
      if (d.options !== undefined && !Array.isArray(d.options))
        errors.push(`decisions[${i}].options must be an array.`);
      validateDrivers(d.drivers, `decisions[${i}]`, errors);
      (d.options || []).forEach((o, j) => {
        if (typeof o === "string") return;
        if (!o || !o.text) errors.push(`decisions[${i}].options[${j}] has no "text".`);
        else validateDrivers(o.drivers, `decisions[${i}].options[${j}]`, errors);
      });
    });
  }
  return errors;
}

// One item per option; a decision with no options becomes one question-level item.
export function flattenItems(data) {
  const items = [];
  for (const d of data.decisions) {
    const opts = d.options || [];
    if (opts.length === 0) {
      items.push({
        item_id: d.id,
        decision_id: d.id,
        source: d.source || "",
        category: d.category || "",
        question: d.question,
        option: null,
        level: "question",
        drivers: normalizeDrivers(d.drivers),
      });
    } else {
      opts.forEach((o, j) => {
        const text = typeof o === "string" ? o : o.text;
        const id = typeof o === "string" || !o.id ? `${d.id}-O${j + 1}` : o.id;
        items.push({
          item_id: id,
          decision_id: d.id,
          source: d.source || "",
          category: d.category || "",
          question: d.question,
          option: text,
          level: "option",
          drivers: normalizeDrivers([...(d.drivers || []), ...((typeof o === "object" && o.drivers) || [])]),
        });
      });
    }
  }
  return items;
}

// ---------- prompt ----------

export function shuffled(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildUserPrompt(item, { context, definitions, labelOrder = LABELS, taxonomy = DEFAULT_TAXONOMY, includeDrivers = true }) {
  const defs = labelOrder.map((l) => `- ${l}: ${definitions[l]}`).join("\n");
  let subject =
    item.option == null
      ? `Design decision (question): ${item.question}`
      : `Design decision (question): ${item.question}\nOption being classified: ${item.option}`;
  if (includeDrivers && item.drivers?.length)
    subject += `\nDecision drivers recorded for this option (quality attributes it affects; ++ strongly supports, + supports, N neutral, - hurts, -- strongly hurts): ${item.drivers.map(driverText).join(", ")}`;
  const types = labelOrder
    .filter((l) => l !== "None" && taxonomy[l])
    .map((l) => `${l}:\n${taxonomy[l].map((c) => `  ${c.id} ${c.name} (${c.hint || ""})`).join("\n")}`)
    .join("\n");
  return [
    `Context: ${context}`,
    "",
    "Labels (choose exactly one):",
    defs,
    "",
    "Bias types (ISO/IEC TR 24027 clause) under each label:",
    types,
    "",
    subject,
    "",
    "If this option were adopted, what is the PRIMARY source of potential unwanted bias it could introduce or must manage, and which bias type under that source fits best? If it has no plausible fairness relevance, choose None and set clause to null.",
    `Respond with JSON only, exactly in this form: {"label": "<one of ${labelOrder.join(" | ")}>", "clause": "<clause id from the list under your label, or null>"}`,
  ].join("\n");
}

// ---------- parsing ----------

const SYNONYMS = [
  [/human[\s_-]*cognitive|cognitive/i, "Cognitive"],
  [/engineering/i, "Engineering"],
  [/\bdata\b/i, "Data"],
  [/\bnone\b|not[\s_-]*relevant|no[\s_-]*bias/i, "None"],
];

export function normalizeLabel(s) {
  if (s == null) return null;
  const t = String(s).trim();
  for (const l of LABELS) if (t.toLowerCase() === l.toLowerCase()) return l;
  for (const [re, l] of SYNONYMS) if (re.test(t)) return l;
  return null;
}

export function parseLabel(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      const v = normalizeLabel(obj.label ?? obj.Label ?? obj.answer);
      if (v) return v;
    } catch (_) {
      /* fall through */
    }
    const lm = m[0].match(/"label"\s*:\s*"([^"]+)"/i);
    if (lm) {
      const v = normalizeLabel(lm[1]);
      if (v) return v;
    }
  }
  // Fallback: exactly one label word mentioned
  const found = LABELS.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(text));
  return found.length === 1 ? found[0] : null;
}

// Returns { label, clause }. The clause must belong to the chosen label; otherwise it is dropped.
export function parseResponse(text, taxonomy = DEFAULT_TAXONOMY) {
  const label = parseLabel(text);
  if (!label || label === "None") return { label, clause: null };
  const list = taxonomy[label] || [];
  let raw = null;
  const m = String(text).match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      raw = obj.clause ?? obj.Clause ?? obj.subtype ?? obj.bias_type ?? null;
    } catch (_) {
      const cm = m[0].match(/"clause"\s*:\s*"([^"]+)"/i);
      raw = cm ? cm[1] : null;
    }
  }
  if (raw == null) return { label, clause: null };
  const t = String(raw).trim().toLowerCase();
  const byId = list.find((c) => t === c.id.toLowerCase() || t.startsWith(`${c.id.toLowerCase()} `));
  if (byId) return { label, clause: byId.id };
  const byName = list.find((c) => t.includes(c.name.toLowerCase()));
  return { label, clause: byName ? byName.id : null };
}

// ---------- self-consistency ----------

export function entropy(counts, total) {
  if (!total) return null;
  let h = 0;
  for (const c of Object.values(counts)) if (c > 0) h -= (c / total) * Math.log2(c / total);
  return h / Math.log2(LABELS.length); // normalised 0..1
}

// labels: array of label strings or null (failed parse/call) for one item × one model
export function selfConsistency(labels) {
  const counts = Object.fromEntries(LABELS.map((l) => [l, 0]));
  let valid = 0;
  for (const l of labels) if (l && counts[l] !== undefined) (counts[l]++, valid++);
  const max = Math.max(...Object.values(counts));
  const top = LABELS.filter((l) => counts[l] === max && max > 0);
  const tie = top.length > 1;
  return {
    runs: labels.length,
    valid,
    failed: labels.length - valid,
    counts,
    majority: valid && !tie ? top[0] : null,
    tie,
    confidence: valid ? max / valid : null,
    entropy: entropy(counts, valid),
  };
}

// Majority clause among the runs that returned the given label.
function clauseVote(labels, clauses, label) {
  const counts = {};
  let n = 0;
  labels.forEach((l, i) => {
    if (l === label && clauses?.[i]) (counts[clauses[i]] = (counts[clauses[i]] || 0) + 1), n++;
  });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max && max > 0);
  return { counts, n, clause: top.length === 1 ? top[0] : null, share: n ? max / n : null };
}

// raw: { [modelKey]: { [item_id]: [label|null, ...] } }; clauses: same shape with clause ids (optional)
export function aggregate(items, modelKeys, raw, threshold, clauses = {}) {
  return items.map((it) => {
    const per = {};
    for (const mk of modelKeys) {
      const labels = (raw[mk] && raw[mk][it.item_id]) || [];
      const sc = selfConsistency(labels);
      const cv = sc.majority && sc.majority !== "None" ? clauseVote(labels, clauses?.[mk]?.[it.item_id], sc.majority) : null;
      per[mk] = { ...sc, clause: cv?.clause ?? null, clause_share: cv?.share ?? null, clause_counts: cv?.counts ?? {} };
    }
    const confident = modelKeys
      .map((mk) => per[mk])
      .filter((r) => r.majority && r.confidence >= threshold)
      .map((r) => r.majority);
    const tally = {};
    for (const l of confident) tally[l] = (tally[l] || 0) + 1;
    let best = null,
      bestN = 0;
    for (const [l, n] of Object.entries(tally)) if (n > bestN) (best = l), (bestN = n);
    const nModels = modelKeys.length;
    let status, final;
    if (bestN === nModels && nModels > 0) (status = "Accepted (full agreement)"), (final = best);
    else if (bestN >= 2 && bestN > nModels / 2) (status = "Accepted (majority)"), (final = best);
    else if (nModels === 1 && bestN === 1) (status = "Accepted (single model)"), (final = best);
    else (status = "Contested"), (final = null);
    // Final clause: pool the clause votes of the models that support the final label.
    let final_clause = null, clause_share = null;
    if (final && final !== "None") {
      const pooled = {};
      for (const mk of modelKeys) {
        const p = per[mk];
        if (p.majority === final && p.confidence >= threshold) for (const [c, n] of Object.entries(p.clause_counts)) pooled[c] = (pooled[c] || 0) + n;
      }
      const tot = Object.values(pooled).reduce((a, b) => a + b, 0);
      const max = Math.max(0, ...Object.values(pooled));
      const top = Object.keys(pooled).filter((c) => pooled[c] === max && max > 0);
      if (top.length === 1) (final_clause = top[0]), (clause_share = max / tot);
    }
    return { ...it, per, final_label: final, final_clause, clause_share, agreement: `${bestN}/${nModels}`, status };
  });
}

// Decision drivers against final bias source: how often each driver appears on items with each final label.
export function driverCrosstab(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const d of r.drivers || []) {
      const k = d.name;
      if (!by.has(k)) by.set(k, { name: k, total: 0, counts: Object.fromEntries([...LABELS, "Contested"].map((l) => [l, 0])), effects: {} });
      const e = by.get(k);
      e.total++;
      e.counts[r.final_label || "Contested"]++;
      if (d.effect) e.effects[d.effect] = (e.effects[d.effect] || 0) + 1;
    }
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// One row per bias type: which items (final label + final clause) address it. Rows with no items are gaps.
export function clauseChecklist(rows, taxonomy = DEFAULT_TAXONOMY) {
  const out = [];
  for (const src of ["Cognitive", "Data", "Engineering"]) {
    for (const c of taxonomy[src] || []) {
      const its = rows.filter((r) => r.final_label === src && r.final_clause === c.id);
      out.push({ source: src, ...c, items: its.map((r) => r.item_id), count: its.length });
    }
    const unspecified = rows.filter((r) => r.final_label === src && !r.final_clause);
    if (unspecified.length) out.push({ source: src, id: "", name: "No agreed bias type", hint: "", items: unspecified.map((r) => r.item_id), count: unspecified.length, unspecified: true });
  }
  return out;
}

// ---------- agreement metrics ----------

export function cohenKappa(a, b, cats) {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x != null && y != null);
  const n = pairs.length;
  if (!n) return { kappa: null, n: 0, po: null, pe: null };
  const po = pairs.filter(([x, y]) => x === y).length / n;
  let pe = 0;
  for (const c of cats) {
    const pa = pairs.filter(([x]) => x === c).length / n;
    const pb = pairs.filter(([, y]) => y === c).length / n;
    pe += pa * pb;
  }
  const kappa = 1 - pe === 0 ? (po === 1 ? 1 : null) : (po - pe) / (1 - pe);
  return { kappa, n, po, pe };
}

// rows: array of arrays, each inner array = labels from all raters for one item (no nulls)
export function fleissKappa(rows, cats) {
  const use = rows.filter((r) => r.length >= 2 && r.every((x) => x != null));
  const N = use.length;
  if (!N) return { kappa: null, n: 0, pbar: null, pe: null };
  const m = use[0].length;
  const table = use.map((r) => cats.map((c) => r.filter((x) => x === c).length));
  const Pi = table.map((row) => (row.reduce((s, x) => s + x * x, 0) - m) / (m * (m - 1)));
  const pbar = Pi.reduce((s, x) => s + x, 0) / N;
  const pj = cats.map((_, j) => table.reduce((s, row) => s + row[j], 0) / (N * m));
  const pe = pj.reduce((s, x) => s + x * x, 0);
  const kappa = 1 - pe === 0 ? (pbar === 1 ? 1 : null) : (pbar - pe) / (1 - pe);
  return { kappa, n: N, pbar, pe };
}

export function landisKoch(k) {
  if (k == null || Number.isNaN(k)) return "undefined";
  if (k < 0) return "poor";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

// ---------- bootstrap confidence intervals ----------

// Small seeded PRNG so confidence intervals are reproducible run to run.
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, p) {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (h - lo);
}

// Percentile bootstrap over items. statFn receives an array of resampled item indices.
export function bootstrapCI(n, statFn, { B = 2000, seed = 24027, alpha = 0.05 } = {}) {
  if (!B || n < 2) return null;
  const rand = mulberry32(seed);
  const vals = [];
  const idx = new Array(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * n);
    const v = statFn(idx);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < B / 2) return null;
  vals.sort((a, b) => a - b);
  return { lo: quantile(vals, alpha / 2), hi: quantile(vals, 1 - alpha / 2), B, seed, level: 1 - alpha };
}

const toBinary = (l) => (l == null ? null : l === "None" ? "Not relevant" : "Relevant");

// Views: all 4 labels; step 1 (fairness-relevant or not); step 2 (source, items every model judged relevant);
// step 3 (TR 24027 bias type, items where every model chose the same source and gave a bias type).
// opts.bootstrap = number of bootstrap resamples for 95% CIs (0 = skip)
export function agreementReport(rows, modelKeys, modelNames = {}, { bootstrap = 0, seed = 24027, taxonomy = null } = {}) {
  const lab = (r, mk) => r.per[mk].majority;
  const views = {
    "All labels (Data / Cognitive / Engineering / None)": { cats: LABELS, get: lab, filter: () => true },
    "Step 1: fairness-relevant vs. None": { cats: ["Relevant", "Not relevant"], get: (r, mk) => toBinary(lab(r, mk)), filter: () => true },
    "Step 2: bias source (items all models judged relevant)": {
      cats: SOURCE_LABELS,
      get: lab,
      filter: (r) => modelKeys.every((mk) => r.per[mk].majority && r.per[mk].majority !== "None"),
    },
  };
  const anyClause = rows.some((r) => modelKeys.some((mk) => r.per[mk].clause));
  if (taxonomy && anyClause) {
    views["Step 3: TR 24027 bias type (items where all models chose the same source)"] = {
      cats: Object.keys(clauseIndex(taxonomy)),
      get: (r, mk) => r.per[mk].clause,
      filter: (r) => {
        const first = r.per[modelKeys[0]].majority;
        return first && first !== "None" && modelKeys.every((mk) => r.per[mk].majority === first && r.per[mk].clause);
      },
    };
  }
  const out = [];
  for (const [name, v] of Object.entries(views)) {
    const sub = rows.filter(v.filter);
    const pairwise = [];
    for (let i = 0; i < modelKeys.length; i++)
      for (let j = i + 1; j < modelKeys.length; j++) {
        const a = sub.map((r) => v.get(r, modelKeys[i]));
        const b = sub.map((r) => v.get(r, modelKeys[j]));
        const res = cohenKappa(a, b, v.cats);
        const ci = bootstrapCI(a.length, (ix) => cohenKappa(ix.map((k) => a[k]), ix.map((k) => b[k]), v.cats).kappa, { B: bootstrap, seed });
        pairwise.push({
          pair: `${modelNames[modelKeys[i]] || modelKeys[i]} and ${modelNames[modelKeys[j]] || modelKeys[j]}`,
          ...res,
          ci,
          interpretation: landisKoch(res.kappa),
        });
      }
    let fl = { kappa: null, n: 0, ci: null };
    if (modelKeys.length >= 3) {
      const rs = sub.map((r) => modelKeys.map((mk) => v.get(r, mk))).filter((r) => r.every((x) => x != null));
      fl = { ...fleissKappa(rs, v.cats), ci: bootstrapCI(rs.length, (ix) => fleissKappa(ix.map((k) => rs[k]), v.cats).kappa, { B: bootstrap, seed }) };
    }
    out.push({ view: name, items: sub.length, fleiss: { ...fl, interpretation: landisKoch(fl.kappa) }, pairwise });
  }
  return out;
}

export function modelSummary(rows, modelKeys, threshold) {
  return modelKeys.map((mk) => {
    const rs = rows.map((r) => r.per[mk]);
    const withConf = rs.filter((r) => r.confidence != null);
    const meanConf = withConf.length ? withConf.reduce((s, r) => s + r.confidence, 0) / withConf.length : null;
    const runs = rs.reduce((s, r) => s + r.runs, 0);
    const failed = rs.reduce((s, r) => s + r.failed, 0);
    const dist = Object.fromEntries(LABELS.map((l) => [l, rs.filter((r) => r.majority === l).length]));
    return {
      model: mk,
      mean_confidence: meanConf,
      above_threshold: rs.filter((r) => r.confidence != null && r.confidence >= threshold).length,
      ties: rs.filter((r) => r.tie).length,
      failed_runs: failed,
      total_runs: runs,
      distribution: dist,
    };
  });
}

// ---------- export ----------

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows, modelKeys, modelNames = {}) {
  const head = ["item_id", "decision_id", "source", "category", "level", "question", "option", "drivers"];
  for (const mk of modelKeys) {
    const n = modelNames[mk] || mk;
    head.push(`${n}_majority`, `${n}_clause`, `${n}_confidence`, `${n}_entropy`, ...LABELS.map((l) => `${n}_n_${l}`), `${n}_failed`);
  }
  head.push("agreement", "final_label", "final_clause", "clause_share", "status");
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    const row = [r.item_id, r.decision_id, r.source, r.category, r.level, r.question, r.option, (r.drivers || []).map(driverText).join("; ")];
    for (const mk of modelKeys) {
      const p = r.per[mk];
      row.push(
        p.majority ?? (p.tie ? "TIE" : ""),
        p.clause ?? "",
        p.confidence == null ? "" : p.confidence.toFixed(2),
        p.entropy == null ? "" : p.entropy.toFixed(3),
        ...LABELS.map((l) => p.counts[l]),
        p.failed
      );
    }
    row.push(r.agreement, r.final_label ?? "", r.final_clause ?? "", r.clause_share == null ? "" : r.clause_share.toFixed(2), r.status);
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n");
}
