#!/usr/bin/env node
import { generateForPack } from "./pack.js";

/** Generate <pack>/toolbox/tools.generated.yaml and <pack>/tools.meta.yaml from ontology.yaml and data.yaml (or their `--target` variants). */
export function runGenerate(argv: string[]): void {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pack = flag("pack");
  if (!pack) {
    console.error("usage: causeline generate --pack <pack dir> [--target <name>] [--out <file>]");
    process.exit(2);
  }
  const { path, metaPath, generated } = generateForPack(pack, { out: flag("out"), target: flag("target") });
  console.log(`wrote ${generated.tools.length} tools -> ${path} and the index -> ${metaPath}`);
  for (const s of generated.skipped) console.log(`  skipped metric ${s.metric}: ${s.reason}`);
}

if (process.argv[1] && /cli\.js$/.test(process.argv[1])) runGenerate(process.argv.slice(2));
