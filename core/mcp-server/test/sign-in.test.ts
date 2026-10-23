import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleFiles } from "@causeline/connect-bigquery";
import { signInTool, withSignIn } from "../src/handlers.js";
import type { ServerConfig } from "../src/config.js";

process.env.CAUSELINE_NO_BROWSER = "1";
const cfg = () => ({ packDir: "", home: mkdtempSync(join(tmpdir(), "signin-tool-")) }) as ServerConfig;
const callers = { caller: async () => ({}) as never, reset: async () => {} };

test("without a sign-in file the assistant is told what to ask the administrator for, and nothing starts", async () => {
  const r = (await signInTool(cfg(), callers)) as { needs_client?: boolean; next: string; started?: boolean };
  assert.equal(r.needs_client, true);
  assert.equal(r.started, undefined);
  assert.match(r.next, /administrator/);
});

test("a sign-in file for a web app is refused in words, once given", async () => {
  const c = cfg();
  const bad = join(c.home!, "web.json");
  writeFileSync(bad, JSON.stringify({ web: { client_id: "x", client_secret: "y" } }));
  await assert.rejects(signInTool(c, callers, { client_file: bad }), /desktop app/);
});

test("with the file given, the sign-in starts, returns at once with a link, and says it never sees the password", async () => {
  const c = cfg();
  const good = join(c.home!, "client.json");
  writeFileSync(good, JSON.stringify({ installed: { client_id: "i", client_secret: "s", auth_uri: "https://accounts.example/auth", token_uri: "https://tokens.example/t" } }));
  const r = (await signInTool(c, callers, { client_file: good })) as { started: boolean; link: string; next: string };
  assert.equal(r.started, true);
  assert.match(r.link, /^https:\/\/accounts\.example\/auth\?/);
  assert.match(r.next, /never see/);
  const check = withSignIn(c, { ok: false, problem: "expired", advice: "old" });
  assert.match(check.advice ?? "", /sign_in/);
  assert.equal((check.sign_in as { file_ready: boolean }).file_ready, true);
  assert.ok(googleFiles(c.home!).client);
});

test("not signed in with no sign-in file points at the administrator, not at a terminal alone", () => {
  const check = withSignIn(cfg(), { ok: false, problem: "not_signed_in", advice: "Sign in with your Google account on this computer first." });
  assert.match(check.advice ?? "", /administrator/);
});
