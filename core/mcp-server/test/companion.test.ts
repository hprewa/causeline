import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFiles, savePack, SqliteToolCaller } from "@causeline/builder";
import { Result } from "@causeline/schema";
import { SignoffScreen } from "../src/signoff.js";
import { homeBody, esc } from "../src/companion-pages.js";

// The read-only pages of the local site: overview, how the steps decide, results.
let dir: string;
let screen: SignoffScreen;
let port: number;
let root: string;
const cfg = () => ({ packDir: join(dir, "ws"), runsDir: join(dir, "runs") });

before(async () => {
  process.env.CAUSELINE_NO_BROWSER = "1";
  dir = mkdtempSync(join(tmpdir(), "companion-"));
  const csv = join(dir, "events.csv");
  writeFileSync(csv, ["event_id,place,happened_at,ok", ...Array.from({ length: 80 }, (_, i) => `E${i},${i % 2 ? "p1" : "p2"},2026-01-${String((i % 28) + 1).padStart(2, "0")} 09:00:00,${i % 3 ? 1 : 0}`)].join("\n") + "\n");
  await connectFiles({ workspace: join(dir, "ws"), files: [csv] });
  const saved = await savePack({
    workspace: join(dir, "ws"),
    ontology: { time: { levels: ["week", "day"], seasonality: "none" }, hierarchies: {}, dimensions: ["place"], metrics: { ok_rate: { type: "ratio", direction: "higher_is_better", min_volume: 5, description: "Share that went well." } } },
    data: { source: "ws-db", facts: { events: { sql: "SELECT event_id, happened_at AS ts, place, ok FROM events", time: "ts", concepts: ["place"] } }, metrics: { ok_rate: { fact: "events", numerator: "ok" } } },
    agents: [{ name: "ok-rate-deep-rca", kpi: "ok_rate", task: "deep_rca", examples: ["why?"] }],
  });
  assert.equal(saved.saved, true, saved.errors.join("; "));
  // two kept answers: one with a hostile value in it, one that was stopped
  mkdirSync(join(dir, "runs"), { recursive: true });
  const generator = { name: "causeline", version: "0", url: "https://example.org" };
  const done = Result.parse({
    playbook: "metric_change",
    inputs: { metric: "ok_rate", period: "2026-W03" },
    status: "complete",
    headline: { metric: "ok_rate", kind: "ratio", format: "fraction", value: 0.62, baseline: 0.7, change: -0.08, z: -4.1, significant: true },
    findings: [{ rank: 1, dimension: "place", value: "<script>alert(1)</script>", impact: -0.05, evidence: [] }],
    contributions: [{ level: "place", node: "p1", contribution: -0.05, share: 0.6, rate_effect: -0.05, mix_effect: 0, volume: 40, baseline_volume: 40, history: { periods: 6, typical: -0.01, low: -0.03, high: 0.02 }, delta_vs_typical: -0.04, verdict: "unusual" }],
    trace: [{ step: "headline", compute: "change_vs_baseline", facts: { significant: true, direction: "down" }, rule: "else \"where\"", skipped: [], notes: [] }],
    generator,
  });
  writeFileSync(join(dir, "runs", "2026-02-01T10-00-00-000Z-metric_change-ok_rate.json"), JSON.stringify(done));
  writeFileSync(join(dir, "runs", "2026-02-02T10-00-00-000Z-metric_change-ok_rate.json"), JSON.stringify(Result.parse({ playbook: "metric_change", inputs: { metric: "ok_rate" }, status: "stopped", headline: null, stopped_reason: "data_still_arriving", stopped_detail: "the newest weeks hold little", generator })));
  utimesSync(join(dir, "runs", "2026-02-01T10-00-00-000Z-metric_change-ok_rate.json"), new Date("2026-02-01T10:00:00Z"), new Date("2026-02-01T10:00:00Z"));
  utimesSync(join(dir, "runs", "2026-02-02T10-00-00-000Z-metric_change-ok_rate.json"), new Date("2026-02-02T10:00:00Z"), new Date("2026-02-02T10:00:00Z"));
  const exploration = {
    id: "2026-02-03T10-00-00-000Z",
    question: "Which <b>team</b> was worst?",
    started: "2026-02-03T10:00:00Z",
    label: "exploratory",
    kpis: [{ kpi: "ok_rate", rung: "draft" }],
    steps: [
      { n: 1, op: "rank", asked: "lowest 3 place by ok_rate, 2026-W03", args: {}, says: "The 2 place values with the lowest ok rate.", columns: ["rank", "node", "value", "volume"], rows: [{ rank: 1, node: "<script>alert(1)</script>", value: 0.3333333, volume: 40 }], rows_total: 5, notes: ["1 place value had under 10 rows."], queries: 2, ms: 5 },
      { n: 2, op: "cannot", asked: "a request that cannot be carried out", args: {}, says: "Free-form queries are not available.", columns: [], rows: [], rows_total: 0, notes: [], refusal: { code: "free_sql", reason: "Free-form queries are not available.", instead: "Add it as a KPI with the Builder." }, queries: 0, ms: 0 },
    ],
    budget: { steps: 1, max_steps: 12, rows: 1, max_rows: 400 },
    stopped: null,
  };
  writeFileSync(join(dir, "runs", "exploration-2026-02-03T10-00-00-000Z.json"), JSON.stringify(exploration));
  writeFileSync(join(dir, "runs", "exploration-bad.json"), JSON.stringify({ nonsense: true }));
  writeFileSync(join(dir, "secret.json"), JSON.stringify({ secret: "do not show" }));
  screen = new SignoffScreen(cfg(), { caller: async () => new SqliteToolCaller(join(dir, "ws")) });
  const url = new URL(await screen.address());
  port = Number(url.port);
  root = url.pathname;
});
after(async () => {
  await screen.close();
});

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; csp: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), csp: String(res.headers["content-security-policy"] ?? ""), text }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the overview shows the KPIs and how far each is trusted, the experts, and the next step; it cannot be reached without the secret or from another site", async () => {
  const page = await get(`${root}home`);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /ok rate/);
  assert.match(page.text, /class="badge draft"/);
  assert.match(page.text, /has not been checked against your own reports yet/);
  assert.match(page.text, /Share that went well|Next:/);
  assert.match(page.text, /aria-current="page">Overview/);
  assert.equal((await get("/home")).status, 404, "no secret");
  assert.equal((await get(`${root}home`, { origin: "https://evil.example" })).status, 403);
});

