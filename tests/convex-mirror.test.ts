import type { schema } from "@fireround/core/db";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { upsert as upsertJobs } from "../convex/jobs";
import { upsert as upsertLead } from "../convex/leads";
import { definedOnly, latestStage, mergeRound, nextOutreachStatus, postedEmail, roundKey } from "../convex/rules";
import { batches, postedJobEmails, toConvexJob } from "../scripts/import-convex-jobs";
import { fromRun, leadsFrom, pushAll } from "../scripts/import-convex-leads";
import { testDb } from "./helpers";

type Doc = Record<string, unknown> & { _id: string };

/** An in-memory ctx.db with Convex's patch rule: a field patched to undefined is removed. */
function fakeDb() {
  const tables: Record<string, Doc[]> = {};
  let next = 0;
  const table = (name: string) => {
    tables[name] ??= [];
    return tables[name];
  };
  const db = {
    query(name: string) {
      let rows = table(name);
      const chain = {
        withIndex(_index: string, build?: (q: unknown) => unknown) {
          const filters: Array<[string, unknown]> = [];
          const q = {
            eq(field: string, value: unknown) {
              filters.push([field, value]);
              return q;
            },
          };
          build?.(q);
          rows = rows.filter((row) => filters.every(([field, value]) => row[field] === value));
          return chain;
        },
        unique: async () => {
          if (rows.length > 1) throw new Error("not unique");
          return rows[0] ?? null;
        },
        collect: async () => [...rows],
      };
      return chain;
    },
    insert: async (name: string, value: Record<string, unknown>) => {
      const _id = `${name}:${++next}`;
      table(name).push({ ...definedOnly(value), _id, _creationTime: next });
      return _id;
    },
    patch: async (id: string, value: Record<string, unknown>) => {
      const row = Object.values(tables)
        .flat()
        .find((doc) => doc._id === id);
      if (!row) throw new Error(`no ${id}`);
      for (const [key, v] of Object.entries(value)) {
        if (v === undefined) delete row[key];
        else row[key] = v;
      }
    },
  };
  return { db, tables, ctx: { db } };
}

// biome-ignore lint/suspicious/noExplicitAny: calls the registered handler directly with a fake ctx.
const run = (fn: unknown, ctx: unknown, args: unknown) => (fn as any)._handler(ctx, args);

const QUOTE = "Write to hello@acme.in for partnerships.";
function lead(overrides: { round?: Record<string, unknown>; contacts?: unknown[]; founders?: unknown[] } = {}) {
  return {
    company: {
      name: "Acme",
      website: "https://www.acme.in",
      category: "",
      description: "",
      operatingStatus: "active",
      personalizationHooks: [],
      relevanceNotes: "",
      sourceUrls: [],
      researchedAt: "2026-11-07T00:00:00.000Z",
    },
    round: {
      stage: "seed",
      stageAsWritten: "Seed",
      amountAsWritten: "$5M",
      currency: "AS_WRITTEN",
      announcedOn: "2026-11-01",
      investors: [],
      sourceUrl: "https://news.example/acme",
      sourceTitle: "",
      evidence: "Acme Seed $5M",
      verificationStatus: "reported",
      ...overrides.round,
    },
    contacts: overrides.contacts ?? [{ email: "hello@acme.in", contactType: "hello", sourceUrl: "https://acme.in/contact", quote: QUOTE }],
    founders: overrides.founders ?? [],
  };
}

