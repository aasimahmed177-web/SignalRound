import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@fireround/core/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { boardBelongsTo, boardTokens, careerLinks, collectCompanyJobs, detectBoards, type ReadText, readBoard } from "../lib/job-boards";
import { scanCompanies, storeScans } from "../lib/job-collector";
import { closeMissingJobs, closeStaleJobs, fundedCompanies, listJobs, parseJobInput, upsertJob, upsertJobs } from "../lib/jobs";
import { searchJobSpy, withPostedEmails } from "../lib/jobspy";
import { ingestSignal, parseSignalInput } from "../lib/signals";
import { testDb } from "./helpers";

let handle: Db;
vi.mock("@/lib/db", () => ({ db: async () => handle }));

/** A fake web: URL → body (JSON values are serialized). Anything else is a 404. */
function web(pages: Record<string, unknown>): ReadText & { calls: string[] } {
  const calls: string[] = [];
  const read = (async (url: string) => {
    calls.push(url);
    if (!(url in pages)) throw new Error(`HTTP 404 reading ${new URL(url).hostname}`);
    const body = pages[url];
    return { text: typeof body === "string" ? body : JSON.stringify(body), url, status: 200 };
  }) as ReadText & { calls: string[] };
  read.calls = calls;
  return read;
}

describe("detectBoards", () => {
  test("finds each supported ATS in page HTML", () => {
    const html = `
      <a href="https://boards.greenhouse.io/acme">Jobs</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeembed"></script>
      <a href="https://jobs.lever.co/leverco/abc">x</a>
      <a href="https://jobs.eu.lever.co/eurco">x</a>
      <iframe src="https://jobs.ashbyhq.com/ashco"></iframe>
      <a href="https://apply.workable.com/workco/">x</a>
      <a href="https://jobs.smartrecruiters.com/SmartCo">x</a>
      <a href="https://recco.recruitee.com/o/role">x</a>
      <a href="https://bamco.bamboohr.com/careers">x</a>`;
    const found = detectBoards(html, "https://acme.com").map((b) => `${b.ats}:${b.token}${b.eu ? ":eu" : ""}`);
    expect(found).toEqual(
      expect.arrayContaining([
        "greenhouse:acme",
        "greenhouse:acmeembed",
        "lever:leverco",
        "lever:eurco:eu",
        "ashby:ashco",
        "workable:workco",
        "smartrecruiters:smartco",
        "recruitee:recco",
        "bamboohr:bamco",
      ]),
    );
    expect(found).not.toContain("greenhouse:embed");
  });

  test("careerLinks keeps same-site career pages, best first", () => {
    const html = `<a href="/about">About</a><a href="/company">Join us</a><a href="/careers">Careers</a><a href="https://other.com/careers">x</a>`;
    expect(careerLinks(html, "https://acme.com/")).toEqual(["https://acme.com/careers", "https://acme.com/company"]);
  });
});

