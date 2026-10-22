import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A number the person already trusts, from a report they know. It is theirs to confirm later; it is not a confirmed check. */
export interface TrustedNumber {
  period: string;
  value: number;
  /** The named report or system it comes from. */
  source: string;
}

/**
 * The prep card: what the person knows before setup starts, kept in setup.json beside the project so that a conversation can stop and
 * another (in any client) carry on. The assistant fills it a few answers at a time; it is never one long form.
 */
export interface SetupCard {
  version: 1;
  updated: string;
  /** The one KPI they care about, in their words. */
  kpi?: string;
  /** How it is worked out today, in their words. */
  how_calculated?: string;
  numbers: TrustedNumber[];
  incidents: { text: string }[];
  /** Zero incidents is a valid answer; this says the question was asked. */
  incidents_answered: boolean;
  /** Whether read access is confirmed, or who to ask. */
  access?: { confirmed: boolean; admin?: string };
}

export interface CardAnswers {
  kpi?: string;
  how_calculated?: string;
  numbers?: TrustedNumber[];
  incidents?: { text: string }[];
  /** True when the person says they have none. */
  no_incidents?: boolean;
  access?: { confirmed: boolean; admin?: string };
}

export interface CardItem {
  item: string;
  done: boolean;
  detail: string;
}

export interface CardStatus {
  items: CardItem[];
  /** The one item to ask about next, in plain words ("" when the card is complete). */
  next: string;
}

/** Numbers the card asks for. */
export const CARD_NUMBERS = 3;

const FILE = "setup.json";
const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function readCard(workspace: string): SetupCard | null {
  const p = join(workspace, FILE);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as SetupCard;
    return { ...raw, numbers: raw.numbers ?? [], incidents: raw.incidents ?? [], incidents_answered: raw.incidents_answered ?? false };
  } catch {
    throw new Error("the saved prep card could not be read; it may have been edited by hand");
  }
}

/** Add answers to the card. Text answers replace; numbers and incidents are added to (the same one is not added twice). */
export function saveCard(workspace: string, answers: CardAnswers): SetupCard {
  const card: SetupCard = readCard(workspace) ?? { version: 1, updated: "", numbers: [], incidents: [], incidents_answered: false };
  if (answers.kpi !== undefined && clean(answers.kpi)) card.kpi = clean(answers.kpi);
  if (answers.how_calculated !== undefined && clean(answers.how_calculated)) card.how_calculated = clean(answers.how_calculated);
  for (const n of answers.numbers ?? []) {
    if (!clean(n.period) || !Number.isFinite(n.value) || !clean(n.source)) throw new Error("a trusted number needs its period, its value and the report it comes from");
    const same = card.numbers.findIndex((x) => x.period === clean(n.period) && x.source === clean(n.source));
    const next = { period: clean(n.period), value: n.value, source: clean(n.source) };
    if (same >= 0) card.numbers[same] = next;
    else if (card.numbers.length >= CARD_NUMBERS) throw new Error(`the card holds ${CARD_NUMBERS} numbers; more can be given later when the numbers are checked`);
    else card.numbers.push(next);
  }
  for (const i of answers.incidents ?? []) {
    if (clean(i.text) && !card.incidents.some((x) => x.text === clean(i.text))) card.incidents.push({ text: clean(i.text) });
  }
  if (answers.no_incidents || (answers.incidents ?? []).length > 0) card.incidents_answered = true;
  if (answers.no_incidents && card.incidents.length > 0) throw new Error("incidents are already on the card; they cannot also be none");
  if (answers.access) card.access = { confirmed: !!answers.access.confirmed, ...(clean(answers.access.admin) ? { admin: clean(answers.access.admin) } : {}) };
  card.updated = new Date().toISOString();
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, FILE), JSON.stringify(card, null, 2) + "\n", "utf-8");
  return card;
}

/** Which items are answered, and the one to ask about next. */
export function cardStatus(card: SetupCard | null): CardStatus {
  const c = card;
  const items: CardItem[] = [
    { item: "the KPI you care about", done: !!c?.kpi, detail: c?.kpi ?? "not asked yet" },
    { item: "how it is worked out today", done: !!c?.how_calculated, detail: c?.how_calculated ?? "not asked yet" },
    { item: `${CARD_NUMBERS} numbers you already trust`, done: (c?.numbers.length ?? 0) >= CARD_NUMBERS, detail: `${c?.numbers.length ?? 0} of ${CARD_NUMBERS}` },
    { item: "past incidents with a known cause", done: !!c?.incidents_answered, detail: c?.incidents_answered ? (c.incidents.length === 0 ? "none" : `${c.incidents.length} noted`) : "not asked yet" },
    { item: "read access to the data", done: !!c?.access, detail: c?.access ? (c.access.confirmed ? "confirmed" : `to be confirmed${c.access.admin ? ` with ${c.access.admin}` : ""}`) : "not asked yet" },
  ];
  const ask: Record<string, string> = {
    "the KPI you care about": "Ask which one KPI they care most about, in their own words.",
    "how it is worked out today": "Ask how that KPI is worked out today (which report or sheet, and the rule).",
    [`${CARD_NUMBERS} numbers you already trust`]: "Ask for a number they trust from a report they know: the period, the value and which report.",
    "past incidents with a known cause": "Ask whether they know of past incidents with a known cause; none is a fine answer.",
    "read access to the data": "Ask whether they can already read the data, or who their admin is.",
  };
  const first = items.find((i) => !i.done);
  return { items, next: first ? ask[first.item] : "" };
}
