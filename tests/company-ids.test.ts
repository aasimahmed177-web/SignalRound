// Clean company ids: a company's id is its page's URL, so it is its verified domain or its name
// hyphenated, never a name with spaces or a namesake's ":identity:<news host>" suffix. New rows are
// minted clean; the backfill renames the rest, and an old URL redirects for good.

import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { companySlug, isCleanCompanyId, nextFreeId } from "../lib/company-ids";
import { applyRenames, loadRenamePlan, planRenames, renameBackup } from "../lib/company-renames";
import { companyRedirect, foldedInto } from "../lib/entity-exists";
import { listRounds, mergeCompanies, persistRecords, renameCompany } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("the id rules", () => {
  test("clean is lowercase letters and digits joined by single dots or hyphens", () => {
    for (const id of ["spiko", "flowengineering.com", "nexbank-capital", "ghost-2", "vital-lyfe.com", "3cschool.net"])
      expect(isCleanCompanyId(id)).toBe(true);
    for (const id of ["nexbank capital", "ghost:identity:venture-pitch-online.com", "Spiko", "-acme", "acme-", "a--b", ""])
      expect(isCleanCompanyId(id)).toBe(false);
  });

  test("a slug folds accents and joins every other run with one hyphen", () => {
    expect(companySlug("nexbank capital")).toBe("nexbank-capital");
    expect(companySlug("Impacto Andalucía Innovación")).toBe("impacto-andalucia-innovacion");
    expect(companySlug("iit madras unicorn frontier fund i")).toBe("iit-madras-unicorn-frontier-fund-i");
    expect(companySlug("AT&T  Ventures!")).toBe("at-t-ventures");
    expect(companySlug("***")).toBe("company");
    expect(isCleanCompanyId(companySlug("  Ünïcode — Labs  "))).toBe(true);
  });

  test("the next free id numbers from 2", () => {
    expect(nextFreeId("ghost", new Set())).toBe("ghost");
    expect(nextFreeId("ghost", new Set(["ghost", "ghost-2"]))).toBe("ghost-3");
  });
});

describe("the rename plan", () => {
  const candidate = (over: Partial<Parameters<typeof planRenames>[0][number]>) => ({
    id: "x",
    name: "X",
    nameKey: "x",
    domain: null,
    verifiedDomain: false,
    rounds: 1,
    published: 0,
    ...over,
  });

  test("a verified domain first, then the name, numbered past any live or folded id", () => {
    const plan = planRenames(
      [
        candidate({ id: "nexbank capital", name: "NexBank Capital, Inc.", nameKey: "nexbank capital", published: 2 }),
        candidate({ id: "cscale.ai:identity:finsmes.com", name: "CScale", nameKey: "cscale", domain: "cscale.ai", verifiedDomain: true }),
        candidate({ id: "ghost:identity:venture-pitch-online.com", name: "Ghost", nameKey: "ghost", domain: "ghost.dev" }),
        candidate({ id: "acme labs", name: "Acme Labs", nameKey: "acme labs" }),
      ],
      new Set(["ghost", "acme-labs"]),
    );
    expect(plan.map((r) => [r.from, r.to, r.basis])).toEqual([
      ["nexbank capital", "nexbank-capital", "name"],
      ["acme labs", "acme-labs-2", "numbered"],
      ["cscale.ai:identity:finsmes.com", "cscale.ai", "domain"],
      ["ghost:identity:venture-pitch-online.com", "ghost-2", "numbered"],
    ]);
  });

  test("of two namesakes, the one with published rounds gets the plain name", () => {
    const plan = planRenames(
      [
        candidate({ id: "flam:identity:af.net", name: "Flam", nameKey: "flam", published: 0 }),
        candidate({ id: "flam app", name: "Flam", nameKey: "flam", published: 3 }),
      ],
      new Set(),
    );
    expect(Object.fromEntries(plan.map((r) => [r.from, r.to]))).toEqual({ "flam app": "flam", "flam:identity:af.net": "flam-2" });
  });
});

describe("new rows", () => {
  test("a company without a domain is minted under its hyphenated name", async () => {
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "NexBank Capital", company_key: "nexbank capital" })], "series-a-b", "run-1");
    const [r] = (await listRounds(db, { includeReview: true })).rows;
    expect(r?.company.id).toBe("nexbank-capital");
  });

  test("a namesake takes the next number, never a news site's host", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "Ghost",
          company_key: "ghost",
          company_domain: "ghost.ai",
          sources: [{ url: "https://ghost.ai/news", host: "ghost.ai" }],
        }),
      ],
      "series-a-b",
      "run-1",
    );
    await persistRecords(
      db,
      [
        record({
          company_name: "Ghost",
          company_key: "ghost",
          stage: "seed",
          announced_date: "2026-10-05",
          sources: [{ url: "https://venture-pitch-online.com/ghost", host: "venture-pitch-online.com" }],
        }),
      ],
      "series-a-b",
      "run-2",
    );
    const ids = (await db.select({ id: schema.companies.id }).from(schema.companies)).map((c) => c.id).sort();
    expect(ids).toEqual(["ghost-2", "ghost.ai"]);
  });
});

