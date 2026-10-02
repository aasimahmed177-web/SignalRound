// The classifier on the live feed. The sweep and the watch searches decide which results to read by
// their rules (an article URL, no directory title); with TYPESAFE_API_KEY set, Jev reads the same
// results and its verdict is stored beside the rules' decision (page_verdicts). It may only add: an
// article the directory-title rule alone declined is read after all when Jev is sure it announces a
// round, and then faces every check a kept page does. It never drops a page the rules keep; that
// direction stays in shadow until `pnpm jev-shadow` shows the evidence for it.

import type { PageClassifier, PageVerdict, ScreenedResult } from "@fireround/core";
import { jevClassifier } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { gte } from "drizzle-orm";

/** Results read at most per run: the shadow is a sample, never the run's cost. */
const SHADOW_RESULTS = 200;

/** The feed's results name no company up front; the question asks about the one the page is about. */
const ANY_COMPANY = "the company the page is about";

/** Jev's reading of a result as a keep: about a raise, and an announcement or an article. */
export function jevKeeps(v: { aboutRaise: number; kind: string }): boolean {
  return v.aboutRaise >= 0.5 && (v.kind === "primary" || v.kind === "news");
}

/** Jev overturns the title rule only when it is sure: the headline is the raise, and the page is an announcement or an article. */
export function jevRescues(v: { aboutRaise: number; kind: string; kindConfidence: number }): boolean {
  return v.aboutRaise >= 0.8 && (v.kind === "primary" || v.kind === "news") && v.kindConfidence >= 0.6;
}

/** Store Jev's verdicts (recordShadowVerdicts) and return the URLs of title-held articles it rescues. Empty without a classifier or on any failure. */
export async function screenWithJev(
  handle: Db,
  run: { lane: "sweep" | "watch"; runId: string | null; presetSlug: string | null },
  screened: ScreenedResult[],
  classify: PageClassifier | null = jevClassifier(),
): Promise<Set<string>> {
  const rescued = new Set<string>();
  await recordShadowVerdicts(handle, run, screened, classify, (r, v) => {
    if (r.heldByTitle && jevRescues(v)) rescued.add(r.url);
  });
  return rescued;
}

/**
 * Store Jev's verdict on each screened result beside the rules' decision. Without a classifier this
 * does nothing, and a failure is swallowed: the classifier never holds up or fails a run. Returns the rows written.
 */
export async function recordShadowVerdicts(
  handle: Db,
  run: { lane: "sweep" | "watch"; runId: string | null; presetSlug: string | null },
  screened: ScreenedResult[],
  classify: PageClassifier | null = jevClassifier(),
  onVerdict?: (result: ScreenedResult, verdict: PageVerdict) => void,
): Promise<number> {
  if (!classify || screened.length === 0) return 0;
  try {
    const sample = screened.slice(0, SHADOW_RESULTS);
    const verdicts = await classify(sample.map((r) => ({ company: ANY_COMPANY, url: r.url, title: r.title, snippet: r.snippet })));
    const rows = sample.flatMap((r, i) => {
      const v = verdicts[i];
      if (!v) return [];
      onVerdict?.(r, v);
      return [
        {
          id: crypto.randomUUID(),
          lane: run.lane,
          runId: run.runId,
          presetSlug: run.presetSlug,
          url: r.url,
          title: r.title ?? null,
          rulesKept: r.kept,
          aboutRaise: v.aboutRaise,
          isRound: v.isRound,
          kind: v.kind,
          kindConfidence: v.kindConfidence,
          model: v.model,
        },
      ];
    });
    if (rows.length > 0) await handle.insert(schema.pageVerdicts).values(rows);
    return rows.length;
  } catch {
    return 0;
  }
}

export interface ShadowComparison {
  total: number;
  agree: number;
  /** The rules keep and Jev would drop, and the other way round. */
  rulesOnly: Array<{ lane: string; url: string; title: string | null; aboutRaise: number; kind: string }>;
  jevOnly: Array<{ lane: string; url: string; title: string | null; aboutRaise: number; kind: string }>;
  byLane: Record<string, { total: number; agree: number; rulesKept: number; jevKept: number }>;
}

/** The rules' decisions and Jev's over the last `days`, and the results where they differ. */
export async function compareShadow(handle: Db, days = 7, now = new Date()): Promise<ShadowComparison> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await handle.select().from(schema.pageVerdicts).where(gte(schema.pageVerdicts.createdAt, since));
  const out: ShadowComparison = { total: rows.length, agree: 0, rulesOnly: [], jevOnly: [], byLane: {} };
  for (const r of rows) {
    const jev = jevKeeps(r);
    out.byLane[r.lane] ??= { total: 0, agree: 0, rulesKept: 0, jevKept: 0 };
    const lane = out.byLane[r.lane];
    lane.total++;
    if (r.rulesKept) lane.rulesKept++;
    if (jev) lane.jevKept++;
    if (jev === r.rulesKept) {
      out.agree++;
      lane.agree++;
      continue;
    }
    const row = { lane: r.lane, url: r.url, title: r.title, aboutRaise: r.aboutRaise, kind: r.kind };
    (r.rulesKept ? out.rulesOnly : out.jevOnly).push(row);
  }
  return out;
}
