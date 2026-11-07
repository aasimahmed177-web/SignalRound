import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { beforeEach, describe, expect, test } from "vitest";
import { ageLabel, applyLink, jobEmails, jobFit, splitJobs } from "../components/jobs/job-view";
import { isAdminPath } from "../lib/access";
import { industryLabel, isPosted, listLeads } from "../lib/leads";
import { visibleNav } from "../lib/nav";
import { testDb } from "./helpers";

let handle: Db;

async function signal(
  id: string,
  company: string,
  metadata: Record<string, unknown>,
  extra: Partial<typeof schema.signalObservations.$inferInsert> = {},
) {
  await handle.insert(schema.signalObservations).values({
    id,
    channel: "funding-news",
    url: `https://news.example.org/${id}`,
    title: `${company} raises`,
    summary: `${company} builds things.`,
    company,
    publishedAt: new Date("2026-11-05T00:00:00Z"),
    metadata,
    ...extra,
  });
}

describe("listLeads", () => {
  beforeEach(async () => {
    handle = await testDb();
    await signal("s1", "Acme", {
      company_website: "https://acme.example.org",
      stage: "Seed",
      amount: "$2M",
      industry: { label: "b2b_saas", confidence: 0.8 },
      other_sources: ["https://other.example.org/acme", "https://news.example.org/s1"],
    });
    await signal("s2", "Bolt", { stage: "Series A", amount: "€5M", industry: "fintech" });
    await signal("s3", "Gone", { stage: "Seed" }, { status: "dismissed" });
    await signal("s4", "Unrelated", {}, { channel: "native-web" });
    await handle.insert(schema.signalPeople).values([
      { id: "p1", signalId: "s1", company: "Acme", name: "Ada Founder", role: "CEO", sourceUrl: "https://acme.example.org/about" },
      { id: "p2", signalId: "s1", company: "Acme", name: "No Email", role: "CTO", sourceUrl: "https://acme.example.org/about" },
    ]);
    await handle.insert(schema.signalEmails).values([
      {
        id: "e1",
        signalId: "s1",
        personId: "p1",
        email: "ada@acme.example.org",
        kind: "founder_personal",
        inbox: "person",
        sourceUrl: "https://acme.example.org/about",
        quote: "Write to Ada at ada@acme.example.org",
      },
      {
        id: "e2",
        signalId: "s1",
        email: "hello@acme.example.org",
        kind: "company_inbox",
        inbox: "general",
        sourceUrl: "https://acme.example.org/contact",
        quote: "hello@acme.example.org",
      },
      // The quote does not show the address: never displayed.
      {
        id: "e3",
        signalId: "s1",
        email: "jobs@acme.example.org",
        kind: "company_inbox",
        inbox: "careers",
        sourceUrl: "https://acme.example.org",
        quote: "Careers",
      },
    ]);
  });

  test("funding observations only, dismissed ones left out, with posted contacts", async () => {
    const listing = await listLeads(handle);
    expect(listing.rows.map((lead) => lead.company).sort()).toEqual(["Acme", "Bolt"]);
    const acme = listing.rows.find((lead) => lead.company === "Acme");
    expect(acme).toMatchObject({ stage: "Seed", amount: "$2M", industry: "b2b_saas", website: "https://acme.example.org" });
    expect(acme?.otherSources).toEqual(["https://other.example.org/acme"]);
    expect(acme?.founders.map((f) => f.name)).toEqual(["Ada Founder"]);
    expect(acme?.founders[0]?.emails.map((e) => e.email)).toEqual(["ada@acme.example.org"]);
    expect(acme?.inboxes.map((e) => e.email)).toEqual(["hello@acme.example.org"]);
    expect(listing.counts).toEqual({ companies: 2, withEmail: 1, founderEmails: 1, inboxes: 1 });
    expect(listing.industries).toEqual(["b2b_saas", "fintech"]);
  });

  test("filters by industry, text, and having an email", async () => {
    expect((await listLeads(handle, { industry: "fintech" })).rows.map((l) => l.company)).toEqual(["Bolt"]);
    expect((await listLeads(handle, { q: "acm" })).rows.map((l) => l.company)).toEqual(["Acme"]);
    expect((await listLeads(handle, { withEmail: true })).rows.map((l) => l.company)).toEqual(["Acme"]);
  });
});

describe("lead helpers", () => {
  test("isPosted needs the page and a quote that contains the address", () => {
    expect(isPosted({ email: "a@b.co", sourceUrl: "https://b.co", quote: "Mail A@B.co" })).toBe(true);
    expect(isPosted({ email: "a@b.co", sourceUrl: "https://b.co", quote: "Contact us" })).toBe(false);
    expect(isPosted({ email: "a@b.co", sourceUrl: "", quote: "a@b.co" })).toBe(false);
  });

  test("industry labels read as words", () => {
    expect(industryLabel("b2b_saas")).toBe("B2B SaaS");
    expect(industryLabel("real_estate")).toBe("Real estate");
  });

  test("Leads is admin-only and hidden from a demo visitor", () => {
    expect(isAdminPath("/leads")).toBe(true);
    expect(visibleNav({ demo: true, admin: false }).some((n) => n.href === "/leads")).toBe(false);
    expect(visibleNav({ demo: true, admin: true }).some((n) => n.href === "/leads")).toBe(true);
  });
});

describe("job view", () => {
  const posting = "https://www.indeed.com/viewjob?jk=1";

  test("emails keep their quote only when the quote shows them; the posting is the source", () => {
    const emails = jobEmails({
      url: posting,
      metadata: {
        public_emails: ["HR@Acme.example.org", "x@acme.example.org", "nope"],
        email_source_quote: "Send CVs to hr@acme.example.org",
      },
    });
    expect(emails).toEqual([
      { email: "hr@acme.example.org", sourceUrl: posting, quote: "Send CVs to hr@acme.example.org" },
      { email: "x@acme.example.org", sourceUrl: posting, quote: null },
    ]);
  });

  test("apply link prefers the employer's page over a job board", () => {
    expect(applyLink({ url: posting, metadata: { apply_url: "https://jobs.lever.co/acme/1" } })).toEqual({
      url: "https://jobs.lever.co/acme/1",
      direct: true,
    });
    expect(applyLink({ url: posting, metadata: { apply_url: "https://www.linkedin.com/jobs/1" } })).toEqual({
      url: posting,
      direct: false,
    });
    expect(applyLink({ url: "https://boards.greenhouse.io/acme/jobs/1", metadata: {} }).direct).toBe(true);
  });

  test("fit reads either shape", () => {
    expect(jobFit({ fit: { score: 72.4, reasons: ["fresh", 3] } })).toEqual({ score: 72, reasons: ["fresh"] });
    expect(jobFit({ fit_score: 40, fit_reasons: ["remote"] })).toEqual({ score: 40, reasons: ["remote"] });
    expect(jobFit({})).toBeNull();
  });

  test("splits by whether the posting printed an email", () => {
    const a = { url: posting, metadata: { public_emails: ["a@acme.example.org"] } };
    const b = { url: posting, metadata: {} };
    expect(splitJobs([a, b])).toEqual({ email: [a], apply: [b] });
  });

  test("age labels", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(ageLabel(new Date("2026-11-07T01:00:00Z"), now)).toBe("today");
    expect(ageLabel(new Date("2026-11-04T12:00:00Z"), now)).toBe("3d ago");
    expect(ageLabel(new Date("2026-09-01T12:00:00Z"), now)).toBe("9w ago");
  });
});
