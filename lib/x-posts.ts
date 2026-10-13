// Significant rounds on X. Off unless X_POSTING says otherwise. The lane rides the deliveries cron
// (hourly) and the deliveries outbox: one row per round on channel "x", so a round is posted at most
// once, a merge carries the row to the survivor (lib/persist.ts), and the post's id and the facts it
// stated stay on the row. Each run first takes down posts whose round has since been rejected, merged
// into one already posted, or corrected on its company, stage, or figure, then posts at most one
// round, no sooner than 24h / X_MAX_POSTS_PER_DAY after the last. dry_run does all of it without
// calling X: it writes what it would post or delete to the log, the row (status previewed), and the
// Slack delivery target X_REVIEW_SLACK_TARGET names, if any. live posts through the X API v2 with
// OAuth 1.0a user context, signed here (HMAC-SHA1, RFC 5849).

import { createHmac, randomBytes } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, gt, inArray, or } from "drizzle-orm";
import { newsBlocks } from "./deliverable.ts";
import { stageOf, usd } from "./format.ts";
import { companyHref } from "./links.ts";
import { BACKOFF_MINUTES, type DeliveryRow } from "./outbox.ts";
import type { RoundRow } from "./persist.ts";
import { listRounds } from "./persist.ts";
import { mrkdwn } from "./slack-blocks.ts";
import { decryptWebhook, slackWebhookKey } from "./slack-credentials.ts";
import { postToSlack } from "./slack-delivery.ts";
import { trendingRoundIds } from "./trending.ts";

const { deliveries, deliveryTargets, fundingRounds, companies } = schema;

type DeliverySnapshot = schema.DeliverySnapshot;

export const X_API = "https://api.x.com/2/tweets";
const X_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The outbox target every X row is filed under; a merge files the duplicate's post under "x:<its id>". */
export const X_TARGET = "x";

/** X counts every link as 23 characters, whatever its length. */
export const X_LINK_LENGTH = 23;
export const X_MAX_LENGTH = 280;

/** Only a round announced today or in the two days before is posted: X is for news, not a backlog. */
export const X_FRESH_DAYS = 2;

/** How far back a post is watched for a correction. */
const CORRECTION_WINDOW_DAYS = 30;

