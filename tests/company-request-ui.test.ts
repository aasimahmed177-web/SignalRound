process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import RequestPage from "../app/(dashboard)/requests/[id]/page";
import { CompanyEmptyState } from "../components/company/company-empty-state";
import { CompanyRequestCallout } from "../components/company/company-request-callout";
import { DossierPending } from "../components/company/dossier-pending";
import { AlsoFound, alsoFound, RequestFundingHistory } from "../components/company/request-funding-history";
import { RequestProgress } from "../components/company/request-progress";
import { RequestProvenance } from "../components/company/request-provenance";
import { paletteOptions } from "../components/search/palette-items";
import { CompanyRequestsList, dossierNote } from "../components/settings/company-requests-list";
import { getCompany } from "../lib/company";
import {
  addRequest,
  dismissRequest,
  markFinished,
  markViewed,
  parseRequestHistory,
  pruneRequests,
  requestLine,
} from "../lib/company-request-history";
import { dossierPending, publicRequestStatus, requestSteps, tallyFromLedger, tallyMessage } from "../lib/company-request-status";
import { shouldSuggestCompany, websiteFromQuery } from "../lib/company-request-ui";
import { companyRequestFor } from "../lib/company-requests";
import { db } from "../lib/db";
import { loadVisibleIds } from "../lib/entity-exists";
import { navItemsFor } from "../lib/nav";
import { gate, proxy } from "../proxy";

beforeEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.COMPANY_REQUESTS;
  await (await db()).execute(sql`truncate table companies cascade`);
});

describe("flagged entry points", () => {
  test("a description hit does not hide the callout, but a name or domain prefix does", () => {
    expect(shouldSuggestCompany("apple", [{ name: "Feather Robotics", domain: "feather.ai" }])).toBe(true);
    expect(shouldSuggestCompany("apple", [{ name: "Apple", domain: "apple.com" }])).toBe(false);
    expect(shouldSuggestCompany("apple", [{ name: "AppleTree", domain: "tree.example" }])).toBe(false);
    expect(shouldSuggestCompany("apple", [{ name: "Different", domain: "apple.com" }])).toBe(false);
    expect(shouldSuggestCompany("https://www.apple.com/about", [{ name: "Different", domain: "apple.com" }])).toBe(false);
    expect(shouldSuggestCompany("apple", [])).toBe(true);
    expect(shouldSuggestCompany("", [])).toBe(false);
  });

  test("the callout offers an inline website form and only domain-like terms are prefilled", () => {
    const callout = renderToStaticMarkup(createElement(CompanyRequestCallout, { query: "missing.example" }));
    expect(callout).toContain("Looking for &quot;missing.example&quot;?");
    expect(callout).toContain('value="missing.example"');
    expect(callout).toContain("The company&#x27;s own website, for example apple.com");
    expect(callout).toContain("Research it");
    expect(renderToStaticMarkup(createElement(CompanyEmptyState, { q: "missing.example" }))).not.toContain("Research it");
    expect(websiteFromQuery("https://www.missing.co.uk/path")).toBe("https://www.missing.co.uk/path");
    expect(websiteFromQuery("Missing Company")).toBe("");
  });

  test("the palette action follows results for any nonempty query, and is absent with the flag off", () => {
    const items = navItemsFor(undefined);
    const hits = {
      companies: [
        {
          kind: "company" as const,
          id: "feather",
          name: "Feather Robotics",
          detail: "Apple supplier",
          domain: "feather.ai",
          logo_url: null,
        },
      ],
      investors: [],
    };
    const options = paletteOptions(items, "apple", hits, true);
    expect(options.at(-1)).toMatchObject({ group: "Research", label: 'Research "apple"', lead: { kind: "request" } });
    expect(options.findIndex((o) => o.lead.kind === "company")).toBeLessThan(options.length - 1);
    expect(paletteOptions(items, "apple", hits, false).some((o) => o.lead.kind === "request")).toBe(false);
    expect(paletteOptions(items, "", hits, true).some((o) => o.lead.kind === "request")).toBe(false);
  });
});

