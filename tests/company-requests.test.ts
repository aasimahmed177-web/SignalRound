process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const started = vi.hoisted(() => vi.fn(async () => undefined));
const scrape = vi.hoisted(() => vi.fn());
const bot = vi.hoisted(() => vi.fn());
vi.mock("workflow/api", () => ({ start: started }));
vi.mock("@/lib/firecrawl", () => ({ getFirecrawl: () => ({ scrape }) }));
vi.mock("botid/server", () => ({ checkBotId: bot }));
// Every public hostname resolves to a public address, so no test touches DNS; a test that passes its
// own resolver still gets it.
vi.mock("@/lib/safe-fetch", async (original) => {
  const real = await original<typeof import("../lib/safe-fetch")>();
  return { ...real, publicUrl: (raw: string, resolve?: Resolve) => real.publicUrl(raw, resolve ?? (async () => ["8.8.8.8"])) };
});

import { GET } from "../app/api/company-requests/[id]/route";
import { POST } from "../app/api/company-requests/route";
import { getCompany } from "../lib/company";
import { knownCompany, limitMessage, normalizeCompanyWebsite, waitPhrase } from "../lib/company-requests";
import { db } from "../lib/db";
import { enqueueDeliveries } from "../lib/delivery";
import { loadVisibleIds } from "../lib/entity-exists";
import { feedHistory, listRounds, persistRecords } from "../lib/persist";
import { rateLimit, resetRateLimitsForTests } from "../lib/rate-limit";
import { queueFundingSearch } from "../lib/request-research";
import type { Resolve } from "../lib/safe-fetch";
import { createEmailTarget, createTarget } from "../lib/settings";
import { enqueueSubscriptions } from "../lib/slack-delivery";
import { trendingRoundIds } from "../lib/trending";
import { brandStep, researchHomepage } from "../workflows/company-request";
import { record } from "./helpers";
import { reader } from "./history-fixtures";

/** A homepage's worth of its own text: the identity check needs a page that says what the company does. */
const HOME_TEXT =
  "Acme builds software for finance teams: close the books faster, reconcile every account, and report with confidence. Trusted by finance leaders at growing companies around the world. About us, careers, press, blog, contact sales, help center, privacy policy, terms of service, cookie settings, and our newsletter for product updates and customer stories. See how teams automate approvals, forecast cash, and give every stakeholder a live view of the numbers, with integrations for the tools they already use.";

const url = "https://acme.example.com/path";
const submit = (website = url, address = "203.0.113.4") =>
  POST(
    new Request("https://fireround.dev/api/company-requests", {
      method: "POST",
      headers: { origin: "https://fireround.dev", host: "fireround.dev", "x-forwarded-for": address, "content-type": "application/json" },
      body: JSON.stringify({ url: website }),
    }),
  );

