import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bigQueryProject, checkConnection } from "@causeline/connect-bigquery";
import { readState } from "@causeline/builder";
import { canonicalKpi, intentEnv, IntentSession, planRun, validateIntent, type HistoryEntry, type IntentEnv } from "@causeline/intent";
import { confidenceOf, loadPackForRun } from "@causeline/runner";
import { conceptsOf, IntentPatch, loadAgents, loadPack, statusSentence, type IntentCheck, type Result } from "@causeline/schema";
import type { ServerConfig } from "./config.js";
import { runPlaybookTool, type Callers } from "./handlers.js";

const ENV_TTL_MS = 5 * 60 * 1000;
const say = (s: string) => s[0].toUpperCase() + s.slice(1);

function parsePatch(raw: unknown): IntentPatch {
  const parsed = IntentPatch.safeParse(raw ?? {});
  if (!parsed.success) throw new Error("the patch is not a valid change to the intent:\n" + parsed.error.issues.map((i) => `  ${i.path.join(".") || "(patch)"}: ${i.message}`).join("\n"));
  return parsed.data;
}

/** One line per fact worth remembering from a result, in words. */
export function summarise(r: Result): string[] {
  if (r.status === "stopped") return [`stopped: ${r.stopped_detail ?? r.stopped_reason ?? "no reason given"}`];
  const lines: string[] = [];
  if (r.headline) {
    const h = r.headline;
    lines.push(`value ${+h.value.toPrecision(4)} against ${+h.baseline.toPrecision(4)} expected (change ${+h.change.toPrecision(3)}${h.significant ? ", significant" : ", within normal variation"})`);
  }
  for (const f of r.findings.slice(0, 3)) lines.push(`${f.dimension} ${f.value}${f.scope ? ` (within ${Object.entries(f.scope).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
  if (r.findings.length === 0 && r.status === "complete") lines.push("no finding stood out");
  return lines;
}

const brief = (h: HistoryEntry) => ({ n: h.n, at: h.at, playback: h.playback, summary: h.summary });

/**
 * The running intent of one conversation: tools that build it up message by message, check it against the
 * data, run it, and remember the answers. A model fills the structure in (it understands words); everything
 * here is deterministic, so the same intent on the same data runs the same analysis.
 */
export class IntentService {
  session = new IntentSession();
  private env: { at: number; value: IntentEnv } | undefined;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly callers: Callers,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A different project was opened: the question being built and what the data covers belong to the old one. */
  reset(): void {
    this.session = new IntentSession();
    this.env = undefined;
  }

  private async environment(): Promise<IntentEnv> {
    if (this.env && this.now().getTime() - this.env.at < ENV_TTL_MS) return this.env.value;
    const pack = loadPackForRun(this.cfg.packDir);
    const value = await intentEnv({ ontology: pack.ontology, data: pack.data, meta: pack.meta, tools: await this.callers.caller(), today: this.now().toISOString().slice(0, 10) });
    this.env = { at: this.now().getTime(), value };
    return value;
  }

  /** Everything a model needs to fill the intent in correctly. */
  async get() {
    const env = await this.environment();
    const ont = env.ontology;
    const a = this.session.active;
    const check = a.kpi || a.period || a.task ? await validateIntent(a, env) : undefined;
    return {
      today: env.as_of === "data_end" ? `${env.data.end} (this data stops there, so "today" is the day after)` : env.today,
      data_covers: env.data,
      weeks: "Monday to Sunday; periods never include today",
      kpis: Object.entries(ont.metrics).map(([name, m]) => ({ name, ...(m.description ? { description: m.description } : {}), ...(m.synonyms ? { also_called: m.synonyms } : {}) })),
      concepts: conceptsOf(ont),
      views: ont.time.levels,
      period_labels: env.labels.slice(-12).map((l) => l.label),
      tasks: { value: "the number for a period", compare: "two periods side by side (needs comparison)", trend: "how it moved over time", deep_rca: "why it changed, and where" },
      active: a,
      said_since_last_run: this.session.unread,
      check,
      history: this.session.history.map(brief),
    };
  }

  /** Take in a message and the change to the intent a model made from it. */
  async set(args: { message?: string; patch?: unknown }) {
    const patch = parsePatch(args?.patch);
    const env = await this.environment();
    // keep the ontology's name for the KPI, not the person's words, so a switch of topic is recognised
    if (patch.kpi) patch.kpi = canonicalKpi(patch.kpi, env.ontology) ?? patch.kpi;
    const { switched } = this.session.set(args?.message, patch);
    const check: IntentCheck = await validateIntent(this.session.active, env);
    return {
      active: this.session.active,
      ...(switched ? { topic_switch: { ...switched, tell_the_user: `Switching to ${switched.to.replace(/_/g, " ")}${switched.kept.length ? `, keeping ${switched.kept.join(", ")}` : ""}.` } } : {}),
      check,
      next: check.status === "ready" ? "Read the play-back to the user in your own words, then call run_intent (or set_intent again if they correct it)." : "Ask the user this one question, then call set_intent with their answer.",
    };
  }

  async run() {
    const env = await this.environment();
    const check = await validateIntent(this.session.active, env);
    if (check.status === "ask") return { ran: false, check, next: "Ask the user this one question, then call set_intent with their answer. Nothing was run." };
    const plan = planRun(check.resolved, { ontology: env.ontology, agents: loadAgents(this.cfg.packDir), labels: env.labels });
    if (plan.kind === "cannot") return { ran: false, playback: check.playback, cannot: say(plan.reason) + ".", next: "Tell the user why, and offer what can be done instead; nothing was run." };

    const { file, result } = await runPlaybookTool(this.cfg, this.callers, { name: plan.playbook, inputs: plan.inputs });
    const at = this.now().toISOString();
    const entry = this.session.record({ at, resolved: check.resolved, playback: check.playback, summary: summarise(result), file }, at);
    return {
      ran: true,
      n: entry.n,
      playback: check.playback,
      notes: [...check.notes, `This answer comes from an expert that ${statusSentence(plan.status, plan.unconfirmed_numbers)}; say so in plain words.`, "Say how sure the answer is, with the label and its reasons from confidence (they come from the run, not from your own judgement)."],
      expert: plan.expert,
      confidence: confidenceOf({ rung: plan.status, unconfirmed: plan.unconfirmed_numbers, result }),
      file,
      result,
      next: "Explain the result in plain words using only what it contains. The user can now refine it with set_intent (the intent is kept), or use recall(n) / start_over.",
    };
  }

  recall(args: { n?: number }) {
    if (args?.n === undefined) return { history: this.session.history.map(brief), next: "Pass n to bring one back as the active intent." };
    const entry = this.session.recall(Number(args.n));
    if (!entry) throw new Error(`there is no answer number ${args.n}; ${this.session.history.length ? `have ${this.session.history.map((h) => h.n).join(", ")}` : "nothing has been run yet"}`);
    return { recalled: brief(entry), active: this.session.active, summary: entry.summary, file: entry.file, next: "The intent is active again; adjust it with set_intent or run it again with run_intent." };
  }

  startOver() {
    this.session.startOver();
    return { active: this.session.active, history_kept: this.session.history.length, next: "Start from the user's new question." };
  }

  /** Can this computer read the pack's data? In words. */
  async checkConnection() {
    // a project still being set up has no saved description yet: check what it was connected with
    if (!existsSync(join(this.cfg.packDir, "data.yaml"))) {
      const bq = readState(this.cfg.packDir)?.bigquery;
      if (!bq) return { ok: false, summary: "Nothing is connected yet, so there is nothing to check.", steps: [] };
      return checkConnection({ project: bq.project, location: bq.location }, bq.dataset);
    }
    const pack = loadPack(this.cfg.packDir, { skipMeta: true });
    if (pack.data.dialect !== "bigquery") return { ok: true, summary: "This pack reads a local database; there is nothing to sign in to.", steps: [] };
    const project = bigQueryProject(this.cfg.packDir);
    if (!project) return { ok: false, summary: "No Google Cloud project is set. Set CAUSELINE_BQ_PROJECT to its id.", steps: [] };
    const file = join(this.cfg.packDir, "data.yaml");
    const sql = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const datasets = [...new Set([...sql.matchAll(/`([\w-]+\.\w+)\.\w+`/g)].map((m) => m[1]))];
    const target = { project, location: process.env.CAUSELINE_BQ_LOCATION };
    let last = await checkConnection(target, datasets[0]);
    for (const d of datasets.slice(1)) if (last.ok) last = await checkConnection(target, d);
    return last;
  }
}