describe("readBoard", () => {
  test("normalizes Greenhouse, Lever and Ashby feeds", async () => {
    const read = web({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
        jobs: [
          {
            id: 7,
            title: "Engineer",
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/7",
            location: { name: "Berlin" },
            departments: [{ name: "R&D" }],
            content: "&lt;p&gt;Build things at acme.com&lt;/p&gt;",
            first_published: "2026-10-01T00:00:00Z",
          },
        ],
      },
      "https://boards-api.greenhouse.io/v1/boards/acme": { name: "Acme" },
      "https://api.lever.co/v0/postings/acme?mode=json": [
        {
          id: "l1",
          text: "Designer",
          hostedUrl: "https://jobs.lever.co/acme/l1",
          categories: { location: "Remote", team: "Design", commitment: "Full-time" },
          workplaceType: "remote",
          createdAt: 1_790_000_000_000,
          descriptionPlain: "Design",
        },
      ],
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": {
        jobs: [
          { id: "a1", title: "PM", jobUrl: "https://jobs.ashbyhq.com/acme/a1", location: "NYC", isRemote: false, isListed: true },
          { id: "a2", title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/acme/a2", isListed: false },
        ],
      },
    });
    const ctx = { company: "Acme", companyWebsite: "https://acme.com" };
    const gh = await readBoard({ ats: "greenhouse", token: "acme", foundOn: "t" }, ctx, read);
    expect(gh.companyName).toBe("Acme");
    expect(gh.jobs[0]).toMatchObject({ title: "Engineer", location: "Berlin", department: "R&D", description: "Build things at acme.com" });
    const lever = await readBoard({ ats: "lever", token: "acme", foundOn: "t" }, ctx, read);
    expect(lever.jobs[0]).toMatchObject({ title: "Designer", remote: true, employment_type: "Full-time", external_id: "acme:l1" });
    const ashby = await readBoard({ ats: "ashby", token: "acme", foundOn: "t" }, ctx, read);
    expect(ashby.jobs.map((j) => j.title)).toEqual(["PM"]);
  });
});

