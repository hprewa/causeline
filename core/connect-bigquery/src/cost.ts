import { DEFAULT_BUDGET_GB, USD_PER_TIB } from "./meter.js";

/** Reading this much in setup needs the person's go-ahead first. */
export const GO_AHEAD_BYTES = 1e9;

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** Bytes read, in words a person can weigh: "1.7 GB". */
export function sayBytes(bytes: number): string {
  if (bytes < 1e6) return "under 1 MB";
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${round(bytes / 1e9, bytes >= 1e10 ? 0 : 1)} GB`;
}

/** What reading that much costs at list price, as a sentence part. The first terabyte each month is free, so this is an upper estimate. */
export function sayUsd(bytes: number): string {
  const usd = (bytes / 2 ** 40) * USD_PER_TIB;
  if (usd < 0.005) return "under a cent";
  if (usd >= 0.995) return `about $${round(usd, 2).toFixed(2)}`;
  const cents = Math.round(usd * 100);
  return `about ${cents} cent${cents === 1 ? "" : "s"}`;
}

export const sayCost = (bytes: number) => `${sayBytes(bytes)}, ${sayUsd(bytes)}`;

/** The most one question may read, as GB, for a spend the person names in dollars. */
export function capGbFromDollars(dollars: number): number {
  if (!(dollars > 0)) throw new Error("the limit must be more than zero; to remove the limit on purpose, ask for that separately");
  return round(((dollars / USD_PER_TIB) * 2 ** 40) / 1e9, 1);
}

/** The cap in force, in words: how much one question may read and what that costs at most. */
export function sayCap(gb: number, source: "chosen" | "default" = "chosen"): string {
  if (gb <= 0) return "There is no limit on what one question may read.";
  return `One question may read up to ${sayBytes(gb * 1e9)} (${sayUsd(gb * 1e9)} at most)${source === "default" ? ": this is the standard limit; you can change it" : ""}.`;
}

export const defaultCapGb = () => DEFAULT_BUDGET_GB;

export interface SetupReadEstimate {
  /** The most the looking-at-the-data step can read. */
  at_most_bytes: number;
  /** True when the person must say go ahead first. */
  needs_go_ahead: boolean;
  say: string;
}

/**
 * Before the Builder looks at the data: the tables' sizes come free from their metadata. Looking reads a sample when a whole pass would pass the
 * setup budget, so the worst case is the smaller of the tables' total and that budget.
 */
export function setupReadEstimate(tableBytes: (number | undefined)[], budgetBytes: number | null): SetupReadEstimate {
  const known = tableBytes.filter((b): b is number => typeof b === "number");
  const total = known.reduce((a, b) => a + b, 0);
  const atMost = budgetBytes === null ? total : Math.min(total, budgetBytes);
  const unknown = tableBytes.length - known.length;
  const needs = atMost > GO_AHEAD_BYTES;
  const size = total > 0 ? `The tables hold ${sayBytes(total)}${unknown > 0 ? " (some sizes are not known)" : ""}.` : "The size of the tables is not known.";
  const say = needs
    ? `${size} Looking at them could read up to ${sayCost(atMost)} (usually much less: big tables are sampled). That is more than ${sayBytes(GO_AHEAD_BYTES)}, so I need your go-ahead before I start.`
    : `${size} Looking at them will read ${atMost === 0 ? "very little" : `at most ${sayCost(atMost)}`}.`;
  return { at_most_bytes: atMost, needs_go_ahead: needs, say };
}
