import type { Intent, IntentPatch, ResolvedIntent } from "@causeline/schema";
import { mergeIntent } from "./merge.js";

/** One answered question, kept so a person can come back to it ("go back to number 2"). */
export interface HistoryEntry {
  n: number;
  at: string;
  /** What the person said that led to it. */
  said: string[];
  intent: Intent;
  resolved: ResolvedIntent;
  playback: string;
  /** One line per fact worth remembering: the headline and the top findings, in words. */
  summary: string[];
  /** Where the full result is on disk. */
  file?: string;
}

export interface Switch {
  from: string;
  to: string;
  /** What carried over unchanged, in words. */
  kept: string[];
}

const KEEP = 50;

/**
 * The conversation's state: the intent being built, what was said since the last run, and the answers so far.
 * Plain data and no clock of its own (callers pass the time), so it can be saved, tested and replayed.
 */
export class IntentSession {
  active: Intent = { filters: {} };
  /** What the person has said since the last run. */
  unread: string[] = [];
  history: HistoryEntry[] = [];
  private next = 1;

  /** Take in a message and the change a model made to the intent from it. */
  set(message: string | undefined, patch: IntentPatch): { switched?: Switch } {
    if (message) this.unread.push(message);
    const before = this.active;
    this.active = mergeIntent(this.active, patch);
    const changedKpi = patch.kpi && before.kpi && patch.kpi !== before.kpi;
    if (!changedKpi || !this.history.length) return {};
    const kept: string[] = [];
    if (this.active.period && before.period) kept.push("the same period");
    if (this.active.task && before.task) kept.push(`the same kind of question (${this.active.task.replace(/_/g, " ")})`);
    for (const [c, v] of Object.entries(this.active.filters)) if (before.filters[c] === v) kept.push(`${c.replace(/_/g, " ")} ${v}`);
    if (this.active.aggregation && before.aggregation === this.active.aggregation) kept.push(`the view (${this.active.aggregation})`);
    return { switched: { from: before.kpi!, to: patch.kpi!, kept } };
  }

  /** The intent ran: remember it and start counting messages again. The intent stays, so a follow-up refines it. */
  record(entry: Omit<HistoryEntry, "n" | "said" | "intent">, at: string): HistoryEntry {
    const full: HistoryEntry = { ...entry, at, n: this.next++, said: this.unread, intent: structuredClone(this.active) };
    this.history.push(full);
    if (this.history.length > KEEP) this.history.shift();
    this.unread = [];
    return full;
  }

  /** An earlier answer, made the active intent again so it can be adjusted ("the same, for another value"). */
  recall(n: number): HistoryEntry | undefined {
    const entry = this.history.find((h) => h.n === n);
    if (entry) {
      this.active = structuredClone(entry.intent);
      this.unread = [];
    }
    return entry;
  }

  /** Forget the question being built (the answers so far are kept). */
  startOver(): void {
    this.active = { filters: {} };
    this.unread = [];
  }
}
