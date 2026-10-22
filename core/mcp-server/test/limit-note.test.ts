import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newState, saveCard, readCard, setCostCap, writeState } from "@causeline/builder";
import { limitNote } from "../src/handlers.js";
import type { ServerConfig } from "../src/config.js";

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "limit-"));
  writeState(dir, { ...newState("src"), dialect: "bigquery" });
  return { dir, cfg: { packDir: dir } as ServerConfig };
};

test("until the person has chosen a limit, what reads data says the standard one and tells the assistant to ask once", () => {
  const { cfg } = project();
  const n = limitNote(cfg) as { say: string; ask_user?: string };
  assert.match(n.say, /standard limit; you can change it/);
  assert.match(n.ask_user ?? "", /ask once/);
});

test("once chosen the limit is said as chosen and nothing more is asked", () => {
  const { dir, cfg } = project();
  setCostCap(dir, 20);
  const n = limitNote(cfg) as { say: string; ask_user?: string };
  assert.match(n.say, /up to 20 GB/);
  assert.doesNotMatch(n.say, /standard/);
  assert.equal(n.ask_user, undefined);
});

test("access on the card is only ever recorded by saving it, so the connection step can do it and the guide forbids doing it from talk", () => {
  const { dir } = project();
  saveCard(dir, { kpi: "x" });
  assert.equal(readCard(dir)!.access, undefined);
  saveCard(dir, { access: { confirmed: true } });
  assert.equal(readCard(dir)!.access!.confirmed, true);
});
