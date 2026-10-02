// The Firecrawl primitives a record passed through, as reader-visible steps. Pure derivation for
// the Built with strip on the feed's expanded row and the company page; the component renders it.

import { hostLabel, laneLabel } from "./format";
import { readAgainst } from "./source-count";

export interface BuiltWithStep {
  key: "search" | "scrape" | "json" | "verify" | "branding" | "alexandria" | "x" | "agent";
  fact: string;
}

/** The slice of a row the trace reads; RoundRow and FeedRow both satisfy it. */
export interface BuiltWithInput {
  sources: Array<{ host: string; query: string | null }>;
  evidence_quotes: string[];
  verification: { status: string; sources_seen?: number; verifier?: string } | null;
  enrichment: { verified: boolean } | null;
  /** Presence flags only: which providers matched on the verified domain. */
  alexandria: { yc: unknown; firmographics: unknown } | null;
}

/**
 * How the record was found, from the lane marker the primary source's `query` carries. A search's
 * own text is how the instance searches, operator detail like the verifier's model, so the step
 * names the lane and never the query.
 */
function searchFact(query: string | null): string {
  const lane = laneLabel(query);
  if (!lane || lane.label === "Search") return "found by Firecrawl search";
  if (lane.label === "Monitor") return "found by a monitor";
  if (lane.label.startsWith("Watch:")) return "found on a watched publisher";
  if (lane.label === "Corroboration") return "found while cross-checking another source";
  if (lane.label === "Manual") return "added by hand from its URL";
  if (lane.label === "Form D") return "from a Form D filing";
  if (lane.label.startsWith("X:")) return `found on ${lane.label}`;
  return "found by the research agent";
}

/**
 * `xPeople` is how many people the Trending lane found posting about the round on X (search on
 * x.com, each post dated by its status id); the step shows when any were.
 */
export function builtWithSteps(row: BuiltWithInput, opts: { dossier?: boolean; xPeople?: number } = {}): BuiltWithStep[] {
  const steps: BuiltWithStep[] = [{ key: "search", fact: searchFact(row.sources[0]?.query ?? null) }];
  const hosts = [...new Set(row.sources.map((s) => hostLabel(s.host)))].slice(0, 3);
  steps.push({
    key: "scrape",
    fact: `${row.sources.length} ${row.sources.length === 1 ? "page" : "pages"} read${hosts.length ? `: ${hosts.join(", ")}` : ""}`,
  });
  steps.push({
    key: "json",
    fact: row.evidence_quotes.length ? "round read into a schema, with the sentence that states it" : "round extracted with a schema",
  });
  const v = row.verification;
  if (!v || v.status === "unverified" || v.status === "skipped") {
    steps.push({ key: "verify", fact: "not yet checked against its sources" });
  } else if (v.verifier && v.verifier !== "judge") {
    // The model's name is operator detail (Settings shows it); the reader needs how much it read.
    steps.push({ key: "verify", fact: `checked against ${readAgainst(row) ?? `${row.sources.length} sources`}` });
  } else {
    steps.push({ key: "verify", fact: "checked against its page with Firecrawl" });
  }
  // A homepage that failed the identity check wrote nothing, so there is no step to show for it.
  if (row.enrichment?.verified) steps.push({ key: "branding", fact: "logo and colour from the homepage" });
  if (row.alexandria && (row.alexandria.yc || row.alexandria.firmographics)) {
    const yc = !!row.alexandria.yc;
    const firmographics = !!row.alexandria.firmographics;
    steps.push({
      key: "alexandria",
      fact:
        yc && firmographics
          ? "founders and batch from Y Combinator, firmographics from FullEnrich, via Alexandria"
          : yc
            ? "founders and batch from Y Combinator via Alexandria"
            : "firmographics from FullEnrich via Alexandria",
    });
  }
  if (opts.xPeople && opts.xPeople > 0) {
    steps.push({
      key: "x",
      // The step's label is X's logomark, so the fact does not name X again.
      fact: `posts from ${opts.xPeople} ${opts.xPeople === 1 ? "person" : "people"}, found with Firecrawl search`,
    });
  }
  if (opts.dossier) steps.push({ key: "agent", fact: "company research by the Firecrawl agent" });
  return steps;
}