describe("renaming a company", () => {
  async function legacy() {
    const db = await testDb();
    await db
      .insert(schema.companies)
      .values({ id: "nexbank capital", name: "NexBank Capital", nameKey: "nexbank capital", domain: "nexbank.com" });
    await persistRecords(
      db,
      [record({ company_name: "NexBank Capital", company_key: "nexbank capital", company_domain: "nexbank.com" })],
      "series-a-b",
      "run-1",
      { companyId: "nexbank capital" },
    );
    const [round] = (await listRounds(db, { includeReview: true })).rows;
    if (round?.company.id !== "nexbank capital") throw new Error(`setup: ${round?.company.id}`);
    await db.insert(schema.enrichments).values({
      companyId: "nexbank capital",
      kind: "profile",
      data: {
        company_key: "nexbank capital",
        company_website: "https://nexbank.com",
        website_source: "record",
        profile: { what_they_sell: "banking" },
      },
    });
    await db.insert(schema.trendingRounds).values({ roundId: round.id, companyId: "nexbank capital", firstSeenAt: new Date() });
    await db.insert(schema.accuracyFlags).values({ companyId: "nexbank capital", rule: "r", severity: "low", reason: "why" });
    await db.insert(schema.accuracyMemory).values({ companyId: "nexbank capital", founders: ["A"] });
    return { db, roundId: round.id };
  }

  test("everything moves, the domain included, and the old URL redirects for good", async () => {
    const { db, roundId } = await legacy();
    expect(await renameCompany(db, "nexbank capital", "nexbank.com")).toBe(true);
    const [round] = (await listRounds(db, { ids: [roundId], includeReview: true })).rows;
    expect(round?.company).toMatchObject({ id: "nexbank.com", name: "NexBank Capital", domain: "nexbank.com" });
    expect(await db.select().from(schema.companies)).toHaveLength(1);
    expect((await db.select().from(schema.enrichments)).map((e) => [e.companyId, (e.data as { company_key: string }).company_key])).toEqual(
      [["nexbank.com", "nexbank.com"]],
    );
    expect((await db.select().from(schema.trendingRounds)).map((t) => t.companyId)).toEqual(["nexbank.com"]);
    expect((await db.select().from(schema.accuracyFlags)).map((f) => f.companyId)).toEqual(["nexbank.com"]);
    expect((await db.select().from(schema.accuracyMemory)).map((m) => m.companyId)).toEqual(["nexbank.com"]);
    expect(await companyRedirect(db, "nexbank capital")).toEqual({ id: "nexbank.com", permanent: true });
    expect(await foldedInto(db, "nexbank capital")).toBe("nexbank.com");
    // A rename again, or onto a taken id, does nothing.
    expect(await renameCompany(db, "nexbank capital", "nexbank-capital")).toBe(false);
  });

  test("a later merge keeps the old URL leading to the survivor; a merge alone stays a temporary redirect", async () => {
    const { db } = await legacy();
    await renameCompany(db, "nexbank capital", "nexbank-capital");
    await db.insert(schema.companies).values({ id: "nexbank-holdings", name: "NexBank", nameKey: "nexbank" });
    await mergeCompanies(db, "nexbank-capital", "nexbank-holdings");
    expect(await companyRedirect(db, "nexbank capital")).toEqual({ id: "nexbank-holdings", permanent: true });
    expect(await companyRedirect(db, "nexbank-capital")).toEqual({ id: "nexbank-holdings", permanent: false });
  });

  test("the backfill plans from the store, backs up what it touches, and applies", async () => {
    const { db } = await legacy();
    await db.insert(schema.companies).values([
      { id: "ghost:identity:venture-pitch-online.com", name: "Ghost", nameKey: "ghost" },
      { id: "ghost", name: "Ghost", nameKey: "ghost" },
    ]);
    await db.insert(schema.companyFolds).values({ fromId: "ghost-2", intoId: "ghost" });
    const plan = await loadRenamePlan(db);
    expect(plan.map((r) => [r.from, r.to, r.basis])).toEqual([
      ["nexbank capital", "nexbank.com", "domain"],
      ["ghost:identity:venture-pitch-online.com", "ghost-3", "numbered"],
    ]);
    const backup = await renameBackup(
      db,
      plan.map((r) => r.from),
    );
    expect(backup.companies).toHaveLength(2);
    expect(backup.funding_rounds).toHaveLength(1);
    expect(backup.enrichments).toHaveLength(1);
    expect(await applyRenames(db, plan)).toEqual({ renamed: 2, skipped: [] });
    expect((await db.select({ id: schema.companies.id }).from(schema.companies)).map((c) => c.id).sort()).toEqual([
      "ghost",
      "ghost-3",
      "nexbank.com",
    ]);
    expect(await loadRenamePlan(db)).toEqual([]);
    const [fold] = await db
      .select()
      .from(schema.companyFolds)
      .where(eq(schema.companyFolds.fromId, "ghost:identity:venture-pitch-online.com"));
    expect(fold).toMatchObject({ intoId: "ghost-3", renamed: true });
  });
});
