// Product analytics, off unless NEXT_PUBLIC_POSTHOG_KEY is set. With no key nothing here loads,
// stores, or sends anything: track() returns at once, trackClick() adds no attributes, and the root
// layout never renders the client that would load posthog-js. With a key, posthog-js loads after
// hydration, once the browser is idle, and sends through the same-origin /ingest rewrite in
// next.config.ts. Events fired before it loads wait in a short queue.

import type { PostHog } from "posthog-js";

/** Every named event and its properties. Names carry the fireround_ prefix; property values stay low-cardinality and free of personal data. */
export interface AnalyticsEvents {
  fireround_deploy_clicked: { location: "hero" | "self_host" | "feed_header" };
  fireround_github_clicked: { location: "header" | "self_host" | "closing" | "footer" | "sidebar" };
  /** `target` is the API reference page (/docs) or the OpenAPI spec. */
  fireround_api_docs_opened: { location: "product" | "api" | "footer" | "feed_hero" | "sidebar" | "docs"; target: "docs" | "openapi" };
  /** `snippet` names what was copied: quick_start, env, slack_command, mcp_config, a code tab's id (curl, mcp), or api_<endpoint> on /docs. */
  fireround_code_copied: { snippet: string };
  /** `preset` is the feed's public slug (`all` for every round). */
  fireround_subscribe_clicked: { channel: "slack" | "rss" | "atom" | "json_feed"; preset: string };
  fireround_export_clicked: { format: "csv" | "json" };
  /** `company` is the company's id (its domain or name key); `stage` is its latest round's, or `none`. */
  fireround_company_viewed: { company: string; stage: string };
  /** `investor` is the hyphen slug, sent only for a firm with a website, never for a person. */
  fireround_investor_viewed: { investor_kind: string; investor?: string };
  fireround_source_clicked: { location: "feed" | "company" | "news"; source_host: string };
  /** `value` is the option chosen for an enumerated filter; a search's text is never sent. */
  fireround_feed_filtered: {
    filter: "search" | "stage" | "sector" | "amount" | "sort" | "view" | "preset" | "unread" | "certainty" | "clear_all";
    value?: string;
  };
}

export type AnalyticsEvent = keyof AnalyticsEvents;

/**
 * The PostHog hosts for NEXT_PUBLIC_POSTHOG_HOST (default US cloud): where /ingest forwards events,
 * where it forwards static assets, and the app the toolbar links to. A self-hosted PostHog serves all three.
 */
export function posthogHosts(host = ""): { api: string; assets: string; ui: string } {
  const api = (host.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
  const cloud = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(api)?.[1];
  if (!cloud) return { api, assets: api, ui: api };
  return { api, assets: `https://${cloud}-assets.i.posthog.com`, ui: `https://${cloud}.posthog.com` };
}

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const QUEUE_MAX = 20;

let client: PostHog | null = null;
let starting = false;
const queue: Array<[string, object]> = [];

function send(event: string, properties: object): void {
  if (!KEY || typeof window === "undefined") return;
  if (client) client.capture(event, { ...properties });
  else if (queue.length < QUEUE_MAX) queue.push([event, properties]);
}

/** Sends one named event; a no-op without the key and on the server. */
export function track<E extends AnalyticsEvent>(event: E, properties: AnalyticsEvents[E]): void {
  send(event, properties);
}

/**
 * Attributes that make a link or button send `event` when clicked, for markup rendered on the
 * server, where no handler can be attached. Without the key it returns nothing, so the markup is
 * unchanged.
 */
export function trackClick<E extends AnalyticsEvent>(event: E, properties: AnalyticsEvents[E]): Record<string, string> {
  if (!KEY) return {};
  return { "data-track": event, "data-track-props": JSON.stringify(properties) };
}

/** The document click listener's half of trackClick: sends the event the clicked element, or its nearest ancestor, names. */
export function trackClickedElement(e: Event): void {
  if (!KEY) return;
  const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-track]") : null;
  const event = el?.dataset.track;
  if (!event) return;
  try {
    send(event, JSON.parse(el.dataset.trackProps ?? "{}"));
  } catch {
    send(event, {});
  }
}

/** Loads and starts posthog-js once, then sends whatever was queued. Without the key it does nothing. */
export async function startAnalytics(): Promise<void> {
  if (!KEY || client || starting || typeof window === "undefined") return;
  starting = true;
  const { default: posthog } = await import("posthog-js");
  posthog.init(KEY, {
    api_host: "/ingest",
    ui_host: posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST).ui,
    person_profiles: "identified_only",
    // No cookie: the anonymous id lives in local storage, so the privacy page's "no tracking cookie" holds.
    persistence: "localStorage",
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    // Nothing beyond the one bundle: no recorder, survey, or toolbar scripts fetched at runtime.
    disable_external_dependency_loading: true,
    respect_dnt: true,
    // Runs before the first pageview, so every event, that one included, carries app=fireround.
    loaded: (ph) => {
      ph.register({ app: "fireround" });
    },
  });
  client = posthog;
  for (const [event, properties] of queue.splice(0)) posthog.capture(event, { ...properties });
}
