// The email digest, composed as pure functions: subject, HTML, and a plain-text fallback, from the
// rounds an email target has waiting. The sender in lib/delivery.ts decides when a digest is due.

import { createHmac } from "node:crypto";
import { approxDate, floorLabel, hostLabel, roundStageLabel, usd } from "./format.ts";
import { webUrl } from "./links.ts";
import type { RoundRow } from "./persist.ts";

export type DigestCadence = "daily" | "weekly";

export interface DigestState {
  cadence: DigestCadence;
  lastSentAt: string | null;
}

export interface DigestScope {
  origin: string;
  cadence: DigestCadence;
  presetSlug: string | null;
  minConfidence: number;
  /** The signed one-click unsubscribe link (digestUnsubscribeUrl); every sent digest carries one. */
  unsubscribeUrl?: string;
}

/** Where a digest's unsubscribe link lands: GET asks to confirm, POST (the button or a mail client's one-click) turns the digest off. */
export const DIGEST_UNSUBSCRIBE_PATH = "/api/digest/unsubscribe";

/**
 * The unsubscribe signature for one email target: an HMAC of its id under the Resend key, the one
 * secret every instance that sends a digest has. Nothing is stored; rotating the key retires old links.
 */
export function digestUnsubscribeToken(targetId: string, key: string): string {
  return createHmac("sha256", key).update(`digest-unsubscribe:${targetId}`).digest("base64url");
}

export function digestUnsubscribeUrl(origin: string, targetId: string, key: string): string {
  return `${origin}${DIGEST_UNSUBSCRIBE_PATH}?${new URLSearchParams({ t: targetId, s: digestUnsubscribeToken(targetId, key) })}`;
}

/**
 * Email digests are optional, for self-hosters: they send only with RESEND_API_KEY and DIGEST_FROM
 * set, and the public pages mention email only then.
 */
export function digestsConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.DIGEST_FROM);
}

/** One email lists at most this many rounds; the rest are counted and linked to the feed. */
export const DIGEST_CAP = 50;

const WINDOW_MS: Record<DigestCadence, number> = { daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000 };

export function digestKey(targetId: string): string {
  return `digest:${targetId}`;
}

export function parseDigestState(value: unknown): DigestState {
  const v = (value ?? {}) as Partial<DigestState>;
  return { cadence: v.cadence === "daily" ? "daily" : "weekly", lastSentAt: typeof v.lastSentAt === "string" ? v.lastSentAt : null };
}

