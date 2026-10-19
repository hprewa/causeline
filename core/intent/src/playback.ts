import type { ResolvedIntent } from "@causeline/schema";

const words = (s: string) => s.replace(/_/g, " ");

/** The intent read back in plain words, so a misunderstanding is caught before anything runs. */
export function playback(r: ResolvedIntent): string {
  const kpi = words(r.kpi);
  const within = Object.entries(r.filters).map(([c, v]) => `${words(c)} ${v}`);
  const scope = within.length ? ` (${within.join(", ")})` : "";
  const by = r.aggregation ? `, by ${words(r.aggregation)}` : "";
  switch (r.task) {
    case "value":
      return `The value of ${kpi}${scope} for ${r.window.description}${by}.`;
    case "compare":
      return `Comparing ${kpi}${scope}: ${r.window.description} against ${r.against?.description ?? "another period"}${by}.`;
    case "trend":
      return `How ${kpi}${scope} moved over ${r.window.description}${by}.`;
    case "deep_rca":
      return `A deep dive into ${kpi}${scope} for ${r.window.description}${by}: what changed, and why.`;
  }
}
