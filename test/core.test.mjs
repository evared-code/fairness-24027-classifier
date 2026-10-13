// Run with: node test/core.test.mjs
import assert from "node:assert/strict";
import {
  parseLabel, selfConsistency, cohenKappa, fleissKappa, flattenItems, validateInput,
  aggregate, agreementReport, toCSV, buildUserPrompt, DEFAULT_DEFINITIONS, DEFAULT_CONTEXT, LABELS, bootstrapCI,
  parseResponse, clauseChecklist, DEFAULT_TAXONOMY, validateTaxonomy, clauseIndex,
  parseDriver, normalizeDrivers, driverCrosstab,
} from "../core.js";
import { readFileSync } from "node:fs";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok -", name); };

t("parseLabel handles JSON, prose and synonyms", () => {
  assert.equal(parseLabel('{"label": "Engineering"}'), "Engineering");
  assert.equal(parseLabel('```json\n{"label":"data"}\n```'), "Data");
  assert.equal(parseLabel('{"label": "Human cognitive"}'), "Cognitive");
  assert.equal(parseLabel("The answer is None."), "None");
  assert.equal(parseLabel("Data or Engineering"), null);
  assert.equal(parseLabel(""), null);
});

t("selfConsistency majority, confidence, ties, failures", () => {
  const r = selfConsistency(["Engineering", "Engineering", "Data", null, "Engineering"]);
  assert.equal(r.majority, "Engineering");
  assert.equal(r.valid, 4);
  assert.equal(r.failed, 1);
  assert.equal(r.confidence, 0.75);
  const tie = selfConsistency(["Data", "None"]);
  assert.equal(tie.majority, null);
  assert.equal(tie.tie, true);
  assert.equal(selfConsistency(["None", "None"]).entropy, 0);
});

// Reference values computed with scikit-learn / statsmodels (see test/reference.py)
const ref = JSON.parse(readFileSync(new URL("./reference.json", import.meta.url)));
t("Cohen's kappa matches scikit-learn", () => {
  const k = cohenKappa(ref.a, ref.b, LABELS).kappa;
  assert.ok(Math.abs(k - ref.cohen) < 1e-9, `${k} vs ${ref.cohen}`);
});
t("Fleiss' kappa matches statsmodels", () => {
  const rows = ref.a.map((x, i) => [x, ref.b[i], ref.c[i]]);
  const k = fleissKappa(rows, LABELS).kappa;
  assert.ok(Math.abs(k - ref.fleiss) < 1e-9, `${k} vs ${ref.fleiss}`);
});

t("Cohen's kappa hand-checkable case", () => {
  // po = 3/4; pe = 0.5*0.25 + 0.5*0.75 = 0.5; kappa = (0.75-0.5)/(1-0.5) = 0.5
  const res = cohenKappa(["E", "E", "D", "D"], ["E", "D", "D", "D"], ["E", "D"]);
  assert.equal(res.po, 0.75);
  assert.equal(res.pe, 0.5);
  assert.equal(res.kappa, 0.5);
  // perfect agreement on a single category is defined as 1, not NaN
  assert.equal(cohenKappa(["None", "None"], ["None", "None"], ["None", "Data"]).kappa, 1);
});

t("bootstrap CI is reproducible and brackets the estimate", () => {
  const rows = ref.a.map((x, i) => [x, ref.b[i], ref.c[i]]);
  const fn = (ix) => fleissKappa(ix.map((k) => rows[k]), LABELS).kappa;
  const ci1 = bootstrapCI(rows.length, fn, { B: 1000, seed: 7 });
  const ci2 = bootstrapCI(rows.length, fn, { B: 1000, seed: 7 });
  assert.deepEqual(ci1, ci2);
  assert.ok(ci1.lo < ref.fleiss && ref.fleiss < ci1.hi, JSON.stringify(ci1));
  assert.ok(ci1.hi - ci1.lo > 0.05 && ci1.hi - ci1.lo < 0.5);
  assert.equal(bootstrapCI(rows.length, fn, { B: 0 }), null);
});

