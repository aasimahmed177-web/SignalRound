// Formatting the News page needs and nothing else does.

import { calendarDay } from "@/lib/format";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The day an article counts under: a date (YYYY-MM-DD) is that day as written; a timestamp is the
 * day it fell on, on the UTC calendar or the reader's own (`utc: false`, in a browser). The same
 * rule relativeDay reads, so a group and the "today" on each card in it always agree.
 */
export function newsDay(iso: string, { utc = true }: { utc?: boolean } = {}): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : calendarDay(d, utc);
}

/**
 * A News day-group key ("2026-09-21") as a heading a reader scans: "Today", "Yesterday", then
 * "Mon 21 Sep", with the year only when it is not this one. "Today" is `now`'s day on the same
 * calendar the keys were cut from: UTC on the server, the reader's own after hydration.
 */
export function dayHeading(day: string, now: Date = new Date(), { utc = true }: { utc?: boolean } = {}): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime())) return day;
  const today = Date.parse(`${calendarDay(now, utc)}T00:00:00Z`);
  const diff = Math.round((today - d.getTime()) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  // Built by hand: Intl's en-GB now writes "Sept" and a comma before the year.
  const label = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === Number(calendarDay(now, utc).slice(0, 4)) ? label : `${label} ${d.getUTCFullYear()}`;
}
