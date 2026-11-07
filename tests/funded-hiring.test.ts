import { describe, expect, test } from "vitest";
import type { FundedCompany, FundedRun } from "../lib/funded-founders";
import {
  applicationEmails,
  bestContact,
  careersPageRoles,
  collectFundedHiring,
  companyListings,
  emailNamesPerson,
  employmentType,
  emptyWatch,
  indeedCountry,
  leadersFromText,
  markReposts,
  mergeRuns,
  refusesEmailedApplications,
  salaryFromText,
  sameDescription,
  seniorityOf,
  withWatched,
} from "../lib/funded-hiring";
import type { ReadText } from "../lib/job-boards";
import { parseJobInput } from "../lib/jobs";

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

function funded(company: string, website: string, extra: Partial<FundedCompany> = {}): FundedCompany {
  return {
    company,
    website,
    brief: null,
    industry: { label: "fintech", confidence: 0.9, evidence_quote: "", source_url: website } as FundedCompany["industry"],
    country: null,
    stage: "Seed",
    stage_key: "seed",
    amount: "$3 Million",
    announced_on: "2026-11-05",
    funding_source_url: `https://news.example/${company}`,
    other_sources: [],
    founders: [],
    company_emails: [
      {
        email: `hello@${new URL(website).hostname}`,
        kind: "company_inbox",
        inbox: "general",
        source_url: website,
        quote: `Write to hello@${new URL(website).hostname}`,
      },
    ],
    ...extra,
  };
}

const run = (companies: FundedCompany[]): FundedRun => ({ generated_at: "2026-11-07T00:00:00Z", window_days: 7, stats: {}, companies });

