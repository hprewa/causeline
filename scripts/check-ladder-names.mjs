#!/usr/bin/env node
// The status ladder was renamed (draft, reconciled, calibrated, verified; once draft, provisional, verified). This fails when the
// retired name "provisional" is still used in code, tools, skills, packs or the README, outside the places that read old files on purpose
// or record history. Run: node scripts/check-ladder-names.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowed = [
  /^docs\/evidence\//, // history: what was true when it was written
  /^decisions\.md$/,
  /^PROGRESS\.md$/,
  /^core\/schema\/src\/status\.ts$/, // reads the old names
  /^core\/schema\/test\/status\.test\.ts$/,
  /^core\/builder\/src\/state\.ts$/, // upgrades old build files
  /^core\/builder\/test\/checks\.test\.ts$/, // tests the upgrade
  /^scripts\/check-ladder-names\.mjs$/,
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf-8" }).split("\n").filter((f) => f && !/\.(png|jpg|ico)$/.test(f));
const hits = [];
for (const f of files) {
  if (allowed.some((a) => a.test(f))) continue;
  let text;
  try {
    text = readFileSync(f, "utf-8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    if (/provisional/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}
if (hits.length > 0) {
  console.error(`the retired status name "provisional" is still used in ${hits.length} place(s):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("ladder names OK: no use of the retired name outside the migration code and the history");
