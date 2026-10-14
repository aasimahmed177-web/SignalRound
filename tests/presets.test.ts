// The preset files as shipped: each parses against the schema, the list comes back in `order`,
// and the stage bands tile pre_seed through growth with no gaps and no overlap. Then the custom
// presets beside them: stored rows list after the files, load by slug, and lose to a file on a slug.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parsePreset, STAGES, slugifyPresetName } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { deleteCustomPreset, isCustomPreset, listPresets, loadPreset, presetOptions, saveCustomPreset } from "../lib/presets";
import { testDb } from "./helpers";

describe("presets", () => {
  test("listPresets returns series-a-b first, then seed, then growth", async () => {
    const presets = await listPresets(await testDb());
    expect(presets.map((p) => p.slug)).toEqual(["series-a-b", "seed", "growth"]);
    expect(presets.map((p) => p.order)).toEqual([10, 20, 30]);
    expect(presetOptions(presets)).toEqual(presets.map((p) => ({ slug: p.slug, name: p.name })));
  });

  test("every JSON file in presets/ parses against the Preset schema", async () => {
    const files = (await readdir(path.join(process.cwd(), "presets"))).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["growth.json", "seed.json", "series-a-b.json"]);
    for (const f of files) {
      const slug = f.replace(/\.json$/, "");
      const preset = await loadPreset(slug);
      expect(preset.slug).toBe(slug);
      expect(preset.queries.length).toBeGreaterThanOrEqual(8);
      expect(preset.goal.length).toBeGreaterThan(0);
      // Every watchlist watches publisher pages and runs stage-free searches. No X profile reads: the
      // accounts they read mirror sites the lane reads directly (Crunchbase News, Dealroom news).
      expect(preset.xAccounts).toEqual([]);
      expect(preset.watchSites.length).toBeGreaterThan(0);
      expect(preset.watchQueries.length).toBeGreaterThan(0);
    }
  });

  test("the stage bands are distinct and together cover pre_seed through growth, with bridge on Series A and B", async () => {
    const presets = await listPresets(await testDb());
    const all = presets.flatMap((p) => p.stages);
    expect(new Set(all).size).toBe(all.length);
    // A bridge (and a pre-Series B or C) sits on the Series A and B watchlist, and no other.
    expect(presets.filter((p) => p.stages.includes("bridge")).map((p) => p.slug)).toEqual(["series-a-b"]);
    const banded = all.filter((s) => s !== "bridge");
    const band = STAGES.slice(0, STAGES.indexOf("growth") + 1);
    expect([...banded].sort()).toEqual([...band].sort());
    // Each preset's banded stages are contiguous in STAGES order.
    for (const p of presets) {
      const idx = p.stages
        .filter((s) => s !== "bridge")
        .map((s) => STAGES.indexOf(s))
        .sort((a, b) => a - b);
      expect(idx[idx.length - 1] - idx[0]).toBe(idx.length - 1);
    }
  });
});

const custom = (slug: string, order: number) =>
  parsePreset({
    slug,
    name: "Series C and later",
    description: "Late-stage rounds.",
    order,
    queries: ['startup "raises Series C" million'],
    goal: "Alert when a startup announces a new Series C or later round.",
    stages: ["series_c", "series_d_plus"],
  });

describe("custom presets", () => {
  test("a saved preset lists after the files, loads by slug, and is gone once deleted", async () => {
    const db = await testDb();
    // An order below every file's still lands after them: files first, then custom by order.
    await saveCustomPreset(db, custom("series-c-plus", 1));
    await saveCustomPreset(db, custom("late-stage", 1));

    const slugs = (await listPresets(db)).map((p) => p.slug);
    expect(slugs).toEqual(["series-a-b", "seed", "growth", "late-stage", "series-c-plus"]);
    expect((await loadPreset("series-c-plus", db)).stages).toEqual(["series_c", "series_d_plus"]);
    expect(await isCustomPreset("series-c-plus")).toBe(true);
    expect(await isCustomPreset("seed")).toBe(false);

    // Save again replaces in place: one row per slug.
    await saveCustomPreset(db, { ...custom("series-c-plus", 1), name: "Series C+" });
    expect((await loadPreset("series-c-plus", db)).name).toBe("Series C+");

    await deleteCustomPreset(db, "series-c-plus");
    expect((await listPresets(db)).map((p) => p.slug)).toEqual(["series-a-b", "seed", "growth", "late-stage"]);
    await expect(loadPreset("series-c-plus", db)).rejects.toThrow(/unknown preset/);
  });

  test("a file slug wins over a custom one, on read and on write", async () => {
    const db = await testDb();
    await expect(saveCustomPreset(db, custom("seed", 5))).rejects.toThrow(/is a file/);
    // A row that slipped in anyway (an older build, a hand edit) is shadowed, not listed twice.
    const { schema } = await import("@fireround/core/db");
    await db.insert(schema.customPresets).values({ slug: "seed", definition: custom("seed", 5) });
    const presets = await listPresets(db);
    expect(presets.filter((p) => p.slug === "seed")).toHaveLength(1);
    expect((await loadPreset("seed", db)).name).toBe("Seed and pre-seed");
  });

  test("parsePreset rejects an empty queries list, and names slugify to the schema's shape", () => {
    expect(() => custom("x", 1).queries).not.toThrow();
    expect(() => parsePreset({ ...custom("empty", 1), queries: [] })).toThrow();
    expect(slugifyPresetName("Series C & later!")).toBe("series-c-later");
    expect(slugifyPresetName("  Späte Runden  ")).toBe("spate-runden");
    expect(slugifyPresetName("***")).toBe("");
  });
});