describe("careersPageRoles", () => {
  test("reads JobPosting data when the page has it", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"Growth Marketing Manager","url":"/careers/growth","datePosted":"2026-11-01","jobLocation":{"address":{"addressLocality":"Berlin","addressCountry":"DE"}}}]}</script>`;
    expect(careersPageRoles(html, "https://acme.example/careers")).toEqual([
      {
        title: "Growth Marketing Manager",
        url: "https://acme.example/careers/growth",
        location: "Berlin, DE",
        department: null,
        employment_type: null,
        salary: null,
        seniority: null,
        posted_at: "2026-11-01T00:00:00.000Z",
        posted_at_source: "job-page",
        days_after_funding: null,
        pre_funding: null,
        application_emails: [],
      },
    ]);
  });

  test("keeps role links on the site or a hosted job page, not nav or culture pages", () => {
    const html = `
      <a href="/careers">Careers</a>
      <a href="/careers/life-at-acme">Life at Acme</a>
      <a href="/careers/seo-specialist"><h3>SEO Specialist</h3><span>Remote</span></a>
      <a href="https://acme.teamtailor.com/jobs/1-backend-engineer">Backend Engineer</a>
      <a href="https://stranger.example/jobs/ceo">Chief of Staff</a>
      <a href="/blog/how-we-hire">How a designer joins</a>`;
    expect(careersPageRoles(html, "https://acme.example/careers").map((role) => role.title)).toEqual([
      "SEO Specialist",
      "Backend Engineer",
    ]);
  });

  test("keeps same-site role links in the page's list of openings, even outside /careers", () => {
    const html = `
      <nav><a href="/pricing">Pricing</a><a href="/about">About the team lead</a></nav>
      <ul class="careers-roles__list"><li><a href="/marketing-lead"><span>Marketing Lead</span><span>Marketing</span></a></li></ul>
      <a href="/growth-manager" aria-label="Growth Manager, Seattle — view role">Growth Manager</a>`;
    expect(careersPageRoles(html, "https://ledgerkite.example/careers").map((role) => role.url)).toEqual([
      "https://ledgerkite.example/marketing-lead",
      "https://ledgerkite.example/growth-manager",
    ]);
  });

  test("takes the role out of a card that packs department, title and location, once per link", () => {
    const html = `
      <a href="/careers/accountant"><span>Finance</span><span>Senior Accountant</span><span>Pune</span></a>
      <a href="/careers/accountant">Senior Accountant</a>`;
    expect(careersPageRoles(html, "https://acme.example/careers")).toEqual([
      {
        title: "Senior Accountant",
        url: "https://acme.example/careers/accountant",
        location: null,
        department: null,
        employment_type: null,
        salary: null,
        seniority: "Senior",
        posted_at: null,
        posted_at_source: null,
        days_after_funding: null,
        pre_funding: null,
        application_emails: [],
      },
    ]);
  });
});

describe("collectFundedHiring", () => {
  test("keeps companies with open roles, counts them, and lists the marketing ones", async () => {
    const read = web({
      "https://acme.example/": `<a href="https://jobs.lever.co/acme">Jobs</a>`,
      "https://api.lever.co/v0/postings/acme?mode=json": [
        {
          id: "1",
          text: "Performance Marketing Manager",
          hostedUrl: "https://jobs.lever.co/acme/1",
          categories: { location: "London" },
          createdAt: 1762300800000,
        },
        { id: "2", text: "Software Engineer", hostedUrl: "https://jobs.lever.co/acme/2" },
      ],
      "https://beta.example/": `<a href="/careers">Careers</a>`,
      "https://beta.example/careers": `<a href="/careers/content-writer">Content Writer</a><a href="/careers/sdr">Sales Development Representative</a>`,
      "https://quiet.example/": "<p>We are not hiring.</p>",
    });
    const result = await collectFundedHiring(
      run([
        funded("Acme", "https://acme.example/", {
          founders: [
            {
              name: "Ada Lane",
              role: "CEO",
              source_url: "https://acme.example/team",
              quote: "",
              linkedin_url: null,
              emails: [
                { email: "ada@acme.example", kind: "founder_personal", source_url: "https://acme.example/team", quote: "ada@acme.example" },
              ],
            },
          ],
        }),
        funded("Beta", "https://beta.example/"),
        funded("Quiet", "https://quiet.example/"),
      ]),
      { read, now: new Date("2026-11-07T00:00:00Z") },
    );

    // Acme's only marketing role is a year older than the round: demoted, not a lead. Beta lists a content role but
    // nothing dates it, and prints only hello@: set apart.
    expect(result.companies).toEqual([]);
    expect(result.demoted_companies.map((company) => [company.company, company.demoted_because])).toEqual([
      ["Acme", "every marketing role predates the 2026-11-05 announcement"],
    ]);
    expect(result.other_companies).toEqual([
      {
        company: "Beta",
        website: "https://beta.example/",
        boards: [{ ats: "careers-page", board_url: "https://beta.example/careers" }],
        open_roles: 2,
      },
    ]);
    expect(result.undated_marketing_roles).toEqual([
      expect.objectContaining({ company: "Beta", title: "Content Writer", url: "https://beta.example/careers/content-writer" }),
    ]);
    expect(result.coverage.map((entry) => [entry.company, entry.roles_from, entry.open_roles, entry.outcome])).toEqual([
      ["Acme", "lever", 2, "demoted: marketing roles predate the round"],
      ["Beta", "careers-page", 2, "no marketing role and no founder or hiring email"],
      ["Quiet", "none", 0, "no open roles found"],
    ]);
    const [acme] = result.demoted_companies;
    expect(acme).toMatchObject({
      boards: [{ ats: "lever", board_url: "https://jobs.lever.co/acme" }],
      open_roles: 2,
      marketing_jobs: [],
      pre_funding_marketing_jobs: [
        {
          title: "Performance Marketing Manager",
          url: "https://jobs.lever.co/acme/1",
          location: "London",
          posted_at: "2025-11-05T00:00:00.000Z",
          posted_at_source: "ats",
          days_after_funding: -365,
          pre_funding: true,
        },
      ],
      founders: [
        {
          name: "Ada Lane",
          role: "CEO",
          emails: [{ email: "ada@acme.example", source_url: "https://acme.example/team", quote: "ada@acme.example" }],
        },
      ],
      company_emails: [{ email: "hello@acme.example", inbox: "general" }],
      best_contact: { email: "ada@acme.example", who: "Ada Lane (CEO)" },
    });
    expect(result.stats).toMatchObject({
      with_marketing_roles_after_funding: 0,
      with_only_pre_funding_marketing_roles: 1,
      scanned: 3,
      with_ats_board: 1,
      with_careers_page: 1,
      with_no_roles_found: 1,
      open_roles: 4,
      marketing_roles: 1,
      marketing_roles_undated_dropped: 1,
      hiring_companies: 0,
      demoted_companies: 1,
      other_companies: 1,
    });
    // The careers-page fallback reuses pages the board search already read.
    expect(read.calls.filter((url) => url === "https://beta.example/careers")).toHaveLength(1);
  });

  test("finds marketing roles by ATS team and comms titles, never product seats, and flags roles older than the round", async () => {
    const read = web({
      "https://fernbank.example/": `<a href="https://jobs.ashbyhq.com/fernbank">Jobs</a>`,
      "https://api.ashbyhq.com/posting-api/job-board/fernbank?includeCompensation=true": {
        jobs: [
          {
            id: "1",
            title: "Website Product Manager",
            department: "Marketing",
            team: "Brand & Content",
            publishedAt: "2026-10-28T13:23:34Z",
          },
          { id: "2", title: "Head of Product - Growth", department: "Product", team: "Growth", publishedAt: "2026-11-05T09:44:11Z" },
          { id: "3", title: "Senior Creative Producer", department: "Communications", publishedAt: "2026-11-06T00:00:00Z" },
          { id: "4", title: "Software Engineer - Backend - Growth", department: "Engineering", team: "Growth" },
          { id: "5", title: "Director, Commercial Growth", department: "Business Development" },
          { id: "6", title: "Controller", department: "Finance" },
          { id: "7", title: "Brand Designer", department: "Marketing", publishedAt: "2026-10-01T00:00:00Z" },
          { id: "8", title: "Product Marketing Manager", department: "Product", publishedAt: "2026-10-01T00:00:00Z" },
        ],
      },
      "https://kumquat.example/": `<a href="/careers">Careers</a>`,
      "https://kumquat.example/careers": `<a href="/careers/plg"><span>Growth</span><span>Head of Product-Led Growth</span></a>`,
    });
    const result = await collectFundedHiring(
      run([funded("Fernbank", "https://fernbank.example/", { announced_on: "2026-11-04" }), funded("Kumquat", "https://kumquat.example/")]),
      {
        read,
        now: new Date("2026-11-07T00:00:00Z"),
      },
    );
    const [fernbank] = result.companies;
    expect(fernbank?.open_roles).toBe(8);
    expect(fernbank?.marketing_jobs.map((role) => [role.title, role.department, role.days_after_funding, role.pre_funding])).toEqual([
      ["Senior Creative Producer", "Communications", 2, false],
    ]);
    // Posted before the round: kept apart from the roles the money is paying for.
    expect(fernbank?.pre_funding_marketing_jobs.map((role) => [role.title, role.days_after_funding])).toEqual([
      ["Product Marketing Manager", -34],
    ]);
    // Kumquat's only role is a product seat: no marketing opening, only hello@, so it is set apart.
    expect(result.companies.map((company) => company.company)).toEqual(["Fernbank"]);
    expect(result.other_companies.map((company) => company.company)).toEqual(["Kumquat"]);
    expect(result.stats).toMatchObject({
      marketing_roles: 2,
      marketing_roles_pre_funding: 1,
      marketing_roles_after_funding: 1,
      with_marketing_roles_after_funding: 1,
    });
  });

  test("scans every company with a website, and reads a company's Indeed/LinkedIn listings when its site shows no roles", async () => {
    const read = web({ "https://wisp.example/": "<p>Wisp builds kitchens.</p>" });
    const unposted = funded("Wisp", "https://wisp.example/", { country: "India" });
    unposted.company_emails = [{ ...unposted.company_emails[0]!, quote: "Contact us" }];
    const queries: unknown[] = [];
    const listing = (title: string, company: string, extra: Record<string, unknown> = {}) =>
      parseJobInput({
        source: "jobspy-indeed",
        external_id: title,
        url: `https://in.indeed.com/viewjob?jk=${title.length}`,
        title,
        company,
        posted_at: "2026-11-06",
        description: "Wisp (wisp.example) is hiring.",
        ...extra,
      });
    const result = await collectFundedHiring(run([unposted, funded("Nosite", "https://nosite.example/", { website: null })]), {
      read,
      now: new Date("2026-11-07T00:00:00Z"),
      searchJobSites: async (query) => {
        queries.push(query);
        return [listing("Social Media Executive", "Wisp"), listing("Line Cook", "Wisp"), listing("SEO Executive", "Wisp Kitchens Ltd")];
      },
    });
    expect(result.stats).toMatchObject({ scanned: 1, with_job_site_listings: 1, open_roles: 2, marketing_roles: 1 });
    expect(queries).toEqual([{ company: "Wisp", website: "https://wisp.example/", country: "India" }]);
    const [wisp] = result.companies;
    expect(wisp?.boards).toEqual([{ ats: "indeed", board_url: "https://in.indeed.com/viewjob?jk=22", match: "name+domain" }]);
    expect(wisp?.marketing_jobs).toEqual([
      expect.objectContaining({
        title: "Social Media Executive",
        posted_at: "2026-11-06T00:00:00.000Z",
        posted_at_source: "indeed",
        days_after_funding: 1,
        pre_funding: false,
      }),
    ]);
    // Nothing unposted is kept as a contact.
    expect(wisp?.company_emails).toEqual([]);
  });

  test("dates careers-page roles from the job page, the sitemap, or the same role's job-site listing; a lastmod after the round proves nothing", async () => {
    const read = web({
      "https://deltoid.example/": `<a href="/careers">Careers</a>`,
      "https://deltoid.example/careers": `<a href="/careers/brand">Brand Manager</a><a href="/careers/seo">SEO Specialist</a><a href="/careers/pr">Communications Lead</a><a href="/careers/cmo">Head of Marketing</a>`,
      "https://deltoid.example/careers/brand": `<meta property="article:published_time" content="2026-11-06T00:00:00Z"><p>Send your CV to jobs@deltoid.example</p>`,
      "https://deltoid.example/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://www.deltoid.example/careers/seo/</loc><lastmod>2026-11-05</lastmod></url></urlset>`,
    });
    const listings = [
      parseJobInput({
        source: "jobspy-linkedin",
        external_id: "1",
        url: "https://www.linkedin.com/jobs/view/1",
        title: "Communications Lead",
        company: "Deltoid Robotics",
        posted_at: "2026-11-04",
        description: "Deltoid Robotics, deltoid.example",
      }),
    ];
    const result = await collectFundedHiring(
      run([funded("Deltoid Robotics", "https://deltoid.example/", { announced_on: "2026-11-05" })]),
      {
        read,
        now: new Date("2026-11-07T00:00:00Z"),
        searchJobSites: async () => listings,
      },
    );
    const [deltoid] = result.companies;
    expect(deltoid?.marketing_jobs.map((role) => [role.title, role.posted_at?.slice(0, 10), role.posted_at_source])).toEqual([
      ["Brand Manager", "2026-11-06", "job-page"],
    ]);
    expect(deltoid?.pre_funding_marketing_jobs.map((role) => [role.title, role.posted_at?.slice(0, 10), role.posted_at_source])).toEqual([
      ["Communications Lead", "2026-11-04", "linkedin"],
    ]);
    // A sitemap lastmod on the announcement day is an edit date: the SEO role is not counted as a post-funding hire.
    expect(result.undated_marketing_roles.map((role) => [role.title, role.reason.slice(0, 28)])).toEqual([
      ["SEO Specialist", "only a sitemap lastmod (2026"],
      ["Head of Marketing", "no posting date from the ATS"],
    ]);
  });
});

