import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { decide, projectSummary, proposeChecks, recordNumber, runChecks, signoffStatus } from "@causeline/builder";
import { loadPack } from "@causeline/schema";
import type { ServerConfig } from "./config.js";
import type { Callers } from "./handlers.js";
import { signoffPage } from "./signoff-page.js";
import { explorationBody, explorationsBody, homeBody, playbookBody, playbooksBody, resultBody, resultsBody, shell, type Section } from "./companion-pages.js";
import { listExplorations, listResults, playbookView, readExploration, readResult } from "./companion-data.js";
import { allPlaybooks } from "./handlers.js";
import { openProjectName } from "./projects.js";

const MAX_BODY = 64 * 1024;

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Refusal(400, `${what} is missing`);
  return v;
};

/** Is this request for a page of ours? The token is in the path, the Host and Origin must be this machine's. */
function sameMachine(req: IncomingMessage, port: number): boolean {
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!ok.has(String(req.headers.host ?? ""))) return false; // a name pointing at this port from elsewhere (DNS rebinding)
  const origin = req.headers.origin;
  return origin === undefined || [...ok].some((h) => origin === `http://${h}`);
}

/** Open the page in the person's browser. Best effort: the URL is always returned as well. */
function openBrowser(url: string): boolean {
  if (process.env.CAUSELINE_NO_BROWSER === "1") return false;
  try {
    const [cmd, ...args] = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The sign-off screen: a small page served from the MCP server's own process, on this machine only, for confirming
 * numbers against the person's own reports. It can do exactly what the chat tools can (suggest numbers, take a
 * number, confirm or flag it, re-run the stored ones) through the same Builder functions, and nothing else: it
 * never edits the model, the SQL or a playbook. Reached only with the secret in its address; a request must name
 * this machine as its Host and, when it has one, as its Origin; writes must be JSON, which a web page from elsewhere
 * cannot send without our consent.
 */
export class SignoffScreen {
  private server?: Server;
  private token = randomBytes(24).toString("base64url");
  private port = 0;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly callers: Callers,
  ) {}

  /** Start listening (once) and return the address of the page. */
  async address(kpi?: string, page = ""): Promise<string> {
    if (!this.server) {
      this.server = createHttpServer((req, res) => void this.handle(req, res));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", () => resolve());
      });
      this.server.unref();
      this.port = (this.server.address() as AddressInfo).port;
    }
    return `http://127.0.0.1:${this.port}/${this.token}/${page}${kpi ? `?kpi=${encodeURIComponent(kpi)}` : ""}`;
  }

  /** Show the page: returns its address, and whether a browser was started for it. */
  async open(kpi?: string, page = ""): Promise<{ url: string; opened: boolean }> {
    const url = await this.address(kpi, page);
    return { url, opened: openBrowser(url) };
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private authentic(path: string): string | null {
    const [, token, ...rest] = path.split("/");
    const a = Buffer.from(token ?? "");
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b) ? rest.join("/") : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: string, type = "application/json; charset=utf-8", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
      res.end(body);
    };
    try {
      if (!sameMachine(req, this.port)) throw new Refusal(403, "this page is only for this computer");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const rest = this.authentic(url.pathname);
      if (rest === null) throw new Refusal(404, "not found");

      if (req.method === "GET") {
        const nonce = randomBytes(16).toString("base64");
        const html = this.readOnlyPage(rest, nonce);
        if (html !== null) {
          return send(200, html, "text/html; charset=utf-8", { "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        }
      }
      if (req.method === "GET" && rest === "") {
        const nonce = randomBytes(16).toString("base64");
        return send(200, signoffPage(nonce, url.searchParams.get("kpi") ?? "", `/${this.token}/`), "text/html; charset=utf-8", {
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (req.method === "GET" && rest === "api/status") return send(200, JSON.stringify(this.status()));
      if (req.method !== "POST" || !rest.startsWith("api/")) throw new Refusal(404, "not found");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Refusal(415, "send JSON");
      const body = await readJson(req);
      send(200, JSON.stringify(await this.act(rest.slice(4), body)));
    } catch (e) {
      if (e instanceof Refusal) return send(e.status, JSON.stringify({ error: e.message }));
      // anything a Builder function says is already plain words
      send(400, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** The read-only pages (overview, how it decides, results), or null when the path is not one of them. They hold no script and no form. */
  private readOnlyPage(rest: string, nonce: string): string | null {
    const base = `/${this.token}/`;
    const page = (title: string, active: Section, body: string) => shell({ title, nonce, base, active, body });
    const [section, ...tail] = rest.split("/");
    const name = tail.join("/");
    try {
      if (section === "home" && tail.length === 0) {
        if (this.cfg.packDir === "") return page("Overview", "home", `<h1>No project is open</h1><p class="lede">Ask the assistant to create a project or open one of yours by name.</p>`);
        return page("Overview", "home", homeBody(projectSummary(this.cfg.packDir, openProjectName(this.cfg) ?? basename(this.cfg.packDir))));
      }
      if (section === "playbooks") {
        if (this.cfg.packDir === "") return page("How it decides", "playbooks", `<h1>No project is open</h1>`);
        const books = allPlaybooks(this.cfg).map((p) => playbookView(p.playbook, p.source));
        if (tail.length === 0) return page("How it decides", "playbooks", playbooksBody(books, base));
        const one = books.find((b) => b.name === decodeURIComponent(name));
        return page(one ? one.name : "Not found", "playbooks", one ? playbookBody(one, base) : `<h1>No such playbook</h1><p><a href="${base}playbooks">All playbooks</a></p>`);
      }
      if (section === "explorations") {
        if (tail.length === 0) return page("Explorations", "explorations", explorationsBody(listExplorations(this.cfg.runsDir), base));
        const file = decodeURIComponent(name);
        const e = readExploration(this.cfg.runsDir, file);
        return page("Exploration", "explorations", e ? explorationBody(e, file, base) : `<h1>That exploration cannot be shown</h1><p class="lede">It is not in this project's results, or it was made by another version.</p><p><a href="${base}explorations">All explorations</a></p>`);
      }
      if (section === "results") {
        if (tail.length === 0) return page("Results", "results", resultsBody(listResults(this.cfg.runsDir), base));
        const file = decodeURIComponent(name);
        const r = readResult(this.cfg.runsDir, file);
        return page("Result", "results", r ? resultBody(r, file, base) : `<h1>That result cannot be shown</h1><p class="lede">It is not in this project's results, or it was made by another version.</p><p><a href="${base}results">All results</a></p>`);
      }
    } catch (e) {
      return page("Cannot show", "home", `<h1>This page cannot be shown</h1><p class="lede">${(e instanceof Error ? e.message : String(e)).replace(/[&<>"']/g, "")}</p>`);
    }
    return null;
  }

  private status() {
    let pack: ReturnType<typeof loadPack> | undefined;
    try {
      pack = loadPack(this.cfg.packDir);
    } catch {
      pack = undefined;
    }
    return {
      kpis: signoffStatus(this.cfg.packDir).map((k) => ({ ...k, rate: pack?.ontology.metrics[k.kpi]?.type === "ratio", description: pack?.ontology.metrics[k.kpi]?.description ?? "" })),
    };
  }

  /** The actions, each the same Builder function the chat tools call. */
  private async act(action: string, body: Record<string, unknown>): Promise<object> {
    const workspace = this.cfg.packDir;
    const kpi = str(body.kpi, "the KPI");
    const tools = await this.callers.caller();
    switch (action) {
      case "propose":
        return proposeChecks({ workspace, kpi, tools });
      case "number":
        return recordNumber({ workspace, kpi, check: str(body.check, "the check"), expected: Number(body.expected), source: str(body.source, "where the number comes from"), tools });
      case "decide": {
        const decision = body.decision === "flag" ? "flag" : body.decision === "confirm" ? "confirm" : null;
        if (!decision) throw new Refusal(400, "decision must be confirm or flag");
        return decide({ workspace, kpi, check: str(body.check, "the check"), decision, note: typeof body.note === "string" ? body.note : undefined, tools });
      }
      case "run-checks":
        return runChecks({ workspace, kpi, tools });
      default:
        throw new Refusal(404, "not found");
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Refusal(413, "too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Refusal(400, "send a JSON object");
  }
}
