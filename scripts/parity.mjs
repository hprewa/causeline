#!/usr/bin/env node
// Compare two eval result files (for example SQLite and BigQuery runs of the same cases) and say where they differ.
// The same data and the same maths must give the same answer on every database; a difference is a bug in a dialect.
//   node scripts/parity.mjs <a.json> <b.json> [--tolerance 1e-9]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const tol = Number(args.includes("--tolerance") ? args[args.indexOf("--tolerance") + 1] : 1e-9);
if (files.length !== 2) {
  console.error("usage: node scripts/parity.mjs <a.json> <b.json> [--tolerance 1e-9]");
  process.exit(2);
}
const [a, b] = files.map((f) => new Map(JSON.parse(readFileSync(f, "utf-8")).map((o) => [o.id, o])));

const differences = [];
const near = (x, y) => Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));
for (const [id, x] of a) {
  const y = b.get(id);
  if (!y) {
    differences.push(`${id}: missing from the second file`);
    continue;
  }
  const sx = x.summary;
  const sy = y.summary;
  if (!sx || !sy) {
    differences.push(`${id}: no summary recorded (${!sx ? "first" : "second"} file)`);
    continue;
  }
  if (sx.status !== sy.status) differences.push(`${id}: status ${sx.status} vs ${sy.status}`);
  if (sx.stopped_reason !== sy.stopped_reason) differences.push(`${id}: stopped_reason ${sx.stopped_reason} vs ${sy.stopped_reason}`);
  if (JSON.stringify(sx.findings) !== JSON.stringify(sy.findings)) differences.push(`${id}: findings ${JSON.stringify(sx.findings)} vs ${JSON.stringify(sy.findings)}`);
  if (JSON.stringify(sx.masking_flags) !== JSON.stringify(sy.masking_flags)) differences.push(`${id}: masking flags ${JSON.stringify(sx.masking_flags)} vs ${JSON.stringify(sy.masking_flags)}`);
  if (sx.headline && sy.headline) {
    for (const k of ["value", "baseline", "change"]) if (!near(sx.headline[k], sy.headline[k])) differences.push(`${id}: headline ${k} ${sx.headline[k]} vs ${sy.headline[k]}`);
  } else if (!!sx.headline !== !!sy.headline) differences.push(`${id}: headline present in only one`);
  if ((x.runner?.pass ?? null) !== (y.runner?.pass ?? null)) differences.push(`${id}: score ${x.runner?.pass} vs ${y.runner?.pass}`);
}
for (const id of b.keys()) if (!a.has(id)) differences.push(`${id}: missing from the first file`);

const cost = [...b.values()].map((o) => o.summary?.cost).filter(Boolean);
if (cost.length) {
  const bytes = cost.reduce((s, c) => s + c.bytes_scanned, 0);
  console.log(`second file read ${(bytes / 1e9).toFixed(2)} GB in ${cost.reduce((s, c) => s + c.queries, 0)} queries (about $${cost.reduce((s, c) => s + c.estimated_usd, 0).toFixed(4)} at list price, before the free tier)`);
}
console.log(`${a.size} cases compared, ${differences.length === 0 ? "identical" : differences.length + " difference(s)"}`);
for (const d of differences) console.log("  " + d);
process.exit(differences.length === 0 ? 0 : 1);
