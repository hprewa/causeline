import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, cardStatus, readCard, saveCard } from "../src/index.js";

const ws = () => mkdtempSync(join(tmpdir(), "card-"));

test("an empty card asks for the KPI first, one thing at a time", () => {
  const s = cardStatus(null);
  assert.equal(s.items.filter((i) => i.done).length, 0);
  assert.match(s.next, /which one KPI/);
});

test("answers are added a few at a time and the next question moves on", () => {
  const w = ws();
  saveCard(w, { kpi: "  on-time   delivery " });
  assert.equal(readCard(w)!.kpi, "on-time delivery");
  saveCard(w, { how_calculated: "orders delivered by the promised date over all orders" });
  assert.match(cardStatus(readCard(w)).next, /number they trust/);
  saveCard(w, { numbers: [{ period: "2026-W07", value: 91.2, source: "weekly ops report" }] });
  saveCard(w, { numbers: [{ period: "2026-W07", value: 91.4, source: "weekly ops report" }] });
  assert.equal(readCard(w)!.numbers.length, 1, "the same period and report is corrected, not added twice");
  assert.equal(readCard(w)!.numbers[0].value, 91.4);
  saveCard(w, { numbers: [{ period: "2026-W08", value: 90, source: "weekly ops report" }, { period: "2026-W09", value: 89, source: "monthly pack" }] });
  assert.throws(() => saveCard(w, { numbers: [{ period: "2026-W10", value: 1, source: "x" }] }), /holds 3 numbers/);
  assert.match(cardStatus(readCard(w)).next, /incidents/);
  saveCard(w, { no_incidents: true });
  assert.equal(cardStatus(readCard(w)).items[3].detail, "none");
  saveCard(w, { access: { confirmed: false, admin: "the data team" } });
  const done = cardStatus(readCard(w));
  assert.equal(done.next, "");
  assert.equal(done.items[4].detail, "to be confirmed with the data team");
});

test("a number without its period, value or source is refused, and none-with-incidents is refused", () => {
  const w = ws();
  assert.throws(() => saveCard(w, { numbers: [{ period: "", value: 1, source: "x" }] }), /period, its value and the report/);
  assert.throws(() => saveCard(w, { numbers: [{ period: "w1", value: Number.NaN, source: "x" }] }), /period, its value and the report/);
  saveCard(w, { incidents: [{ text: "billing outage in March" }] });
  assert.throws(() => saveCard(w, { no_incidents: true }), /cannot also be none/);
});

test("build_status resumes from the card: progress in one line, and the card's next question comes first", () => {
  const w = ws();
  assert.match(buildStatus(w).next, /Connect the user's data/, "no card yet: unchanged flow");
  saveCard(w, { kpi: "complaint volume" });
  const s = buildStatus(w);
  assert.equal(s.steps[0].step, "prep card");
  assert.equal(s.steps[0].done, false);
  assert.match(s.next, /how that KPI is worked out/);
  assert.match(s.progress, /^0 of 2 setup steps done$/);
});

test("a card file damaged by hand is reported, not ignored", () => {
  const w = ws();
  saveCard(w, { kpi: "x" });
  writeFileSync(join(w, "setup.json"), "{ nope");
  assert.throws(() => readCard(w), /could not be read/);
  assert.ok(readFileSync(join(w, "setup.json"), "utf-8").includes("nope"));
});
