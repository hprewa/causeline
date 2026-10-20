import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFiles, readState, savePack, SqliteToolCaller } from "@causeline/builder";
import { confirmNumberTool, proposeChecksTool, signoffStatusTool, runChecksTool } from "../src/handlers.js";
import { SignoffScreen } from "../src/signoff.js";

// Neutral data: 6 whole weeks from Monday 2026-01-05, 8 rows a day over three places in two groups and two channels.
const PLACES = ["p1", "p2", "q1"];
const rows: { id: string; grp: string; place: string; channel: string; day: string; ok: number }[] = [];
for (let d = 0; d < 42; d++) {
  const day = new Date(Date.UTC(2026, 0, 5 + d)).toISOString().slice(0, 10);
  for (let k = 0; k < 8; k++) rows.push({ id: `E${d}_${k}`, grp: PLACES[k % 3].startsWith("p") ? "g1" : "g2", place: PLACES[k % 3], channel: k % 2 ? "web" : "phone", day, ok: (d * 7 + k) % 5 !== 0 ? 1 : 0 });
}
const rate = (from: string, to: string, keep: (r: (typeof rows)[number]) => boolean = () => true) => {
  const inside = rows.filter((r) => r.day >= from && r.day <= to && keep(r));
  return inside.reduce((a, r) => a + r.ok, 0) / inside.length;
};

let dir: string;
let screen: SignoffScreen;
let base: string;
let port: number;
const cfg = () => ({ packDir: join(dir, "ws"), runsDir: join(dir, "runs") });
const callers = () => ({ caller: async () => new SqliteToolCaller(join(dir, "ws")) });

before(async () => {
  process.env.CAUSELINE_NO_BROWSER = "1";
  dir = mkdtempSync(join(tmpdir(), "signoff-"));
  const csv = join(dir, "events.csv");
  writeFileSync(csv, ["event_id,grp,place,channel,happened_at,ok", ...rows.map((r) => `${r.id},${r.grp},${r.place},${r.channel},${r.day} 09:00:00,${r.ok}`)].join("\n") + "\n");
  await connectFiles({ workspace: join(dir, "ws"), files: [csv] });
  const saved = await savePack({
    workspace: join(dir, "ws"),
    ontology: { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: { geo: ["grp", "place"] }, dimensions: ["channel"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 5, description: "Share of events that went well." } } },
    data: { source: "ws-db", facts: { events: { sql: "SELECT event_id, happened_at AS ts, grp, place, channel, ok FROM events", time: "ts", concepts: ["grp", "place", "channel"], one_row_per: { table: "events", column: "event_id" } } }, metrics: { ok_rate: { fact: "events", numerator: "ok" } } },
  });
  assert.equal(saved.saved, true, saved.errors.join("; "));
  screen = new SignoffScreen(cfg(), callers());
  base = (await screen.address("ok_rate")).split("?")[0];
  port = Number(new URL(base).port);
});
after(async () => {
  await screen.close();
});

interface Reply {
  status: number;
  type: string;
  csp: string;
  text: string;
  json: any;
}
/** A raw request, so the Host and Origin headers can be set the way a hostile page would. */
function http(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; host?: string; raw?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}), ...opts.headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), csp: String(res.headers["content-security-policy"] ?? ""), text, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const root = () => new URL(base).pathname;