describe("collectCompanyJobs", () => {
  test("follows the homepage to its careers page and the board it links", async () => {
    const read = web({
      "https://acme.com/": `<a href="/careers">Careers</a>`,
      "https://acme.com/careers": `<a href="https://jobs.ashbyhq.com/acme">Open roles</a>`,
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": {
        jobs: [{ id: "a1", title: "PM", jobUrl: "https://jobs.ashbyhq.com/acme/a1" }],
      },
    });
    const result = await collectCompanyJobs({ company: "Acme", website: "https://acme.com/" }, read);
    expect(result.boards).toHaveLength(1);
    expect(result.boards[0]?.board).toMatchObject({ ats: "ashby", token: "acme", foundOn: "https://acme.com/careers" });
  });

  test("a guessed board is kept only when its own data names the company's domain", async () => {
    const stranger = web({
      "https://acme.com/": "<p>no links</p>",
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
        jobs: [{ id: 1, title: "Cook", absolute_url: "https://x/1", content: "Work at acme-restaurants.example" }],
      },
      "https://boards-api.greenhouse.io/v1/boards/acme": { name: "Acme Restaurants Group" },
    });
    expect((await collectCompanyJobs({ company: "Acme", website: "https://acme.com/" }, stranger)).boards).toHaveLength(0);

    const ours = web({
      "https://acme.com/": "<p>no links</p>",
      "https://api.lever.co/v0/postings/acme?mode=json": [
        { id: "l1", text: "Eng", hostedUrl: "https://jobs.lever.co/acme/l1", descriptionPlain: "Apply via acme.com" },
      ],
    });
    const result = await collectCompanyJobs({ company: "Acme", website: "https://acme.com/" }, ours);
    expect(result.boards[0]?.board.ats).toBe("lever");
    expect(result.boards[0]?.jobs[0]?.metadata).toMatchObject({ discovery: "name-guess-verified" });
  });

  test("a guessed Ashby board counts when the board page lists the company's website", async () => {
    const read = web({
      "https://getpliant.com/": "<p>no links</p>",
      "https://api.ashbyhq.com/posting-api/job-board/pliant?includeCompensation=true": {
        jobs: [{ id: "a1", title: "PM", jobUrl: "https://jobs.ashbyhq.com/pliant/a1", publishedAt: "2026-11-01T00:00:00Z" }],
      },
      "https://jobs.ashbyhq.com/pliant": `<script>window.__appData = {"organization":{"organizationId":"o1","name":"Pliant","publicWebsite":"https://www.getpliant.com/"}}</script>`,
    });
    const result = await collectCompanyJobs({ company: "Pliant", website: "https://getpliant.com/" }, read);
    expect(result.boards.map((board) => [board.board.ats, board.board.token])).toEqual([["ashby", "pliant"]]);
  });

  test("boardTokens tries the domain and the name, squashed and hyphenated", () => {
    expect(boardTokens("Peppermint Robotics", "https://www.peppermintrobotics.com/")).toEqual([
      "peppermintrobotics",
      "peppermint-robotics",
    ]);
    expect(boardTokens("Clinics On Cloud", "https://clinicsoncloud.com/")).toEqual(["clinicsoncloud", "clinics-on-cloud"]);
  });

  test("reads Teamtailor RSS, Personio XML and Gem boards with their posting dates", async () => {
    const read = web({
      "https://acme.teamtailor.com/jobs.rss": `<?xml version="1.0"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme</title><item><title>Content Marketing Manager</title><pubDate>Tue, 03 Nov 2026 19:37:57 +0100</pubDate><link>https://acme.teamtailor.com/jobs/1-content</link><remoteStatus>fully</remoteStatus><guid>g1</guid><tt:locations><tt:location><tt:city>Stockholm</tt:city><tt:country>Sweden</tt:country></tt:location></tt:locations><tt:department>Marketing</tt:department><description>&lt;p&gt;Write for us&lt;/p&gt;</description></item></channel></rss>`,
      "https://acme.jobs.personio.de/xml?language=en": `<?xml version="1.0" encoding="UTF-8"?><workzag-jobs><position><id>42</id><subcompany>Acme GmbH</subcompany><office>Berlin</office><department>Marketing</department><name>Brand Manager</name><employmentType>permanent</employmentType><createdAt>2026-11-02T08:00:00+00:00</createdAt><jobDescriptions><jobDescription><name>About</name><value>&lt;p&gt;Own the brand&lt;/p&gt;</value></jobDescription></jobDescriptions></position></workzag-jobs>`,
      "https://api.gem.com/job_board/v0/acme/job_posts/": [
        {
          id: "j1",
          title: "SEO Lead",
          absolute_url: "https://jobs.gem.com/acme/j1",
          location: { name: "Remote, USA" },
          location_type: "remote",
          departments: [{ name: "Growth" }],
          employment_type: "full_time",
          content_plain: "About Acme",
          first_published_at: "2026-11-04T10:00:00Z",
        },
      ],
    });
    const ctx = { company: "Acme" };
    const tt = await readBoard({ ats: "teamtailor", token: "acme", foundOn: "t" }, ctx, read);
    expect(tt.companyName).toBe("Acme");
    expect(tt.jobs[0]).toMatchObject({
      title: "Content Marketing Manager",
      url: "https://acme.teamtailor.com/jobs/1-content",
      location: "Stockholm, Sweden",
      department: "Marketing",
      remote: true,
      posted_at: "2026-11-03T18:37:57.000Z",
    });
    const personio = await readBoard({ ats: "personio", token: "acme", foundOn: "t" }, ctx, read);
    expect(personio.companyName).toBe("Acme GmbH");
    expect(personio.jobs[0]).toMatchObject({
      title: "Brand Manager",
      url: "https://acme.jobs.personio.de/job/42",
      department: "Marketing",
      posted_at: "2026-11-02T08:00:00.000Z",
      description: "Own the brand",
    });
    const gem = await readBoard({ ats: "gem", token: "acme", foundOn: "t" }, ctx, read);
    expect(gem.jobs[0]).toMatchObject({ title: "SEO Lead", department: "Growth", remote: true, posted_at: "2026-11-04T10:00:00.000Z" });
    expect(
      detectBoards(
        `<a href="https://jobs.gem.com/ocient-inc-">Jobs</a><a href="https://acme.jobs.personio.de/">x</a><a href="https://acme.teamtailor.com/jobs">y</a>`,
        "p",
      ).map((b) => `${b.ats}:${b.token}`),
    ).toEqual(["teamtailor:acme", "personio:acme", "gem:ocient-inc-"]);
  });

  test("boardBelongsTo accepts an exact ATS company name", () => {
    expect(
      boardBelongsTo(
        { board: { ats: "workable", token: "x", foundOn: "t" }, boardUrl: "u", companyName: "Acme, Inc.", jobs: [{ title: "a" } as never] },
        "Acme",
        "https://acme.io",
      ),
    ).toBe(true);
  });
});