export type XMode = "off" | "dry_run" | "live";

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XConfig {
  mode: XMode;
  /** A round at or above this many USD millions qualifies (X_MIN_USD_MILLIONS, 50). */
  minUsdMillions: number;
  /** A round this high in Trending or higher qualifies whatever its amount (X_TRENDING_TOP, 5; 0 turns the rule off). */
  trendingTop: number;
  maxPerDay: number;
  credentials: XCredentials | null;
  /** A Slack delivery target, by its label as Settings shows it or its id: dry runs are posted there for review. */
  reviewTarget: string | null;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function xConfig(env: Record<string, string | undefined> = process.env): XConfig {
  const raw = env.X_POSTING?.trim().toLowerCase();
  const mode: XMode = raw === "live" || raw === "dry_run" ? raw : "off";
  const { X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = env;
  return {
    mode,
    minUsdMillions: positive(env.X_MIN_USD_MILLIONS, 50),
    trendingTop: env.X_TRENDING_TOP?.trim() === "0" ? 0 : Math.floor(positive(env.X_TRENDING_TOP, 5)),
    maxPerDay: Math.floor(positive(env.X_MAX_POSTS_PER_DAY, 6)),
    credentials:
      X_CONSUMER_KEY && X_CONSUMER_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET
        ? {
            consumerKey: X_CONSUMER_KEY,
            consumerSecret: X_CONSUMER_SECRET,
            accessToken: X_ACCESS_TOKEN,
            accessTokenSecret: X_ACCESS_TOKEN_SECRET,
          }
        : null,
    reviewTarget: env.X_REVIEW_SLACK_TARGET?.trim() || null,
  };
}

// OAuth 1.0a.

/** RFC 3986 percent-encoding, as OAuth 1.0a signs it: encodeURIComponent plus ! ' ( ) *. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The HMAC-SHA1 signature over the method, the URL without its query, and every parameter (the
 * query's, a form body's, and the oauth_ ones) sorted by encoded key and value. A JSON body is not signed.
 */
export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const u = new URL(url);
  const all: Array<[string, string]> = [...u.searchParams.entries(), ...Object.entries(params)].map(([k, v]) => [
    percentEncode(k),
    percentEncode(v),
  ]);
  all.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  const base = [
    method.toUpperCase(),
    percentEncode(`${u.origin}${u.pathname}`),
    percentEncode(all.map(([k, v]) => `${k}=${v}`).join("&")),
  ].join("&");
  return createHmac("sha1", `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`)
    .update(base)
    .digest("base64");
}

/** The Authorization header for one request. `form` is a form-encoded body's fields (signed); a JSON body has none. */
export function oauthHeader(
  method: string,
  url: string,
  creds: XCredentials,
  opts: { nonce?: string; timestamp?: number; form?: Record<string, string> } = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(24).toString("base64").replace(/\W/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(method, url, { ...oauth, ...opts.form }, creds.consumerSecret, creds.accessTokenSecret);
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k] as string)}"`)
    .join(", ")}`;
}

// The post.

/** A name or a description as it may appear in a post: no @ (no one is tagged), no # (no hashtags), no $TICKER. */
function clean(text: string): string {
  return text
    .replace(/[@#＠＃]/g, "")
    .replace(/\$(?=[A-Za-z])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A legal form at the end of a name, with the comma before it: "NexBank Capital, Inc." reads "NexBank Capital". */
const LEGAL_SUFFIX = [
  /,?\s+(?:inc\.?|corp\.?|corporation|ltd\.?|limited|llc|plc)$/i,
  /,?\s+(?:PBC|GmbH|AG|SA|S\.A\.|SAS|B\.V\.|Co\.|AB|Oy|Oyj|ApS|A\/S|AS|N\.V\.|NV|S\.p\.A\.|SpA|Pty|KK|SE|Sàrl)$/u,
];

/** A name without its trailing legal forms ("Acme Co., Ltd." reads "Acme"); never emptied. */
export function withoutLegalSuffix(name: string): string {
  let out = name.trim();
  for (let again = true; again; ) {
    again = false;
    for (const suffix of LEGAL_SUFFIX) {
      const next = out.replace(suffix, "").replace(/[,\s]+$/, "");
      if (next && next !== out) {
        out = next;
        again = true;
      }
    }
  }
  return out;
}

/**
 * What follows a comma in a lead's name when it describes the lead rather than naming a second one:
 * a possessive ("Mundi Ventures' European scale-up fund"), an article or connective ("the Export and
 * Investment Fund of Denmark", "through its impact fund", "or Labcorp"), or any lowercase start.
 */
const DESCRIPTOR = [/^(?:the|a|an|its|their|through|via|or|which|who|part of)\b/i, /^\p{Ll}/u, /\p{L}[’'](?:s\b|\s)/u];

/** A lead as one investor: its descriptor clause cut ("Kembara, Mundi Ventures' European scale-up fund" reads "Kembara"), no legal form. */
export function leadName(name: string): string {
  const cleaned = clean(name);
  const comma = cleaned.indexOf(",");
  const head = comma > 0 && DESCRIPTOR.some((d) => d.test(cleaned.slice(comma + 1).trim())) ? cleaned.slice(0, comma) : cleaned;
  return withoutLegalSuffix(head);
}

/** Whether a company's page URL is fit to post: no merge-guard id ("acme:identity:news.example") and no spaces. */
export function cleanCompanyUrl(companyId: string): boolean {
  return !/:identity:|\s/.test(companyId);
}

/** X's weighted length: links count 23, most scripts 1 a character, CJK and emoji 2. */
export function xLength(text: string): number {
  let n = 0;
  for (const part of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) {
      n += X_LINK_LENGTH;
      continue;
    }
    for (const ch of part) {
      const c = ch.codePointAt(0) ?? 0;
      n += c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037) ? 1 : 2;
    }
  }
  return n;
}

const STAGE_PHRASE: Record<string, string> = {
  pre_seed: "pre-seed round",
  seed: "seed round",
  pre_a: "pre-Series A round",
  growth: "growth round",
  bridge: "bridge round",
  debt: "debt round",
  grant: "grant",
  convertible: "convertible round",
  secondary: "secondary round",
  undisclosed: "round",
  other: "round",
};

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** Words an amount as written puts before its figure; the post keeps them ("up to $4B"). */
const QUALIFIER = /^\s*(up to|nearly|almost|around|about|approximately|roughly|over|more than|at least|close to)\b/i;

/** Self-description that is a claim, not a fact. */
const HYPE =
  /\b(leader|leading|world'?s|first|best|pioneer\w*|revolution\w*|innovative|cutting[- ]edge|premier|top|unicorn|disrupt\w*|game[- ]chang\w*|breakthrough)\b/i;

export type FactsInput = Pick<RoundRow, "stage" | "stage_as_written" | "amount"> & { company: { name: string } };

/** What a post states, and what a later correction is judged on: the company, the stage, and the figure. */
export function postFacts(r: FactsInput): DeliverySnapshot["facts"] {
  const stage = stageOf(r);
  const symbol = r.amount.currency ? CURRENCY_SYMBOL[r.amount.currency] : undefined;
  const converted = !symbol && !!r.amount.currency && r.amount.usd_millions !== null;
  const millions = symbol ? (r.amount.value ?? r.amount.usd_millions) : r.amount.usd_millions;
  const billions = (millions ?? 0) / 1000;
  const dollars =
    millions !== null && millions >= 1000 && millions < 10_000 && billions.toFixed(2) !== `${billions.toFixed(1)}0`
      ? `$${billions.toFixed(2)}B`
      : usd(converted && millions !== null ? Math.round(millions) : millions);
  const figure = symbol ? dollars.replace("$", symbol) : dollars;
  const qualifier = figure
    ? (QUALIFIER.exec(r.amount.as_written ?? "")?.[1]?.toLowerCase() ?? (converted ? "about" : undefined))
    : undefined;
  return {
    company: withoutLegalSuffix(clean(r.company.name)),
    stage: r.stage === "series_d_plus" && stage === "Series D+" ? "late-stage round" : (STAGE_PHRASE[r.stage] ?? stage),
    amount: qualifier ? `${qualifier} ${figure}` : figure,
  };
}

/** The company's own line, when it is short, plain, and its homepage passed the identity check. */
export function oneLiner(r: Pick<RoundRow, "company" | "enrichment">): string | null {
  if (!r.enrichment?.verified || !r.company.description) return null;
  const d = clean(r.company.description)
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/[.\s]+$/, "");
  if (!d || d.length > 60 || /[.!?;:]\s/.test(d) || HYPE.test(d)) return null;
  return `${d.charAt(0).toUpperCase()}${d.slice(1)}.`;
}

function article(phrase: string): string {
  return /^([aeiou]|[$€£](8|11(?!\d)|18(?!\d)))/i.test(phrase) ? "an" : "a";
}

/** The second word of a firm named for its founder ("Khosla Ventures"). */
const FIRM_WORD = /^(?:ventures|capital|partners|fund|group|investments|holdings)$/;

/**
 * "Spiko raised a $90M Series B led by New Enterprise Associates. Tokenized cash funds.\n<company page>".
 * Two leads at most, then "and others"; a lead another lead already names ("Patrick Soon-Shiong" beside
 * "Patrick Soon-Shiong's NantWorks", "Vinod Khosla" beside "Khosla Ventures") is said once. The
 * company's line only when oneLiner allows it. A post that would run past 280 drops the line, then the leads.
 */
export function postText(r: RoundRow, origin: string): string {
  const { company, stage, amount } = postFacts(r);
  const names = r.lead_investors.map(leadName).filter(Boolean);
  const leads = names.filter((name) => {
    const words = name.toLowerCase().split(" ");
    const within = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`,
      "u",
    );
    return !names.some((other) => {
      const theirs = other.toLowerCase();
      if (theirs === name.toLowerCase()) return false;
      if (within.test(theirs)) return true;
      const [first, firm, ...rest] = theirs.split(" ");
      return words.length === 2 && rest.length === 0 && first === words[1] && FIRM_WORD.test(firm ?? "");
    });
  });
  const link = `${origin}${companyHref(r.company.id)}`;
  const about = oneLiner(r);
  const sentence = (shown: number) => {
    const named = leads.slice(0, shown);
    const led =
      named.length === 0
        ? ""
        : leads.length === 1
          ? ` led by ${named[0]}`
          : leads.length === 2 && shown === 2
            ? ` led by ${named[0]} and ${named[1]}`
            : ` led by ${named.join(", ")} and others`;
    const raised = !amount
      ? `${article(stage)} ${stage}`
      : QUALIFIER.test(amount)
        ? `${amount} in ${article(stage)} ${stage}`
        : `${article(amount)} ${amount} ${stage}`;
    return `${company} raised ${raised}${led}`.replace(/\.+$/, "");
  };
  const variants = [
    [sentence(2), about],
    [sentence(2), null],
    [sentence(1), null],
    [sentence(0), null],
  ].map(([s, line]) => `${s}.${line ? ` ${line}` : ""}\n${link}`);
  return variants.find((t) => xLength(t) <= X_MAX_LENGTH) ?? (variants.at(-1) as string);
}