t("dataset file validates and flattens", () => {
  const data = JSON.parse(readFileSync(new URL("../data/ethical-ai-metaverse.json", import.meta.url)));
  assert.deepEqual(validateInput(data), []);
  const items = flattenItems(data);
  const decisions = data.decisions.length;
  console.log(`    ${decisions} decisions, ${items.length} items`);
  assert.equal(decisions, 32);
  assert.equal(items.filter((i) => i.level === "option").length, 72);
  assert.equal(items.filter((i) => i.level === "question").length, 2);
  assert.equal(new Set(items.filter((i) => i.option).map((i) => i.option)).size, 64);
});

t("aggregate + report + csv run end to end", () => {
  const items = [
    { item_id: "a", decision_id: "d", question: "q", option: "o1", level: "option" },
    { item_id: "b", decision_id: "d", question: "q", option: "o2", level: "option" },
  ];
  const raw = {
    m1: { a: Array(10).fill("Engineering"), b: Array(10).fill("None") },
    m2: { a: [...Array(8).fill("Engineering"), "Data", "Data"], b: Array(10).fill("None") },
    m3: { a: Array(10).fill("Data"), b: [...Array(5).fill("None"), ...Array(5).fill("Data")] },
  };
  const rows = aggregate(items, ["m1", "m2", "m3"], raw, 0.8);
  assert.equal(rows[0].status, "Accepted (majority)");
  assert.equal(rows[0].final_label, "Engineering");
  assert.equal(rows[1].status, "Accepted (majority)"); // m3 tie → not counted
  const rep = agreementReport(rows, ["m1", "m2", "m3"]);
  assert.equal(rep.length, 3);
  const csv = toCSV(rows, ["m1", "m2", "m3"]);
  assert.ok(csv.split("\n").length === 3);
});

t("prompt contains option, definitions and label list", () => {
  const p = buildUserPrompt({ question: "Q?", option: "Opt" }, { context: DEFAULT_CONTEXT, definitions: DEFAULT_DEFINITIONS });
  assert.ok(p.includes("Opt") && p.includes("Engineering:") && p.includes('{"label"'));
});

t("parseResponse keeps a clause only if it belongs to the label", () => {
  assert.deepEqual(parseResponse('{"label":"Data","clause":"6.3.4"}'), { label: "Data", clause: "6.3.4" });
  assert.deepEqual(parseResponse('{"label":"Data","clause":"6.3.4 Non-representative sampling"}'), { label: "Data", clause: "6.3.4" });
  assert.deepEqual(parseResponse('{"label":"Cognitive","clause":"Automation bias"}'), { label: "Cognitive", clause: "6.2.2" });
  assert.deepEqual(parseResponse('{"label":"Engineering","clause":"6.3.4"}'), { label: "Engineering", clause: null });
  assert.deepEqual(parseResponse('{"label":"None","clause":null}'), { label: "None", clause: null });
  assert.deepEqual(parseResponse('{"label":"Data"}'), { label: "Data", clause: null });
});

t("taxonomy is valid and every clause id is unique", () => {
  assert.deepEqual(validateTaxonomy(DEFAULT_TAXONOMY), []);
  assert.equal(Object.keys(clauseIndex()).length, DEFAULT_TAXONOMY.Data.length + DEFAULT_TAXONOMY.Cognitive.length + DEFAULT_TAXONOMY.Engineering.length);
  assert.ok(validateTaxonomy({ Data: [] }).length > 0);
});