describe("who to write to", () => {
  test("reads managing directors from an imprint and founders from a press kit, nicknames dropped", () => {
    const imprint = [
      "Represented by (Managing Director): Julian Exampleman",
      "Email: founders@driftwood.example",
      "Represented by (Managing Director): Gustave Testard",
      "Email: gustave.testard@driftwood.example",
      "Geschäftsführer: Max Muster und Erika Beispiel",
    ].join("\n");
    expect(leadersFromText(imprint, "Driftwood").map((leader) => [leader.name, leader.role])).toEqual([
      ["Julian Exampleman", "Managing director"],
      ["Gustave Testard", "Managing director"],
      ["Max Muster", "Managing director"],
      ["Erika Beispiel", "Managing director"],
    ]);
    const kit = [
      `Leonhard "Lenny" Placeholt — Co-Founder & COO: Responsible for operations.`,
      "Gustave Testard — Co-Founder & CTO: Space engineer.",
      "Linda Sampleton — Head of Communications",
      "“Space should be open.”— Julian Exampleman, CEO",
    ].join("\n");
    expect(leadersFromText(kit, "Driftwood").map((leader) => [leader.name, leader.role])).toEqual([
      ["Leonhard Placeholt", "Co-founder & COO"],
      ["Gustave Testard", "Co-founder & CTO"],
    ]);
  });

  test("an address is a person's only when its local part spells their name", () => {
    expect(emailNamesPerson("gustave.testard@driftwood.example", "Gustave Testard")).toBe(true);
    expect(emailNamesPerson("gtestard@driftwood.example", "Gustave Testard")).toBe(true);
    expect(emailNamesPerson("ana@acme.example", "Ana Lane")).toBe(true);
    expect(emailNamesPerson("founders@driftwood.example", "Julian Exampleman")).toBe(false);
    expect(emailNamesPerson("marketing@acme.example", "Mark Etting")).toBe(false);
    // A surname alone, a fragment, or a first name that is also a desk word is not enough.
    expect(emailNamesPerson("testard@driftwood.example", "Gustave Testard")).toBe(false);
    expect(emailNamesPerson("gus@driftwood.example", "Gustave Testard")).toBe(false);
    expect(emailNamesPerson("dev@acme.example", "Dev Testwala")).toBe(false);
    expect(emailNamesPerson("sales@acme.example", "Sam Sales")).toBe(false);
  });

  test("application emails: hiring inboxes or a line asking for a CV, on the company's own domain", () => {
    const page = "https://kumquat.example/careers/plg";
    expect(
      applicationEmails(
        [
          { email: "hiring@kumquat.example", source_url: page, quote: "Send a note and resume to hiring@kumquat.example." },
          { email: "hi@kumquat.example", source_url: page, quote: "hi@kumquat.example" },
          { email: "ana@kumquat.example", source_url: page, quote: "Apply by writing to ana@kumquat.example" },
          { email: "jobs@agency.example", source_url: page, quote: "Send your CV to jobs@agency.example" },
          { email: "privacy@kumquat.example", source_url: page, quote: "Applicant data: privacy@kumquat.example" },
          { email: "careers@kumquat.example", source_url: page, quote: "Need an accommodation? careers@kumquat.example" },
        ],
        "https://kumquat.example/",
      ).map((email) => email.email),
    ).toEqual(["hiring@kumquat.example", "ana@kumquat.example"]);
  });
});

