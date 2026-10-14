// Companies saved under a slug or a lowercase name take the name their own evidence writes.
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { applyCompanyNameRepair, planCompanyNameRepair, properNameIn, slugLikeName } from "../lib/company-name-repair";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("repair-slug-names", () => {
  test("only a name written all in lowercase is a slug", () => {
    expect(slugLikeName("sandboxaq")).toBe(true);
    expect(slugLikeName("hub-international")).toBe(true);
    expect(slugLikeName("manychat.com")).toBe(true);
    expect(slugLikeName("Consensys")).toBe(false);
    expect(slugLikeName("1337")).toBe(false);
  });

  test("the evidence's own spelling of the slug names the company", () => {
    expect(
      properNameIn("k2space", "k2space.com", {
        texts: ["K2 Space Announces $110M Series B and First Successful In-Space Demonstration", "K2 Space raised $110 million"],
        site: [],
      }),
    ).toEqual({ name: "K2 Space", count: 2, initialOnly: false });
    expect(
      properNameIn("ambiencehealthcare", "ambiencehealthcare.com", {
        texts: ["Ambience Healthcare Announces $243 Million Series C", "Ambience Healthcare, the AI platform"],
        site: ["Ambience Healthcare"],
      })?.name,
    ).toBe("Ambience Healthcare");
    // The domain written out is the slug of its label.
    expect(properNameIn("bilt.me", "bilt.me", { texts: ["Bilt raises €615K", "the startup Bilt said"], site: [] })?.name).toBe("Bilt");
    // The site's own spelling outranks the press, and its capitals throughout are the brand's.
    expect(properNameIn("xpanceo", "xpanceo.com", { texts: ["startup Xpanceo raised", "Xpanceo said"], site: ["XPANCEO"] })?.name).toBe(
      "XPANCEO",
    );
  });

  test("a headline's capitals, a sentence's first word, or a single press mention is no name", () => {
    expect(properNameIn("veir", "veir.com", { texts: ["VEIR RAISES $75M", "VEIR RAISES $75M SERIES B"], site: [] })).toBeNull();
    expect(properNameIn("enso", "enso.bot", { texts: ["Enso raises $5M. Enso builds agents."], site: [] })).toBeNull();
    expect(properNameIn("aalo", "aalo.com", { texts: ["the startup Aalo closed"], site: [] })).toBeNull();
    expect(properNameIn("aalo", "aalo.com", { texts: ["the startup Aalo closed", "reactor maker Aalo said"], site: [] })).toEqual({
      name: "Aalo",
      count: 2,
      initialOnly: true,
    });
  });

  test("a company whose own site writes it in lowercase keeps its name", () => {
    expect(properNameIn("bunq", "bunq.com", { texts: ["the bank Bunq raised", "neobank Bunq said"], site: ["bunq"] })).toBeNull();
    expect(properNameIn("noon", "noon.com", { texts: ["retailer Noon raised", "marketplace Noon said"], site: ["noon.com"] })).toBeNull();
  });

  test("the plan reads each slug's evidence, and the repair renames only rows that still hold it", async () => {
    const db = await testDb();
    await persistRecords(
      db,
      [
        record({
          company_name: "k2space",
          company_key: "k2space",
          company_website: "https://k2space.com",
          company_domain: "k2space.com",
          evidence_quotes: ["K2 Space raised $110 million in a Series B.", "satellite maker K2 Space said"],
        }),
        record({
          company_name: "bunq",
          company_key: "bunq",
          company_website: "https://bunq.com",
          company_domain: "bunq.com",
          evidence_quotes: ["the neobank Bunq raised", "neobank Bunq said"],
        }),
      ],
      "growth",
      "run-1",
    );
    const companies = await db.select().from(schema.companies);
    const k2 = companies.find((c) => c.domain === "k2space.com");
    const bunq = companies.find((c) => c.domain === "bunq.com");
    await db.insert(schema.enrichments).values({ companyId: bunq!.id, kind: "profile", data: { brand: { name: "bunq" } } });
    const plan = await planCompanyNameRepair(db);
    expect(plan.map((p) => [p.id, p.from, p.to])).toEqual([[k2!.id, "k2space", "K2 Space"]]);

    const done = await applyCompanyNameRepair(db, plan);
    expect(done).toHaveLength(1);
    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, k2!.id));
    expect(row?.name).toBe("K2 Space");
    expect(row?.nameKey).toBe("k2 space");
    // The slug stays one of the company's names, so a reading that writes it still finds the company.
    const aliases = await db.select().from(schema.companyAliases).where(eq(schema.companyAliases.companyId, k2!.id));
    expect(aliases.map((a) => [a.kind, a.aliasKey, a.alias])).toContainEqual(["name", "k2space", "k2space"]);
    // A row renamed since the plan was read is left alone.
    expect(await applyCompanyNameRepair(db, plan)).toEqual([]);
  });
});
