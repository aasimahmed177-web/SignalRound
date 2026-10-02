// A company's pricing as a reader scans it: one plan per row, the price tidied for display, plans
// that share a family ("GPU Instances - On-demand", "GPU Instances - Reserved") under one label.
// Display only: the stored `price_as_written` is never rewritten, and every row keeps it whole for a
// tooltip, so a tidy that drops a word loses nothing. Drawn from every plan list on the live feed
// (2026-09-24): monthly tiers, per-seat and per-hour prices, model catalogs, fee schedules, sentences
// where a price should be, and call-to-action links copied off the page's buttons.

export interface Plan {
  name: string;
  price_as_written: string | null;
}

export type PriceKind = "amount" | "free" | "custom" | "text" | "none";

export interface PriceRow {
  /** The family a run of plans shares, shown once above them; null for a plan on its own. */
  group: string | null;
  /** The plan's name, or within a group the part after the family. */
  name: string;
  /** The price as it displays; null when the page gave none. */
  price: string | null;
  kind: PriceKind;
  /** The plan and price exactly as stored, for the tooltip. */
  title: string;
}

export interface PricingView {
  rows: PriceRow[];
  /** No row carries a price (only "Custom", sentences, or nothing): the list reads as a count instead. */
  onRequest: boolean;
  /** A row already says Free, so a separate "free tier" tag would repeat it. */
  showsFree: boolean;
}

const CURRENCY = "$€£¥₹";
const HAS_NUMBER = /\d/;
const HAS_MONEY = new RegExp(`[\\d${CURRENCY}]`);

