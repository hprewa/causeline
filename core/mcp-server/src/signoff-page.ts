import { NAV_CSS, navFor } from "./companion-pages.js";

/**
 * The sign-off page: one HTML file, no external scripts, fonts or images. Everything it shows from the server is put
 * on the page as text (never as markup). `focus` is the KPI to put first (taken from the address, used only as text).
 */
export function signoffPage(nonce: string, focus: string, base = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-off</title>
<style nonce="${nonce}">
${NAV_CSS}
:root { --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#5b6672; --line:#d9dee4; --accent:#1f5fbf; --ok:#1a7f4b; --okbg:#e3f4ea; --warn:#9a5b00; --warnbg:#fdf0d8; --bad:#b3261e; --badbg:#fbe4e2; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14171b; --card:#1d2227; --ink:#e8ebee; --muted:#9aa5b1; --line:#323a43; --accent:#6ea3f2; --ok:#6fd09a; --okbg:#163626; --warn:#f0b867; --warnbg:#3a2c12; --bad:#f2a29c; --badbg:#3d1d1a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.lede { color:var(--muted); margin:0 0 20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:0 0 16px; }
.head { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; }
.head h2 { font-size:1.15rem; margin:0; }
.badge { font-size:.8rem; font-weight:600; padding:2px 10px; border-radius:99px; border:1px solid currentColor; }
.draft { color:var(--muted); } .reconciled, .calibrated { color:var(--warn); background:var(--warnbg); } .verified { color:var(--ok); background:var(--okbg); }
.gap { color:var(--muted); margin:6px 0 12px; }
.row { border-top:1px solid var(--line); padding:12px 0; }
.label { font-weight:600; }
.fields { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; align-items:center; }
input { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); min-width:0; }
input.num { width:10rem; } input.src { flex:1 1 14rem; }
button { font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
button.quiet { background:transparent; color:var(--accent); }
button:disabled { opacity:.5; cursor:default; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) button:not(.quiet) { color:#0b1220; } }
.pair { display:grid; grid-template-columns: max-content 1fr; gap:2px 12px; margin:8px 0; }
.pair b { font-weight:600; }
.match { color:var(--ok); font-weight:600; } .nomatch { color:var(--bad); font-weight:600; }
.hints { margin:6px 0 0 18px; padding:0; color:var(--muted); }
.note { background:var(--warnbg); color:var(--warn); padding:6px 10px; border-radius:6px; margin-top:6px; }
.err { background:var(--badbg); color:var(--bad); padding:8px 12px; border-radius:6px; margin:0 0 16px; }
.done { color:var(--ok); } .flagged { color:var(--bad); }
details { margin:6px 0; } summary { cursor:pointer; color:var(--muted); }
.fail { color:var(--bad); }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
@media (max-width: 480px) { input.num { width:100%; } }
</style>
</head>
<body>
<main>
${base ? navFor(base, "signoff") : ""}
<h1>Sign-off</h1>
<p class="lede">Check each number against a report of your own, from somewhere else. Your number comes first; ours is shown after, so yours is not shaped by it. Nothing here changes the model or the data.</p>
<div id="err" class="err" hidden></div>
<div id="app"><p class="lede">Loading...</p></div>
</main>
<script nonce="${nonce}">
"use strict";
var FOCUS = ${JSON.stringify(focus).replace(/</g, "\\u003c")};
var reveals = {};
var app = document.getElementById("app");
var errBox = document.getElementById("err");

function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) { if (k === "class") el.className = attrs[k]; else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]); else el.setAttribute(k, attrs[k]); }
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c === null || c === undefined || c === false) continue; el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return el;
}
function fmt(v, rate) {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return rate && Math.abs(v) <= 1 ? (v * 100).toFixed(2) + "%" : String(Math.round(v * 1000) / 1000);
}
function showError(msg) { errBox.hidden = !msg; errBox.textContent = msg || ""; }

async function call(path, body) {
  var res = await fetch("api/" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || "something went wrong");
  return data;
}
async function act(fn) {
  showError("");
  try { await fn(); } catch (e) { showError(e.message); }
  await load();
}

var LEVELS = { draft: "Draft", reconciled: "Reconciled", calibrated: "Calibrated", verified: "Verified" };
var NOW = {
  reconciled: "Reconciled: the automatic checks pass and the numbers from your reports match, from different periods and angles. ",
  calibrated: "Calibrated: it also stays quiet over ordinary past periods. ",
  verified: "Verified: it also finds the known incidents or planted faults it was tested on. "
};