beforeEach(async () => {
  started.mockClear();
  scrape.mockReset();
  bot.mockReset();
  await resetRateLimitsForTests();
  await (await db()).execute(sql`truncate table companies cascade`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.COMPANY_REQUESTS;
  delete process.env.COMPANY_REQUESTS_DAILY_MAX;
});

describe("website validation", () => {
  test("normalizes subdomains and paths to one registrable domain", async () => {
    expect(await normalizeCompanyWebsite("https://www.acme.co.uk/products?q=1")).toEqual({
      domain: "acme.co.uk",
      url: "https://acme.co.uk/",
    });
    expect(await normalizeCompanyWebsite("acme.co.uk")).toEqual({ domain: "acme.co.uk", url: "https://acme.co.uk/" });
  });

  test("refuses internal addresses, unsafe schemes, and non-company hosts", async () => {
    const actual = await vi.importActual<typeof import("../lib/company-requests")>("@/lib/company-requests");
    for (const bad of [
      "http://127.0.0.1/",
      "http://localhost/",
      "ftp://acme.com",
      "http://169.254.169.254/",
      "https://linkedin.com/company/acme",
      "https://techcrunch.com/acme",
      "https://crunchbase.com/organization/acme",
      "https://acme.com:8080/",
    ]) {
      expect(await normalizeCompanyWebsite(bad), bad).toBeNull();
    }
    expect(await actual.normalizeCompanyWebsite("https://acme.com", async () => ["10.0.0.1"])).toBeNull();
  });
});

describe("submission", () => {
  test("BotID stops a classified bot before opening a research job", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("VERCEL", "1");
    bot.mockResolvedValue({ isBot: true });
    expect((await submit()).status).toBe(403);
    expect(started).not.toHaveBeenCalled();
  });

  test("the flag off hides both APIs before any spend", async () => {
    expect((await submit()).status).toBe(404);
    expect((await GET(new Request("https://fireround.dev"), { params: Promise.resolve({ id: crypto.randomUUID() }) })).status).toBe(404);
    expect(started).not.toHaveBeenCalled();
  });

  test("dedupes an active domain and returns an existing company's page", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    const first = await submit();
    expect(first.status).toBe(202);
    const { id } = await first.json();
    expect((await (await submit("https://www.acme.example.com/other")).json()).id).toBe(id);
    expect(started).toHaveBeenCalledTimes(1);
    const status = await GET(new Request("https://fireround.dev"), { params: Promise.resolve({ id }) });
    expect((await status.json()).status).toBe("queued");
    expect(status.headers.get("cache-control")).toBe("no-store");
    await (await db()).insert(schema.companies).values({ id: "acme", name: "Acme", nameKey: "acme", domain: "acme.com" });
    await (await db()).insert(schema.companyRequests).values({
      id: crypto.randomUUID(),
      domain: "acme.com",
      submittedUrl: "https://acme.com/",
      requesterHash: "hash",
      companyId: "acme",
      status: "done",
    });
    expect(await knownCompany(await db(), "acme.com")).toBe("acme");
    expect((await (await submit("https://acme.com")).json()).companyUrl).toBe("/companies/acme");
    expect(started).toHaveBeenCalledTimes(1);
  });

  test("enforces three per address and a global cap across addresses", async () => {
    vi.stubEnv("PUBLIC_DEMO", "1");
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("COMPANY_REQUESTS_DAILY_MAX", "4");
    for (let i = 0; i < 3; i++) expect((await submit(`https://firm${i}.com`)).status).toBe(202);
    expect((await submit("https://fourth.com")).status).toBe(429);
    expect((await submit("https://fourth.com", "203.0.113.5")).status).toBe(202);
    expect((await submit("https://fifth.com", "203.0.113.6")).status).toBe(429);
    expect(started).toHaveBeenCalledTimes(4);
  });

  test("a private instance's operator skips the per-address limit, never the global cap", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("COMPANY_REQUESTS_DAILY_MAX", "5");
    for (let i = 0; i < 5; i++) expect((await submit(`https://firm${i}.com`)).status).toBe(202);
    const over = await submit("https://sixth.com");
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/^Fireround has reached today's research limit\. Try again in about /);
  });

  test("a wait reads in minutes and hours", () => {
    expect(waitPhrase(20)).toBe("about a minute");
    expect(waitPhrase(600)).toBe("about 10 minutes");
    expect(waitPhrase(3600)).toBe("about 1 hour");
    expect(waitPhrase(5537)).toBe("about 1 hour 32 minutes");
    expect(limitMessage("address", 5537)).toBe(
      "You've used today's 3 research requests. You can request another in about 1 hour 32 minutes.",
    );
  });
});

