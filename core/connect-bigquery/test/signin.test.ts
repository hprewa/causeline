import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSignIn, googleFiles, hasOwnSignIn, parseClientFile, saveClientFile, signInInUse, useOwnSignIn } from "../src/index.js";

const CLIENT = { installed: { client_id: "id.apps.example", client_secret: "shh", auth_uri: "https://accounts.example/auth", token_uri: "https://tokens.example/token" } };

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "signin-"));
  const src = join(dir, "downloaded.json");
  writeFileSync(src, JSON.stringify(CLIENT));
  saveClientFile(dir, src);
  return dir;
};

/** A Google that checks nothing but records what it was asked, and a "browser" that goes straight back to the listener. */
function fakeGoogle(opts: { refresh?: boolean; status?: number } = {}) {
  const calls: { body: URLSearchParams }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (String(url) !== CLIENT.installed.token_uri) return fetch(url, init);
    calls.push({ body: new URLSearchParams(String(init?.body)) });
    const ok = (opts.status ?? 200) === 200;
    return new Response(JSON.stringify(ok ? { access_token: "a", ...(opts.refresh === false ? {} : { refresh_token: "r-1" }) } : { error: "invalid_grant" }), { status: opts.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("the sign-in page link asks for a code with PKCE, comes back to this computer only, and asks for BigQuery and nothing else", async () => {
  const h = home();
  let link = "";
  const g = fakeGoogle();
  const { url, done } = await beginSignIn({ home: h, fetchFn: g.fetchFn, timeoutMs: 200, open: (u) => (link = u) });
  assert.equal(link, url);
  const p = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, CLIENT.installed.auth_uri);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(p.get("scope"), "https://www.googleapis.com/auth/bigquery");
  assert.equal(p.get("access_type"), "offline");
  assert.ok(p.get("state") && p.get("state")!.length > 20);
  assert.equal((await done).ok, false); // nobody came back
});

test("coming back with the right state and a code keeps a lasting sign-in, and the code is exchanged with the matching verifier", async () => {
  const h = home();
  const g = fakeGoogle();
  const { url, done } = await beginSignIn({ home: h, fetchFn: g.fetchFn, open: () => {} });
  const p = new URL(url).searchParams;
  const back = await fetch(`${p.get("redirect_uri")}/?code=abc&state=${p.get("state")}`);
  assert.equal(back.status, 200);
  assert.deepEqual(await done, { ok: true });
  assert.equal(g.calls.length, 1);
  const sent = g.calls[0].body;
  assert.equal(sent.get("code"), "abc");
  assert.equal(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url"), p.get("code_challenge"));
  const saved = JSON.parse(readFileSync(googleFiles(h).credentials, "utf-8"));
  assert.deepEqual(saved, { type: "authorized_user", client_id: "id.apps.example", client_secret: "shh", refresh_token: "r-1" });
  assert.equal(hasOwnSignIn(h), true);
});

test("an answer with the wrong state is refused and nothing is kept", async () => {
  const h = home();
  const g = fakeGoogle();
  const { url, done } = await beginSignIn({ home: h, fetchFn: g.fetchFn, open: () => {} });
  const back = await fetch(`${new URL(url).searchParams.get("redirect_uri")}/?code=abc&state=not-it`);
  assert.equal(back.status, 400);
  const r = await done;
  assert.equal(r.ok, false);
  assert.match((r as { say: string }).say, /did not match/);
  assert.equal(g.calls.length, 0);
  assert.equal(existsSync(googleFiles(h).credentials), false);
});

test("choosing not to allow access is said plainly and nothing is kept", async () => {
  const h = home();
  const { url, done } = await beginSignIn({ home: h, open: () => {} });
  const p = new URL(url).searchParams;
  await fetch(`${p.get("redirect_uri")}/?error=access_denied&state=${p.get("state")}`);
  const r = await done;
  assert.match((r as { say: string }).say, /not allowed/);
  assert.equal(existsSync(googleFiles(h).credentials), false);
});

test("Google giving no lasting sign-in, or refusing the code, is said in words and keeps nothing", async () => {
  for (const o of [{ refresh: false }, { status: 400 }]) {
    const h = home();
    const g = fakeGoogle(o);
    const { url, done } = await beginSignIn({ home: h, fetchFn: g.fetchFn, open: () => {} });
    const p = new URL(url).searchParams;
    await fetch(`${p.get("redirect_uri")}/?code=abc&state=${p.get("state")}`);
    const r = await done;
    assert.equal(r.ok, false);
    assert.equal(existsSync(googleFiles(h).credentials), false);
  }
});

test("running out of time says so and leaves nothing behind", async () => {
  const h = home();
  const { done } = await beginSignIn({ home: h, timeoutMs: 50, open: () => {} });
  const r = await done;
  assert.match((r as { say: string }).say, /not finished in time/);
});

test("a sign-in file for a web app, or something else, is refused with what to ask for", () => {
  assert.throws(() => parseClientFile(JSON.stringify({ web: { client_id: "x", client_secret: "y" } })), /desktop app/);
  assert.throws(() => parseClientFile("not json"), /could not be read/);
  assert.throws(() => parseClientFile(JSON.stringify({ installed: {} })), /does not look like/);
});

test("with no sign-in file there is nothing to start", async () => {
  await assert.rejects(beginSignIn({ home: mkdtempSync(join(tmpdir(), "signin-")), open: () => {} }), /no Google sign-in file/i);
});

test("Causeline's own sign-in is used only when the person has not pointed Google's libraries elsewhere", () => {
  const h = home();
  writeFileSync(googleFiles(h).credentials, "{}");
  const env: NodeJS.ProcessEnv = {};
  assert.equal(useOwnSignIn(h, env), true);
  assert.equal(signInInUse(h, env), "causeline");
  const other: NodeJS.ProcessEnv = { GOOGLE_APPLICATION_CREDENTIALS: "/somewhere/else.json" };
  assert.equal(useOwnSignIn(h, other), false);
  assert.equal(signInInUse(h, other), "other_settings");
  assert.equal(signInInUse(h, {}), "google_tool");
});