// Which round goes next.

type Thresholds = Pick<XConfig, "minUsdMillions" | "trendingTop">;

/** Which significance rules a round meets: its amount, its Trending rank, both, or neither. */
export function xRules(r: Pick<RoundRow, "amount">, cfg: Thresholds, trendingRank: number | null): Array<"amount" | "trending"> {
  const rules: Array<"amount" | "trending"> = [];
  if ((r.amount.usd_millions ?? 0) >= cfg.minUsdMillions) rules.push("amount");
  if (trendingRank !== null && trendingRank <= cfg.trendingTop) rules.push("trending");
  return rules;
}

/** Why this round is not one for X (beyond the news rule every channel shares), or null when it may go. */
export function xRefusal(r: RoundRow, cfg: Thresholds, trendingRank: number | null, now: Date): string | null {
  if (r.history) return "history round";
  if (r.certainty !== "announced") return `${r.certainty}, not announced`;
  if (r.disposition !== "publish") return r.disposition;
  if (r.verification?.status !== "confirmed" && r.verification?.status !== "corrected")
    return `read-back ${r.verification?.status ?? "pending"}`;
  if (r.lead_investors.length === 0 && r.amount.usd_millions === null && !r.amount.as_written) return "no lead investor and no amount";
  if (xRules(r, cfg, trendingRank).length === 0) return `under $${cfg.minUsdMillions}M and not in Trending's top ${cfg.trendingTop}`;
  if (!r.announced_on || r.announced_on < freshSince(now)) return `announced ${r.announced_on ?? "undated"}: not fresh`;
  if (!cleanCompanyUrl(r.company.id)) return UNCLEAN_URL;
  return null;
}