/** The first digest goes out on the first flush with a row; after that, one per cadence window. */
export function digestDue(state: DigestState, now: number = Date.now()): boolean {
  if (!state.lastSentAt) return true;
  const last = new Date(state.lastSentAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= WINDOW_MS[state.cadence];
}

export function digestSubject(count: number, cadence: DigestCadence): string {
  const when = cadence === "daily" ? "today" : "this week";
  // Found in the window, whenever announced: an older round read this week is newly found, not new.
  return `Fireround: ${count} ${count === 1 ? "round" : "rounds"} newly found ${when}`;
}

/** Text into HTML: also what the feeds use, since scraped names and titles are markup to a reader. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function amountOf(r: RoundRow): string {
  return r.amount.usd_millions ? usd(r.amount.usd_millions) : (r.amount.as_written ?? "amount not stated");
}

function leadOf(r: RoundRow): string {
  return r.lead_investors.length ? r.lead_investors.join(", ") : "lead not stated";
}

function scopeLine(scope: DigestScope): string {
  const preset = scope.presetSlug ?? "all presets";
  return `This digest covers ${preset}, ${floorLabel(scope.minConfidence)}.`;
}

function feedUrl(scope: DigestScope): string {
  return scope.presetSlug ? `${scope.origin}/feed?preset=${encodeURIComponent(scope.presetSlug)}` : `${scope.origin}/feed`;
}

export function digestHtml(rounds: RoundRow[], scope: DigestScope): string {
  const shown = rounds.slice(0, DIGEST_CAP);
  const more = rounds.length - shown.length;
  const feed = feedUrl(scope);
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const muted = "color:#6b6b6b;";
  const rows = shown
    .map((r) => {
      const url = `${scope.origin}/companies/${encodeURIComponent(r.company.id)}`;
      const logoUrl = webUrl(r.company.logo_url);
      const sourceUrl = webUrl(r.sources[0]?.url);
      const logo = logoUrl
        ? `<img src="${esc(logoUrl)}" width="20" height="20" alt="" style="width:20px;height:20px;border-radius:4px;vertical-align:middle;margin-right:8px;">`
        : "";
      const src = sourceUrl
        ? `<a href="${esc(sourceUrl)}" style="${muted}text-decoration:none;">${esc(hostLabel(r.sources[0].host))}</a>`
        : "";
      return `<tr>
<td style="padding:12px 0;border-bottom:1px solid #e6e6e6;vertical-align:top;">
<div style="font-size:15px;line-height:20px;">${logo}<a href="${esc(url)}" style="color:#111111;font-weight:600;text-decoration:none;">${esc(r.company.name)}</a> <span style="${muted}">${r.certainty === "expected" ? "Expected · " : ""}${esc(roundStageLabel(r))}</span></div>
<div style="font-size:13px;line-height:18px;margin-top:2px;${muted}">${esc(amountOf(r))} &middot; ${esc(leadOf(r))} &middot; ${esc(approxDate(r.announced_on, r.date_precision))}${src ? ` &middot; ${src}` : ""}</div>
</td>
</tr>`;
    })
    .join("\n");
  const moreLine =
    more > 0
      ? `<p style="font-size:13px;line-height:18px;${muted}">and ${more} more in <a href="${esc(feed)}" style="color:#fa5d19;">the feed</a>.</p>`
      : "";
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(digestSubject(rounds.length, scope.cadence))}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:${font};">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
<div style="font-size:12px;line-height:16px;letter-spacing:0.04em;text-transform:uppercase;${muted}">Fireround</div>
<h1 style="font-size:20px;line-height:28px;font-weight:600;margin:4px 0 16px;">${rounds.length} ${rounds.length === 1 ? "round" : "rounds"} newly found ${scope.cadence === "daily" ? "today" : "this week"}</h1>
<div style="height:1px;background:#fa5d19;margin-bottom:4px;"></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${rows}
</table>
${moreLine}
<p style="font-size:12px;line-height:18px;margin-top:24px;${muted}"><a href="${esc(feed)}" style="color:#fa5d19;">Open the feed</a>. ${esc(scopeLine(scope))}${scope.unsubscribeUrl ? ` <a href="${esc(scope.unsubscribeUrl)}" style="${muted}">Unsubscribe</a>.` : ""}</p>
</div>
</body>
</html>`;
}

export function digestText(rounds: RoundRow[], scope: DigestScope): string {
  const shown = rounds.slice(0, DIGEST_CAP);
  const more = rounds.length - shown.length;
  const feed = feedUrl(scope);
  const lines = shown.map((r) => {
    const src = r.sources[0] ? ` (${hostLabel(r.sources[0].host)})` : "";
    return `${r.company.name}, ${r.certainty === "expected" ? "expected " : ""}${roundStageLabel(r)}: ${amountOf(r)}, ${leadOf(r)}, ${approxDate(r.announced_on, r.date_precision)}${src}\n  ${scope.origin}/companies/${encodeURIComponent(r.company.id)}`;
  });
  return [
    digestSubject(rounds.length, scope.cadence),
    "",
    ...lines,
    ...(more > 0 ? ["", `and ${more} more in the feed: ${feed}`] : []),
    "",
    `Open the feed: ${feed}`,
    scopeLine(scope),
    ...(scope.unsubscribeUrl ? [`Unsubscribe: ${scope.unsubscribeUrl}`] : []),
  ].join("\n");
}
