import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

/**
 * Signing in to Google without a terminal. An administrator makes a "desktop app" sign-in file in their own Google Cloud project (so no review
 * by Google is involved); the person gives it to Causeline once. Signing in then opens Google's own page in the browser, where the person
 * allows access, and Causeline keeps the lasting sign-in it gets back in its own folder. Causeline never sees a password, and the person's
 * own `gcloud` sign-in is left as it is. Read-only comes from the person's role in the data, not from this.
 */

/** BigQuery only; the role the person holds decides what that can reach. */
export const SIGN_IN_SCOPE = "https://www.googleapis.com/auth/bigquery";

export interface GoogleFiles {
  dir: string;
  /** The sign-in file the administrator made. */
  client: string;
  /** What Causeline keeps after the person signed in (the same shape Google's own tools write). */
  credentials: string;
}

export const googleFiles = (home: string): GoogleFiles => {
  const dir = join(home, "google");
  return { dir, client: join(dir, "client.json"), credentials: join(dir, "credentials.json") };
};

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
}

/** Read the file Google's console gives for a desktop app. Anything else is refused in words an administrator can act on. */
export function parseClientFile(text: string): OAuthClient {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not the sign-in file from Google's console (it could not be read). Ask for the JSON file downloaded for a desktop app.");
  }
  if (raw?.web) throw new Error("That sign-in file is for a web app. Ask your administrator for one made for a desktop app (Google Cloud console, APIs and services, Credentials, OAuth client ID, application type Desktop app).");
  const c = raw?.installed;
  if (!c?.client_id || !c?.client_secret) throw new Error("That file does not look like a desktop app sign-in file from Google's console. Ask your administrator to download it again.");
  return { client_id: String(c.client_id), client_secret: String(c.client_secret), auth_uri: String(c.auth_uri ?? "https://accounts.google.com/o/oauth2/v2/auth"), token_uri: String(c.token_uri ?? "https://oauth2.googleapis.com/token") };
}

export const hasClientFile = (home: string) => existsSync(googleFiles(home).client);
export const hasOwnSignIn = (home: string) => existsSync(googleFiles(home).credentials);

/** Keep a copy of the administrator's sign-in file in Causeline's folder. */
export function saveClientFile(home: string, from: string): OAuthClient {
  const client = parseClientFile(readFileSync(resolve(from), "utf-8"));
  const f = googleFiles(home);
  mkdirSync(f.dir, { recursive: true });
  copyFileSync(resolve(from), f.client);
  return client;
}

/**
 * Use Causeline's own sign-in for this process (and the data connection software it starts, which inherits the environment) when one exists
 * and the person has not pointed Google's libraries somewhere else. Returns whether it is in use.
 */
export function useOwnSignIn(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const own = googleFiles(home).credentials;
  if (!existsSync(own)) return false;
  if (!env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_APPLICATION_CREDENTIALS === own) env.GOOGLE_APPLICATION_CREDENTIALS = own;
  return env.GOOGLE_APPLICATION_CREDENTIALS === own;
}

/** Which sign-in a connection would use, in words. */
export function signInInUse(home: string, env: NodeJS.ProcessEnv = process.env): "causeline" | "other_settings" | "google_tool" {
  const own = googleFiles(home).credentials;
  if (env.GOOGLE_APPLICATION_CREDENTIALS === own && existsSync(own)) return "causeline";
  return env.GOOGLE_APPLICATION_CREDENTIALS ? "other_settings" : "google_tool";
}

export type SignInResult = { ok: true } | { ok: false; say: string };