describe("one company address per request", () => {
  const id = "7990bb45-e603-4396-aa13-19322c5a9171";
  const insert = (set: Partial<typeof schema.companyRequests.$inferInsert> = {}) =>
    db().then((handle) =>
      handle
        .insert(schema.companyRequests)
        .values({ id, domain: "acme.com", submittedUrl: "https://acme.com/", requesterHash: "private", ...set }),
    );

  test("researching, done, and refused requests have a page at the domain; no request is a 404", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    const handle = await db();
    expect(await companyRequestFor(handle, "acme.com")).toBeNull();
    expect((await loadVisibleIds()).companies).not.toContain("acme.com");

    await insert({ status: "running", step: "history", message: "Researching the company's funding history." });
    const running = await companyRequestFor(handle, "acme.com");
    expect(running).toMatchObject({ status: "running", step: "history" });
    expect((await loadVisibleIds()).companies).toContain("acme.com");
    const researching = renderToStaticMarkup(
      createElement(RequestProgress, { initial: publicRequestStatus(running as NonNullable<typeof running>) }),
    );
    expect(researching).toContain("Funding search");
    expect(researching).toContain("Firecrawl Agent, usually 3 to 8 minutes");
    expect(researching).toContain("You don&#x27;t need to stay on this page.");
    expect(researching).toContain('href="/companies"');
    expect(researching).not.toContain("private");

    await handle
      .update(schema.companyRequests)
      .set({ status: "refused", message: "The website could not be verified as a company homepage." })
      .where(eq(schema.companyRequests.id, id));
    const stopped = await companyRequestFor(handle, "acme.com");
    const refused = renderToStaticMarkup(
      createElement(RequestProgress, { initial: publicRequestStatus(stopped as NonNullable<typeof stopped>) }),
    );
    expect(refused).toContain("The website could not be verified as a company homepage.");
    expect(refused).toContain("search the feed");
    expect((await loadVisibleIds()).companies).toContain("acme.com");

    await handle.insert(schema.companies).values({ id: "acme.com", name: "Acme", nameKey: "acme", domain: "acme.com" });
    await handle
      .update(schema.companyRequests)
      .set({ status: "done", companyId: "acme.com", message: "Company added. Research found no earlier funding rounds to check." })
      .where(eq(schema.companyRequests.id, id));
    expect(publicRequestStatus((await companyRequestFor(handle, "acme.com")) as NonNullable<typeof running>).companyUrl).toBe(
      "/companies/acme.com",
    );
    expect(await getCompany(handle, "acme.com")).toMatchObject({ addedOnRequest: true, rounds: [] });

    vi.stubEnv("COMPANY_REQUESTS", "0");
    await handle.update(schema.companyRequests).set({ status: "running" }).where(eq(schema.companyRequests.id, id));
    expect((await loadVisibleIds()).companies).not.toContain("acme.com");
  });

  test("an old request link redirects to the company address; an unknown id stays a 404", async () => {
    vi.stubEnv("COMPANY_REQUESTS", "1");
    vi.stubEnv("PUBLIC_DEMO", "1");
    const missing = await proxy(new NextRequest(`https://fireround.dev/requests/${id}`));
    expect(missing.headers.get("x-middleware-rewrite")).toContain(`/_missing/requests/${id}`);
    await expect(RequestPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    await insert();
    const moved = await proxy(new NextRequest(`https://fireround.dev/requests/${id}?x=1`));
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("https://fireround.dev/companies/acme.com");
    await expect(RequestPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
    vi.stubEnv("COMPANY_REQUESTS", "0");
    await expect(RequestPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
  });

  test("the branding read shows while research runs and never once the site is refused", () => {
    const base = {
      id,
      domain: "acme.com",
      step: "website" as const,
      message: null,
      tally: null,
      companyId: null,
      createdAt: new Date(),
      brand: { name: "Acme Robotics", logo: "https://acme.com/logo.svg", color: "#123456" },
    };
    const running = renderToStaticMarkup(createElement(RequestProgress, { initial: publicRequestStatus({ ...base, status: "running" }) }));
    expect(running).toContain("Acme Robotics");
    expect(running).toContain(`/api/logo/${id}?kind=request&amp;ui=1`);
    const refusedStatus = publicRequestStatus({
      ...base,
      status: "refused",
      message: "The website could not be verified as a company homepage.",
    });
    expect(refusedStatus.brand).toBeNull();
    const refused = renderToStaticMarkup(createElement(RequestProgress, { initial: refusedStatus }));
    expect(refused).not.toContain("Acme Robotics");
    expect(refused).not.toContain("kind=request");
  });

  test("steps tick off in order; the dossier ticks on its own and may still run on a done request", () => {
    const states = (
      status: "queued" | "running" | "done" | "refused" | "failed",
      step: "website" | "profile" | "history" | "rounds" | null,
      dossier: "running" | "done" | "failed" | null = null,
    ) => requestSteps({ status, step, dossier: dossier && { status: dossier, startedAt: null, finishedAt: null } }).map((s) => s.state);
    // website, profile, funding search, company dossier, earlier rounds verified
    expect(states("queued", null)).toEqual(["current", "pending", "pending", "pending", "pending"]);
    expect(states("running", "profile")).toEqual(["done", "current", "pending", "pending", "pending"]);
    expect(states("running", "history", "running")).toEqual(["done", "done", "current", "current", "pending"]);
    expect(states("done", "rounds", "running")).toEqual(["done", "done", "done", "current", "pending"]);
    expect(states("done", "rounds", "done")).toEqual(["done", "done", "done", "done", "done"]);
    expect(states("failed", "history", "running")).toEqual(["done", "done", "pending", "pending", "pending"]);
    const steps = requestSteps({ status: "running", step: "history", dossier: { status: "running", startedAt: null, finishedAt: null } });
    expect(steps.map((s) => s.label)).toEqual([
      "Website checked",
      "Company profile",
      "Funding search",
      "Company dossier",
      "Earlier rounds verified",
    ]);
    expect(steps[3].hint).toBe("Firecrawl Agent, usually 3 to 8 minutes");
    expect(
      requestSteps({ status: "done", step: "rounds", dossier: { status: "failed", startedAt: null, finishedAt: null } })[3],
    ).toMatchObject({
      state: "pending",
      hint: "did not finish",
    });
    const tally = {
      found: 4,
      verified: 1,
      priors: [
        { label: "Seed", verified: true, reason: null },
        { label: "Series A", verified: false, reason: "no dated announcement found" },
        { label: "Series B", verified: false, reason: "still checking" },
        { label: "Series C", verified: false, reason: "still checking" },
      ],
    };
    expect(requestSteps({ status: "running", step: "rounds", tally })[4]).toMatchObject({ hint: "2 of 4 checked", state: "current" });
    const allChecked = {
      ...tally,
      priors: tally.priors.map((p) => ({ ...p, reason: p.reason === "still checking" ? "no page found" : p.reason })),
    };
    expect(requestSteps({ status: "running", step: "rounds", tally: allChecked })[4]).toMatchObject({
      hint: "4 of 4 checked",
      state: "done",
    });
    expect(requestSteps({ status: "done", step: "rounds", tally: { found: 0, verified: 0, priors: [] } })[4]).toMatchObject({
      hint: "none found",
      state: "done",
    });
    expect(dossierPending({ status: "done", dossier: { status: "running", startedAt: null, finishedAt: null } })).toBe(true);
    expect(dossierPending({ status: "done", dossier: { status: "done", startedAt: null, finishedAt: null } })).toBe(false);
    expect(dossierPending({ status: "running", dossier: { status: "running", startedAt: null, finishedAt: null } })).toBe(false);
  });

  test("a requested company with rounds lists what else was found and why it is not verified", () => {
    const tally = {
      found: 3,
      verified: 1,
      priors: [
        { label: "Seed, $3M, 2023-07", verified: true, reason: null, source: "funding search" },
        { label: "Series A, $18M", verified: false, reason: "no dated announcement found", source: "funding search" },
        { label: "Series B, $40M, 2025", verified: false, reason: "still checking", source: "company dossier" },
      ],
    };
    expect(alsoFound(tally).map((p) => p.label)).toEqual(["Series A, $18M"]);
    const html = renderToStaticMarkup(createElement(AlsoFound, { tally }));
    expect(html).toContain("ALSO FOUND, NOT VERIFIED");
    expect(html).toContain("Series A, $18M");
    expect(html).toContain("no dated announcement found · found by funding search");
    expect(renderToStaticMarkup(createElement(AlsoFound, { tally: { ...tally, priors: [tally.priors[0]] } }))).toBe("");
  });

  test("the still-researching line shows while the dossier runs", () => {
    expect(renderToStaticMarkup(createElement(DossierPending, { id }))).toContain(
      "Still researching: a company dossier from Firecrawl&#x27;s Agent may add earlier rounds and founders.",
    );
    const html = renderToStaticMarkup(
      createElement(RequestFundingHistory, { tally: { found: 0, verified: 0, priors: [] }, dossierRunning: true }),
    );
    expect(html).toContain("The funding search found no earlier rounds.");
    expect(dossierNote({ dossierStatus: "done", dossierStartedAt: new Date(0), dossierFinishedAt: new Date(372_000) })).toBe(
      "dossier 6 min 12 s",
    );
    expect(dossierNote({ dossierStatus: "running", dossierStartedAt: new Date(0), dossierFinishedAt: null })).toBe("dossier running");
  });
});

describe("your requests", () => {
  const a = { id: "7990bb45-e603-4396-aa13-19322c5a9171", domain: "acme.com", submittedAt: 1_000 };
  const b = { id: "8990bb45-e603-4396-aa13-19322c5a9171", domain: "beta.com", submittedAt: 2_000 };

  test("storage is parsed defensively, newest first, one entry per domain", () => {
    expect(parseRequestHistory(null)).toEqual([]);
    expect(parseRequestHistory("{not json")).toEqual([]);
    expect(parseRequestHistory(JSON.stringify([a, { id: "x", domain: "bad.com", submittedAt: 1 }, { ...b, outcome: "maybe" }]))).toEqual([
      a,
    ]);
    const list = addRequest(addRequest([], a), b);
    expect(list.map((r) => r.domain)).toEqual(["beta.com", "acme.com"]);
    const again = { ...a, id: "9990bb45-e603-4396-aa13-19322c5a9171", submittedAt: 3_000 };
    expect(addRequest(list, again).map((r) => r.id)).toEqual([again.id, b.id]);
  });

  test("dismissal removes one; finished requests age out seven days after they finish", () => {
    const day = 86_400_000;
    const list = markFinished(addRequest(addRequest([], a), b), a.id, "done", 10 * day);
    expect(list.find((r) => r.id === a.id)).toMatchObject({ finishedAt: 10 * day, outcome: "done" });
    expect(markFinished(list, a.id, "failed", 11 * day).find((r) => r.id === a.id)?.finishedAt).toBe(10 * day);
    expect(pruneRequests(list, 16 * day).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(pruneRequests(list, 17 * day).map((r) => r.id)).toEqual([b.id]);
    expect(dismissRequest(list, b.id).map((r) => r.id)).toEqual([a.id]);
  });

  test("a finished result leaves the list once seen; a running request never does", () => {
    const running = addRequest([], a);
    expect(pruneRequests(running, 60 * 86_400_000)).toEqual(running);
    // View clicked on a done request.
    const clicked = markViewed(markFinished(running, a.id, "done", 5_000), (r) => r.id === a.id, "done", 6_000);
    expect(clicked[0]).toMatchObject({ viewed: true, outcome: "done", finishedAt: 5_000 });
    expect(pruneRequests(clicked, 7_000)).toEqual([]);
    // The company page rendered in its done state before the list had polled.
    const rendered = markViewed(running, (r) => r.domain === "acme.com", "done", 8_000);
    expect(rendered[0]).toMatchObject({ viewed: true, outcome: "done", finishedAt: 8_000 });
    expect(pruneRequests(rendered, 8_001)).toEqual([]);
    // A refused result page seen.
    expect(
      pruneRequests(
        markViewed(running, (r) => r.id === a.id, "refused", 9_000),
        9_001,
      ),
    ).toEqual([]);
    // Another request's page leaves this one alone.
    expect(markViewed(running, (r) => r.domain === "beta.com", "done", 9_000)).toEqual(running);
  });

  test("each line says where the request stands", () => {
    expect(requestLine("running", 0, 150_000)).toBe("researching · 2 min");
    expect(requestLine(null, 0, 10_000)).toBe("researching · 1 min");
    expect(requestLine("done", 0, 0)).toBe("ready");
    expect(requestLine("refused", 0, 0)).toBe("couldn't verify");
    expect(requestLine("failed", 0, 0)).toBe("couldn't verify");
  });
});

describe("research tally", () => {
  const prior = (stage: string, amount: string | null, date: string | null) => ({
    stage_as_written: stage,
    amount_as_written: amount,
    announced_date: date,
    lead_investors: [],
  });

  test("the completion message names what was found, verified, and why the rest was not", () => {
    const apple = tallyFromLedger([
      { prior: prior("Angel investment", "$250,000", "1977"), status: "no_source", outcome: { reason: "no page states it" } },
      { prior: prior("Venture round", "$517,000", "1978"), status: "no_source", outcome: { reason: "no page states it" } },
    ]);
    expect(apple).toEqual({
      found: 2,
      verified: 0,
      priors: [
        {
          label: "Angel investment, $250,000, 1977",
          verified: false,
          reason: "no dated announcement online from the 1970s",
          source: "company dossier",
        },
        {
          label: "Venture round, $517,000, 1978",
          verified: false,
          reason: "no dated announcement online from the 1970s",
          source: "company dossier",
        },
      ],
    });
    expect(tallyMessage(apple)).toBe(
      "Found 2 earlier rounds in research, verified 0: no dated announcement online from the 1970s for either.",
    );
    const mixed = tallyFromLedger([
      { prior: prior("Seed", "$2M", "2021"), status: "promoted", outcome: { disposition: "publish" } },
      { prior: prior("Series A", null, null), status: "no_source", outcome: { reason: "no candidate page" } },
      { prior: prior("Grant", null, null), status: "skipped", outcome: null },
    ]);
    expect(tallyMessage(mixed)).toBe(
      "Found 3 earlier rounds in research, verified 1. Not verified: no page found (1), not enough detail to search (1).",
    );
    const recent = tallyFromLedger([
      { prior: prior("Series A", "$10M", "2021-04"), status: "no_source", outcome: { reason: "no page states it" } },
    ]);
    expect(tallyMessage(recent)).toBe("Found 1 earlier round in research, verified 0: no dated announcement found for it.");
    expect(tallyMessage({ found: 0, verified: 0, priors: [] })).toBe("Company added. Research found no earlier funding rounds to check.");
  });

  test("a requested company with no verified round explains itself instead of empty figures", () => {
    const html = renderToStaticMarkup(
      createElement(RequestFundingHistory, {
        tally: {
          found: 1,
          verified: 0,
          priors: [{ label: "Angel investment, $250,000, 1977", verified: false, reason: "no dated announcement found" }],
        },
      }),
    );
    expect(html).toContain("Research found 1 earlier round. None could be verified.");
    expect(html).toContain("Angel investment, $250,000, 1977");
    expect(html).toContain("no dated announcement found");
    expect(html).toContain("Fireround only lists rounds it can check against a dated announcement.");
  });
});

test("completed provenance controls the quiet company note", async () => {
  const handle = await db();
  await handle.insert(schema.companies).values({ id: "acme", name: "Acme", nameKey: "acme", domain: "acme.com" });
  await handle.insert(schema.companyRequests).values({
    id: crypto.randomUUID(),
    domain: "acme.com",
    submittedUrl: "https://acme.com/",
    requesterHash: "hash",
    status: "done",
    companyId: "acme",
  });
  const page = await getCompany(handle, "acme");
  expect(page?.addedOnRequest).toBe(true);
  expect(renderToStaticMarkup(createElement(RequestProvenance, { addedOnRequest: page?.addedOnRequest ?? false }))).toContain(
    "Added on request",
  );
  expect(renderToStaticMarkup(createElement(RequestProvenance, { addedOnRequest: false }))).toBe("");
});

test("admin request list shows recent domain, status, time, and request link", () => {
  vi.stubEnv("PUBLIC_DEMO", "1");
  expect(gate(new NextRequest("https://fireround.dev/settings")).status).toBe(404);
  const html = renderToStaticMarkup(
    createElement(CompanyRequestsList, {
      requests: [
        {
          id: crypto.randomUUID(),
          domain: "acme.com",
          status: "done",
          companyId: "acme.com",
          tally: { found: 2, verified: 0, priors: [] },
          dossierStatus: null,
          dossierStartedAt: null,
          dossierFinishedAt: null,
          createdAt: new Date("2026-09-26T08:00:00Z"),
        },
      ],
    }),
  );
  expect(html).toContain("acme.com");
  expect(html).toContain("done");
  expect(html).toContain("2026");
  expect(html).toContain('href="/companies/acme.com"');
  expect(html).toContain("found 2, verified 0");
});