/** Until company URLs are clean everywhere, a round whose page URL would carry an internal id waits. */
export const UNCLEAN_URL = "unclean company url";

/** The earliest announced day X takes, YYYY-MM-DD. */
export function freshSince(now: Date): string {
  return new Date(now.getTime() - X_FRESH_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** The least time between two posts: the day's cap spread through the day. */
export function spacingMs(maxPerDay: number): number {
  return DAY_MS / maxPerDay;
}

/** Statuses that mean a round has had its turn in this mode and never goes again. */
function taken(row: DeliveryRow, mode: XMode): boolean {
  return mode === "dry_run" || (row.status !== "previewed" && row.status !== "failed");
}

/**
 * The next round to post from `eligible` (best first), or why nothing goes this run: a failed post
 * still backing off, the day's cap, or the spacing since the last post in this mode.
 */
export function nextPost<T extends Pick<RoundRow, "id">>(
  eligible: T[],
  ledger: DeliveryRow[],
  cfg: Pick<XConfig, "mode" | "maxPerDay">,
  now: Date,
): { round: T } | { wait: string } {
  if (cfg.mode === "live") {
    const backing = ledger.find((d) => d.status === "failed" && d.nextAttemptAt > now);
    if (backing) return { wait: `backing off until ${backing.nextAttemptAt.toISOString()} (${backing.lastError ?? "failed"})` };
  }
  const posted = ledger
    .map((d) => d.snapshot)
    .filter((s): s is DeliverySnapshot => s?.mode === cfg.mode)
    .map((s) => new Date(s.at).getTime());
  if (posted.filter((t) => t > now.getTime() - DAY_MS).length >= cfg.maxPerDay)
    return { wait: `${cfg.maxPerDay} posts in the last 24 hours` };
  const last = Math.max(0, ...posted);
  const next = last + spacingMs(cfg.maxPerDay);
  if (next > now.getTime()) return { wait: `next post no sooner than ${new Date(next).toISOString()}` };
  const done = new Set(ledger.filter((d) => taken(d, cfg.mode)).map((d) => d.roundId));
  const round = eligible.find((r) => !done.has(r.id));
  return round ? { round } : { wait: "no eligible round" };
}

/** The best first: Trending's top rounds by rank, then the largest, then the newest. */
export function byPriority(rows: Array<RoundRow & { trendingRank: number | null }>): Array<RoundRow & { trendingRank: number | null }> {
  return [...rows].sort(
    (a, b) =>
      (a.trendingRank ?? Number.POSITIVE_INFINITY) - (b.trendingRank ?? Number.POSITIVE_INFINITY) ||
      (b.amount.usd_millions ?? 0) - (a.amount.usd_millions ?? 0) ||
      (b.announced_on ?? "").localeCompare(a.announced_on ?? ""),
  );
}

/** The rounds X may take now, best first: fresh, significant, published, and deliverable under the news rule. */
export async function xCandidates(
  handle: Db,
  cfg: Thresholds,
  now: Date,
  log: (line: string) => void = () => {},
): Promise<Array<RoundRow & { trendingRank: number | null }>> {
  const top = cfg.trendingTop > 0 ? await trendingRoundIds(handle, now, cfg.trendingTop) : [];
  const since = freshSince(now);
  const [large, trending] = await Promise.all([
    listRounds(handle, {
      since,
      certainty: "announced",
      history: "exclude",
      minUsdMillions: cfg.minUsdMillions,
      sort: "amount",
      limit: 200,
    }),
    top.length ? listRounds(handle, { ids: top, limit: top.length, history: "exclude" }) : { rows: [] },
  ]);
  const byId = new Map([...large.rows, ...trending.rows].map((r) => [r.id, r]));
  const rows = [...byId.values()].map((r) => ({ ...r, trendingRank: top.includes(r.id) ? top.indexOf(r.id) + 1 : null }));
  const blocks = await newsBlocks(handle, rows, now);
  return byPriority(
    rows.filter((r) => {
      if (blocks.has(r.id)) return false;
      const refusal = xRefusal(r, cfg, r.trendingRank, now);
      if (refusal === UNCLEAN_URL) log(`x: skipped (unclean company url): ${r.id} (${companyHref(r.company.id)})`);
      return refusal === null;
    }),
  );
}

// Corrections.

export interface CurrentFacts {
  disposition: string;
  facts: DeliverySnapshot["facts"];
}

/**
 * Why a post must come down, or null: its round was rejected, it duplicates an earlier post of the
 * same round (both copies were posted before a merge), or its company, stage, or figure changed.
 */
export function correctionReason(row: DeliveryRow, current: CurrentFacts | undefined, firstPostId: string | null): string | null {
  const said = row.snapshot?.facts;
  if (!said) return null;
  if (!current) return "round deleted";
  if (current.disposition === "rejected") return "round rejected";
  if (firstPostId && row.externalId && row.externalId !== firstPostId) return `duplicate of post ${firstPostId} after a merge`;
  const changed = (["company", "stage", "amount"] as const)
    .filter((k) => said[k].toLowerCase() !== current.facts[k].toLowerCase())
    .map((k) => `${k} changed from "${said[k]}" to "${current.facts[k]}"`);
  return changed.length ? changed.join("; ") : null;
}

async function currentFacts(handle: Db, ids: string[]): Promise<Map<string, CurrentFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await handle
    .select({
      id: fundingRounds.id,
      disposition: fundingRounds.disposition,
      stage: fundingRounds.stage,
      stageAsWritten: fundingRounds.stageAsWritten,
      value: fundingRounds.amountValue,
      currency: fundingRounds.amountCurrency,
      asWritten: fundingRounds.amountAsWritten,
      usdMillions: fundingRounds.amountUsdMillions,
      name: companies.name,
    })
    .from(fundingRounds)
    .innerJoin(companies, eq(companies.id, fundingRounds.companyId))
    .where(inArray(fundingRounds.id, ids));
  const num = (v: string | null) => (v === null ? null : Number(v));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        disposition: r.disposition,
        facts: postFacts({
          company: { name: r.name },
          stage: r.stage,
          stage_as_written: r.stageAsWritten,
          amount: { value: num(r.value), currency: r.currency, as_written: r.asWritten, usd_millions: num(r.usdMillions) },
        }),
      },
    ]),
  );
}