function checkRow(k, c) {
  var row = h("div", { class: "row" }, h("div", { class: "label" }, c.label));
  var rv = reveals[k.kpi + "/" + c.id];
  if (c.state === "confirmed") {
    row.appendChild(h("div", { class: "done" }, "Confirmed. You said " + fmt(c.expected, k.rate) + " (" + c.source + "); the tools give " + fmt(c.got, k.rate) + "."));
    return row;
  }
  if (c.state === "flagged") row.appendChild(h("div", { class: "flagged" }, "Flagged" + (c.note ? ": " + c.note : "") + ". Give the number again to re-check it."));
  if (c.note && c.state === "pending") row.appendChild(h("div", { class: "note" }, c.note));
  if (c.expected !== undefined && c.state === "pending") {
    var match = rv ? rv.match : Math.abs(c.got - c.expected) <= 0.01 * Math.abs(c.expected);
    var pair = h("div", { class: "pair" }, h("b", null, "You said"), h("span", null, fmt(c.expected, k.rate) + " (" + c.source + ")"), h("b", null, "The tools give"), h("span", null, fmt(c.got, k.rate)), h("b", null, "So"), h("span", { class: match ? "match" : "nomatch" }, match ? "They match." : "They do not match."));
    row.appendChild(pair);
    if (rv && rv.hints && rv.hints.length) { var ul = h("ul", { class: "hints" }); rv.hints.forEach(function (t) { ul.appendChild(h("li", null, t)); }); row.appendChild(ul); }
    var actions = h("div", { class: "fields" });
    var yes = h("button", { onclick: function () { act(function () { return call("decide", { kpi: k.kpi, check: c.id, decision: "confirm" }); }); } }, "Confirm");
    if (!match) yes.disabled = true;
    actions.appendChild(yes);
    actions.appendChild(h("button", { class: "quiet", onclick: function () { var why = window.prompt("What looks wrong? (optional)", "") || ""; act(function () { return call("decide", { kpi: k.kpi, check: c.id, decision: "flag", note: why }); }); } }, "Flag it"));
    row.appendChild(actions);
  }
  var num = h("input", { class: "num", type: "text", inputmode: "decimal", placeholder: "your number", "aria-label": "your number for " + c.label });
  var src = h("input", { class: "src", type: "text", placeholder: "which report it comes from", "aria-label": "source of your number for " + c.label });
  if (c.source && c.state !== "confirmed") src.value = c.source;
  var go = h("button", { class: c.expected !== undefined ? "quiet" : "", onclick: function () {
    var n = parseFloat(String(num.value).replace(/[%,\\s]/g, ""));
    if (!isFinite(n)) { showError("Type your number first."); return; }
    act(async function () { reveals[k.kpi + "/" + c.id] = await call("number", { kpi: k.kpi, check: c.id, expected: n, source: src.value }); });
  } }, c.expected !== undefined ? "Check a different number" : "Check");
  row.appendChild(h("div", { class: "fields" }, num, src, go));
  return row;
}

function kpiCard(k) {
  var card = h("section", { class: "card", id: "kpi-" + k.kpi });
  card.appendChild(h("div", { class: "head" }, h("h2", null, k.kpi.replace(/_/g, " ")), h("span", { class: "badge " + k.level }, LEVELS[k.level] || k.level)));
  if (k.description) card.appendChild(h("div", { class: "lede" }, k.description));
  card.appendChild(h("div", { class: "gap" }, (NOW[k.level] || "") + (k.gap ? "To go further: " + k.gap + "." : "")));
  if (k.unconfirmed) card.appendChild(h("div", { class: "note" }, "Numbers not confirmed against your reports: answers from this KPI say so."));
  if (k.calibration) card.appendChild(h("div", { class: "note" }, "False alarms: it raised something in " + Math.round(k.calibration.false_alarm_rate * 100) + "% of " + k.calibration.quiet_periods + " ordinary periods; you allow " + Math.round(k.calibration.allowed * 100) + "%. " + (k.calibration.pass ? "That is within what you allow." : "That is more than you allow.")));
  if (k.auto) {
    var failed = k.auto.results.filter(function (r) { return !r.ok && !r.skipped; });
    var d = h("details", failed.length ? { open: "open" } : null, h("summary", null, failed.length ? failed.length + " automatic check(s) fail" : "Automatic checks: all pass (" + k.auto.results.length + ")"));
    k.auto.results.forEach(function (r) { d.appendChild(h("div", { class: r.ok ? "" : "fail" }, (r.ok ? (r.skipped ? "- " : "ok ") : "FAIL ") + r.detail)); });
    card.appendChild(d);
  }
  if (k.checks.length === 0) card.appendChild(h("div", { class: "row" }, "No numbers to check yet."));
  k.checks.forEach(function (c) { card.appendChild(checkRow(k, c)); });
  var acts = h("div", { class: "actions" });
  acts.appendChild(h("button", { class: k.checks.length ? "quiet" : "", onclick: function () { act(function () { return call("propose", { kpi: k.kpi }); }); } }, "Suggest numbers to check"));
  if (k.checks.some(function (c) { return c.state === "confirmed"; }) || k.auto === undefined && k.checks.length) acts.appendChild(h("button", { class: "quiet", onclick: function () { act(function () { return call("run-checks", { kpi: k.kpi }); }); } }, "Re-run the stored checks"));
  card.appendChild(acts);
  return card;
}

async function load() {
  try {
    var data = await call("status");
    app.textContent = "";
    var kpis = data.kpis.slice().sort(function (a, b) { return (b.kpi === FOCUS) - (a.kpi === FOCUS); });
    if (kpis.length === 0) app.appendChild(h("p", { class: "lede" }, "No KPI has been saved yet."));
    kpis.forEach(function (k) { app.appendChild(kpiCard(k)); });
  } catch (e) { showError(e.message); }
}
load();
</script>
</body>
</html>
`;
}