export interface BeginOptions {
  home: string;
  /** Open the page in the browser (the tests replace this). */
  open?: (url: string) => void;
  /** How long to wait for the person; default five minutes. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** The platform's way to open a page; a failure is not fatal because the link is also given to the person. */
export function openInBrowser(url: string): void {
  if (process.env.CAUSELINE_NO_BROWSER) return; // the tests, and a computer with no screen
  try {
    const child =
      process.platform === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the link is shown to the person as well
  }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>Causeline</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h2>${title}</h2><p>${body}</p></body>`;

/**
 * Start a sign-in: a local listener that only this computer can reach, Google's page opened in the browser, and the answer exchanged for a
 * lasting sign-in kept in Causeline's folder. Returns the link at once (shown to the person in case no window opened); `done` settles when the
 * person finishes, refuses, or the time runs out, and never throws.
 */
export async function beginSignIn(opts: BeginOptions): Promise<{ url: string; done: Promise<SignInResult> }> {
  const files = googleFiles(opts.home);
  if (!existsSync(files.client)) throw new Error("There is no Google sign-in file yet. Ask your administrator for one (a desktop app sign-in file from Google's console).");
  const client = parseClientFile(readFileSync(files.client, "utf-8"));
  const doFetch = opts.fetchFn ?? fetch;
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let settle!: (r: SignInResult) => void;
  const done = new Promise<SignInResult>((r) => (settle = r));
  const server = createServer();
  await new Promise<void>((res, rej) => server.once("error", rej).listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}`;
  const finish = (r: SignInResult) => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    settle(r);
  };
  const timer = setTimeout(() => finish({ ok: false, say: "The sign-in page was not finished in time, so nothing was changed. Ask again when you are ready." }), opts.timeoutMs ?? 5 * 60_000);

  server.on("request", async (req, res) => {
    const u = new URL(req.url ?? "/", redirect);
    if (u.searchParams.get("state") === null && !u.searchParams.has("error")) {
      res.writeHead(404).end(); // anything that is not Google's answer (a browser asking for an icon)
      return;
    }
    const reply = (code: number, title: string, body: string) => res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(PAGE(title, body));
    if (u.searchParams.get("state") !== state) {
      reply(400, "That did not work", "This page did not come from the sign-in you started. Go back to your assistant and ask to sign in again.");
      finish({ ok: false, say: "The answer did not match the sign-in that was started, so it was refused. Ask to sign in again." });
      return;
    }
    if (u.searchParams.get("error")) {
      reply(200, "Nothing was changed", "You chose not to allow access. You can close this window.");
      finish({ ok: false, say: "Access was not allowed on Google's page, so nothing was changed." });
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) {
      reply(400, "That did not work", "Google did not send a code. Go back to your assistant and ask to sign in again.");
      finish({ ok: false, say: "Google did not return what was needed. Ask to sign in again." });
      return;
    }
    try {
      const r = await doFetch(client.token_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }).toString(),
      });
      const body = (await r.json()) as { refresh_token?: string; error?: string };
      if (!r.ok || !body.refresh_token) {
        reply(400, "That did not work", "Google would not complete the sign-in. Go back to your assistant for what to do next.");
        finish({ ok: false, say: body.refresh_token === undefined && r.ok ? "Google did not give a lasting sign-in. Ask to sign in again and allow access on the page." : "Google would not complete the sign-in with this sign-in file. Ask your administrator whether it is still valid and whether your account is allowed to use it." });
        return;
      }
      mkdirSync(files.dir, { recursive: true });
      writeFileSync(files.credentials, JSON.stringify({ type: "authorized_user", client_id: client.client_id, client_secret: client.client_secret, refresh_token: body.refresh_token }, null, 2) + "\n", "utf-8");
      try {
        chmodSync(files.credentials, 0o600);
      } catch {
        // not every file system has modes
      }
      reply(200, "You are signed in", "You can close this window and go back to your assistant.");
      finish({ ok: true });
    } catch {
      reply(500, "That did not work", "Could not reach Google to finish. Check your internet connection and ask to sign in again.");
      finish({ ok: false, say: "Could not reach Google to finish the sign-in. Check the internet connection and ask again." });
    }
  });

  const url = `${client.auth_uri}?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: SIGN_IN_SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString()}`;
  (opts.open ?? openInBrowser)(url);
  return { url, done };
}
