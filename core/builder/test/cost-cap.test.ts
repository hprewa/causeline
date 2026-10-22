import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costCap, newState, readState, setCostCap, writeState } from "../src/index.js";

const ws = (dialect?: "bigquery") => {
  const w = mkdtempSync(join(tmpdir(), "cap-"));
  writeState(w, { ...newState("src"), ...(dialect ? { dialect } : {}) });
  return w;
};

test("a limit is kept in the build record and written into the saved data definition without losing its comments", () => {
  const w = ws("bigquery");
  assert.equal(costCap(w), undefined);
  assert.deepEqual(setCostCap(w, 12), { saved_in_pack: false });
  assert.equal(costCap(w), 12);
  writeFileSync(join(w, "data.yaml"), "# the data\ndialect: bigquery\nbudget_gb: 5 # drafted\ntime: {}\n");
  assert.deepEqual(setCostCap(w, 30), { saved_in_pack: true });
  const text = readFileSync(join(w, "data.yaml"), "utf-8");
  assert.match(text, /^# the data/);
  assert.match(text, /budget_gb: 30/);
  assert.equal(readState(w)!.cost_cap_gb, 30);
  setCostCap(w, 0);
  assert.equal(costCap(w), 0, "no limit is a choice that is kept");
});

test("a limit is refused for local files and for nonsense, and nothing is stored", () => {
  const w = ws();
  assert.throws(() => setCostCap(w, 5), /cloud database/);
  const b = ws("bigquery");
  assert.throws(() => setCostCap(b, -1), /number of GB/);
  assert.throws(() => setCostCap(b, Number.NaN), /number of GB/);
  assert.equal(costCap(b), undefined);
  assert.throws(() => setCostCap(mkdtempSync(join(tmpdir(), "none-")), 5), /connect the data first/);
});