describe("role details", () => {
  test("pay, employment type and level", () => {
    expect(salaryFromText("The base salary range is $140,000 - $180,000 per year, plus equity.")).toBe("$140,000 - $180,000 per year");
    expect(salaryFromText("Compensation: €60k–€80k")).toBe("€60k–€80k");
    expect(salaryFromText("We have 3 - 5 open seats and a $5-10 snack budget")).toBeNull();
    expect([employmentType("FullTime"), employmentType("FULL_TIME"), employmentType(["PART_TIME"]), employmentType("Intern")]).toEqual([
      "Full-time",
      "Full-time",
      "Part-time",
      "Internship",
    ]);
    expect(
      [
        "Head of Marketing",
        "Senior Content Writer",
        "Robotics Product Marketing Lead",
        "Lead Generation Specialist",
        "Marketing Manager",
      ].map(seniorityOf),
    ).toEqual(["Head", "Senior", "Lead", null, null]);
  });

  test("merges overlapping funded runs, each company once", () => {
    const a = { generated_at: "2026-11-07T00:00:00Z", window_days: 7, stats: {}, companies: [funded("Acme", "https://acme.example/")] };
    const b = {
      generated_at: "2026-11-07T01:00:00Z",
      window_days: 14,
      stats: {},
      companies: [funded("Acme", "https://www.acme.example/"), funded("Beta", "https://beta.example/")],
    };
    const merged = mergeRuns([a, b]);
    expect(merged.companies.map((company) => company.company)).toEqual(["Acme", "Beta"]);
    expect(merged.window_days).toBe(14);
  });
});