test("the page needs the secret address, this machine as Host, and no other site as Origin", async () => {
  assert.equal((await http("GET", "/")).status, 404, "no secret");
  assert.equal((await http("GET", "/wrong-secret/")).status, 404);
  assert.equal((await http("GET", `${root()}api/status`, { host: `evil.example:${port}` })).status, 403, "a name that is not this machine (DNS rebinding)");
  assert.equal((await http("GET", `${root()}api/status`, { headers: { origin: "https://evil.example" } })).status, 403, "another site");
  assert.equal((await http("POST", `${root()}api/propose`, { body: { kpi: "ok_rate" }, headers: { origin: "https://evil.example" } })).status, 403, "another site cannot write");
  assert.equal((await http("POST", `${root()}api/propose`, { raw: "kpi=ok_rate", headers: { "content-type": "text/plain" } })).status, 415, "writes must be JSON");
  assert.equal((await http("POST", `${root()}api/propose`, { raw: "not json" })).status, 400);
  assert.equal((await http("POST", `${root()}api/unknown`, { body: { kpi: "ok_rate" } })).status, 404);
  assert.equal((await http("POST", `${root()}api/propose`, { raw: "x".repeat(70_000) })).status, 413, "a large body is refused");
  assert.equal((await http("GET", `${root()}api/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200, "its own page");
});

test("the page is one self-contained file: a script and style that carry the response's nonce, nothing from elsewhere", async () => {
  const page = await http("GET", `${root()}?kpi=ok_rate`);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(page.csp)?.[1];
  assert.ok(nonce && page.text.includes(`<script nonce="${nonce}">`) && page.text.includes(`<style nonce="${nonce}">`));
  assert.match(page.csp, /default-src 'none'/);
  assert.match(page.csp, /connect-src 'self'/);
  assert.equal(/(src|href)\s*=\s*["']?https?:/i.test(page.text), false, "no external scripts, styles or images");
  assert.equal(/<script[^>]*\ssrc=/i.test(page.text), false);
  assert.match(page.text, /prefers-color-scheme: dark/);
  // a hostile name in the address is put in the page as a JSON string, never as markup
  const hostile = await http("GET", `${root()}?kpi=${encodeURIComponent("</script><script>alert(1)</script>")}`);
  assert.ok(!hostile.text.includes("</script><script>alert(1)"), "the focus is escaped");
});

test("a KPI is signed off from the page's own calls, and the chat tools see the same state", async () => {
  const api = (path: string, body?: unknown) => http(body === undefined ? "GET" : "POST", `${root()}api/${path}`, { body });
  const proposed = await api("propose", { kpi: "ok_rate" });
  assert.equal(proposed.status, 200, proposed.text);
  const total = proposed.json.proposals.find((p: { kind: string }) => p.kind === "total");
  const slice = proposed.json.proposals.find((p: { kind: string }) => p.kind === "slice");
  assert.ok(!/"got"/.test(proposed.text), "no number of ours with the questions");
  const status1 = (await api("status")).json.kpis[0];
  assert.equal(status1.level, "draft");
  assert.equal(status1.rate, true);
  assert.ok(status1.checks.every((c: Record<string, unknown>) => !("got" in c)), "the status does not show ours before theirs");

  const week = rate("2026-02-09", "2026-02-15");
  const wrong = await api("number", { kpi: "ok_rate", check: total.id, expected: 50, source: "the weekly report" });
  assert.equal(wrong.json.match, false);
  assert.ok(wrong.json.hints.length >= 3);
  assert.ok(Math.abs(wrong.json.got - week) < 1e-9, "ours is revealed once theirs is in");
  const refused = await api("decide", { kpi: "ok_rate", check: total.id, decision: "confirm" });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /do not match/);
  assert.equal((await api("number", { kpi: "ok_rate", check: total.id, expected: week, source: "  " })).status, 400, "a number must name its source");

  await api("number", { kpi: "ok_rate", check: total.id, expected: week, source: "the weekly report" });
  const confirmed = await api("decide", { kpi: "ok_rate", check: total.id, decision: "confirm" });
  assert.equal(confirmed.json.level, "provisional");

  const sliceState = readState(cfg().packDir)!.kpis.ok_rate.checks.find((c) => c.id === slice.id)!;
  const [concept, value] = Object.entries(sliceState.scope)[0];
  const part = rate("2026-02-09", "2026-02-15", (r) => (r as unknown as Record<string, string>)[concept] === value);
  await api("number", { kpi: "ok_rate", check: slice.id, expected: part, source: "the group report" });
  const second = await api("decide", { kpi: "ok_rate", check: slice.id, decision: "confirm" });
  assert.equal(second.json.level, "verified", second.json.gap);

  // the same state through the chat tool
  const viaTool = signoffStatusTool(cfg(), { kpi: "ok_rate" }).kpis[0];
  assert.equal(viaTool.level, "verified");
  assert.deepEqual(viaTool.checks.filter((c) => c.state === "confirmed").map((c) => c.source).sort(), ["the group report", "the weekly report"]);
  // flagging from the page, and running the stored checks again
  const grain = proposed.json.proposals.find((p: { kind: string }) => p.kind === "grain");
  await api("number", { kpi: "ok_rate", check: grain.id, expected: 0.1, source: "the daily export" });
  assert.equal((await api("decide", { kpi: "ok_rate", check: grain.id, decision: "flag", note: "looks far off" })).json.state, "flagged");
  assert.equal(signoffStatusTool(cfg(), { kpi: "ok_rate" }).kpis[0].level, "provisional", "a flagged number holds it back");
  const again = (await api("run-checks", { kpi: "ok_rate" })).json;
  assert.equal(again.rechecked.length, 2);
  assert.ok(again.rechecked.every((r: { match: boolean }) => r.match));
});

test("the chat tools do the same things the page does", async () => {
  // a fresh KPI state: start again from the proposals
  const proposed = await proposeChecksTool(cfg(), callers(), { kpi: "ok_rate", odd_period: { start: "2026-01-12", end: "2026-01-18", name: "the audited week" } });
  assert.ok(proposed.proposals.some((p) => p.kind === "total" && /audited week/.test(p.label)), "their own window, classed by its shape");
  const odd = proposed.proposals.find((p) => /audited week/.test(p.label))!;
  const flagged = await confirmNumberTool(cfg(), callers(), { kpi: "ok_rate", check: odd.id, expected: 0.5, source: "audit file", flag: true, note: "does not look right" });
  assert.equal(flagged.confirmed, false);
  assert.equal(flagged.state, "flagged");
  const right = await confirmNumberTool(cfg(), callers(), { kpi: "ok_rate", check: odd.id, expected: rate("2026-01-12", "2026-01-18"), source: "audit file", tolerance: 0.002 });
  assert.equal(right.confirmed, true);
  const stored = (await runChecksTool(cfg(), callers(), { kpi: "ok_rate" })).rechecked.find((r) => r.id === odd.id);
  assert.equal(stored?.match, true);
});