describe("leads:upsert", () => {
  test("a re-import keeps outreach progress; needs_contact moves up once an email arrives", async () => {
    const { ctx, tables } = fakeDb();
    await run(upsertLead, ctx, lead());
    expect(tables.companies[0].outreachStatus).toBe("qualified");
    tables.companies[0].outreachStatus = "contacted";
    await run(upsertLead, ctx, lead());
    expect(tables.companies[0].outreachStatus).toBe("contacted");
    tables.companies[0].outreachStatus = "not_a_fit";
    await run(upsertLead, ctx, lead({ contacts: [] }));
    expect(tables.companies[0].outreachStatus).toBe("not_a_fit");

    expect(nextOutreachStatus(null, false)).toBe("needs_contact");
    expect(nextOutreachStatus("needs_contact", true)).toBe("qualified");
    expect(nextOutreachStatus("replied", true)).toBe("replied");
  });

  test("one round per stage: a new amount or earlier date updates it, keeping the earliest date and the disclosed amount", async () => {
    const { ctx, tables } = fakeDb();
    await run(upsertLead, ctx, lead({ round: { amountAsWritten: "$5M", announcedOn: "2026-11-02" } }));
    await run(upsertLead, ctx, lead({ round: { amountAsWritten: "Undisclosed", announcedOn: "2026-11-01" } }));
    await run(upsertLead, ctx, lead({ round: { amountAsWritten: "₹40 Cr", announcedOn: "2026-11-03" } }));
    expect(tables.fundingRounds).toHaveLength(1);
    expect(tables.fundingRounds[0]).toMatchObject({ dedupeKey: "acme.in|seed", announcedOn: "2026-11-01", amountAsWritten: "₹40 Cr" });

    expect(roundKey("acme.in", "seed")).toBe("acme.in|seed");
    const merged = mergeRound(
      { announcedOn: "2026-10-30", amountAsWritten: "$5M", amountUsd: 5_000_000 },
      { announcedOn: "2026-11-01", amountAsWritten: "Undisclosed" },
    );
    expect(merged).toMatchObject({ announcedOn: "2026-10-30", amountAsWritten: "$5M", amountUsd: 5_000_000 });
  });

  test("a legacy-keyed round of the same stage is updated, not duplicated", async () => {
    const { ctx, tables } = fakeDb();
    await run(upsertLead, ctx, lead());
    tables.fundingRounds[0].dedupeKey = "acme.in|seed|2026-11-01|$5m";
    await run(upsertLead, ctx, lead({ round: { amountAsWritten: "$6M" } }));
    expect(tables.fundingRounds).toHaveLength(1);
    expect(tables.fundingRounds[0].dedupeKey).toBe("acme.in|seed");
  });

  test("latestStage follows the latest-dated round, not the last import", async () => {
    const { ctx, tables } = fakeDb();
    await run(upsertLead, ctx, lead({ round: { stage: "series_a", stageAsWritten: "Series A", announcedOn: "2026-11-01" } }));
    await run(upsertLead, ctx, lead({ round: { stage: "seed", announcedOn: "2025-03-01" } }));
    expect(tables.fundingRounds).toHaveLength(2);
    expect(tables.companies[0].latestStage).toBe("series_a");

    expect(
      latestStage([
        { stage: "seed", announcedOn: "2026-01-01" },
        { stage: "series_a", announcedOn: "2026-01-01" },
      ]),
    ).toBe("series_a");
  });

  test("only emails whose quote shows them are saved, and founders without one are dropped", async () => {
    const { ctx, tables } = fakeDb();
    const result = await run(
      upsertLead,
      ctx,
      lead({
        contacts: [
          { email: "hello@acme.in", contactType: "hello", sourceUrl: "https://acme.in/contact", quote: QUOTE },
          { email: "sales@acme.in", contactType: "sales", sourceUrl: "https://acme.in/contact", quote: QUOTE },
        ],
        founders: [
          {
            name: "Asha Rao",
            role: "CEO",
            sourceUrl: "https://acme.in/team",
            emails: [{ email: "asha@acme.in", sourceUrl: "https://acme.in/team", quote: "Asha Rao, CEO" }],
          },
        ],
      }),
    );
    expect(tables.contacts.map((c) => c.email)).toEqual(["hello@acme.in"]);
    expect(tables.contacts[0].publicListingVerified).toBe(true);
    expect(tables.people ?? []).toHaveLength(0);
    expect(result.skippedContacts).toBe(1);
    expect(postedEmail({ email: "Hello@Acme.in", sourceUrl: "https://acme.in", quote: QUOTE })).toBe(true);
    expect(postedEmail({ email: "hello@acme.in", sourceUrl: "https://acme.in", quote: undefined })).toBe(false);
  });
});

