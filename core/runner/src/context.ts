import type { Comparison, Contribution, Evidence, Explained, FactValue, Headline, Trend, MaskingFlag, Ontology, PathNode, TraceEntry } from "@causeline/schema";
import type { Decomposition } from "./decompose.js";
import type { Dispersion } from "./dispersion.js";
import type { ResolvedThresholds } from "./masking.js";
import type { PeriodInfo, Window } from "./period.js";
import type { SlotNames } from "./seasonal.js";
import type { ToolIndex } from "./toolindex.js";
import type { Components, Direction, ToolCaller } from "./types.js";

/** A finding before ranking: where the change is, and how to re-check it over time. */
export interface FindingDraft {
  dimension: string;
  value: string;
  /** Change in the metric (headline units) attributed to this node. */
  impact: number;
  effect?: "rate" | "mix";
  evidence: string[];
  /** Reported as a contributor, not followed as a culprit. */
  role?: "contributor";
  scope?: Record<string, string>;
  /** Which column/value to filter on, and its baseline, for the persistence check (absent for time-slot findings). */
  persist?: { col: string; value: string; base: Components };
  persistence?: "persistent" | "single_slot";
}

/** Deepest informative node a hierarchy drill reached; refine ranks dimensions inside it. */
export interface HierarchyCandidate {
  hierarchy: string;
  level: string;
  node: string;
  base: Components;
  /** Product of current-volume shares down to and including this node. */
  scaleAfter: number;
}

/** A split of the whole window by one concept that the drill looked at, kept so the contributions step can say who contributed what. */
export interface LevelLook {
  concept: string;
  decomposition: Decomposition;
}

export interface RunContext {
  ontology: Ontology;
  metric: string;
  /** How the metric is built: a ratio of two components, or a total. Products are split into drivers first. */
  kind: "ratio" | "sum";
  /** For totals: how much of the baseline total is expected in the current window (1 / baseline periods). */
  sumScale: number;
  minVolume: number;
  direction: Direction;
  th: ResolvedThresholds;
  tools: ToolCaller;
  /** Finds a tool by what it answers; the runner never builds a tool name. */
  index: ToolIndex;
  inputs: Record<string, string | number | boolean>;
  /** The declared slots (cycles, calendar attributes); empty when seasonality is none. */
  slots: SlotNames;
  /**
   * Slot restriction for the baseline rows of node queries: slot name -> comma list of the values the
   * narrowed window sits in. Empty until the period (calendar flags) or the time drill sets it.
   */
  slotFilter: Record<string, string>;
  /** What the seasonal handling did or could not do, for result.seasonality. */
  seasonNotes: string[];
  /** Resolved by the data check. */
  period?: PeriodInfo;
  /** Current drill window; starts as the whole period and narrows in the time drill. */
  window?: Window;
  headline?: Headline;
  trend?: Trend;
  comparison?: Comparison;
  onset?: string | null;
  path: PathNode[];
  flags: MaskingFlag[];
  drafts: FindingDraft[];
  /** Supporting records fetched by evidence steps. */
  evidence: Evidence[];
  candidates: HierarchyCandidate[];
  /** How much more the metric moves from period to period than counting noise gives; zero until the data check has estimated it. */
  dispersion: Dispersion;
  /** Splits of the whole window the drill looked at (a hierarchy's first level, a diluted sweep, a flat dimension). */
  looks: LevelLook[];
  contributions: Contribution[];
  explained?: Explained;
  stop?: { reason: string; detail: string };
  /** Facts published by the steps so far, keyed `<step>.<name>`. */
  facts: Record<string, FactValue>;
  trace: TraceEntry[];
  /** What each executed step was, so `within` can tell a hierarchy drill from a dimension ranking. */
  stepKinds: Map<string, { compute: string; over?: string }>;
}

export const round6 = (x: number | null | undefined): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6;
