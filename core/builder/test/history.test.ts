import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaybook, pairsFromHistory, runPlaybook, type ToolCaller } from "@causeline/runner";
import { loadPack, type ToolsMeta } from "@causeline/schema";
import { connectFiles } from "../src/connect.js";
import { seeded } from "../src/inject.js";
import { savePack } from "../src/savepack.js";
import { SqliteToolCaller } from "../src/sqlite-tools.js";

/** Fourteen weeks at five sites whose rates and volumes move every week on their own; one site is absent from some weeks. */
async function moving(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "builder-history-"));
  const rand = seeded(11);
  const rates: Record<string, number> = { north: 0.9, south: 0.8, east: 0.6, west: 0.45, islands: 0.7 };
  const rows = ["event_id,site,happened_at,ok,cost"];
  let id = 0;
  for (let week = 0; week < 14; week++) {
    for (const site of Object.keys(rates)) {
      if (site === "islands" && week % 3 === 1) continue;
      const rate = rates[site] + (rand() - 0.5) * 0.25;
      const n = Math.round(120 * (0.7 + rand() * 0.6));
      for (let i = 0; i < n; i++) {
        const day = new Date(Date.UTC(2026, 0, 5 + week * 7 + Math.floor(rand() * 7)));
        rows.push(`E${++id},${site},${day.toISOString().slice(0, 10)} ${String(8 + Math.floor(rand() * 10)).padStart(2, "0")}:00:00,${rand() < rate ? 1 : 0},${(5 + rand() * 20).toFixed(2)}`);
      }
    }
  }
  const csv = join(dir, "events.csv");
  writeFileSync(csv, rows.join("\n") + "\n");
  const ws = join(dir, "ws");
  await connectFiles({ workspace: ws, files: [csv] });
  const r = await savePack({
    workspace: ws,
    ontology: { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: {}, dimensions: ["site"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 30 }, spend: { type: "sum", direction: "lower_is_better" } } },
    data: { source: "ws-db", facts: { events: { sql: "SELECT event_id, happened_at AS ts, site, ok, cost FROM events", time: "ts", concepts: ["site"] } }, metrics: { ok_rate: { fact: "events", numerator: "ok" }, spend: { fact: "events", value: "cost" } } },
  });
  assert.equal(r.saved, true, r.errors.join());
  return ws;
}

test("a level's history read in one query gives the same result as the same history read two periods a call, with fewer queries", async (t) => {
  const ws = await moving();
  const pack = loadPack(ws, { requireMeta: true });
  const playbook = loadPlaybook("metric_change", ws);
  // a pack generated before the history tool existed: the same index without it
  const older: ToolsMeta = { tools: Object.fromEntries(Object.entries(pack.meta!.tools).filter(([, m]) => m.kind !== "history")) };
  assert.ok(Object.keys(older.tools).length < Object.keys(pack.meta!.tools).length, "the pack has a history tool");

  for (const metric of ["ok_rate", "spend"]) {
    const run = async (meta: ToolsMeta) => {
      const inner = new SqliteToolCaller(ws);
      const names: string[] = [];
      const tools: ToolCaller = { call: (name, params, step) => (names.push(name.split("?")[0]), inner.call(name, params, step)) };
      const r = await runPlaybook({ playbook, ontology: pack.ontology, meta, tools, inputs: { metric, period: "2026-W13", baseline: 4 } });
      return { names, said: { status: r.status, headline: r.headline, findings: r.findings, contributions: r.contributions, masking_flags: r.masking_flags, path: r.path, explained: r.explained } };
    };
    const one = await run(pack.meta!);
    const pairs = await run(older);
    assert.equal(one.said.status, "complete");
    assert.deepEqual(one.said, pairs.said, `${metric}: every number on the path is the same`);
    assert.ok(one.names.includes(`${metric}_history`), "the one-query history was used");
    assert.ok(!pairs.names.includes(`${metric}_history`));
    assert.ok(one.names.length < pairs.names.length, `${metric}: ${one.names.length} queries against ${pairs.names.length}`);
    t.diagnostic(`${metric}: ${pairs.names.length} queries two periods a call, ${one.names.length} with one query a level`);
  }
});

test("rows of a history query are put back as the two-period rows the slice query gives: absent periods are zeros, other periods are left out", () => {
  const rows = [
    { node: "a", bucket: "W1", num: 5, den: 10, sq: 5 },
    { node: "a", bucket: "W2", num: 6, den: 10, sq: 6 },
    { node: "b", bucket: "W2", num: 1, den: 4, sq: 1 },
    { node: "c", bucket: "W3", num: 9, den: 9, sq: 9 },
  ];
  assert.deepEqual(pairsFromHistory(rows, "W1", "W2"), [
    { node: "a", cur: { num: 5, den: 10, sq: 5 }, base: { num: 6, den: 10, sq: 6 } },
    { node: "b", cur: { num: 0, den: 0, sq: 0 }, base: { num: 1, den: 4, sq: 1 } },
  ]);
  // an odd period out is asked for on its own, as both sides
  assert.deepEqual(pairsFromHistory(rows, "W3", "W3"), [{ node: "c", cur: { num: 9, den: 9, sq: 9 }, base: { num: 9, den: 9, sq: 9 } }]);
});