describe("jobs:upsert", () => {
  const base = { source: "greenhouse", externalId: "1", url: "https://boards.example/1", title: "PM", company: "Acme" };

  test("a repeat sighting that omits fields keeps the stored values", async () => {
    const { ctx, tables } = fakeDb();
    await run(upsertJobs, ctx, {
      jobs: [{ ...base, salary: "$100k", postedAt: "2026-11-01T00:00:00.000Z", boardUrl: "https://boards.example" }],
    });
    await run(upsertJobs, ctx, { jobs: [{ ...base, status: "closed" }] });
    expect(tables.jobs).toHaveLength(1);
    expect(tables.jobs[0]).toMatchObject({
      salary: "$100k",
      postedAt: "2026-11-01T00:00:00.000Z",
      boardUrl: "https://boards.example",
      status: "closed",
    });
    expect(definedOnly({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test("rejects a postedAt that is not ISO 8601 and drops emails no quote shows", async () => {
    const { ctx, tables } = fakeDb();
    await expect(run(upsertJobs, ctx, { jobs: [{ ...base, postedAt: "3 days ago" }] })).rejects.toThrow(/ISO/);
    await run(upsertJobs, ctx, {
      jobs: [
        {
          ...base,
          publicEmails: [
            { email: "jobs@acme.in", sourceUrl: base.url, quote: "Apply: jobs@acme.in" },
            { email: "ceo@acme.in", sourceUrl: base.url, quote: "Apply: jobs@acme.in" },
          ],
        },
      ],
    });
    expect(tables.jobs[0].publicEmails).toEqual([{ email: "jobs@acme.in", sourceUrl: base.url, quote: "Apply: jobs@acme.in" }]);
  });
});

describe("import-convex-jobs", () => {
  const row = {
    id: "j1",
    source: "greenhouse",
    externalId: "1",
    url: "https://boards.example/1",
    title: "PM",
    company: "Acme",
    companyWebsite: null,
    boardUrl: "https://boards.example",
    signalId: "sig_1",
    location: null,
    remote: null,
    department: null,
    employmentType: null,
    salary: null,
    description: "long text",
    postedAt: new Date("2026-11-01T05:00:00Z"),
    status: "closed",
    metadata: { public_emails: ["Jobs@acme.in", "guess@acme.in"], email_source_quote: "Send CVs to jobs@acme.in" },
    firstSeenAt: new Date("2026-11-02T00:00:00Z"),
    lastSeenAt: new Date("2026-11-03T00:00:00Z"),
    createdAt: new Date("2026-11-02T00:00:00Z"),
    updatedAt: new Date("2026-11-03T00:00:00Z"),
  } satisfies typeof schema.jobPostings.$inferSelect;

  test("carries board, signal, status, ISO postedAt and only quoted emails", () => {
    const job = toConvexJob(row);
    expect(job).toMatchObject({
      boardUrl: "https://boards.example",
      signalId: "sig_1",
      status: "closed",
      postedAt: "2026-11-01T05:00:00.000Z",
    });
    expect(job.publicEmails).toEqual([{ email: "jobs@acme.in", sourceUrl: row.url, quote: "Send CVs to jobs@acme.in" }]);
    expect("salary" in job).toBe(false);
    expect(postedJobEmails({ url: row.url, metadata: {} })).toEqual([]);
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("import-convex-leads", () => {
  test("the legacy array gets the same posted-email filter, and bad websites are skipped", () => {
    const legacy = [
      lead(),
      lead({ contacts: [{ email: "x@acme.in", contactType: "hello", sourceUrl: "https://acme.in" }] }),
      { ...lead(), company: { ...lead().company, website: "acme dot in" } },
    ];
    const leads = leadsFrom(legacy);
    expect(leads).toHaveLength(1);
    expect(leads[0].contacts).toHaveLength(1);
  });

  test("a run company with a malformed website is skipped", () => {
    const company = {
      company: "Acme",
      website: "not a url",
      brief: null,
      industry: { label: "", confidence: 0 },
      country: "India",
      stage: "Seed",
      stage_key: "seed",
      amount: null,
      announced_on: "2026-11-01",
      funding_source_url: "https://news.example/acme",
      other_sources: [],
      founders: [],
      company_emails: [{ email: "hello@acme.in", kind: "company_inbox", inbox: "general", source_url: "https://acme.in", quote: QUOTE }],
    };
    expect(leadsFrom({ generated_at: "", window_days: 7, stats: {}, companies: [company] } as never)).toHaveLength(0);
    expect(
      leadsFrom({ generated_at: "", window_days: 7, stats: {}, companies: [{ ...company, website: "https://acme.in" }] } as never),
    ).toEqual(
      [fromRun({ ...company, website: "https://acme.in" } as never)].map((l) => ({
        ...l,
        company: { ...l.company, researchedAt: expect.any(String) },
      })),
    );
  });

  test("one failing lead does not stop the rest", () => {
    const pushed: string[] = [];
    const failures = pushAll([{ company: { name: "A" } }, { company: { name: "B" } }, { company: { name: "C" } }], (l) => {
      if (l.company.name === "B") throw new Error("convex run failed\nstack");
      pushed.push(l.company.name);
    });
    expect(pushed).toEqual(["A", "C"]);
    expect(failures).toEqual([{ company: "B", error: "convex run failed" }]);
  });
});

describe("job_postings list indexes", () => {
  test("the migration adds the source and newest-first indexes listJobs uses", async () => {
    const handle = await testDb();
    const result = await handle.execute(sql`select indexname from pg_indexes where tablename = 'job_postings'`);
    const names = (result as unknown as { rows: Array<{ indexname: string }> }).rows.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(["job_postings_source_idx", "job_postings_open_posted_idx"]));
  });
});
