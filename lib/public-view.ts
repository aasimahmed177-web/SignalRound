// What a public visitor may read of a round or a run. The store keeps operator detail beside the
// record: which model read a row back, the search query that found each page, why a profile was
// refused, and what every run spent in credits. A public demo serves /api/v1, the MCP tools, the
// feeds, and the exports to anyone, so each of those surfaces passes its rows through here first.
// Admins, and every caller on a private instance (the password already gated them), keep the full row.

import { isBareDollar, parseAmount, withBasis } from "@fireround/core";
import type { RunRow } from "./news.ts";
import type { RoundRow } from "./persist.ts";

/** A round's valuation as a reader may cite it: the figure as its source wrote it, in USD when known, and pre- or post-money when a source says which. */
export interface RoundValuation {
  usd_millions: number | null;
  as_written: string;
  basis: "post" | "pre" | "unknown";
}

const BASIS = /\b(pre|post)[\s-]?money\b/i;

/**
 * The valuation a reader may cite, or null. Only a published round (never a flagged, held-for-review
 * or rejected one) that closed (announced or reported) and that the read-back confirmed or corrected
 * carries one. The USD figure is the stated one, or the round's own announcement-day rate when the
 * valuation is in the amount's currency; any other currency leaves it null. A bare "$" valuation beside a bare "$"
 * amount is in whatever dollar that amount was read as (an Australian outlet's A$, or unsure). The basis comes from the
 * valuation's own words, else from a sentence the round keeps that states the same figure.
 */
export function citableValuation(r: {
  valuation_as_written: string | null;
  quotes: readonly (string | null)[];
  disposition: RoundRow["disposition"];
  certainty: RoundRow["certainty"];
  verification: { status: string } | null;
  amount: Pick<RoundRow["amount"], "value" | "currency" | "usd_millions"> & { as_written?: string | null };
}): RoundValuation | null {
  const asWritten = r.valuation_as_written?.trim();
  if (!asWritten || r.disposition !== "publish") return null;
  if (r.certainty !== "announced" && r.certainty !== "reported") return null;
  if (r.verification?.status !== "confirmed" && r.verification?.status !== "corrected") return null;
  const { amount } = r;
  const { value, currency: written } = parseAmount(asWritten);
  if (value === null) return null;
  const currency = isBareDollar(asWritten) && isBareDollar(amount.as_written) ? amount.currency : written;
  const rate =
    currency === "USD"
      ? 1
      : currency && amount.currency === currency && amount.value && amount.usd_millions !== null
        ? amount.usd_millions / amount.value
        : null;
  const basis = [asWritten, ...r.quotes.filter((q): q is string => Boolean(q)).map((q) => withBasis(asWritten, q))]
    .map((text) => BASIS.exec(text)?.[1]?.toLowerCase())
    .find(Boolean);
  return {
    usd_millions: rate === null ? null : Math.round(value * rate * 1000) / 1000,
    as_written: asWritten,
    basis: basis === "pre" || basis === "post" ? basis : "unknown",
  };
}

/** Whether a round's valuation is disclosed as a reader sees it: true only for a citable one; a hidden one says nothing either way. */
export function publicValuationDisclosed(r: Partial<Pick<RoundRow, "valuation" | "valuation_disclosed">>): boolean | null {
  if (r.valuation) return true;
  return r.valuation_disclosed === false ? false : null;
}

/**
 * A verdict's verifier as a reader may see it: "judge" (NativeWebClient read the primary page) or "model"
 * (every source read together). The stored label names the model and gateway, which is operator
 * detail; the UI only ever asks whether a row was reconciled.
 */
export function publicVerifier(verifier: string | undefined): "judge" | "model" | undefined {
  if (verifier === undefined) return undefined;
  return verifier === "judge" ? "judge" : "model";
}

/**
 * The lane a source came in by, without the search text: a sweep's query string ("funding round"
 * "seed" OR "pre-seed" ...) is how the instance searches, so it reads as "search". The lane
 * markers themselves (corroborate, formd, watch:host, x:@handle, monitor, agent, manual) say
 * nothing a reader could not see on the page and pass through, with a monitor's id and an agent's
 * play cut to the lane word.
 */
export function publicLane(query: string | null | undefined): string | null {
  if (!query) return null;
  if (query === "formd" || query === "corroborate" || query === "manual" || query === "search") return query;
  if (query.startsWith("watch:") || query.startsWith("x:")) return query;
  if (query.startsWith("monitor:") || query.startsWith("check:")) return "monitor";
  if (query.startsWith("agent:")) return "agent";
  return "search";
}

