#!/usr/bin/env node
// Build-spec core rule: the core never mentions a domain term. Fails if a pack-specific word
// appears in core/*/src (tests may use any vocabulary).
//
// The terms come from two places:
//   1. a short fixed list of domain words (below), and
//   2. every identifier in every pack's ontology.yaml and data.yaml (fact and evidence names, hierarchy and level
//      names, dimensions, metric names, pack-defined time levels), so adding a pack extends the
//      check without anyone remembering to.
// Words the core legitimately uses for something else are listed in scripts/purity-allow.json,
// each with its reason.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

// Words from the example domains (logistics, contact centres, financial crime). The core, the skills and the
// shared playbooks are domain-free: a use case's words live in its pack, and nowhere else.
const FIXED = [
  "shipment", "carrier", "sku", "customers?", "region", "zone", "otif", "warehouse", "depot", "dock",
  "freight", "deliver(y|ies)", "orders?_id", "centre", "handle_seconds", "abandon(ed|ment)?", "fulfil(l)?ment",
  "stockout", "alerts?_rate", "transactions?", "complaints?", "sla", "queue",
];
// pack-defined time levels use these generic names for built-in levels; those are the core's own vocabulary
const BUILTIN_TIME = new Set(["year", "quarter", "month", "week", "day", "hour"]);

const allow = existsSync("scripts/purity-allow.json") ? JSON.parse(readFileSync("scripts/purity-allow.json", "utf-8")) : {};
const allowed = new Set(Object.keys(allow).filter((k) => !k.startsWith("_")).map((k) => k.toLowerCase()));

function packTerms() {
  const terms = new Map(); // term -> pack it came from
  const add = (name, pack) => {
    if (typeof name !== "string" || !/^[A-Za-z_]\w*$/.test(name)) return;
    if (name.length < 3 || BUILTIN_TIME.has(name) || allowed.has(name.toLowerCase())) return;
    if (!terms.has(name)) terms.set(name, pack);
  };
  if (!existsSync("packs")) return terms;
  for (const pack of readdirSync("packs")) {
    const file = join("packs", pack, "ontology.yaml");
    if (!existsSync(file)) continue;
    const o = YAML.parse(readFileSync(file, "utf-8"));
    for (const [h, levels] of Object.entries(o.hierarchies ?? {})) {
      add(h, pack);
      for (const l of levels) add(l, pack);
    }
    for (const d of o.dimensions ?? []) add(d, pack);
    for (const m of Object.keys(o.metrics ?? {})) add(m, pack);
    for (const l of o.time?.levels ?? []) add(typeof l === "string" ? l : l.name, pack);
    // the data definition is where a pack's table-shaped words live: facts, evidence sources, custom slots
    const dataFile = join("packs", pack, "data.yaml");
    if (existsSync(dataFile)) {
      const d = YAML.parse(readFileSync(dataFile, "utf-8"));
      for (const [name, fact] of Object.entries(d.facts ?? {})) {
        add(name, pack);
        for (const c of fact.concepts ?? []) add(c, pack);
        for (const k of Object.keys(fact.slots ?? {})) add(k, pack);
      }
      for (const name of Object.keys(d.evidence ?? {})) add(name, pack);
    }
  }
  return terms;
}

const derived = packTerms();
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`\\b(${[...FIXED.filter((t) => !allowed.has(t)), ...[...derived.keys()].map(escape)].join("|")})\\b`, "i");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js|json)$/.test(name)) yield p;
  }
}

let bad = 0;
for (const pkg of readdirSync("core")) {
  const src = join("core", pkg, "src");
  try { statSync(src); } catch { continue; }
  for (const file of walk(src)) {
    readFileSync(file, "utf-8").split(/\r?\n/).forEach((line, i) => {
      const m = line.match(re);
      if (m) {
        bad++;
        const from = derived.get(m[0]) ?? derived.get(m[0].toLowerCase());
        console.error(`${file}:${i + 1}: domain term "${m[0]}"${from ? ` (from pack ${from})` : ""}: ${line.trim()}`);
      }
    });
  }
}
// the skills and shared playbooks are read by people and agents on every use case: same rule, fixed list only
const prose = [];
if (existsSync("skills")) for (const d of readdirSync("skills")) { const f = join("skills", d, "SKILL.md"); if (existsSync(f)) prose.push(f); }
if (existsSync("playbooks")) for (const f of readdirSync("playbooks")) if (f.endsWith(".yaml")) prose.push(join("playbooks", f));
const fixedRe = new RegExp(`\b(${FIXED.filter((t) => !allowed.has(t)).join("|")})\b`, "i");
for (const file of prose) {
  readFileSync(file, "utf-8").split(/\r?\n/).forEach((line, i) => {
    const m = line.match(fixedRe);
    if (m) { bad++; console.error(`${file}:${i + 1}: domain term "${m[0]}": ${line.trim()}`); }
  });
}
if (bad) { console.error(`\n${bad} domain-term violation(s) in core/`); process.exit(1); }
console.log(`core purity OK (${derived.size} pack identifiers from ${new Set(derived.values()).size} pack(s) + ${FIXED.length} fixed terms checked)`);
