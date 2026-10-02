import { describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
  cacheLife: () => {},
  cacheTag: () => {},
}));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ db: async () => ({ insert: () => ({ values: () => ({ onConflictDoNothing: async () => [] }) }) }) }));
vi.mock("@/lib/presets", () => ({
  loadPreset: async (slug: string) => {
    if (slug === "unknown-preset") throw new Error(`unknown preset: ${slug}`);
    return { slug };
  },
}));

import { start } from "workflow/api";
import { ingestUrl } from "../app/(dashboard)/review/actions";
import { addTarget } from "../app/(dashboard)/settings/actions";
import { attempt } from "../lib/action-result";

describe("attempt", () => {
  test("a resolved value lands in value; a thrown message lands in error, never thrown through", async () => {
    expect(await attempt(async () => 42)).toEqual({ ok: true, value: 42 });
    expect(
      await attempt(async () => {
        throw new Error("No monitor for this preset yet.");
      }),
    ).toEqual({ ok: false, error: "No monitor for this preset yet." });
    // A rejection that is not an Error still lands as a readable string.
    expect(
      await attempt(async () => {
        throw "plain rejection" as unknown;
      }),
    ).toEqual({ ok: false, error: "plain rejection" });
  });
});

describe("addTarget", () => {
  // The refused URL returns a result the form can show; in production a thrown action error
  // would reach the reader as boilerplate instead.
  test("an http non-localhost target comes back { ok: false, error } before the store opens", async () => {
    const r = await addTarget({ channel: "webhook", target: "http://example.com/hook", label: "", presetSlug: "", minConfidence: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Target must be an https URL (http is allowed for localhost only).");
  });

  test("a malformed email target is refused the same way", async () => {
    const r = await addTarget({ channel: "email", target: "not-an-address", label: "", presetSlug: "", minConfidence: 0.5 });
    expect(r).toEqual({ ok: false, error: "Target must be an email address." });
  });
});

describe("ingestUrl", () => {
  test("rejects a non-https URL before the store opens", async () => {
    const r = await ingestUrl({ url: "http://example.com/story", presetSlug: "seed" });
    expect(r).toEqual({ ok: false, error: "URL must be https." });
    expect(vi.mocked(start)).not.toHaveBeenCalled();
  });

  test("rejects an unknown preset", async () => {
    const r = await ingestUrl({ url: "https://example.com/story", presetSlug: "unknown-preset" });
    expect(r).toEqual({ ok: false, error: "unknown preset: unknown-preset" });
    expect(vi.mocked(start)).not.toHaveBeenCalled();
  });

  test("a valid pair starts the ingest workflow on the manual lane and returns the run id", async () => {
    const r = await ingestUrl({ url: "https://example.com/story", presetSlug: "seed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.runId).toMatch(/^check:/);
    expect(vi.mocked(start)).toHaveBeenCalledWith(expect.anything(), [
      "manual",
      "https://example.com/story",
      "seed",
      expect.stringMatching(/^https?:\/\//),
      expect.any(String),
    ]);
  });
});