/**
 * A note a reviewer reads, not a reader: why a row waits for a person ("held for review: ...", "held: ...")
 * or why it moved to history ("reported later: ..."). The verdict's own change lines and remarks stay.
 */
const REVIEWER_NOTE = /^(?:held for review|held|reported later):/i;

/** A verdict's notes as a reader may see them: the reviewer's notes gone. */
export function publicNotes(notes: readonly string[]): string[] {
  return notes.filter((n) => !REVIEWER_NOTE.test(n));
}

/**
 * The public form of a round in the API and JSONL: no verifier, no source queries, no profile-refusal
 * trail, and none of the reviewer's record (the hold, a person's pins, the reviewer's notes). A valuation
 * shows only where it is citable (citableValuation): a flagged or unverified row's stays off.
 */
export function publicRound<
  T extends Pick<RoundRow, "verification" | "sources" | "enrichment"> & Partial<Pick<RoundRow, "valuation" | "valuation_disclosed">>,
>(r: T & { hold?: unknown; pinned?: unknown }) {
  const { verification, sources, enrichment, hold: _hold, pinned: _pinned, ...rest } = r;
  let publicVerification: Omit<NonNullable<RoundRow["verification"]>, "verifier"> | null = null;
  if (verification) {
    const { verifier: _verifier, ...kept } = verification;
    publicVerification = { ...kept, notes: publicNotes(kept.notes ?? []) };
  }
  let publicEnrichment: Omit<NonNullable<RoundRow["enrichment"]>, "error" | "website_source"> | null = null;
  if (enrichment) {
    const { error: _error, website_source: _source, ...kept } = enrichment;
    publicEnrichment = kept;
  }
  return {
    ...rest,
    valuation_as_written: r.valuation?.as_written ?? null,
    valuation_disclosed: publicValuationDisclosed(r),
    verification: publicVerification,
    sources: sources.map(({ query: _query, ...s }) => s),
    enrichment: publicEnrichment,
  };
}

/** A key that carries spend: every credits field and counter, and the budget skips that follow from it. */
const SPEND_KEY = /credit|budget/i;

/**
 * A run's error as a reader may see it. Runs store `String(err)`, and a driver error quotes the query
 * and its parameters, so one that names a query, or carries a stack, reads as a plain sentence; any
 * other keeps its first line, minus the workflow runtime's step paths.
 */
export function publicRunError(error: string | null): string | null {
  if (!error) return null;
  if (/failed query|\bparams:|^\s+at\s/im.test(error)) return "The run stopped on an internal error.";
  return error
    .split("\n")[0]
    .replace(/step\/\/\.\/workflows\/[\w.-]+\/\//g, "")
    .slice(0, 200);
}

/** The public form of a run: its lane, times, counts, and error, with every credit and budget figure gone. */
export function publicRun(run: RunRow) {
  const { credits_estimated: _e, credits_measured: _m, credits_charged: _c, overlapped: _o, counts, error, ...rest } = run;
  return {
    ...rest,
    counts: counts ? Object.fromEntries(Object.entries(counts).filter(([k]) => !SPEND_KEY.test(k))) : null,
    error: publicRunError(error),
  };
}

/** Model and provider labels as they appear in stored verifier fields ("gateway:openai/gpt-5.6-luna"). */
const MODEL_TEXT = /\bgateway:|\b(?:openai|anthropic|google|openrouter|mistral|meta|xai)\/[\w.-]+|\bgpt-\d|\bclaude-|\bgemini-/i;

/**
 * Every place in a public payload where operator detail shows: a key that names spend, a verifier, a
 * source query, a profile-refusal trail, the reviewer's hold or pins, or a string value that names a
 * model or reads as a reviewer's note. Empty for a clean
 * payload; the tests run every public surface through it so a field that comes back fails them.
 */
export function internalFields(value: unknown, path = "$"): string[] {
  if (typeof value === "string") return MODEL_TEXT.test(value) || REVIEWER_NOTE.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => internalFields(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = `${path}.${k}`;
    const bad =
      SPEND_KEY.test(k) ||
      k === "verifier" ||
      k === "query" ||
      k === "website_source" ||
      k === "hold" ||
      k === "pinned" ||
      (k === "error" && path.endsWith(".enrichment"));
    return [...(bad ? [here] : []), ...internalFields(v, here)];
  });
}
