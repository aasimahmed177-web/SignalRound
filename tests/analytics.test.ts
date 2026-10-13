import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const posthog = vi.hoisted(() => {
  const client = {
    init: vi.fn((_key: string, config: { loaded?: (ph: unknown) => void }) => config.loaded?.(client)),
    capture: vi.fn(),
    register: vi.fn(),
  };
  return client;
});
vi.mock("posthog-js", () => ({ default: posthog }));

/** lib/analytics reads the key once, at import, as the bundle does at build; each test imports it fresh. */
async function load(key?: string) {
  vi.resetModules();
  if (key) vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", key);
  else vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  return import("@/lib/analytics");
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("product analytics without NEXT_PUBLIC_POSTHOG_KEY", () => {
  test("track() is a no-op and posthog-js never loads", async () => {
    const { track, startAnalytics, trackClickedElement } = await load();
    track("fireround_deploy_clicked", { location: "hero" });
    await startAnalytics();
    trackClickedElement({ target: null } as unknown as Event);
    track("fireround_github_clicked", { location: "header" });
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  test("trackClick() adds no attributes, so the markup is unchanged", async () => {
    const { trackClick } = await load();
    expect(trackClick("fireround_export_clicked", { format: "csv" })).toEqual({});
  });
});

describe("product analytics with NEXT_PUBLIC_POSTHOG_KEY", () => {
  test("starts through the same-origin proxy with the privacy-light settings, then sends what was queued", async () => {
    const { track, startAnalytics } = await load("phc_test");
    track("fireround_company_viewed", { company: "acme.com", stage: "seed" });
    expect(posthog.capture).not.toHaveBeenCalled();

    await startAnalytics();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    const [key, config] = posthog.init.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(key).toBe("phc_test");
    expect(config).toMatchObject({
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      capture_pageleave: true,
      autocapture: false,
      disable_session_recording: true,
      respect_dnt: true,
    });
    expect(posthog.register).toHaveBeenCalledWith({ app: "fireround" });
    expect(posthog.capture).toHaveBeenCalledWith("fireround_company_viewed", { company: "acme.com", stage: "seed" });

    track("fireround_export_clicked", { format: "json" });
    expect(posthog.capture).toHaveBeenLastCalledWith("fireround_export_clicked", { format: "json" });
    await startAnalytics();
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  test("trackClick() marks an element and the click listener sends its event", async () => {
    const { trackClick, trackClickedElement, startAnalytics } = await load("phc_test");
    await startAnalytics();
    const attrs = trackClick("fireround_github_clicked", { location: "footer" });
    expect(attrs).toEqual({ "data-track": "fireround_github_clicked", "data-track-props": '{"location":"footer"}' });

    class FakeElement {
      dataset = { track: attrs["data-track"], trackProps: attrs["data-track-props"] };
      closest() {
        return this;
      }
    }
    vi.stubGlobal("Element", FakeElement);
    trackClickedElement({ target: new FakeElement() } as unknown as Event);
    expect(posthog.capture).toHaveBeenLastCalledWith("fireround_github_clicked", { location: "footer" });
  });
});

describe("posthogHosts", () => {
  test("maps PostHog Cloud to its asset and app hosts, and keeps a self-hosted origin for all three", async () => {
    const { posthogHosts } = await load();
    expect(posthogHosts()).toEqual({
      api: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
      ui: "https://us.posthog.com",
    });
    expect(posthogHosts("https://eu.i.posthog.com/")).toEqual({
      api: "https://eu.i.posthog.com",
      assets: "https://eu-assets.i.posthog.com",
      ui: "https://eu.posthog.com",
    });
    expect(posthogHosts("https://ph.example.com")).toEqual({
      api: "https://ph.example.com",
      assets: "https://ph.example.com",
      ui: "https://ph.example.com",
    });
  });
});