test("the read-only pages hold no script, no form and no button, and the policy allows none", async () => {
  for (const path of ["home", "playbooks", "playbooks/metric_change", "explorations", "explorations/exploration-2026-02-03T10-00-00-000Z.json", "results", "results/2026-02-01T10-00-00-000Z-metric_change-ok_rate.json"]) {
    const page = await get(`${root}${path}`);
    assert.equal(page.status, 200, path);
    assert.doesNotMatch(page.text, /<script|<form|<button|<input|onclick=/i, path);
    assert.match(page.csp, /default-src 'none'/);
    assert.doesNotMatch(page.csp, /script-src/);
    assert.equal(/(src|href)\s*=\s*["']?https?:/i.test(page.text), false, "nothing from elsewhere");
    assert.match(page.text, /<nav aria-label="Pages">/);
  }
});

test("the sign-off page is the same site: it carries the menu, and the menu reaches every page", async () => {
  const page = await get(root);
  assert.match(page.text, /aria-current="page">Sign-off/);
  for (const label of ["Overview", "How it decides", "Explorations", "Results"]) assert.match(page.text, new RegExp(`>${label}</a>`));
  assert.match(page.text, new RegExp(`href="${root}playbooks"`));
});

test("how it decides: each playbook in plain words, its conditions and what it records", async () => {
  const list = await get(`${root}playbooks`);
  assert.match(list.text, /metric change/);
  const one = await get(`${root}playbooks/metric_change`);
  assert.match(one.text, /Check the data is complete/);
  assert.match(one.text, /Find when it changed/);
  assert.match(one.text, /Only when <code>headline\.significant<\/code>/);
  assert.match(one.text, /<code>headline\.significant<\/code>/);
  assert.match((await get(`${root}playbooks/nope`)).text, /No such playbook/);
});

test("results: listed newest first, opened by name, with the values escaped", async () => {
  const list = await get(`${root}results`);
  assert.ok(list.text.indexOf("data still arriving") < list.text.indexOf("place &lt;script&gt;"), "the stopped answer is newer, so it comes first");
  const one = await get(`${root}results/2026-02-01T10-00-00-000Z-metric_change-ok_rate.json`);
  assert.match(one.text, /62\.0% against 70\.0% expected: -8\.0 points/);
  assert.match(one.text, /place = &lt;script&gt;alert\(1\)&lt;\/script&gt;/, "a hostile value is shown as text");
  assert.doesNotMatch(one.text, /<script>alert/);
  assert.match(one.text, /Who contributed how much/);
  assert.match(one.text, /unusual/);
  assert.match(one.text, /How the steps went/);
  const stopped = await get(`${root}results/2026-02-02T10-00-00-000Z-metric_change-ok_rate.json`);
  assert.match(stopped.text, /Stopped: data still arriving/);
});

test("results: only a plain file name inside the results folder is ever read", async () => {
  for (const bad of ["..%2Fsecret.json", "..%5Csecret.json", "%2e%2e%2fsecret.json", "secret.json", "nope.json", "a%2Fb.json"]) {
    const page = await get(`${root}results/${bad}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /cannot be shown/, bad);
    assert.doesNotMatch(page.text, /do not show/, bad);
  }
});

test("escaping covers the five characters that can break out of markup", () => {
  assert.equal(esc(`<a href="x" onclick='y'>&`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  assert.match(homeBody({ name: "<b>x</b>", folder: "", next: "<i>", tracked: true, data: { dialect: "sqlite", tables: [] }, kpis: [], experts: [], incidents: 0, recent_changes: [] }), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("explorations: listed with their question, opened by name, labelled exploratory, with every step, its rows, its refusal and its budget, escaped", async () => {
  const list = await get(`${root}explorations`);
  assert.equal(list.status, 200);
  assert.match(list.text, /Which &lt;b&gt;team&lt;\/b&gt; was worst\?/);
  assert.match(list.text, /1 request refused/);
  assert.doesNotMatch(list.text, /exploration-bad|nonsense/, "a file that is not an exploration is not listed");
  assert.doesNotMatch((await get(`${root}results`)).text, /Which &lt;b&gt;team/, "explorations are not mixed into the results");
  const one = await get(`${root}explorations/exploration-2026-02-03T10-00-00-000Z.json`);
  assert.match(one.text, /class="banner"><b>Exploratory\.<\/b>/);
  assert.match(one.text, /no claim about cause/);
  assert.match(one.text, /ok rate \(not yet checked against your reports\)/, "the trust in the KPI read is said");
  assert.match(one.text, /Step 1/);
  assert.match(one.text, /<td class="n">0\.3333<\/td>/, "numbers are shown to four places");
  assert.match(one.text, /5 found; 1 shown/);
  assert.match(one.text, /1 place value had under 10 rows/);
  assert.match(one.text, /<b>Not done:<\/b> Free-form queries are not available\. <b>Instead:<\/b> Add it as a KPI with the Builder\./);
  assert.match(one.text, /Used 1 of 12 steps and 1 of 400 rows/);
  assert.match(one.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(one.text, /<script>alert|<b>team/);
});

test("explorations: only an exploration file inside the results folder is read", async () => {
  for (const bad of ["..%2Fsecret.json", "%2e%2e%2fsecret.json", "secret.json", "2026-02-01T10-00-00-000Z-metric_change-ok_rate.json", "exploration-bad.json", "exploration-nope.json", "exploration-..%2Fsecret.json"]) {
    const page = await get(`${root}explorations/${bad}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /cannot be shown/, bad);
    assert.doesNotMatch(page.text, /do not show/, bad);
  }
});

