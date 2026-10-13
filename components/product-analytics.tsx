"use client";

import { useEffect } from "react";
import { type AnalyticsEvent, type AnalyticsEvents, startAnalytics, track, trackClickedElement } from "@/lib/analytics";

/**
 * Starts product analytics after hydration, when the browser is next idle, and listens for clicks
 * on elements marked with trackClick(). Renders nothing. The root layout mounts it only when
 * NEXT_PUBLIC_POSTHOG_KEY is set (lib/analytics.ts).
 */
export function ProductAnalytics() {
  useEffect(() => {
    document.addEventListener("click", trackClickedElement, true);
    const start = () => void startAnalytics();
    const idle = "requestIdleCallback" in window ? window.requestIdleCallback(start, { timeout: 4000 }) : null;
    const timer = idle === null ? window.setTimeout(start, 1500) : null;
    return () => {
      document.removeEventListener("click", trackClickedElement, true);
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
  return null;
}

/** Sends `event` once when a page renders it, and again when its properties change on a client navigation. */
export function TrackView<E extends AnalyticsEvent>({ event, properties }: { event: E; properties: AnalyticsEvents[E] }) {
  const json = JSON.stringify(properties);
  useEffect(() => {
    track(event, JSON.parse(json));
  }, [event, json]);
  return null;
}
