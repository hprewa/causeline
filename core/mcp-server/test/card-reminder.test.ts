import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newState, saveCard, writeState } from "@causeline/builder";
import { cardReminder } from "../src/handlers.js";
import type { ServerConfig } from "../src/config.js";

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "reminder-"));
  writeState(dir, newState("src"));
  return { dir, cfg: { packDir: dir } as ServerConfig };
};

test("no card, no reminder", () => {
  assert.deepEqual(cardReminder(project().cfg), {});
});

test("with no report numbers, the unanswered incident question is still asked for", () => {
  const { dir, cfg } = project();
  saveCard(dir, { kpi: "orders", how_calculated: "count of orders", access: { confirmed: true } });
  const r = cardReminder(cfg) as { still_to_ask: string };
  assert.match(r.still_to_ask, /numbers they trust|trust/);
  saveCard(dir, { numbers: [{ period: "week 1", value: 1, source: "report" }, { period: "week 2", value: 2, source: "report" }, { period: "week 3", value: 3, source: "report" }] });
  assert.match((cardReminder(cfg) as { still_to_ask: string }).still_to_ask, /incidents/);
  saveCard(dir, { no_incidents: true });
  assert.deepEqual(cardReminder(cfg), {});
});