describe("job storage", () => {
  beforeEach(async () => {
    handle = await testDb();
  });
  afterEach(() => vi.unstubAllEnvs());

  const job = (id: string, extra: Record<string, unknown> = {}) =>
    parseJobInput({
      source: "greenhouse",
      external_id: `acme:${id}`,
      url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
      title: `Role ${id}`,
      company: "Acme",
      board_url: "https://job-boards.greenhouse.io/acme",
      ...extra,
    });

  test("upserts idempotently, closes what a board stopped listing, and reopens on return", async () => {
    await upsertJob(handle, job("1"));
    await upsertJob(handle, job("2"));
    await upsertJob(handle, job("1", { title: "Role 1 (updated)" }));
    let listing = await listJobs(handle);
    expect(listing.counts.open).toBe(2);
    expect(listing.rows.map((r) => r.title)).toContain("Role 1 (updated)");

    expect(await closeMissingJobs(handle, "https://job-boards.greenhouse.io/acme", "greenhouse", ["acme:1"])).toBe(1);
    listing = await listJobs(handle);
    expect(listing.counts).toMatchObject({ open: 1, closed: 1 });

    await upsertJob(handle, job("2"));
    expect((await listJobs(handle)).counts.open).toBe(2);
  });

  test("links roles to the funding signal and filters to funded startups", async () => {
    const signal = await ingestSignal(
      handle,
      parseSignalInput({
        channel: "native-web",
        url: "https://news.example/acme-raises",
        title: "Acme raises $10M",
        company: "Acme",
        metadata: { company_website: "https://acme.com/", funding: { amount_as_written: "$10M", stage_as_written: "Seed" } },
      }),
    );
    expect(await fundedCompanies(handle)).toEqual([{ signalId: signal.id, company: "Acme", website: "https://acme.com/" }]);

    await storeScans(handle, [
      {
        company: "Acme",
        website: "https://acme.com/",
        boards: [{ ats: "greenhouse", token: "acme", boardUrl: "https://job-boards.greenhouse.io/acme", foundOn: "t", jobs: 1 }],
        jobs: [job("1", { signal_id: signal.id })],
        warnings: [],
      },
    ]);
    await upsertJob(handle, job("9", { source: "jobspy-linkedin", company: "Other Co", board_url: null }));
    const funded = await listJobs(handle, { funded: true });
    expect(funded.rows).toHaveLength(1);
    expect(funded.rows[0]).toMatchObject({ company: "Acme", funding: "$10M · Seed" });
    expect((await listJobs(handle, { q: "other" })).rows.map((r) => r.company)).toEqual(["Other Co"]);
  });

  test("the jobs API needs the ingest key and round-trips a posting", async () => {
    vi.stubEnv("SIGNAL_INGEST_KEY", "k");
    const { GET, POST } = await import("../app/api/v1/jobs/route");
    const url = "http://localhost/api/v1/jobs";
    expect((await GET(new Request(url))).status).toBe(401);
    const body = { source: "reddit", external_id: "t3_abc", url: "https://reddit.com/r/x/abc", title: "Hiring: Rust dev", company: "Acme" };
    const posted = await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify([body]) }));
    expect(posted.status).toBe(201);
    const bad = await POST(
      new Request(url, { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ title: "x" }) }),
    );
    expect(bad.status).toBe(400);
    const listed = await GET(new Request(`${url}?q=rust`, { headers: { authorization: "Bearer k" } }));
    await expect(listed.json()).resolves.toMatchObject({ data: [{ source: "reddit", title: "Hiring: Rust dev" }] });
  });
});

