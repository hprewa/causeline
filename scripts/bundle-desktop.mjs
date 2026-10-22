#!/usr/bin/env node
// Build the Claude Desktop extension: dist/causeline-<version>.mcpb, one file a person double-clicks. It holds the one bundled server file
// (with the guides inside it), the core playbooks, an icon and the manifest; no Toolbox (it is fetched the first time it is needed).
//   npm run bundle:desktop        (builds the server bundle first)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const repo = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")).version;
const server = join(repo, "clients", "claude-code", "server", "causeline-mcp.mjs");
if (!existsSync(server)) throw new Error("the server bundle is missing; run `npm run bundle:plugin` first");

const stage = join(repo, "dist", "desktop-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(server, join(stage, "server", "causeline-mcp.mjs"));
cpSync(join(repo, "playbooks"), join(stage, "playbooks"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(repo, "clients", "claude-desktop", "manifest.json"), "utf-8"));
manifest.version = version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// a plain 512 x 512 placeholder icon, made here so the build needs nothing else: a blue square with a white ring
const crc = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
};
const N = 512;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const d = Math.hypot(x - N / 2, y - N / 2);
    const ring = d > 140 && d < 190;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = ring ? 255 : 31;
    raw[o + 1] = ring ? 255 : 95;
    raw[o + 2] = ring ? 255 : 191;
    raw[o + 3] = 255;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(join(stage, "icon.png"), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));

const out = join(repo, "dist", `causeline-${version}.mcpb`);
mkdirSync(join(repo, "dist"), { recursive: true });
const run = (args) => spawnSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", ...args], { cwd: repo, encoding: "utf-8", shell: process.platform === "win32" });
const valid = run(["validate", join(stage, "manifest.json")]);
console.log((valid.stdout + valid.stderr).trim());
if (valid.status !== 0) throw new Error("the manifest did not validate");
const packed = run(["pack", stage, out]);
console.log((packed.stdout + packed.stderr).trim());
if (packed.status !== 0 || !existsSync(out)) throw new Error("the extension was not packed");
console.log(`extension: ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