describe("homepage identity", () => {
  test("the existing enrichment verifies a homepage and saves its profile", async () => {
    const id = crypto.randomUUID();
    await (await db())
      .insert(schema.companyRequests)
      .values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "hash" });
    scrape.mockResolvedValue({
      json: {
        what_they_sell: "Software for finance teams.",
        customer_type: "B2B software",
        sells_software_subscription: true,
        identity_reason: "This is Acme's website.",
        different_business: null,
        same_company: true,
      },
      branding: { brandName: "Acme" },
      markdown: HOME_TEXT,
      links: [],
      metadata: {},
    });
    expect(await researchHomepage(id)).toEqual({ status: "verified", companyId: "acme.com" });
    expect(scrape).toHaveBeenCalled();
    const [request] = await (await db()).select().from(schema.companyRequests);
    expect(request.step).toBe("profile");
    const [company] = await (await db()).select().from(schema.companies);
    expect(company.description).toBe("Software for finance teams.");
    expect((await (await db()).select().from(schema.enrichments)).some((row) => row.kind === "profile")).toBe(true);
    expect(await researchHomepage(id)).toEqual({ status: "verified", companyId: "acme.com" });
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  test("a different business is refused without leaving a public company", async () => {
    const id = crypto.randomUUID();
    await (await db())
      .insert(schema.companyRequests)
      .values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "hash" });
    scrape.mockResolvedValue({
      json: {
        what_they_sell: "Personal diary.",
        customer_type: "other",
        sells_software_subscription: false,
        identity_reason: "A personal diary, not a company.",
        different_business: "personal blog",
        same_company: false,
      },
      branding: { brandName: "Someone Else" },
      links: [],
      metadata: {},
    });
    expect(await researchHomepage(id)).toEqual({ status: "refused" });
    expect(await (await db()).select().from(schema.companies)).toEqual([]);
  });
});

test("a completed request has a company page and proxy visibility without any round", async () => {
  const handle = await db();
  await handle.insert(schema.companies).values({ id: "acme.com", name: "Acme", nameKey: "acme", domain: "acme.com" });
  await handle.insert(schema.companyRequests).values({
    id: crypto.randomUUID(),
    domain: "acme.com",
    submittedUrl: "https://acme.com/",
    requesterHash: "hash",
    companyId: "acme.com",
    status: "done",
    message: "No earlier funding round could be verified.",
  });
  expect((await loadVisibleIds()).companies).toContain("acme.com");
  const page = await getCompany(handle, "acme.com");
  expect(page?.rounds).toEqual([]);
  expect(page?.company.website).toBeNull();
});

test("a requested round dated within fourteen days never queues any delivery or enters default views", async () => {
  const handle = await db();
  const id = "acme.com";
  await handle.insert(schema.companies).values({ id, name: "Acme", nameKey: "acme", domain: "acme.com" });
  await handle.insert(schema.companyRequests).values({
    id: crypto.randomUUID(),
    domain: "acme.com",
    submittedUrl: "https://acme.com/",
    requesterHash: "hash",
    companyId: id,
    status: "done",
  });
  const announced = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const round = record({ id: `acme:series_a:${announced}`, company_name: "Acme", company_key: "acme", announced_date: announced });
  await persistRecords(handle, [round], "series-a-b", "company-request:test", { history: true, companyId: id });
  expect((await getCompany(handle, id))?.rounds.map((row) => row.id)).toEqual([round.id]);
  expect((await loadVisibleIds()).companies).toContain(id);
  await createTarget(handle, { channel: "slack", target: "https://hooks.slack.test/abc" });
  await createTarget(handle, { channel: "webhook", target: "https://hooks.example.test/funding" });
  await createEmailTarget(handle, { target: "hello@example.com", cadence: "daily" });
  expect(await enqueueDeliveries(handle, [round.id], "series-a-b")).toBe(0);
  expect(await enqueueSubscriptions(handle, (await listRounds(handle, { ids: [round.id] })).rows)).toBe(0);
  expect(await handle.select().from(schema.deliveries)).toEqual([]);
  expect((await listRounds(handle, { history: feedHistory({}) })).rows.map((row) => row.id)).not.toContain(round.id);
  expect(await trendingRoundIds(handle, new Date())).not.toContain(round.id);
  expect((await listRounds(handle, { history: "exclude" })).rows.map((row) => row.id)).not.toContain(round.id);
  expect((await listRounds(handle, { companyId: id })).rows.map((row) => row.id)).toContain(round.id);
});

