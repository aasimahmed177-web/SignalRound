// The messages a public subscription receives, beyond the round card itself (slackBlocks in
// slack-blocks.ts): the welcome after install, the "and N more" note that closes a burst, the daily
// digest, and the test. Pure builders over RoundRow, so the landing page and the tests draw
// exactly what a channel gets. Every one ends with the same footer: Fireround, Manage, Unsubscribe, Privacy.

import { sectorLabel, stageOf, usd } from "./format.ts";
import { houseHeadline } from "./house.ts";
import { companyHref } from "./links.ts";
import type { RoundRow } from "./persist.ts";
import type { SlackBlock, SlackButton, SlackMessage } from "./slack-blocks.ts";
import { announcedLabel, brandLine, link, mrkdwn, slackBlocks } from "./slack-blocks.ts";
import type { Cadence } from "./slack-subscriptions.ts";
import { ALL_PRESETS, channelLabel, manageUrl, unsubscribeUrl } from "./slack-subscriptions.ts";

/** Cards a burst posts before the rest collapse into one "and N more" note. */
export const BURST_CARDS = 5;

/** The hour (UTC) the daily digest goes out. */
export const DIGEST_HOUR_UTC = 7;

/** Rounds the digest lists by amount, and trending rounds it adds. */
export const DIGEST_TOP = 5;
export const DIGEST_TRENDING = 3;

/** What a message needs to know about the subscription it is for. */
export interface MessageScope {
  origin: string;
  /** The manage token: every message links to the manage page and its unsubscribe step. */
  token: string;
  presetSlug: string;
  presetName: string;
}

/** The feed on this instance, narrowed to the subscription's preset. */
export function feedUrl(origin: string, presetSlug: string): string {
  return presetSlug === ALL_PRESETS ? `${origin}/feed` : `${origin}/feed?preset=${encodeURIComponent(presetSlug)}`;
}

/** The context line under every message: the product, the manage page, unsubscribe, and the privacy page. */
export function footerBlock(scope: Pick<MessageScope, "origin" | "token">): SlackBlock {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: [
          link(scope.origin, "Fireround"),
          link(manageUrl(scope.origin, scope.token), "Manage"),
          link(unsubscribeUrl(scope.origin, scope.token), "Unsubscribe"),
          link(`${scope.origin}/privacy`, "Privacy"),
        ].join(" · "),
      },
    ],
  };
}

function withFooter(message: SlackMessage, scope: MessageScope): SlackMessage {
  return { ...message, blocks: [...message.blocks, footerBlock(scope)] };
}

/** One round, the full card, with the subscription's footer under its buttons. */
export function roundCard(r: RoundRow, scope: MessageScope): SlackMessage {
  return withFooter(slackBlocks(r, scope.origin), scope);
}

/** "Acme raised a $20M Series A": the card's headline, for compact lines. */
function headline(r: RoundRow): { text: string; by: string } {
  const amount = usd(r.amount.usd_millions) || r.amount.as_written || "";
  const { lead, figure, rest, by } = houseHeadline({ name: r.company.name, amount, stage: stageOf(r), leads: r.lead_investors });
  return { text: `${r.certainty === "expected" ? "Expected: " : ""}${lead}${figure ?? ""}${rest}`, by };
}

/**
 * A round in one short section: the headline linked to its page on Fireround, then the sector,
 * the leads, and the day. The compact form the welcome and the digest list rounds in.
 */
export function compactRound(r: RoundRow, origin: string): SlackBlock {
  const { text } = headline(r);
  const leads = r.lead_investors.length ? `led by ${mrkdwn(r.lead_investors.slice(0, 2).join(" and "))}` : null;
  const detail = [
    r.company.sector && r.company.sector !== "other" ? sectorLabel(r.company.sector) : null,
    leads,
    r.announced_on ? announcedLabel(r) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // A row: the logo inline, the headline linked, the detail under it. A section's image accessory
  // would draw a large square beside every round and make the list three times as tall.
  return brandLine(r, origin, `*${link(`${origin}${companyHref(r.company.id)}`, text)}*${detail ? `\n${detail}` : ""}`);
}

function button(text: string, url: string, action: string, primary = false): SlackButton {
  return { type: "button", text: { type: "plain_text", text }, url, action_id: action, ...(primary ? { style: "primary" as const } : {}) };
}

/** What the channel receives, in words: "each funding round we find" or "each round we find that matches Seed and pre-seed". */
export function scopeWords(presetSlug: string, presetName: string): string {
  return presetSlug === ALL_PRESETS ? "each funding round we find" : `each round we find that matches ${presetName}`;
}

export function cadenceWords(cadence: Cadence): string {
  return cadence === "daily"
    ? `one digest each morning at ${String(DIGEST_HOUR_UTC).padStart(2, "0")}:00 UTC`
    : "each round as it is found";
}

/**
 * The first message after install: where it is connected, what will arrive and how often, today's
 * trending rounds (or the newest, on a day nothing trends) as compact cards, and the manage link.
 */
export function welcomeMessage(
  input: { channel: string | null; cadence: Cadence; trending: RoundRow[]; latest?: RoundRow[] },
  scope: MessageScope,
): SlackMessage {
  const channel = channelLabel(input.channel);
  const picks = input.trending.length ? input.trending.slice(0, 3) : (input.latest ?? []).slice(0, 3);
  const title = input.trending.length ? "*Trending on Fireround today*" : "*The newest rounds on Fireround*";
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Fireround is connected to ${channel}`.slice(0, 150) } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `This channel gets *${mrkdwn(scopeWords(scope.presetSlug, scope.presetName))}*, ${cadenceWords(input.cadence)}. Each post shows the amount, the lead investor, and links to the articles that reported it.`,
      },
    },
    ...(picks.length ? [{ type: "divider" as const }, { type: "section" as const, text: { type: "mrkdwn" as const, text: title } }] : []),
    ...picks.map((r) => compactRound(r, scope.origin)),
    {
      type: "actions",
      elements: [
        button("Open Fireround", feedUrl(scope.origin, scope.presetSlug), "open_feed", true),
        button("Manage this channel", manageUrl(scope.origin, scope.token), "manage"),
      ],
    },
  ];
  return withFooter({ text: `Fireround is connected to ${channel}`, blocks, unfurl_links: false, unfurl_media: false }, scope);
}

/** The note that closes a burst: the rounds past the first few, counted, with the way to see them. */
export function moreMessage(n: number, scope: MessageScope): SlackMessage {
  const words = `And ${n} more new ${n === 1 ? "round" : "rounds"} on Fireround`;
  return withFooter(
    {
      text: words,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${words}.*` } },
        { type: "actions", elements: [button("See them on Fireround", feedUrl(scope.origin, scope.presetSlug), "open_feed", true)] },
      ],
      unfurl_links: false,
      unfurl_media: false,
    },
    scope,
  );
}

