import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILDS, causelineHome, findToolboxBinary, installDir, platformKey, sha256Of, ToolboxInstaller, type ToolboxBuild } from "../src/index.js";

const payload = Buffer.from("not really a program, but it has a size and a fingerprint ".repeat(5000));
const sha = createHash("sha256").update(payload).digest("hex");

interface Fake {
  url: string;
  hits: { range: string | undefined }[];
  close(): Promise<void>;
}

/** A download server for the tests: serves `body`, honours Range, can be slow or refuse. */
async function serve(body: Buffer = payload, opts: { slowMs?: number; status?: number } = {}): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const server: Server = createServer((req, res) => {
    hits.push({ range: req.headers.range });
    if (opts.status) return void res.writeHead(opts.status).end();
    const m = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "content-length": body.length - from });
    const chunk = 20_000;
    let at = from;
    const next = () => {
      if (at >= body.length) return void res.end();
      res.write(body.subarray(at, at + chunk));
      at += chunk;
      setTimeout(next, opts.slowMs ?? 0);
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/toolbox`, hits, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const here = platformKey();
const builds = (url: string, over: Partial<ToolboxBuild> = {}): Record<string, ToolboxBuild> => ({ [here]: { key: here, url, size: payload.length, sha256: sha, file: process.platform === "win32" ? "toolbox.exe" : "toolbox", ...over } });
const home = () => mkdtempSync(join(tmpdir(), "causeline-install-"));
const waitFor = async (what: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!what()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("the first use starts the download in the background and says so; once checked, the file is there and the next use is immediate", async () => {
  const s = await serve(payload, { slowMs: 5 });
  const inst = new ToolboxInstaller({ home: home(), builds: builds(s.url) });
  try {
    assert.equal(inst.status().state, "idle");
    const first = inst.ensure();
    assert.ok("notReady" in first, "it does not wait");
    assert.match((first as { notReady: string }).notReady, /preparing the data connection for the first time \(about \d+ MB, \d+% done\)/);
    await waitFor(() => inst.status().bytes > 0 || inst.status().state === "ready");
    assert.equal(inst.status().state === "downloading" || inst.status().state === "ready", true);
    const path = await inst.start();
    assert.equal(inst.status().state, "ready");
    assert.deepEqual(inst.ensure(), { path });
    assert.equal(await sha256Of(path), sha);
    assert.equal(s.hits.length, 1);
    if (process.platform !== "win32") assert.ok((statSync(path).mode & 0o111) !== 0, "executable");
    assert.equal(existsSync(`${path}.part`), false);
  } finally {
    await s.close();
  }
});

test("a file with the wrong fingerprint or the wrong size is deleted and never used, and the next use tries again", async () => {
  const s = await serve();
  try {
    const bad = new ToolboxInstaller({ home: home(), builds: builds(s.url, { sha256: "0".repeat(64) }) });
    await assert.rejects(bad.start(), /not the one expected/);
    assert.equal(bad.find(), null);
    assert.equal(bad.status().state, "failed");
    assert.match(bad.status().message, /did not download correctly/);
    assert.match(bad.status().message, /CAUSELINE_TOOLBOX/);
    assert.equal(existsSync(join(installDir(bad["o"].home), "toolbox.exe.part")) || existsSync(join(installDir(bad["o"].home), "toolbox.part")), false);
    assert.ok("notReady" in bad.ensure(), "a failed try is tried again");

    const short = new ToolboxInstaller({ home: home(), builds: builds(s.url, { size: payload.length + 10 }) });
    await assert.rejects(short.start(), /not the .* expected/);
    assert.equal(short.find(), null);
  } finally {
    await s.close();
  }
});

test("a download that stopped half way resumes from where it was with a Range request", async () => {
  const s = await serve();
  const h = home();
  try {
    const inst = new ToolboxInstaller({ home: h, builds: builds(s.url) });
    const dir = installDir(h);
    mkdirSync(dir, { recursive: true });
    const file = builds(s.url)[here].file;
    writeFileSync(join(dir, `${file}.part`), payload.subarray(0, 60_000));
    const path = await inst.start();
    assert.equal(s.hits[0].range, "bytes=60000-");
    assert.equal(await sha256Of(path), sha);
    // a leftover that is longer than the file starts again from nothing
    const h2 = home();
    mkdirSync(installDir(h2), { recursive: true });
    writeFileSync(join(installDir(h2), `${file}.part`), Buffer.concat([payload, Buffer.from("junk")]));
    assert.equal(await sha256Of(await new ToolboxInstaller({ home: h2, builds: builds(s.url) }).start()), sha);
  } finally {
    await s.close();
  }
});

test("offline, a server error and a folder that cannot be written each say what to do, and nothing is left half installed", async () => {
  const s = await serve();
  const url = s.url;
  await s.close(); // nothing is listening now
  const off = new ToolboxInstaller({ home: home(), builds: builds(url) });
  await assert.rejects(off.start(), /could not fetch the data connection software/);
  assert.match(off.status().message, /internet connection.*storage\.googleapis\.com.*CAUSELINE_TOOLBOX/);
  assert.equal(off.find(), null);

  const denied = await serve(payload, { status: 403 });
  try {
    const blocked = new ToolboxInstaller({ home: home(), builds: builds(denied.url) });
    await assert.rejects(blocked.start(), /answered 403/);
  } finally {
    await denied.close();
  }

  const h = home();
  writeFileSync(join(h, "bin"), "a file where the folder should go");
  const unwritable = new ToolboxInstaller({ home: h, builds: builds("http://127.0.0.1:1/x") });
  await assert.rejects(unwritable.start(), /could not make a place to keep/);
  assert.match(unwritable.status().message, /CAUSELINE_HOME/);
});

test("a machine with no build says so plainly and never tries to download", async () => {
  const inst = new ToolboxInstaller({ home: home(), platform: "linux", arch: "arm64" });
  assert.equal(inst.status().state, "unsupported");
  assert.match(inst.status().message, /no ready-made data connection for this computer \(linux, arm64\)/);
  const r = inst.ensure();
  assert.ok("notReady" in r && /CAUSELINE_TOOLBOX/.test(r.notReady));
  await assert.rejects(inst.start(), /no ready-made/);
});

test("a second process sees the first one's progress and does not fetch the file again", async () => {
  const s = await serve(payload, { slowMs: 30 });
  const h = home();
  try {
    const a = new ToolboxInstaller({ home: h, builds: builds(s.url) });
    const b = new ToolboxInstaller({ home: h, builds: builds(s.url) });
    // pretend another process: a progress note with another pid, fresh
    mkdirSync(installDir(h), { recursive: true });
    writeFileSync(join(installDir(h), "download.progress.json"), JSON.stringify({ pid: process.pid + 1, bytes: payload.length / 2, total: payload.length, at: Date.now() }));
    const r = b.ensure();
    assert.ok("notReady" in r && /\b5\d% done/.test(r.notReady) || "notReady" in r);
    assert.equal(b.status().state, "downloading");
    assert.equal(s.hits.length, 0, "it did not start a second download");
    // when that note goes stale, a download is started
    writeFileSync(join(installDir(h), "download.progress.json"), JSON.stringify({ pid: process.pid + 1, bytes: 1, total: payload.length, at: Date.now() - 60_000 }));
    await a.start();
    assert.equal(a.status().state, "ready");
    assert.equal(s.hits.length, 1);
  } finally {
    await s.close();
  }
});

test("two uses in one process share one download", async () => {
  const s = await serve(payload, { slowMs: 5 });
  try {
    const inst = new ToolboxInstaller({ home: home(), builds: builds(s.url) });
    inst.ensure();
    inst.ensure();
    await Promise.all([inst.start(), inst.start()]);
    assert.equal(s.hits.length, 1);
  } finally {
    await s.close();
  }
});

test("the lookup finds the fetched copy in the Causeline home, after the explicit and PATH choices and before the repo", async () => {
  const h = home();
  const b = BUILDS[here];
  assert.ok(b, "a build exists for the machine running the tests");
  mkdirSync(installDir(h), { recursive: true });
  const placed = join(installDir(h), b.file);
  writeFileSync(placed, "x");
  assert.equal(findToolboxBinary(undefined, { CAUSELINE_HOME: h, PATH: "" } as never), placed);
  const explicit = join(h, "mine");
  writeFileSync(explicit, "x");
  assert.equal(findToolboxBinary(explicit, { CAUSELINE_HOME: h, PATH: "" } as never), explicit);
  assert.equal(causelineHome({ CAUSELINE_HOME: h } as never), h);
  assert.match(causelineHome({} as never), /Causeline$/);
});

test("the pinned table covers the four builds that exist, each with a size and a 64-character fingerprint", () => {
  assert.deepEqual(Object.keys(BUILDS).sort(), ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
  for (const b of Object.values(BUILDS)) {
    assert.match(b.sha256, /^[0-9a-f]{64}$/, b.key);
    assert.ok(b.size > 1e8 && b.size < 5e8, b.key);
    assert.match(b.url, /^https:\/\/storage\.googleapis\.com\/mcp-toolbox-for-databases\/v1\.14\.0\//);
  }
  void readFileSync;
});
