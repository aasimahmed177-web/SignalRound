"use client";

import { useSyncExternalStore } from "react";
import { relativeDay } from "@/lib/format";

const noSubscribe = () => () => {};

/**
 * "today", "yesterday", "3d ago" against the reader's own calendar. The server knows only UTC, so it
 * renders the UTC answer, and hydration re-renders with the browser's time zone: an evening in New
 * York reads a round from that morning as today, not yesterday.
 */
export function RelativeDay({ iso, onDate = false }: { iso: string | null; onDate?: boolean }) {
  const label = useSyncExternalStore(
    noSubscribe,
    () => relativeDay(iso),
    () => relativeDay(iso, { utc: true }),
  );
  // Inside a sentence a calendar date wants an "on" ("checked on Sep 20"); "today" and "3d ago" do not.
  return <>{onDate && /^[A-Z]/.test(label) ? `on ${label}` : label}</>;
}

export function RelativeCheck({ iso }: { iso: string | null }) {
  const label = useSyncExternalStore(
    noSubscribe,
    () => checkAge(iso, Date.now()),
    () => checkAge(iso, Date.now()),
  );
  return <>{label}</>;
}

function checkAge(iso: string | null, now: number): string {
  if (!iso) return "unknown";
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
