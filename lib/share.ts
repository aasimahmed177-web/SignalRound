// What a shared link says about itself: the one-line description, the Open Graph and Twitter
// titles, and the figures the link-preview cards draw. Pure over the page reads, so the metadata,
// the cards, and the tests all build from the same sentences.

import type { Metadata } from "next";
import type { CompanyPage } from "@/lib/company";
import { reportedAmount, roundStageLabel, sectorLabel, stageLabel, stageOf } from "@/lib/format";
import type { InvestorPage } from "@/lib/investor";
import { canonicalUrl } from "@/lib/origin";
import type { BareRoundRow, RoundRow } from "@/lib/persist";
import { readAgainst, sourceCount, sourcesLabel } from "@/lib/source-count";
import { capitalizeFirst } from "@/lib/text";

const SITE = "Fireround";

/** Slack and most unfurlers cut the description near here; a sentence that ends is better than one cut. */
const MAX_DESCRIPTION = 300;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "sales engagement platform" reads as "Sales engagement platform"; "eBay" and a missing one stay as they are. */
export function capitalise(text: string | null | undefined): string | null {
  const t = text?.trim();
  return t ? capitalizeFirst(t) : null;
}

function withStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Trims to the last word that fits, with an ellipsis, so a long description never ends mid-word. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** "4 Sep 2026" for a stated day, "Sep 2026" when the day came from a weekly or monthly roundup. */
export function cardDate(iso: string | null, precision: RoundRow["date_precision"]): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return precision === "day" ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`;
}

function monthYear(iso: string | null): string | null {
  return cardDate(iso, "month");
}

/** A label mid-sentence: "Fintech" reads "fintech", but an acronym ("AI", "HR tech") keeps its capitals. */
function inSentence(label: string): string {
  return /^\p{Lu}\p{Lu}/u.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** "Series A" keeps its capital; "seed", "growth" read lowercase inside a sentence. */
function stageInSentence(label: string): string {
  return label.startsWith("Series") ? label : inSentence(label);
}

/** "The Moon Venture", "A and B", "A, B and 2 others". */
export function nameList(names: string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** The amount as a reader would say it: USD when converted, else what the source wrote. */
export function amountLabel(r: BareRoundRow): string | null {
  return reportedAmount(r);
}

/** "Seed ext." for a card's latest-round line. */
export function roundLabel(r: BareRoundRow): string {
  return `${roundStageLabel(r)}${r.is_extension ? " ext." : ""}`;
}

/**
 * What the round was verified against, in words ("5 sources", "1 of 2 sources"), else nothing: an
 * unverified or flagged round claims no verification. The count is the sources the page lists.
 */
export function verifiedAgainst(r: RoundRow): string | null {
  if (r.disposition === "flagged") return null;
  return readAgainst(r);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface CompanyShare {
  title: string;
  description: string;
  latest: RoundRow | null;
  /** Rounds the page counts (rejected left out), newest first. */
  counted: RoundRow[];
}

/**
 * "Zeliq raised $8M in its seed round, led by The Moon Venture and CMI (Sep 2026). 5 sources." Then what
 * the company does, when the record knows. The count is the sources the page lists for the round.
 */
export function companyShare(page: CompanyPage): CompanyShare {
  const { company, rounds } = page;
  const counted = rounds.filter((r) => r.disposition !== "rejected");
  const latest = counted[0] ?? null;
  const what = capitalise(company.description);
  if (!latest) {
    const description = what ? withStop(what) : `${company.name} on ${SITE}: every funding round on record, with its sources.`;
    return { title: company.name, description: clip(description, MAX_DESCRIPTION), latest, counted };
  }
  const amount = amountLabel(latest);
  const stage = stageInSentence(stageOf(latest));
  const ext = latest.is_extension ? " extension" : "";
  const round = ["undisclosed", "other"].includes(latest.stage)
    ? `a funding round${ext}`
    : amount
      ? `its ${stage}${stage.startsWith("Series") ? "" : " round"}${ext}`
      : `a ${stage} round${ext}`;
  let sentence = amount ? `${company.name} raised ${amount} in ${round}` : `${company.name} raised ${round}`;
  if (latest.lead_investors.length) sentence += `, led by ${nameList(latest.lead_investors)}`;
  const when = monthYear(latest.announced_on);
  if (when) sentence += ` (${when})`;
  sentence += ".";
  if (sourceCount(latest) > 0) sentence += ` ${sourcesLabel(latest)}.`;
  const description = what ? `${sentence} ${withStop(what)}` : sentence;
  const headline = amount ? `${amount} ${roundLabel(latest)}` : `${roundLabel(latest)} round`;
  return { title: `${company.name}: ${headline}`, description: clip(description, MAX_DESCRIPTION), latest, counted };
}

export interface InvestorShare {
  title: string;
  description: string;
  latest: InvestorPage["rounds"][number] | null;
}

/** "Insight Partners led 3 rounds and joined 2 more on record, most recently Kastle's $24M Series A (Sep 2026). Mostly Series A, in fintech." */
export function investorShare(page: InvestorPage): InvestorShare {
  const { investor, rounds, totals, stages, sectors } = page;
  const latest = rounds[0] ?? null;
  if (!latest) {
    return { title: investor.name, description: `${investor.name} on ${SITE}: the rounds it led and joined, with their sources.`, latest };
  }
  const seats =
    totals.led && totals.participated
      ? `led ${plural(totals.led, "round")} and joined ${totals.participated} more`
      : totals.led
        ? `led ${plural(totals.led, "round")}`
        : `joined ${plural(totals.participated, "round")}`;
  const amount = amountLabel(latest);
  const when = monthYear(latest.announced_on);
  const recent = `${latest.company.name}'s ${amount ? `${amount} ` : ""}${roundLabel(latest)}${when ? ` (${when})` : ""}`;
  let text = `${investor.name} ${seats} on record, most recently ${recent}.`;
  const topStages = stages.slice(0, 2).map((s) => stageInSentence(stageLabel(s.stage)));
  const topSectors = sectors
    .filter((s) => s.sector !== "other")
    .slice(0, 2)
    .map((s) => inSentence(sectorLabel(s.sector)));
  if (rounds.length > 1 && (topStages.length || topSectors.length)) {
    const parts = [topStages.length ? `Mostly ${nameList(topStages)}` : "Mostly", topSectors.length ? `in ${nameList(topSectors)}` : ""];
    text += ` ${parts.filter(Boolean).join(", ")}.`;
  }
  const title = totals.led ? `${investor.name}: led ${plural(totals.led, "round")}` : `${investor.name}: ${plural(rounds.length, "round")}`;
  return { title, description: clip(text, MAX_DESCRIPTION), latest };
}

/** The root card, for index pages that set their own Open Graph text and so replace the root's images too. */
const ROOT_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Fireround: the open-source funding feed, built on Firecrawl",
};

/**
 * Description plus Open Graph and Twitter text for a page. A segment's `openGraph` replaces the
 * root's wholesale (siteName and type included), so they ride along here. `image: "root"` points at
 * the root card for a page with no card of its own; a page with a colocated opengraph-image leaves
 * `images` out so Next fills in its own.
 */
export function shareMetadata({
  title,
  description,
  image,
  canonical,
}: {
  title: string;
  description: string;
  image?: "root";
  /** The list page's own path: its filter, sort, and page variants all name this one address to a search engine. */
  canonical?: string;
}): Metadata {
  return {
    description,
    ...(canonical ? { alternates: { canonical: canonicalUrl(canonical) } } : {}),
    openGraph: {
      title,
      description,
      siteName: SITE,
      type: "website",
      ...(image === "root" ? { images: [ROOT_IMAGE] } : {}),
    },
    twitter: { card: "summary_large_image", title, description },
  };
}
