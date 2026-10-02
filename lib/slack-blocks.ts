// A round as a Slack message: the Block Kit payload an incoming webhook receives. Pure, so the
// landing page's preview and the subscription messages (slack-messages.ts) draw exactly what posts.

import { hostLabel, sectorLabel, stageOf, usd } from "./format.ts";
import { houseHeadline } from "./house.ts";
import { companyHref, webUrl } from "./links.ts";
import type { RoundRow } from "./persist.ts";
import { readAgainst } from "./source-count.ts";
import { capitalizeFirst } from "./text.ts";

export interface SlackText {
  type: "mrkdwn" | "plain_text";
  text: string;
}

export interface SlackButton {
  type: "button";
  text: { type: "plain_text"; text: string };
  url: string;
  action_id: string;
  style?: "primary";
}

export interface SlackImage {
  type: "image";
  image_url: string;
  alt_text: string;
}

/** The Block Kit subset a round message uses; the landing page's preview draws exactly these. */
export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text?: SlackText; fields?: SlackText[]; accessory?: SlackImage }
  | { type: "context"; elements: Array<SlackText | SlackImage> }
  | { type: "actions"; elements: SlackButton[] }
  | { type: "divider" };

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
  unfurl_links: boolean;
  unfurl_media: boolean;
}

/** Slack mrkdwn treats &, < and > as control characters; record text is escaped so a stray one cannot break a link. */
export function mrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A mrkdwn link. A URL that is not http(s) is left out (the label stands alone), and the three
 * characters that would end the link early are percent-encoded, so a crafted URL cannot splice text
 * or a second link into the message.
 */
export function link(url: string, label: string): string {
  const href = webUrl(url);
  if (!href) return mrkdwn(label);
  return `<${href.replace(/[<>|]/g, (c) => encodeURIComponent(c))}|${mrkdwn(label)}>`;
}

/** "Sep 22, 2026", with a tilde when the day is borrowed from a roundup or a monthly list. */
export function announcedLabel(r: RoundRow): string {
  if (!r.announced_on) return "Undated";
  const day = new Date(`${r.announced_on.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (r.date_precision === "month") {
    const month = new Date(`${r.announced_on.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return `~ ${month}`;
  }
  return r.date_precision === "day" ? day : `~ ${day}`;
}

/**
 * The company's logo as Slack can draw it: always our own /api/logo route, which answers a PNG tile
 * whatever the stored logo is (SVG, a slow host, none at all). Slack rejects a whole message when one
 * of its images cannot be downloaded, so a message never points at a third-party image.
 */
export function slackLogo(r: RoundRow, origin: string): SlackImage {
  return { type: "image", image_url: `${origin}/api/logo/${encodeURIComponent(r.company.id)}`, alt_text: `${r.company.name} logo` };
}

/** "A, B, C and 2 more": a syndicate that fits a field without hiding its size. */
export function nameList(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * The Verified mark's verdict (components/confidence.tsx) in a line. A corrected record reads as
 * verified: what posts is the corrected record, and the correction note stays on the round's page.
 */
function verdictLine(r: RoundRow): string {
  const status = r.verification?.status ?? "unverified";
  const n = r.sources.length;
  // A flagged row claims no verification, as on the feed; the count is the sources the message lists.
  if (r.disposition === "flagged") return `Developing · ${n} ${n === 1 ? "source" : "sources"}`;
  const reach = readAgainst(r);
  if (reach !== null) return `*Verified* against ${reach}`;
  if (status === "contradicted" || status === "not_news") return "*The sources contradict this record*";
  return `Developing · ${n} ${n === 1 ? "source" : "sources"}`;
}

/**
 * A round as one Slack message: the headline the feed strip uses, the company line, a grid of
 * the fields a reader scans (a field the record lacks is left out, never a placeholder), the
 * verdict with the pages behind it, and buttons to the company page and the primary source.
 * Unfurls are off: the sources are links to follow, not five article cards under every round.
 */
/**
 * The small brand line a round opens with: the logo inline at text size, then the company and its
 * site. Slack draws a section's image accessory as a large square beside the text, which leaves a
 * tall gap next to a one-line description; a context image sits in the line instead.
 */
export function brandLine(r: RoundRow, origin: string, rest?: string): SlackBlock {
  return { type: "context", elements: [slackLogo(r, origin), { type: "mrkdwn", text: rest ?? `*${mrkdwn(r.company.name)}*` }] };
}

export function slackBlocks(r: RoundRow, origin: string): SlackMessage {
  const amount = usd(r.amount.usd_millions) || r.amount.as_written || "";
  const stage = stageOf(r);
  const { lead, figure, rest, by } = houseHeadline({ name: r.company.name, amount, stage, leads: r.lead_investors });
  const headline = `${r.certainty === "expected" ? "Expected: " : ""}${lead}${figure ?? ""}${rest}`;
  const domain = r.company.domain ?? r.company.website?.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/?#].*$/, "");
  const site = r.company.website && domain ? link(r.company.website, domain) : null;
  const about = r.company.description ? mrkdwn(capitalizeFirst(r.company.description)) : null;
  const field = (label: string, value: string): SlackText => ({ type: "mrkdwn", text: `*${label}*\n${mrkdwn(value)}` });
  const fields = [
    field("Amount", amount || "Not stated"),
    field("Stage", stage),
    field(r.lead_investors.length > 1 ? "Leads" : "Lead", r.lead_investors.length ? nameList(r.lead_investors) : "Not stated"),
    field(r.certainty === "expected" ? "Reported" : "Announced", announcedLabel(r)),
    // "Other" names nothing; like any field the record lacks, it is left out.
    ...(r.company.sector && r.company.sector !== "other" ? [field("Sector", sectorLabel(r.company.sector))] : []),
    ...(r.other_investors.length ? [field("Also in", nameList(r.other_investors))] : []),
    ...(r.valuation_as_written ? [field("Valuation", r.valuation_as_written)] : []),
  ];
  const shown = r.sources.slice(0, 3).map((s) => link(s.url, hostLabel(s.host)));
  const more = r.sources.length - shown.length;
  const sources = shown.length ? `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : null;
  // Slack refuses a whole message over one button URL past 3,000 characters, so a very long source link loses its button.
  const primary = [r.verification?.url, r.sources[0]?.url].find((u): u is string => !!u && u.length <= 3000) ?? null;
  const buttons: SlackButton[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Open round" },
      url: `${origin}${companyHref(r.company.id)}`,
      action_id: "open_round",
      style: "primary",
    },
    ...(primary
      ? [
          {
            type: "button" as const,
            text: { type: "plain_text" as const, text: "Read the source" },
            url: primary,
            action_id: "open_source",
          },
        ]
      : []),
  ];
  return {
    text: `${headline}${by}`,
    blocks: [
      brandLine(r, origin, [`*${mrkdwn(r.company.name)}*`, site].filter(Boolean).join(" · ")),
      { type: "header", text: { type: "plain_text", text: headline.slice(0, 150) } },
      ...(about ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: about } }] : []),
      { type: "section", fields },
      { type: "context", elements: [{ type: "mrkdwn", text: [verdictLine(r), sources].filter(Boolean).join(" · ") }] },
      { type: "actions", elements: buttons },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