// The run.

export interface XRunSummary {
  mode: XMode;
  posted: Array<{ round: string; text: string; postId: string | null }>;
  retracted: Array<{ round: string; reason: string; postId: string | null }>;
  waiting: string | null;
  error: string | null;
}

export interface XRunOpts {
  cfg?: XConfig;
  fetchImpl?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}

function rowKey(roundId: string, target: string) {
  return and(eq(deliveries.roundId, roundId), eq(deliveries.channel, "x"), eq(deliveries.target, target));
}

async function xError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `X ${res.status}: ${body.slice(0, 200)}`;
}

/** The review channel for dry runs: a Slack delivery target, by label or id. Best effort; a failure is logged, never thrown. */
async function review(handle: Db, cfg: XConfig, text: string, fetchImpl: typeof fetch, log: (line: string) => void): Promise<void> {
  if (!cfg.reviewTarget) return;
  const [t] = await handle
    .select({ target: deliveryTargets.target })
    .from(deliveryTargets)
    .where(
      and(eq(deliveryTargets.channel, "slack"), or(eq(deliveryTargets.id, cfg.reviewTarget), eq(deliveryTargets.label, cfg.reviewTarget))),
    )
    .limit(1);
  const key = slackWebhookKey();
  const url = t && key ? decryptWebhook(t.target, key) : null;
  if (!url) {
    log(`x: review target ${cfg.reviewTarget} is not a readable Slack target`);
    return;
  }
  const outcome = await postToSlack(
    url,
    { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: mrkdwn(text) } }], unfurl_links: false, unfurl_media: false },
    fetchImpl,
  );
  if (!outcome.ok) log(`x: review post failed (${outcome.code})`);
}