describe("job-site listings", () => {
  const job = (company: string, description: string) =>
    parseJobInput({
      source: "jobspy-indeed",
      external_id: company,
      url: "https://www.indeed.com/viewjob?jk=1",
      title: "Marketing Manager",
      company,
      description,
      posted_at: "2026-11-01",
    });
  test("keeps only the exact employer name; a short name also needs its domain in a posting", () => {
    expect(companyListings([job("Cent", "Join our team")], "Cent", "https://www.cent.example/")).toBeNull();
    expect(companyListings([job("Cent", "Learn more at cent.example")], "Cent", "https://www.cent.example/")?.match).toBe("name+domain");
    expect(companyListings([job("Mintwhirl Robotics", "Cleaning robots")], "Mintwhirl Robotics", "https://mintwhirl.example/")?.match).toBe(
      "name",
    );
    expect(companyListings([job("Mintwhirl Labs", "x")], "Mintwhirl Robotics", "https://mintwhirl.example/")).toBeNull();
    expect([indeedCountry("United States"), indeedCountry("India"), indeedCountry(null)]).toEqual(["usa", "india", "usa"]);
  });
});

describe("collectFundedHiring contacts", () => {
  test("promotes a managing director whose imprint prints their email, adds job-page application emails and role details", async () => {
    const read = web({
      "https://drift.example/": `<a href="https://jobs.lever.co/drift">Jobs</a><a href="/imprint">Imprint</a><a href="mailto:fly@drift.example">Email us</a>`,
      "https://api.lever.co/v0/postings/drift?mode=json": [
        {
          id: "1",
          text: "Head of Marketing",
          hostedUrl: "https://jobs.lever.co/drift/1",
          categories: { location: "Vienna", commitment: "Full-time" },
          salaryRange: { currency: "EUR", min: 70000, max: 90000, interval: "per-year-salary" },
          descriptionPlain: "Lead our brand.\nSend your CV to jobs@drift.example and tell us about a launch you ran.",
          createdAt: Date.parse("2026-11-04T00:00:00Z"),
        },
      ],
      "https://drift.example/imprint": `<div>Represented by (Managing Director): Gustave Testard</div><div>Email: gustave.testard@drift.example</div><div>Represented by (Managing Director): Julian Exampleman</div><div>Email: founders@drift.example</div><div>Data protection: privacy@drift.example</div>`,
      "https://jobs.lever.co/drift/1": `<html><body><h2>Head of Marketing</h2><p>Questions? hiring@drift.example</p></body></html>`,
      "https://news.example/Drift": `<html><body><article><p>Drift, founded by Julian Exampleman and Gustave Testard, raised €6.9 million.</p></article></body></html>`,
    });
    const drift = funded("Drift", "https://drift.example/", {
      announced_on: "2026-11-03",
      company_emails: [
        {
          email: "privacy@drift.example",
          kind: "company_inbox",
          inbox: "support",
          source_url: "https://drift.example/imprint",
          quote: "privacy@drift.example",
        },
        {
          email: "fly@drift.example",
          kind: "company_inbox",
          inbox: "other",
          source_url: "https://drift.example/",
          quote: "fly@drift.example",
        },
      ],
    });
    const result = await collectFundedHiring(run([drift]), { read, now: new Date("2026-11-07T00:00:00Z") });
    const [company] = result.companies;
    expect(company?.founders).toEqual([
      {
        name: "Gustave Testard",
        // The imprint titles him, and the funding article names him a founder.
        role: "Managing director; Co-founder",
        source_url: "https://drift.example/imprint",
        quote: "Represented by (Managing Director): Gustave Testard",
        emails: [
          {
            email: "gustave.testard@drift.example",
            source_url: "https://drift.example/imprint",
            quote: "Email: gustave.testard@drift.example",
          },
        ],
      },
    ]);
    expect(company?.company_emails.map((email) => [email.email, email.inbox])).toEqual([
      ["founders@drift.example", "founders"],
      ["fly@drift.example", "other"],
    ]);
    expect(company?.marketing_jobs).toEqual([
      expect.objectContaining({
        title: "Head of Marketing",
        employment_type: "Full-time",
        salary: "EUR 70000–90000 per-year-salary",
        seniority: "Head",
        days_after_funding: 1,
        pre_funding: false,
        application_emails: [
          { email: "hiring@drift.example", source_url: "https://jobs.lever.co/drift/1", quote: "Questions? hiring@drift.example" },
          {
            email: "jobs@drift.example",
            source_url: "https://jobs.lever.co/drift/1",
            quote: "Send your CV to jobs@drift.example and tell us about a launch you ran.",
          },
        ],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("privacy@");
    expect(result.stats).toMatchObject({
      founders_with_email: 1,
      marketing_roles_with_application_email: 1,
      marketing_roles_with_salary: 1,
    });
  });

  test("does not keep a run's founder email when the address and its line name someone else", async () => {
    const read = web({
      "https://mantle.example/": `<a href="https://jobs.lever.co/mantle">Jobs</a>`,
      "https://api.lever.co/v0/postings/mantle?mode=json": [
        { id: "1", text: "Brand Manager", hostedUrl: "https://jobs.lever.co/mantle/1", createdAt: Date.parse("2026-11-06T00:00:00Z") },
      ],
    });
    const mantle = funded("Mantle", "https://mantle.example/", {
      company_emails: [],
      founders: [
        {
          name: "Ashwin Testkar",
          role: "Co-founder",
          source_url: "https://news.example/Mantle",
          quote: "Founded by Ashwin Testkar",
          linkedin_url: null,
          emails: [
            {
              email: "amit.testkar@mantle.example",
              kind: "founder_personal",
              source_url: "https://mantle.example/privacy",
              quote: "Email: amit.testkar@mantle.example",
            },
          ],
        },
      ],
    });
    const result = await collectFundedHiring(run([mantle]), { read });
    expect(result.companies[0]?.founders).toEqual([]);
  });

  test("keeps a dated marketing opening without a contact, never showing privacy or security desks", async () => {
    const read = web({
      "https://kale.example/": `<a href="https://jobs.lever.co/kale">Jobs</a>`,
      "https://api.lever.co/v0/postings/kale?mode=json": [
        {
          id: "1",
          text: "Field Marketing Manager",
          hostedUrl: "https://jobs.lever.co/kale/1",
          createdAt: Date.parse("2026-11-06T00:00:00Z"),
        },
      ],
    });
    const kale = funded("Kale", "https://kale.example/", {
      company_emails: [
        {
          email: "privacy@kale.example",
          kind: "company_inbox",
          inbox: "support",
          source_url: "https://kale.example/p",
          quote: "privacy@kale.example",
        },
        {
          email: "security@kale.example",
          kind: "company_inbox",
          inbox: "support",
          source_url: "https://kale.example/s",
          quote: "security@kale.example",
        },
      ],
    });
    const result = await collectFundedHiring(run([kale]), { read });
    expect(result.companies.map((company) => [company.company, company.marketing_jobs.length, company.company_emails])).toEqual([
      ["Kale", 1, []],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/privacy@|security@/);
  });
});

describe("post-funding roles and who to write to first", () => {
  test("a posting that says emailed applications are deleted has no application email", async () => {
    expect(
      refusesEmailedApplications(
        "Do not contact Ocelot directly to apply for a role. For security purposes, any applications received via email will be deleted.",
      ),
    ).toBe(true);
    expect(refusesEmailedApplications("We do not accept resumes by email; apply on this page.")).toBe(true);
    expect(refusesEmailedApplications("Send your CV to jobs@acme.example")).toBe(false);
    const read = web({
      "https://ocelot.example/": `<a href="https://jobs.lever.co/ocelot">Jobs</a>`,
      "https://api.lever.co/v0/postings/ocelot?mode=json": [
        {
          id: "1",
          text: "Demand Generation Manager",
          hostedUrl: "https://jobs.lever.co/ocelot/1",
          createdAt: Date.parse("2026-11-06T00:00:00Z"),
          descriptionPlain:
            "Do not contact Ocelot directly to apply for a role. For security purposes, any applications received via email will be deleted.\nQuestions about your application? recruiting@ocelot.example",
        },
      ],
      "https://jobs.lever.co/ocelot/1": `<p>Apply below.</p><a href="mailto:recruiting@ocelot.example">recruiting@ocelot.example</a>`,
    });
    const result = await collectFundedHiring(run([funded("Ocelot", "https://ocelot.example/", { company_emails: [] })]), { read });
    expect(result.companies[0]?.marketing_jobs[0]).toMatchObject({ title: "Demand Generation Manager", application_emails: [] });
    expect(result.companies[0]?.best_contact).toBeNull();
  });

  test("reads the CEO from a contact card and writes to them first, never sales@ or press@", async () => {
    const card = (name: string, title: string, email: string) =>
      `<div><p>${name}</p><p>${title}</p><a href="mailto:${email}">${email}</a></div>`;
    const read = web({
      "https://voltwise.example/": `<a href="https://jobs.lever.co/voltwise">Jobs</a><a href="/contact-us">Contact</a>`,
      "https://api.lever.co/v0/postings/voltwise?mode=json": [
        {
          id: "1",
          text: "Growth Marketing Manager",
          hostedUrl: "https://jobs.lever.co/voltwise/1",
          createdAt: Date.parse("2026-11-06T00:00:00Z"),
        },
      ],
      "https://voltwise.example/contact-us": [
        "<p>Sales: sales@voltwise.example</p><p>Media: press@voltwise.example</p>",
        card("Pekka Example", "CEO", "pekka@voltwise.example"),
        card("Tero Sample", "COO", "tero.sample@voltwise.example"),
        card("Aleksi Testinen", "Finance", "aleksi.testinen@voltwise.example"),
      ].join(""),
    });
    const result = await collectFundedHiring(run([funded("Voltwise Power", "https://voltwise.example/", { company_emails: [] })]), {
      read,
    });
    const [voltwise] = result.companies;
    expect(voltwise?.founders).toEqual([
      {
        name: "Pekka Example",
        role: "CEO",
        source_url: "https://voltwise.example/contact-us",
        quote: "Pekka Example · CEO",
        emails: [
          {
            email: "pekka@voltwise.example",
            source_url: "https://voltwise.example/contact-us",
            quote: "Pekka Example · CEO · pekka@voltwise.example",
          },
        ],
      },
    ]);
    expect(voltwise?.best_contact).toMatchObject({ email: "pekka@voltwise.example", who: "Pekka Example (CEO)" });
    // Other staff are kept with the card that names them, below the founder; sales and press come last.
    expect(voltwise?.company_emails.map((email) => [email.email, email.inbox, email.quote])).toEqual([
      ["tero.sample@voltwise.example", "person", "Tero Sample · COO · tero.sample@voltwise.example"],
      ["aleksi.testinen@voltwise.example", "person", "Aleksi Testinen · Finance · aleksi.testinen@voltwise.example"],
      ["sales@voltwise.example", "sales", "Sales: sales@voltwise.example"],
      ["press@voltwise.example", "press", "Media: press@voltwise.example"],
    ]);
  });

  test("best contact: CEO, then a founder, then a role's application email, then founders@/careers@; never sales or press", () => {
    const email = (address: string) => ({ email: address, source_url: "https://a.example/", quote: address });
    const base = { founders: [], marketing_jobs: [], pre_funding_marketing_jobs: [], company_emails: [] };
    expect(
      bestContact({
        ...base,
        founders: [
          { name: "Bo Ray", role: "Co-founder & CTO", source_url: "", quote: "", emails: [email("bo@a.example")] },
          { name: "Al Ng", role: "CEO", source_url: "", quote: "", emails: [email("al@a.example")] },
        ],
      })?.email,
    ).toBe("al@a.example");
    expect(
      bestContact({
        ...base,
        company_emails: [
          { ...email("sales@a.example"), inbox: "sales" },
          { ...email("press@a.example"), inbox: "press" },
        ],
      }),
    ).toBeNull();
    expect(
      bestContact({
        ...base,
        company_emails: [
          { ...email("sales@a.example"), inbox: "sales" },
          { ...email("careers@a.example"), inbox: "careers" },
        ],
      })?.who,
    ).toBe("careers inbox");
  });

  test("a daily watch dates a role that appears after an earlier post-announcement poll, and drops rounds older than 30 days", async () => {
    const watch = emptyWatch();
    const pages = (roles: string) =>
      web({ "https://zeta.example/": `<a href="/careers">Careers</a>`, "https://zeta.example/careers": roles });
    const zeta = funded("Zeta", "https://zeta.example/", { announced_on: "2026-11-05", company_emails: [] });
    const first = await collectFundedHiring(run([zeta]), {
      read: pages(`<a href="/careers/backend">Backend Engineer</a><a href="/careers/brand">Brand Lead</a>`),
      now: new Date("2026-11-06T09:00:00Z"),
      watch,
    });
    // The brand role was already up at the first poll: nothing dates it, so it is not counted.
    expect(first.undated_marketing_roles.map((role) => role.title)).toEqual(["Brand Lead"]);
    const second = await collectFundedHiring(run([zeta]), {
      read: pages(
        `<a href="/careers/backend">Backend Engineer</a><a href="/careers/brand">Brand Lead</a><a href="/careers/content">Content Marketing Manager</a>`,
      ),
      now: new Date("2026-11-07T09:00:00Z"),
      watch,
    });
    expect(second.companies[0]?.marketing_jobs.map((role) => [role.title, role.posted_at_source, role.days_after_funding])).toEqual([
      ["Content Marketing Manager", "first-seen", 2],
    ]);
    expect(second.stats).toMatchObject({ with_marketing_roles_after_funding: 1, marketing_roles_after_funding_first_seen_by_watch: 1 });
    expect(watch.companies["zeta.example"]?.polls).toHaveLength(2);

    // A watched company is polled again when today's run no longer lists it; one past its 30 days leaves the watch.
    watch.companies["old.example"] = { ...watch.companies["zeta.example"]!, watch_until: "2026-11-01T00:00:00.000Z" };
    const merged = withWatched(run([]), watch, new Date("2026-11-08T00:00:00Z"));
    expect(merged.companies.map((company) => company.company)).toEqual(["Zeta"]);
    expect(Object.keys(watch.companies)).toEqual(["zeta.example"]);
  });
});

describe("reposts and headline numbers", () => {
  const body =
    "Voltwise is hiring a growth marketer to own paid search, lifecycle email and our launch calendar across three markets. You will run weekly experiments, report on pipeline, and work with sales on account based campaigns for utilities and data centre operators. We offer equity, a learning budget and flexible hours.";

  test("the same description is one posting, even wrapped in a job page; a different one is not", () => {
    expect(sameDescription(body, `Careers Home About ${body} Apply now Privacy`)).toBe(true);
    expect(
      sameDescription(body, body.replace(/growth marketer.*$/, "backend engineer to build our billing service in Go and Postgres.")),
    ).toBe(false);
    expect(sameDescription("Short text.", "Short text.")).toBe(false);
  });

  test("a post-funding listing that matches a pre-funding one keeps the earlier date and is not a post-funding hire", () => {
    const role = (url: string, posted_at: string, days: number) => ({
      title: "Growth Marketing Manager",
      url,
      location: null,
      department: null,
      employment_type: null,
      salary: null,
      seniority: null,
      posted_at,
      posted_at_source: "ats" as const,
      days_after_funding: days,
      pre_funding: days < 0,
      application_emails: [],
    });
    const fresh = role("https://jobs.lever.co/voltwise/2", "2026-11-06T00:00:00.000Z", 1);
    const older = {
      ...role("https://www.linkedin.com/jobs/view/9", "2026-09-01T00:00:00.000Z", -65),
      posted_at_source: "linkedin" as const,
    };
    const other = { ...role("https://jobs.lever.co/voltwise/3", "2026-11-06T00:00:00.000Z", 1), title: "Brand Designer" };
    const texts: Record<string, string> = { [fresh.url]: body, [older.url]: `LinkedIn ${body}`, [other.url]: body };
    const result = markReposts([fresh, other], [older], (r) => texts[r.url] ?? null);
    expect(result.afterFunding.map((r) => r.title)).toEqual(["Brand Designer"]);
    expect(result.reposts).toEqual([
      expect.objectContaining({
        url: fresh.url,
        posted_at: "2026-09-01T00:00:00.000Z",
        posted_at_source: "linkedin",
        days_after_funding: -65,
        pre_funding: true,
        repost_of: older.url,
      }),
    ]);
  });

  test("a board repost is demoted end to end, and quotes for mailto links are visible words", async () => {
    const read = web({
      "https://voltwise.example/": `<a href="https://jobs.lever.co/voltwise">Jobs</a><a href="/contact-us">Contact</a>`,
      "https://api.lever.co/v0/postings/voltwise?mode=json": [
        {
          id: "1",
          text: "Growth Marketing Manager",
          hostedUrl: "https://jobs.lever.co/voltwise/1",
          createdAt: Date.parse("2026-09-01T00:00:00Z"),
          descriptionPlain: body,
        },
        {
          id: "2",
          text: "Growth Marketing Manager",
          hostedUrl: "https://jobs.lever.co/voltwise/2",
          createdAt: Date.parse("2026-11-06T00:00:00Z"),
          descriptionPlain: body,
        },
      ],
      "https://voltwise.example/contact-us": `<p><a href="mailto:careers@voltwise.example">Join us</a></p>`,
    });
    const result = await collectFundedHiring(run([funded("Voltwise Power", "https://voltwise.example/", { company_emails: [] })]), {
      read,
    });
    expect(result.companies).toEqual([]);
    const [voltwise] = result.demoted_companies;
    expect(voltwise?.pre_funding_marketing_jobs.map((r) => [r.url, r.posted_at?.slice(0, 10), r.repost_of ?? null])).toEqual([
      ["https://jobs.lever.co/voltwise/1", "2026-09-01", null],
      ["https://jobs.lever.co/voltwise/2", "2026-09-01", "https://jobs.lever.co/voltwise/1"],
    ]);
    expect(voltwise?.company_emails).toEqual([
      expect.objectContaining({ email: "careers@voltwise.example", inbox: "careers", quote: "Join us (mailto:careers@voltwise.example)" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("<a ");
    expect(result.stats).toMatchObject({
      marketing_roles_after_funding: 0,
      marketing_roles_reposted: 1,
      with_marketing_role_after_funding_and_contact: 0,
      with_marketing_role_and_contact: 1,
    });
  });

  test("headline: post-funding marketing roles, and companies with one plus a posted founder or hiring email", async () => {
    const read = web({
      "https://kale.example/": `<a href="https://jobs.lever.co/kale">Jobs</a>`,
      "https://api.lever.co/v0/postings/kale?mode=json": [
        {
          id: "1",
          text: "Content Marketing Lead",
          hostedUrl: "https://jobs.lever.co/kale/1",
          createdAt: Date.parse("2026-11-06T00:00:00Z"),
        },
      ],
      "https://jobs.lever.co/kale/1": `<p>Send your portfolio to jobs@kale.example</p>`,
    });
    const result = await collectFundedHiring(run([funded("Kale", "https://kale.example/", { company_emails: [] })]), { read });
    expect(Object.keys(result.stats).slice(0, 2)).toEqual([
      "marketing_roles_after_funding",
      "with_marketing_role_after_funding_and_contact",
    ]);
    expect(result.stats).toMatchObject({ marketing_roles_after_funding: 1, with_marketing_role_after_funding_and_contact: 1 });
  });
});