/** "[Start Free Trial](https://…)" is a button's label and link, not a price: keep the label. */
function stripLinks(s: string): string {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** What a sales-led price says in its many spellings; the whole price, never a word inside one. */
const CUSTOM =
  /^(?:custom(?: pricing| quote)?(?:\s*\/\s*\w+)?|contact(?: us| sales)?|talk to (?:us|sales)|let'?s talk|get a (?:personali[sz]ed )?quote|request (?:a )?(?:quote|demo)|book a demo|tailored.*|volume[- ]based pricing|enterprise pricing)[.!]?$/i;

/** A price that is zero and says nothing else ("$0", "$0.00/ Month", "Free per user/month", "forever"). */
function isFree(s: string): boolean {
  if (/^(?:free|forever|free forever)\b/i.test(s) && !/\d/.test(s.replace(/^free\b/i, ""))) return true;
  const zero = new RegExp(`^[${CURRENCY}]?\\s*0(?:[.,]0+)?(?![\\d.,])`);
  if (!zero.test(s)) return false;
  // "₹0 for first month, then ₹500/month" is not free: another figure follows.
  return !/[1-9]/.test(s);
}

/** Billing periods and per-unit wording, spelled one way. */
function tidyUnits(s: string): string {
  return (
    s
      // "/ month", "/Month", "per month", "/m" mean a month; "monthly" and "a month" only right after a figure
      // ("$59 monthly", "£75 a month"), never inside a phrase ("free monthly credits").
      .replace(/\s*(?:\/|\bper\b)\s*(?:months?|mo|m)\b\.?/gi, "/mo")
      .replace(/(\d[kKmM]?)\s+(?:(?:billed\s+)?monthly|a\s+month)\b/gi, "$1/mo")
      .replace(/\s*(?:\/|\bper\b)\s*(?:years?|yr|yearly|annum)\b/gi, "/yr")
      .replace(/(\d[kKmM]?)\s+a\s+year\b/gi, "$1/yr")
      .replace(/\s*(?:\/|\bper\b)\s*(?:hours?|hr|h)\b/gi, "/hr")
      // "/ 6 months" keeps its count.
      .replace(/\s*\/\s*(\d+)\s*months?\b/gi, "/$1 mo")
      // "per user/month", "per seat/ month", "/ Mo / seat": the unit, then the period.
      .replace(/\s*(?:\/|\bper\b)\s*(user|seat|member)s?\s*\/mo\b/gi, "/$1/mo")
      .replace(/\/mo\s*\/\s*(user|seat|member)s?\b/gi, "/$1/mo")
      // "€17.99/ month" closes up; " / " between two prices ("₹6/minute / $0.10/minute") stays a separator.
      .replace(new RegExp(`\\s*\\/\\s*(?=[^\\s${CURRENCY}\\d])`, "g"), "/")
  );
}

/**
 * Filler a pricing page wraps around the figure: "Pay-as-you-go pricing from $1.12/h to $9.25/h"
 * says "$1.12 to $9.25/hr". Only words that carry no information go; the figure and its terms stay.
 */
function tidyAmount(raw: string): string {
  let s = raw;
  s = s.replace(/^(?:pay[- ]as[- ]you[- ]go\s+)?pricing\s+/i, "");
  s = s.replace(/^(?:starting|starts)\s+(?:at|from)\s+/i, "from ");
  s = s.replace(/^from\s+/i, "from ");
  // "per GPU from $4.46/h to $9.25/h": the unit reads after the figure.
  const perFirst = /^per\s+([\w-]+)\s+(from\s+.*)$/i.exec(s);
  if (perFirst) s = `${perFirst[2]} per ${perFirst[1]}`;
  s = tidyUnits(s);
  // "from $1.12/hr to $9.25/hr" is a range; the shared unit is said once.
  s = s.replace(
    new RegExp(`\\bfrom\\s+([${CURRENCY}]?\\d[\\d.,]*[kKmM]?)(\\/[\\w/]+)?\\s+to\\s+([${CURRENCY}]?\\d[\\d.,]*[kKmM]?)(\\/[\\w/]+)?`, "i"),
    (_m, a: string, ua: string | undefined, b: string, ub: string | undefined) =>
      !ua || !ub || ua === ub ? `${a} to ${b}${ub ?? ua ?? ""}` : `${a}${ua} to ${b}${ub}`,
  );
  // A trailing billing clause reads after a comma: "$139/user/mo, billed annually".
  s = s.replace(/,?\s+(billed\s+(?:annually|yearly))\b/i, ", $1");
  return s
    .replace(/\s{2,}/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

/** One price for display, and what kind of price it is. */
export function displayPrice(raw: string | null): { price: string | null; kind: PriceKind } {
  if (raw === null) return { price: null, kind: "none" };
  const s = stripLinks(raw).replace(/\s+/g, " ").trim();
  if (!s) return { price: null, kind: "none" };
  if (isFree(s)) return { price: "Free", kind: "free" };
  if (!HAS_NUMBER.test(s) && /free trial/i.test(s)) return { price: "Free trial", kind: "free" };
  if (CUSTOM.test(s)) return { price: "Custom", kind: "custom" };
  // "Flexible subscription based on your business size" is a sentence, not a price.
  if (!HAS_MONEY.test(s)) return { price: s.replace(/[.\s]+$/, ""), kind: "text" };
  return { price: tidyAmount(s), kind: "amount" };
}

/** "GPU Instances - On-demand" and "Voice Agents (Pay as you go)": a family and a variant. */
function split(name: string): { head: string; tail: string } | null {
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(name);
  if (dash) return { head: dash[1].trim(), tail: dash[2].trim() };
  const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(name);
  if (paren) return { head: paren[1].trim(), tail: paren[2].trim() };
  return null;
}

/**
 * The plans as rows. Exact repeats drop (a catalog listed twice); a name listed again with another
 * price (a monthly and an annual toggle) folds into one row; adjacent plans sharing a family group
 * under it. Page order is kept: a pricing page already runs cheapest to dearest.
 */
export function pricingView(plans: Plan[]): PricingView {
  const merged: Array<{ name: string; prices: Array<{ price: string | null; kind: PriceKind }>; title: string[] }> = [];
  for (const p of plans) {
    const name = p.name.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const shown = displayPrice(p.price_as_written);
    const original = p.price_as_written ? `${name}: ${p.price_as_written}` : name;
    const same = merged.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!same) merged.push({ name, prices: [shown], title: [original] });
    else if (!same.prices.some((x) => x.price === shown.price)) {
      same.prices.push(shown);
      same.title.push(original);
    }
  }

  const rows: PriceRow[] = merged.map((m) => {
    const priced = m.prices.filter((x) => x.price !== null);
    const first = priced[0] ?? { price: null, kind: "none" as const };
    return {
      group: null,
      name: m.name,
      price: priced.length > 1 ? priced.map((x) => x.price).join(" or ") : first.price,
      kind: priced.some((x) => x.kind === "amount") ? "amount" : first.kind,
      title: m.title.join("\n"),
    };
  });

  // A family groups only when two or more adjacent plans share it; a lone "CPU Instances - On-demand" keeps its name.
  const parts = rows.map((r) => split(r.name));
  for (let i = 0; i < rows.length; ) {
    const head = parts[i]?.head.toLowerCase();
    let j = i + 1;
    while (head && j < rows.length && parts[j]?.head.toLowerCase() === head) j++;
    if (head && j - i >= 2) {
      for (let k = i; k < j; k++) rows[k] = { ...rows[k], group: parts[i]?.head ?? null, name: parts[k]?.tail ?? rows[k].name };
    }
    i = j;
  }

  return {
    rows,
    onRequest: rows.length > 0 && rows.every((r) => r.kind !== "amount" && r.kind !== "free"),
    showsFree: rows.some((r) => r.kind === "free"),
  };
}

const MODEL_LABEL: Record<string, string | null> = {
  "usage-based": "Usage-based",
  "seat-based": "Per seat",
  "flat subscription": "Flat subscription",
  "tiered plans": "Tiered plans",
  "hybrid (plans plus usage)": "Plans plus usage",
  "free only": "Free",
  "sales-led (contact us)": "Sales-led",
  unknown: null,
};

/** The pricing model as a label; null for "unknown", which says nothing a reader can use. */
export function pricingModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model in MODEL_LABEL) return MODEL_LABEL[model];
  return model.charAt(0).toUpperCase() + model.slice(1);
}
