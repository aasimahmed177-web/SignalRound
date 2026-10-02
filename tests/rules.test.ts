// Aliases taught in the review queue land in alias_rules and come back merged over the seed in
// rules/aliases.json, the table winning on a key. Nothing here writes the file: a deployed
// filesystem is read-only, so the seed must stay exactly as committed.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadAliases, saveAlias } from "../lib/rules";
import { testDb } from "./helpers";

const seedPath = path.join(process.cwd(), "rules/aliases.json");
const seed = async () => JSON.parse(await readFile(seedPath, "utf8")) as Record<string, string>;

describe("alias rules", () => {
  test("a saved alias is returned by loadAliases, normalized, alongside the seed", async () => {
    const db = await testDb();
    expect(await loadAliases(db)).toEqual(await seed());

    await saveAlias(db, "Acme Robotics, Inc.", "ACME");
    const aliases = await loadAliases(db);
    expect(aliases.acme).toBeUndefined();
    expect(aliases["acme robotics"]).toBe("acme");
    expect(aliases).toEqual({ ...(await seed()), "acme robotics": "acme" });

    // Saving the same alias again replaces its target: one row per alias key.
    await saveAlias(db, "Acme Robotics", "Acme Holdings");
    expect((await loadAliases(db))["acme robotics"]).toBe("acme holdings");
  });

  test("the table wins over the seed on a key collision", async () => {
    const db = await testDb();
    const [aliasKey, seeded] = Object.entries(await seed())[0];
    expect(seeded).toBeDefined();
    await saveAlias(db, aliasKey, `${seeded} group`);
    expect((await loadAliases(db))[aliasKey]).toBe(`${seeded} group`);
  });

  test("an empty key or a self-mapping is a no-op", async () => {
    const db = await testDb();
    await saveAlias(db, "", "acme");
    await saveAlias(db, "acme", "");
    await saveAlias(db, "***", "acme");
    await saveAlias(db, "Acme Inc", "acme");
    expect(await loadAliases(db)).toEqual(await seed());
  });

  test("saveAlias never touches rules/aliases.json", async () => {
    const before = await stat(seedPath);
    const content = await readFile(seedPath, "utf8");
    const db = await testDb();
    await saveAlias(db, "Widgets Co", "Widgets International");
    const after = await stat(seedPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(seedPath, "utf8")).toBe(content);
  });
});
