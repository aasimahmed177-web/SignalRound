// Two namesake guards that live on the store: a folded company's old id still reaches the company
// (Slack deliveries linked the HEO Robotics and Sol Foundry pages before those rows were folded), and
// the enrich lane takes a company a clear left with only its refused hosts, never one mid-repair.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../lib/db";
import { clearProfile, replaceProfile } from "../lib/enrich";
import { foldedInto } from "../lib/entity-exists";
import { mergeCompanies, persistRecords } from "../lib/persist";
import { pendingStep } from "../workflows/enrich";
import { record } from "./helpers";

vi.mock("workflow/api", () => ({ start: vi.fn(async () => undefined) }));

beforeEach(async () => {
  await (await db()).execute(sql`truncate companies, company_folds, runs cascade`);
});

describe("a folded company's old id", () => {
  test("the HEO case: the fold is recorded, and the old id leads to the survivor, through a later fold too", async () => {
    const handle = await db();
    await handle.insert(schema.companies).values([
      { id: "heo robotics", name: "HEO Robotics", nameKey: "heo robotics", domain: "heorobotics.com" },
      { id: "heo:identity:substack.com", name: "HEO", nameKey: "heo", domain: "heospace.com" },
      { id: "heo-space", name: "HEO", nameKey: "heo" },
    ]);
    await mergeCompanies(handle, "heo robotics", "heo:identity:substack.com");
    expect(await foldedInto(handle, "heo robotics")).toBe("heo:identity:substack.com");
    expect(await foldedInto(handle, "heo:identity:substack.com")).toBeNull();
    // The survivor folded in turn: the first fold follows it.
    await mergeCompanies(handle, "heo:identity:substack.com", "heo-space");
    expect(await foldedInto(handle, "heo robotics")).toBe("heo-space");
    expect(await foldedInto(handle, "heo:identity:substack.com")).toBe("heo-space");
    expect(await handle.select().from(schema.companyFolds).where(eq(schema.companyFolds.fromId, "heo-space"))).toEqual([]);
    expect(await foldedInto(handle, "nobody")).toBeNull();
  });

  test("a fold from before folds were recorded: the old id is the survivor's domain or one of its names", async () => {
    const handle = await db();
    // Sol Foundry (solfoundry.co) was folded into Sol, which took its domain; HEO Robotics left its name behind.
    await handle.insert(schema.companies).values([
      { id: "sol", name: "Sol Foundry Inc.", nameKey: "sol", domain: "solfoundry.co" },
      { id: "heo:identity:substack.com", name: "HEO", nameKey: "heo", domain: "heospace.com" },
    ]);
    await handle
      .insert(schema.companyAliases)
      .values({ companyId: "heo:identity:substack.com", kind: "name", aliasKey: "heo robotics", alias: "HEO Robotics" });
    expect(await foldedInto(handle, "solfoundry.co")).toBe("sol");
    expect(await foldedInto(handle, "heo robotics")).toBe("heo:identity:substack.com");
  });
});

describe("the enrich lane and a repair", () => {
  async function gemba() {
    const handle = await db();
    await persistRecords(
      handle,
      [
        record({
          company_name: "GEMBA",
          company_key: "gemba",
          company_domain: "jp-gemba.com",
          company_website: "https://jp-gemba.com",
          stage: "seed",
          stage_as_written: "seed",
          confidence: 0.95,
        }),
      ],
      "seed",
      "run-1",
    );
    // On the feed, where the lane looks.
    await handle.update(schema.fundingRounds).set({ disposition: "publish" });
    const [company] = await handle.select({ id: schema.companies.id }).from(schema.companies);
    return { handle, id: company.id };
  }

  test("a company with no profile row is pending; a hand-written replacement is never; a clear that keeps refused hosts is again", async () => {
    const { handle, id } = await gemba();
    expect((await pendingStep("seed", 10)).map((c) => c.id)).toEqual([id]);
    await replaceProfile(handle, id, { website: "https://jp-gemba.com", refuse: ["thegemba.com"], note: "set by hand" });
    expect(await pendingStep("seed", 10)).toEqual([]);
    await clearProfile(handle, id);
    expect((await pendingStep("seed", 10)).map((c) => c.id)).toEqual([id]);
    const [row] = await handle.select().from(schema.enrichments).where(eq(schema.enrichments.companyId, id));
    expect(row?.data).toMatchObject({ retry: true, refused_hosts: ["thegemba.com"] });
  });
});