describe("review regressions: boards", () => {
  test("detectBoards lowercases tokens so ids stay stable when a link's casing changes", () => {
    const a = detectBoards(`<a href="https://boards.greenhouse.io/Acme">x</a>`, "p");
    const b = detectBoards(`<a href="https://boards.greenhouse.io/acme">x</a>`, "p");
    expect(a).toEqual(b);
    expect(a[0]?.token).toBe("acme");
  });

  test("Greenhouse posted_at is the publish date only; updated_at goes to metadata", async () => {
    const read = web({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
        jobs: [{ id: 1, title: "Old role", updated_at: "2026-11-06T00:00:00Z" }],
      },
    });
    const gh = await readBoard({ ats: "greenhouse", token: "acme", foundOn: "t" }, { company: "Acme" }, read);
    expect(gh.jobs[0]?.posted_at).toBeNull();
    expect(gh.jobs[0]?.metadata).toMatchObject({ updated_at: "2026-11-06T00:00:00.000Z" });
  });

  test("Lever workplaceType unspecified/hybrid is unknown, onsite is false", async () => {
    const lever = (workplaceType: string) => ({ id: workplaceType, text: "Role", workplaceType });
    const read = web({
      "https://api.lever.co/v0/postings/acme?mode=json": [lever("unspecified"), lever("hybrid"), lever("onsite"), lever("remote")],
    });
    const result = await readBoard({ ats: "lever", token: "acme", foundOn: "t" }, { company: "Acme" }, read);
    expect(result.jobs.map((j) => j.remote)).toEqual([null, null, false, true]);
  });

  test("SmartRecruiters pages to totalFound and refuses a short listing", async () => {
    const posting = (i: number) => ({ id: `p${i}`, name: `Role ${i}` });
    const page = (offset: number, count: number, totalFound: number) => ({
      totalFound,
      content: Array.from({ length: count }, (_, i) => posting(offset + i)),
    });
    const url = (offset: number) => `https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=${offset}`;
    const full = web({ [url(0)]: page(0, 100, 150), [url(100)]: page(100, 50, 150) });
    const read = await readBoard({ ats: "smartrecruiters", token: "acme", foundOn: "t" }, { company: "Acme" }, full);
    expect(read.jobs).toHaveLength(150);
    const short = web({ [url(0)]: page(0, 100, 250), [url(100)]: page(100, 40, 250) });
    await expect(readBoard({ ats: "smartrecruiters", token: "acme", foundOn: "t" }, { company: "Acme" }, short)).rejects.toThrow(
      /stopped at 140 of 250/,
    );
  });

  test("boardBelongsTo does not match names that differ only by descriptive words", () => {
    const read = (companyName: string) => ({
      board: { ats: "greenhouse" as const, token: "acme", foundOn: "name-guess" },
      boardUrl: "u",
      companyName,
      jobs: [{ title: "a", url: "https://job-boards.greenhouse.io/acme/jobs/1" } as never],
    });
    expect(boardBelongsTo(read("Acme Labs"), "Acme AI", "https://acme.ai")).toBe(false);
    expect(boardBelongsTo(read("Acme Ltd."), "Acme", "https://acme.ai")).toBe(true);
  });
});

