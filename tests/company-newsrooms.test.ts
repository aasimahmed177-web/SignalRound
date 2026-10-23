process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import type { NativeWebClient as Firecrawl } from "@fireround/core/web";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { checkCompanySection, companyNewsroomTargets, discoverCompany } from "../lib/company-newsrooms";
import { queueNewsroomHistoryLeads } from "../lib/request-research";
import { testDb } from "./helpers";
import { item, round } from "./history-fixtures";

test("a verified homepage adds its linked sibling, stores newsrooms, and claims each fresh post once", async () => {
  const handle = await testDb();
  const id = "acme.test";
  const homepage = `https://${id}`;
  await handle.insert(schema.companies).values({ id, name: "Acme", nameKey: "acme", domain: id, website: homepage });
  await handle.insert(schema.enrichments).values({
    companyId: id,
    kind: "profile",
    data: { company_website: homepage, website_source: "search", profile: { same_company: true } },
  });
  const target = (await companyNewsroomTargets(handle)).find((row) => row.id === id);
  expect(target).toBeDefined();
  expect(target?.top).toBe(true);
  expect(target?.monitor).toBe(true);
  const article = `${homepage}/news/2026/09/27/acme-raises-series-a`;
  const client = {
    scrape: async () => ({ links: [`${homepage}/news`, "https://acme.substack.com/p/acme-funding"] }),
    map: async (url: string) => ({
      links: url === `${homepage}/news` ? [{ url: article }] : [{ url: "https://acme.substack.com/p/acme-funding" }],
    }),
  } as unknown as Firecrawl;
  expect(await discoverCompany(handle, client, target as NonNullable<typeof target>, new Date("2026-09-27T12:00:00Z"))).toBe(2);
  const aliases = await handle.select().from(schema.companyAliases).where(eq(schema.companyAliases.companyId, id));
  expect(aliases.map((a) => a.aliasKey)).toContain("acme.substack.com");
  const sections = await handle.select().from(schema.companyNewsrooms).where(eq(schema.companyNewsrooms.companyId, id));
  expect(sections.map((s) => s.url)).toEqual(expect.arrayContaining([`${homepage}/news`, "https://acme.substack.com"]));

  const now = new Date("2026-09-27T12:00:00Z");
  expect((await checkCompanySection(handle, client, id, `${homepage}/news`, now)).urls).toEqual([article]);
  expect((await checkCompanySection(handle, client, id, `${homepage}/news`, now)).urls).toEqual([]);
  const articleFromPage = `${homepage}/news/2026/09/27/acme-secures-seed-round`;
  const pageLinks = { map: async () => ({ links: [] }), scrape: async () => ({ links: [articleFromPage] }) } as unknown as Firecrawl;
  expect((await checkCompanySection(handle, pageLinks, id, `${homepage}/news`, now)).urls).toEqual([articleFromPage]);
  await handle
    .update(schema.candidates)
    .set({ status: "failed", createdAt: new Date("2026-09-25T12:00:00Z") })
    .where(and(eq(schema.candidates.monitorId, `company:${id}`), eq(schema.candidates.url, article)));
  expect((await checkCompanySection(handle, client, id, `${homepage}/news`, now)).urls).toEqual([article]);
});

test("an explicitly older company post becomes a history lead, not a funding row", async () => {
  const handle = await testDb();
  const id = "history-newsroom.test";
  await handle.insert(schema.companies).values({ id, name: "Footprint", nameKey: "footprint", domain: id });
  const now = new Date("2026-09-27T12:00:00Z");
  const old = item(`https://${id}/news/2026/08/01/seed`, round({ announced_date: "2026-08-01" }));
  const fresh = item(`https://${id}/news/2026/09/26/series-a`, round({ announced_date: "2026-09-26", round_type_as_written: "Series A" }));
  expect(await queueNewsroomHistoryLeads(handle, id, [old, fresh], now)).toBe(1);
  expect(await handle.select().from(schema.historyPromotions).where(eq(schema.historyPromotions.companyId, id))).toHaveLength(1);
  expect(await handle.select().from(schema.fundingRounds).where(eq(schema.fundingRounds.companyId, id))).toHaveLength(0);
});