/** "Wed 23 Sep", the house's day heading. Built from parts: en-GB's short September is "Sept". */
function dayLabel(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

export interface DigestInput {
  /** The window's rounds, any order; the digest ranks them. */
  rounds: RoundRow[];
  /** Trending rounds, best first. */
  trending: RoundRow[];
  now: Date;
}

/**
 * One morning's digest: the count and the total, the largest rounds by amount, then what is
 * trending (skipping any already listed), and the way to the feed. Null when there is nothing to
 * say, so a quiet day posts nothing.
 */
export function digestMessage(input: DigestInput, scope: MessageScope): SlackMessage | null {
  if (input.rounds.length === 0 && input.trending.length === 0) return null;
  const top = [...input.rounds]
    .sort((a, b) => (b.amount.usd_millions ?? -1) - (a.amount.usd_millions ?? -1) || b.first_seen_at.localeCompare(a.first_seen_at))
    .slice(0, DIGEST_TOP);
  const listed = new Set(top.map((r) => r.id));
  const trending = input.trending.filter((r) => !listed.has(r.id)).slice(0, DIGEST_TRENDING);
  const total = input.rounds.reduce((sum, r) => sum + (r.amount.usd_millions ?? 0), 0);
  const n = input.rounds.length;
  const scopeNote = scope.presetSlug === ALL_PRESETS ? "" : ` in ${mrkdwn(scope.presetName)}`;
  // The window is when Fireround found a round, not when it was announced: a June round read today is
  // "newly found", never "new" (the pre-launch audit's digest led with a June 5 round under "new").
  const summary =
    n === 0
      ? `No rounds newly found${scopeNote} in the last day. Here is what is trending.`
      : `*${n} ${n === 1 ? "round" : "rounds"} newly found*${scopeNote} in the last day${total > 0 ? `, *${usd(total)}* in total` : ""}.`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Fireround daily · ${dayLabel(input.now)}` } },
    { type: "section", text: { type: "mrkdwn", text: summary } },
    ...(top.length
      ? [
          { type: "section" as const, text: { type: "mrkdwn" as const, text: "*Largest rounds*" } },
          ...top.map((r) => compactRound(r, scope.origin)),
        ]
      : []),
    ...(trending.length
      ? [
          { type: "divider" as const },
          { type: "section" as const, text: { type: "mrkdwn" as const, text: "*Trending*" } },
          ...trending.map((r) => compactRound(r, scope.origin)),
        ]
      : []),
    {
      type: "actions",
      elements: [
        button(n > top.length ? `See all ${n} on Fireround` : "Open Fireround", feedUrl(scope.origin, scope.presetSlug), "open_feed", true),
      ],
    },
  ];
  return withFooter(
    {
      text: n ? `Fireround daily: ${n} ${n === 1 ? "round" : "rounds"} newly found` : "Fireround daily",
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    },
    scope,
  );
}

/** A test from the manage page: the newest round as a real card, marked as a test. */
export function testMessage(r: RoundRow | null, scope: MessageScope): SlackMessage {
  const note: SlackBlock = {
    type: "context",
    elements: [{ type: "mrkdwn", text: "A test from this channel's manage page. New rounds arrive like this." }],
  };
  if (!r) {
    return withFooter(
      {
        text: "Fireround test",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Fireround is connected.* No round to show yet; the first one posts here." } },
          note,
        ],
        unfurl_links: false,
        unfurl_media: false,
      },
      scope,
    );
  }
  const card = slackBlocks(r, scope.origin);
  return withFooter({ ...card, text: `Test: ${card.text}`, blocks: [note, ...card.blocks] }, scope);
}
