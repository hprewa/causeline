#!/usr/bin/env node
// The terminal-free Google sign-in against real Google, through the real MCP server over stdio. Google's own tool sign-in is hidden (an empty
// Google config folder, no credentials variable), so only Causeline's own sign-in can work. A person must click through Google's page once.
//   node scripts/signin-proof.mjs --client <the desktop-app sign-in file from the Google Cloud console>
// Needs CAUSELINE_BQ_PROJECT (the project queries are billed to). Everything it keeps is in a temporary folder, deleted at the end.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = resolve(import.meta.dirname, "..");
const flag = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const clientFile = flag("client") ? resolve(flag("client")) : undefined;
if (!clientFile || !existsSync(clientFile)) throw new Error("give --client <path to the sign-in file>");
const project = process.env.CAUSELINE_BQ_PROJECT;
if (!project) throw new Error("set CAUSELINE_BQ_PROJECT to the project queries are billed to");

const work = mkdtempSync(join(tmpdir(), "signin-proof-"));
const home = join(work, "home");
const emptyGoogle = join(work, "no-google-tools");
mkdirSync(emptyGoogle, { recursive: true });
const failures = [];
const check = (n, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? `: ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok) failures.push(n);
};

// the person's own Google tool sign-in, to prove it was neither used nor changed
const appData = process.env.APPDATA ?? join(homedir(), ".config");
const adcFile = join(process.env.CLOUDSDK_CONFIG ?? join(appData, "gcloud"), "application_default_credentials.json");
const adcBefore = existsSync(adcFile) ? statSync(adcFile).mtimeMs : null;

const env = { ...process.env, CAUSELINE_HOME: home, CAUSELINE_PLAYBOOKS: resolve(repo, "playbooks"), CAUSELINE_PACK: "", CLOUDSDK_CONFIG: emptyGoogle, APPDATA: emptyGoogle, HOME: emptyGoogle, USERPROFILE: process.env.USERPROFILE };
delete env.GOOGLE_APPLICATION_CREDENTIALS;
delete env.CAUSELINE_NO_BROWSER;

const client = new Client({ name: "signin-proof", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repo, "core", "mcp-server", "dist", "src", "main.js")], env }));
const tool = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { error: res.isError ? res.content?.[0]?.text : undefined, body: res.structuredContent };
};
try {
  await tool("create_project", { name: "Sign-in proof" });
  const before = await tool("connect_bigquery", { dataset: "bigquery-public-data.cfpb_complaints", project });
  check("before signing in, with Google's tool sign-in hidden, the connection is refused as not signed in", !before.body?.connected, before.body?.summary ?? before.error);

  const none = await tool("sign_in");
  check("with no sign-in file the tool asks for one and starts nothing", none.body?.needs_client === true, none.body?.say);

  const started = await tool("sign_in", { client_file: clientFile });
  check("with the file given, a sign-in starts and returns at once with a link", started.body?.started === true && /accounts\.google\.com/.test(started.body?.link ?? ""), started.error ?? started.body?.link?.slice(0, 60));
  console.log("\n>>> A Google page should have opened in your browser. Choose your account and allow access. Waiting up to 5 minutes...\n");

  let after;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await tool("check_connection");
    if (after.body?.sign_in?.signed_in_with_causeline) break;
  }
  check("the sign-in was kept after the click", after?.body?.sign_in?.signed_in_with_causeline === true, JSON.stringify(after?.body?.sign_in));
  check("the connection check says Causeline's own sign-in is in use", /Causeline's own/.test(String(after?.body?.sign_in?.using ?? "")), after?.body?.sign_in?.using);

  const conn = await tool("connect_bigquery", { dataset: "bigquery-public-data.cfpb_complaints", project });
  check("the public dataset connects with that sign-in alone", !conn.error && conn.body?.connected === true, conn.error ?? conn.body?.summary);
  const found = await tool("discover_for_kpi", { kpi: "complaint volume" });
  check("discovery runs on it (shortlist, reads nothing)", found.body?.stage === "shortlist", found.error ?? found.body?.say);
  const draft = await tool("discover_for_kpi", { kpi: "complaint volume", tables: ["complaint_database"], go_ahead: true });
  check("discovery then reads the confirmed table and drafts sentences (the data connection software uses the sign-in too)", draft.body?.stage === "draft" && (draft.body?.draft ?? []).length > 0, draft.error ?? draft.body?.say);

  const creds = join(home, "google", "credentials.json");
  const keys = existsSync(creds) ? Object.keys(JSON.parse(readFileSync(creds, "utf-8"))).sort().join(",") : "";
  check("the lasting sign-in is in Causeline's own folder in the shape Google's tools use (values not shown)", keys === "client_id,client_secret,refresh_token,type", keys);
} finally {
  await client.close();
}
const adcAfter = existsSync(adcFile) ? statSync(adcFile).mtimeMs : null;
check("the person's own Google tool sign-in was not touched", adcBefore === adcAfter, `${adcBefore} -> ${adcAfter}`);
rmSync(work, { recursive: true, force: true });
console.log(failures.length ? `\nFAILED: ${failures.join("; ")}` : "\nREAL GOOGLE SIGN-IN PROOF PASSED");
process.exit(failures.length ? 1 : 0);