describe("review regressions: storage", () => {
  beforeEach(async () => {
    handle = await testDb();
  });

  const posting = (id: string, extra: Record<string, unknown> = {}) =>
    parseJobInput({
      source: "jobspy-linkedin",
      external_id: id,
      url: `https://www.linkedin.com/jobs/view/${id}`,
      title: `Role ${id}`,
      company: "Acme",
      ...extra,
    });

  test("closeStaleJobs closes board-less rows not seen in the window, scoped by source", async () => {
    await upsertJob(handle, posting("1"));
    await upsertJob(handle, posting("2", { source: "reddit" }));
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await closeStaleJobs(handle, { sourcePrefixes: ["jobspy-"], now: later })).toBe(1);
    expect((await listJobs(handle)).rows.map((r) => r.source)).toEqual(["reddit"]);
    expect(await closeStaleJobs(handle, { now: new Date() })).toBe(0);
    await upsertJob(handle, posting("1"));
    expect((await listJobs(handle)).counts.open).toBe(2);
  });

  test("upsertJobs is all-or-nothing", async () => {
    await expect(upsertJobs(handle, [posting("1"), posting("2", { signal_id: "no-such-signal" })])).rejects.toThrow();
    expect((await listJobs(handle)).counts.open).toBe(0);
    expect(await upsertJobs(handle, [posting("1"), posting("2")])).toHaveLength(2);
  });

  test("a posting the board still lists but that fails validation is warned about and not closed", async () => {
    const boardUrl = "https://job-boards.greenhouse.io/acme";
    await upsertJob(
      handle,
      parseJobInput({
        source: "greenhouse",
        external_id: "acme:2",
        url: `${boardUrl}/jobs/2`,
        title: "Role 2",
        company: "Acme",
        board_url: boardUrl,
      }),
    );
    const read = web({
      "https://acme.com/": `<a href="https://boards.greenhouse.io/acme">Jobs</a>`,
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
        jobs: [
          { id: 1, title: "Role 1", absolute_url: `${boardUrl}/jobs/1` },
          { id: 2, title: "x".repeat(400), absolute_url: `${boardUrl}/jobs/2` },
        ],
      },
    });
    const scans = await scanCompanies([{ company: "Acme", website: "https://acme.com/" }], undefined, 1, read);
    expect(scans[0]?.jobs).toHaveLength(1);
    expect(scans[0]?.warnings.some((w) => w.includes("acme:2") && w.includes("invalid"))).toBe(true);
    expect(await storeScans(handle, scans)).toMatchObject({ stored: 1, closed: 0 });
  });
});

describe("review regressions: JobSpy emails", () => {
  test("emails come from the stored description with a quote; JobSpy's HTML regex hits are dropped", () => {
    const job = parseJobInput({
      source: "jobspy-indeed",
      external_id: "1",
      url: "https://in.indeed.com/viewjob?jk=1",
      title: "SEO Executive",
      company: "Acme",
      description: "We are hiring.\nSend your CV to hr@acme.example.org",
      metadata: { public_emails: ["logo@2x.png", "gone@acme.example.org"], search: "seo" },
    });
    expect(withPostedEmails(job).metadata).toEqual({
      search: "seo",
      public_emails: ["hr@acme.example.org"],
      email_source_quote: "Send your CV to hr@acme.example.org",
    });
    expect(withPostedEmails({ ...job, description: "No email here" }).metadata).toEqual({ search: "seo" });
  });
});

describe("review regressions: JobSpy output decoding", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("a UTF-8 character split across pipe chunks is decoded intact", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jobspy-"));
    const line = Buffer.from(
      `${JSON.stringify({ source: "jobspy-indeed", external_id: "1", url: "https://x.example/1", title: "Ingénieur", company: "Acme" })}\n`,
    );
    const cut = line.indexOf(Buffer.from("é")) + 1;
    writeFileSync(path.join(dir, "a.bin"), line.subarray(0, cut));
    writeFileSync(path.join(dir, "b.bin"), line.subarray(cut));
    const fake = path.join(dir, "python");
    writeFileSync(fake, `#!/bin/sh\ncat > /dev/null\ncat "${dir}/a.bin"\nsleep 0.2\ncat "${dir}/b.bin"\n`);
    chmodSync(fake, 0o755);
    vi.stubEnv("JOBSPY_PYTHON", fake);
    const { jobs } = await searchJobSpy({ search: "x" }, 10_000);
    expect(jobs.map((job) => job.title)).toEqual(["Ingénieur"]);
  });
});