t("final clause pools votes of supporting models; checklist shows gaps", () => {
  const items = [
    { item_id: "a", decision_id: "d", question: "q", option: "o1", level: "option" },
    { item_id: "b", decision_id: "d", question: "q", option: "o2", level: "option" },
  ];
  const raw = { m1: { a: Array(5).fill("Data"), b: Array(5).fill("None") }, m2: { a: Array(5).fill("Data"), b: Array(5).fill("None") } };
  const clauses = {
    m1: { a: ["6.3.4", "6.3.4", "6.3.4", "6.3.2", "6.3.4"], b: Array(5).fill(null) },
    m2: { a: ["6.3.4", "6.3.2", "6.3.2", "6.3.4", "6.3.4"], b: Array(5).fill(null) },
  };
  const rows = aggregate(items, ["m1", "m2"], raw, 0.8, clauses);
  assert.equal(rows[0].per.m1.clause, "6.3.4");
  assert.equal(rows[0].final_clause, "6.3.4");
  assert.equal(rows[0].clause_share, 0.7);
  assert.equal(rows[1].final_clause, null);
  const cl = clauseChecklist(rows);
  const hit = cl.find((c) => c.id === "6.3.4");
  assert.deepEqual(hit.items, ["a"]);
  assert.equal(cl.filter((c) => !c.unspecified && c.count === 0).length, cl.filter((c) => !c.unspecified).length - 1);
  const rep = agreementReport(rows, ["m1", "m2"], {}, { taxonomy: DEFAULT_TAXONOMY });
  assert.equal(rep.length, 4);
  assert.equal(rep[3].items, 1);
});

t("decision drivers: parsing, validation, merging and prompt", () => {
  assert.deepEqual(parseDriver("Transparency (+)"), { name: "Transparency", effect: "+" });
  assert.deepEqual(parseDriver("Bias (N)"), { name: "Bias", effect: "N" });
  assert.deepEqual(parseDriver("Privacy"), { name: "Privacy", effect: "" });
  assert.deepEqual(parseDriver({ name: "Security", effect: "++" }), { name: "Security", effect: "++" });
  assert.deepEqual(parseDriver("Trust (−)"), { name: "Trust", effect: "-" });
  const data = { decisions: [{ id: "D", question: "q?", drivers: ["Trust (+)"], options: [{ id: "O1", text: "a", drivers: ["Trust (++)", "Bias (N)"] }, "b"] }] };
  assert.deepEqual(validateInput(data), []);
  const items = flattenItems(data);
  assert.deepEqual(items[0].drivers, [{ name: "Trust", effect: "++" }, { name: "Bias", effect: "N" }]);
  assert.deepEqual(items[1].drivers, [{ name: "Trust", effect: "+" }]);
  assert.ok(validateInput({ decisions: [{ id: "D", question: "q", drivers: "Trust" }] }).length > 0);
  assert.ok(validateInput({ decisions: [{ id: "D", question: "q", drivers: [{ name: "T", effect: "x" }] }] }).length > 0);
  const p1 = buildUserPrompt(items[0], { context: "c", definitions: DEFAULT_DEFINITIONS });
  assert.ok(p1.includes("Decision drivers recorded for this option") && p1.includes("Trust (++)"));
  const p2 = buildUserPrompt(items[0], { context: "c", definitions: DEFAULT_DEFINITIONS, includeDrivers: false });
  assert.ok(!p2.includes("Decision drivers"));
  const xt = driverCrosstab([{ drivers: items[0].drivers, final_label: "Data" }, { drivers: items[1].drivers, final_label: null }]);
  assert.equal(xt[0].name, "Trust");
  assert.equal(xt[0].total, 2);
  assert.equal(xt[0].counts.Data, 1);
  assert.equal(xt[0].counts.Contested, 1);
});

t("example dataset carries drivers on every option", () => {
  const data = JSON.parse(readFileSync(new URL("../data/ethical-ai-metaverse.json", import.meta.url)));
  const items = flattenItems(data);
  assert.equal(items.filter((i) => i.level === "option" && i.drivers.length).length, 72);
});

console.log(`\n${passed} tests passed`);