/** One run of the X lane: corrections first, then at most one post. Off does nothing and reads nothing. */
export async function runXPosts(handle: Db, origin: string, opts: XRunOpts = {}): Promise<XRunSummary> {
  const cfg = opts.cfg ?? xConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line: string) => console.log(line));
  const summary: XRunSummary = { mode: cfg.mode, posted: [], retracted: [], waiting: null, error: null };
  if (cfg.mode === "off") return summary;
  const creds = cfg.credentials;
  if (cfg.mode === "live" && !creds) {
    summary.error = "X_POSTING is live but X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, or X_ACCESS_TOKEN_SECRET is missing";
    log(`x: ${summary.error}`);
    return summary;
  }
  const live = cfg.mode === "live" && creds ? creds : null;

  const ledger = await handle
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.channel, "x"), gt(deliveries.createdAt, new Date(now.getTime() - CORRECTION_WINDOW_DAYS * DAY_MS))));

  // Corrections: real posts in either mode (only live deletes them), and in a dry run its own previews.
  const watched = ledger.filter((d) => (d.status === "sent" && d.externalId) || (cfg.mode === "dry_run" && d.status === "previewed"));
  const facts = await currentFacts(handle, [...new Set(watched.map((d) => d.roundId))]);
  for (const d of watched) {
    const firstPost =
      ledger
        .filter((o) => o.roundId === d.roundId && o.externalId && (o.status === "sent" || o.status === "retracted") && o.snapshot)
        .sort((a, b) => (a.snapshot?.at ?? "").localeCompare(b.snapshot?.at ?? ""))[0]?.externalId ?? null;
    const reason = correctionReason(d, facts.get(d.roundId), firstPost);
    if (!reason) continue;
    if (!d.externalId || !live) {
      log(
        `x: would delete ${d.externalId ? `post ${d.externalId}` : "preview"} for ${d.roundId} (${reason}): ${JSON.stringify(d.snapshot?.text)}`,
      );
      if (cfg.mode === "dry_run") await review(handle, cfg, `Would delete from X (${reason}):\n${d.snapshot?.text ?? ""}`, fetchImpl, log);
      if (!d.externalId) {
        await handle.update(deliveries).set({ status: "retracted", lastError: reason, updatedAt: now }).where(rowKey(d.roundId, d.target));
        summary.retracted.push({ round: d.roundId, reason, postId: null });
      }
      continue;
    }
    const url = `${X_API}/${encodeURIComponent(d.externalId)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "DELETE",
        headers: { authorization: oauthHeader("DELETE", url, live) },
        signal: AbortSignal.timeout(X_TIMEOUT_MS),
      });
    } catch (err) {
      await handle
        .update(deliveries)
        .set({ lastError: `delete failed: ${err instanceof Error ? err.message : String(err)}`, updatedAt: now })
        .where(rowKey(d.roundId, d.target));
      continue;
    }
    if (res.ok || res.status === 404) {
      await handle.update(deliveries).set({ status: "retracted", lastError: reason, updatedAt: now }).where(rowKey(d.roundId, d.target));
      summary.retracted.push({ round: d.roundId, reason, postId: d.externalId });
      log(`x: deleted post ${d.externalId} for ${d.roundId} (${reason})`);
      continue;
    }
    const error = await xError(res);
    await handle
      .update(deliveries)
      .set({ lastError: `delete failed: ${error}`, updatedAt: now })
      .where(rowKey(d.roundId, d.target));
    log(`x: delete of ${d.externalId} failed, retried next run: ${error}`);
    if (res.status === 429) break;
  }

  // At most one post.
  const eligible = await xCandidates(handle, cfg, now, log);
  const eligibleIds = new Set(eligible.map((r) => r.id));
  for (const d of ledger) {
    if (d.status === "failed" && d.nextAttemptAt <= now && !eligibleIds.has(d.roundId)) {
      await handle
        .update(deliveries)
        .set({ status: "dead_letter", lastError: `no longer eligible for X; last error: ${d.lastError}`, updatedAt: now })
        .where(rowKey(d.roundId, d.target));
    }
  }
  const pick = nextPost(eligible, ledger, cfg, now);
  if ("wait" in pick) {
    summary.waiting = pick.wait;
    log(`x: ${cfg.mode}: nothing posted, ${pick.wait}`);
    return summary;
  }
  const r = pick.round;
  const text = postText(r, origin);
  const snapshot: DeliverySnapshot = { mode: cfg.mode, at: now.toISOString(), text, facts: postFacts(r) };

  if (!live) {
    await handle
      .insert(deliveries)
      .values({ roundId: r.id, channel: "x", target: X_TARGET, status: "previewed", snapshot, deliveredCertainty: r.certainty })
      .onConflictDoNothing();
    summary.posted.push({ round: r.id, text, postId: null });
    log(`x: would post for ${r.id}: ${JSON.stringify(text)}`);
    await review(handle, cfg, `Would post on X:\n${text}`, fetchImpl, log);
    return summary;
  }

  // Claim the row before calling X, so two runs can never post one round twice.
  const [claimed] = await handle
    .insert(deliveries)
    .values({ roundId: r.id, channel: "x", target: X_TARGET, status: "pending" })
    .onConflictDoUpdate({
      target: [deliveries.roundId, deliveries.channel, deliveries.target],
      set: { status: "pending", updatedAt: now },
      setWhere: inArray(deliveries.status, ["previewed", "failed"]),
    })
    .returning({ attempts: deliveries.attempts });
  if (!claimed) {
    summary.waiting = `${r.id} was claimed by another run`;
    return summary;
  }
  let res: Response;
  try {
    res = await fetchImpl(X_API, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", X_API, live), "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(X_TIMEOUT_MS),
    });
  } catch (err) {
    res = new Response(err instanceof Error ? err.message : String(err), { status: 599 });
  }
  const attempts = claimed.attempts + 1;
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
    const postId = body?.data?.id ?? null;
    await handle
      .update(deliveries)
      .set({ status: "sent", externalId: postId, snapshot, attempts, lastError: null, deliveredCertainty: r.certainty, updatedAt: now })
      .where(rowKey(r.id, X_TARGET));
    summary.posted.push({ round: r.id, text, postId });
    log(`x: posted ${postId} for ${r.id}: ${JSON.stringify(text)}`);
    return summary;
  }
  // 429 waits for X's own reset; anything else (a 403 included) takes the outbox's backoff, then the dead letters.
  const error = await xError(res);
  const reset = Number(res.headers.get("x-rate-limit-reset"));
  const dead = res.status !== 429 && attempts >= BACKOFF_MINUTES.length;
  const wait =
    res.status === 429
      ? Number.isFinite(reset) && reset * 1000 > now.getTime()
        ? reset * 1000 - now.getTime()
        : 15 * 60_000
      : (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 600) * 60_000;
  await handle
    .update(deliveries)
    .set({
      status: dead ? "dead_letter" : "failed",
      attempts,
      nextAttemptAt: new Date(now.getTime() + wait),
      lastError: error,
      updatedAt: now,
    })
    .where(rowKey(r.id, X_TARGET));
  summary.error = error;
  log(`x: post for ${r.id} failed (${dead ? "dead-lettered" : `retry after ${Math.round(wait / 60_000)} min`}): ${error}`);
  return summary;
}