test("request budgets fail closed when shared rate counting is unavailable", async () => {
  const handle = await db();
  await handle.execute(sql`alter table rate_limits rename to rate_limits_unavailable`);
  try {
    const limit = { bucket: "request-outage", limit: 3, windowMs: 86_400_000 };
    expect((await rateLimit(limit, "203.0.113.40", Date.now(), true)).ok).toBe(false);
  } finally {
    await handle.execute(sql`alter table rate_limits_unavailable rename to rate_limits`);
  }
});

describe("sibling sites", () => {
  test("the sibling sites the homepage links become the company's own, and the funding search maps them too", async () => {
    const handle = await db();
    const id = crypto.randomUUID();
    await handle
      .insert(schema.companyRequests)
      .values({ id, domain: "tldraw.com", submittedUrl: "https://www.tldraw.com/", requesterHash: "h" });
    scrape.mockResolvedValue({
      json: {
        what_they_sell: "A collaborative whiteboard and an infinite canvas SDK.",
        customer_type: "developer tool or API",
        sells_software_subscription: true,
        identity_reason: "tldraw's own site.",
        different_business: null,
        same_company: true,
      },
      branding: { brandName: "tldraw" },
      markdown: HOME_TEXT,
      links: ["https://tldraw.dev/", "https://github.com/tldraw/tldraw", "https://tldraw.substack.com/", "https://canvas.io/"],
      metadata: {},
    });
    await brandStep(id);
    expect(await researchHomepage(id)).toEqual({ status: "verified", companyId: "tldraw.com" });
    const aliases = await handle
      .select({ key: schema.companyAliases.aliasKey })
      .from(schema.companyAliases)
      .where(sql`${schema.companyAliases.kind} = 'domain'`);
    expect(aliases.map((a) => a.key).sort()).toEqual(["tldraw.dev", "tldraw.substack.com"]);
    const { reader: r } = reader();
    const mapped: string[] = [];
    r.map = async (domain) => {
      mapped.push(domain);
      return [];
    };
    await queueFundingSearch(handle, r, "tldraw.com");
    expect(mapped[0]).toBe("tldraw.com");
    expect(mapped).toHaveLength(2);
  });
});

describe("clean names", () => {
  test("the company is saved and searched under its clean name", async () => {
    const handle = await db();
    const id = crypto.randomUUID();
    await handle
      .insert(schema.companyRequests)
      .values({ id, domain: "resend.com", submittedUrl: "https://resend.com/", requesterHash: "h" });
    scrape.mockResolvedValue({
      json: {
        what_they_sell: "Email API for developers.",
        customer_type: "developer tool or API",
        sells_software_subscription: true,
        identity_reason: "Resend's own site.",
        different_business: null,
        same_company: true,
      },
      branding: { brandName: "Resend · Email for developers" },
      markdown: HOME_TEXT,
      links: [],
      metadata: {},
    });
    expect(await researchHomepage(id)).toEqual({ status: "verified", companyId: "resend.com" });
    const [company] = await handle.select().from(schema.companies);
    expect(company).toMatchObject({ name: "Resend", nameKey: "resend" });
    const { reader: r } = reader();
    const queries: string[] = [];
    r.search = async (q) => {
      queries.push(q);
      return [];
    };
    r.map = async (_domain, q) => {
      queries.push(q);
      return [];
    };
    await queueFundingSearch(handle, r, "resend.com");
    expect(queries.sort()).toEqual(['"Resend" funding', '"Resend" raises', '"Resend" seed round', "Resend funding raises series seed"]);
    await handle.execute(sql`update companies set name = 'Resend · Email for developers' where id = 'resend.com'`);
    queries.length = 0;
    await queueFundingSearch(handle, r, "resend.com");
    expect(queries).toContain("Resend funding raises series seed");
    expect(queries.every((q) => !q.includes("Email for developers"))).toBe(true);
  });
});
