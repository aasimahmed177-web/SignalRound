import { describe, expect, test } from "vitest";
import type { ReadText } from "../lib/job-boards";
import {
  addSiteBriefs,
  companyBrief,
  companyKey,
  companySite,
  dedupeMarketingJobs,
  employerLink,
  isMarketingRole,
  isMarketingTitle,
  type MarketingJob,
  marketingSearches,
  postingEmails,
  resolveLocation,
  similarTitles,
  siteDescription,
  toMarketingJob,
} from "../lib/marketing-jobs";
import { htmlLinks, htmlText } from "../lib/remote-boards";

const NOW = new Date("2026-11-07T12:00:00Z");
const SINCE = new Date(NOW.getTime() - 7 * 86_400_000);

describe("marketing titles", () => {
  test("keeps marketing roles and drops sales, engineering and look-alikes", () => {
    for (const title of [
      "Digital Marketing Executive",
      "SEO Specialist",
      "Social Media Manager - Velour",
      "Performance Marketing Manager",
      "Senior Copywriter",
      "Paid Media Specialist",
      "Brand Manager",
      "Marketing Intern",
      "Sales & Marketing Executive",
      "Content Writer",
      "CRM Marketing Manager",
    ])
      expect(isMarketingTitle(title), title).toBe(true);
    for (const title of [
      "Real Estate Sales Executive",
      "Telemarketing Executive",
      "Marketing Data Engineer",
      "Graphic Designer (Social Media)",
      "Social Worker",
      "Content Reviewer",
      "Business Development & Marketing Manager",
      "Network Marketing Associate",
    ])
      expect(isMarketingTitle(title), title).toBe(false);
  });
});

describe("isMarketingRole", () => {
  test("reads the ATS team and growth, brand, comms and GTM titles, not other crafts or sales teams", () => {
    for (const [title, team] of [
      ["Senior Creative Producer", "Communications"],
      ["Product Marketing Manager", "Product"],
      ["Head of Product Marketing", null],
      ["GTM Lead", null],
      ["Head of Communications", null],
      ["Demand Generation Manager", null],
      ["Performance Marketing Manager", "Sales"],
    ] as const)
      expect(isMarketingRole(title, team), title).toBe(true);
    for (const [title, team] of [
      ["Software Engineer - Backend - Growth", "Engineering · Growth"],
      ["Marketing Data Engineer", "Marketing"],
      ["Director, Commercial Growth", "Business Development"],
      ["Content Reviewer", null],
      ["Enterprise Sales Director", "Go To Market"],
      ["Sales Development Representative", "Go To Market"],
      ["Strategic Accounts Development Manager", "Go To Market"],
      ["Controller", "Finance"],
      ["Product Manager", "Product"],
      ["Website Product Manager", "Marketing · Brand & Content"],
      ["Head of Product - Growth", "Product · Growth"],
      ["Head of Product-Led Growth", null],
      ["Product Growth Manager", "Growth"],
      ["Sales cum CRM Executive", null],
      ["VP, Product", "Marketing"],
    ] as const)
      expect(isMarketingRole(title, team), title).toBe(false);
  });
});

describe("posting emails", () => {
  test("keeps emails written in the text, with the line they appear on", () => {
    const text =
      "**About the role**\nWe need a SEO executive.\n\nInterested candidates can share CV at [hr\\_team@acme.example](mailto:hr_team@acme.example).";
    expect(postingEmails(text)).toEqual({
      emails: ["hr_team@acme.example"],
      quote: "Interested candidates can share CV at hr_team@acme.example.",
    });
  });

  test("drops privacy, accommodation, platform and example addresses", () => {
    const text = [
      "For accommodation requests email talent-access@bigco.example.",
      "Questions about your data: privacy@bigco.example",
      "Offers only originate from an @bigco.example address (e.g. a.sample@bigco.example).",
      "Applied via candidate-a1b2c3@indeed.com",
      "To check the authenticity of such emails, write to hrop@bigco.example.",
      "Need help applying? AccessibilitySupport@bigco.example",
      "To become an approved agency, write to careers@bigco.example",
      "Send your portfolio to jobs@bigco.example",
    ].join("\n");
    expect(postingEmails(text).emails).toEqual(["jobs@bigco.example"]);
  });

  test("cuts a TLD run into the next word back to the address", () => {
    expect(postingEmails("Send CV to: Quillhr@gmail.comusing the job title as subject.").emails).toEqual(["quillhr@gmail.com"]);
    expect(postingEmails("Mail hr@peakexample.inContact 98765").emails).toEqual(["hr@peakexample.in"]);
    expect(postingEmails("Mail info@lanternclubexample.me today").emails).toEqual(["info@lanternclubexample.me"]);
  });

  test("shortens a long line around the email", () => {
    const long = `${"word ".repeat(80)}email cv@smallexample.co ${"more ".repeat(80)}`;
    const { quote } = postingEmails(long);
    expect(quote?.length).toBeLessThanOrEqual(242);
    expect(quote).toContain("cv@smallexample.co");
  });
});

describe("employer links", () => {
  test("prefers the employer's own page and never a job board", () => {
    expect(employerLink([], "https://www.orbitfoldtech.example/career/#")).toBe("https://www.orbitfoldtech.example/career/#");
    expect(employerLink([], "https://in.indeed.com/viewjob?jk=1")).toBeNull();
    expect(
      employerLink([
        "https://jobicy.com/company/x",
        "https://keelson.example/careers/diversity/identity",
        "https://harbourline.teamtailor.com",
        "http://saltmarsh.example/careers",
      ]),
    ).toBe("https://harbourline.teamtailor.com/");
    expect(employerLink(["https://saltmarsh.example/about"])).toBeNull();
  });
});

describe("company brief", () => {
  test("reads the posting's about section or a self-description, else the industry", () => {
    expect(
      companyBrief(
        "Brickvane",
        "## About Us\nBrickvane is a venture-backed startup rethinking how new homes get designed. We are growing.",
      ),
    ).toBe("Brickvane is a venture-backed startup rethinking how new homes get designed.");
    expect(companyBrief("Acme Pvt Ltd", "Hiring now!\nAcme is a leading D2C skincare brand based in Pune. Apply today.")).toBe(
      "Acme is a leading D2C skincare brand based in Pune.",
    );
    expect(companyBrief("Acme", "We are hiring a marketer.", { company_industry: "Marketing & Advertising" })).toBe(
      "Industry: Marketing & Advertising",
    );
    expect(companyBrief("Acme", "We are hiring a marketer.")).toBeNull();
  });
});

describe("toMarketingJob", () => {
  const base = {
    source: "jobspy-indeed",
    external_id: "1",
    url: "https://in.indeed.com/viewjob?jk=1",
    title: "Digital Marketing Executive",
    company: "Orbitfold Technologies",
    location: "Pune, MH, IN",
    posted_at: "2026-11-06",
    description: "Orbitfold Technologies is a software company building ERP tools.\nSend your resume to hr@orbitfoldtech.example",
    metadata: { apply_url: "https://www.orbitfoldtech.example/career/#" },
  };

  test("maps a posting with an email and the employer's apply link", () => {
    expect(toMarketingJob(base, SINCE, NOW)).toEqual({
      title: "Digital Marketing Executive",
      company: "Orbitfold Technologies",
      company_brief: "Orbitfold Technologies is a software company building ERP tools.",
      location: "Pune, MH, IN",
      remote: null,
      posted_at: "2026-11-06T00:00:00.000Z",
      source: "indeed",
      source_url: "https://in.indeed.com/viewjob?jk=1",
      apply_url: "https://www.orbitfoldtech.example/career/#",
      emails: ["hr@orbitfoldtech.example"],
      contact_only_emails: [],
      email_source_quote: "Send your resume to hr@orbitfoldtech.example",
    });
  });

  test("an address only for adjustments or questions moves the role to apply-link and keeps it as contact-only", () => {
    const description =
      "Apply on our careers site.\nIf you experience any difficulties while submitting your application, please email askhr@lumenarts.example";
    const job = toMarketingJob({ ...base, description }, SINCE, NOW);
    expect(typeof job !== "string" && [job.emails, job.contact_only_emails, job.email_source_quote]).toEqual([
      [],
      ["askhr@lumenarts.example"],
      "If you experience any difficulties while submitting your application, please email askhr@lumenarts.example",
    ]);
  });

  test("keeps the application inbox and sets aside the adjustments address", () => {
    const description =
      "Send your CV to jobs@orbitfoldtech.example.\nIf you need any adjustments to support your application, please contact recruitment@orbitfoldtech.example.";
    const job = toMarketingJob({ ...base, description }, SINCE, NOW);
    expect(typeof job !== "string" && [job.emails, job.contact_only_emails]).toEqual([
      ["jobs@orbitfoldtech.example"],
      ["recruitment@orbitfoldtech.example"],
    ]);
  });

  test("drops old, undated and non-marketing postings", () => {
    expect(toMarketingJob({ ...base, posted_at: "2026-10-30" }, SINCE, NOW)).toBe("older than the window");
    expect(toMarketingJob({ ...base, posted_at: null }, SINCE, NOW)).toBe("no posting date");
    expect(toMarketingJob({ ...base, title: "Backend Engineer" }, SINCE, NOW)).toBe("not a marketing role");
  });

  test("falls back to the source page when no employer link is known", () => {
    const job = toMarketingJob({ ...base, description: "Apply on Indeed.", metadata: {} }, SINCE, NOW);
    expect(typeof job !== "string" && [job.apply_url, job.emails, job.email_source_quote]).toEqual([base.url, [], null]);
  });
});

describe("resolveLocation", () => {
  test("a state-only location takes the one city of that state the posting names", () => {
    expect(resolveLocation("MH, India", "Job Location: Andheri East, Mumbai")).toBe("Mumbai, MH, India");
    expect(resolveLocation("KA, India", "We are hiring in Bangalore. Offices in Delhi too.")).toBe("Bengaluru, KA, India");
    expect(resolveLocation("MH, India", "Location: Nagpur. Our HQ is in Mumbai.")).toBe("Nagpur, MH, India");
  });

  test("no city, several cities, or a location with a city stay as they are", () => {
    expect(resolveLocation("MH, India", "Great marketing role.")).toBe("MH, India");
    expect(resolveLocation("MH, India", "Offices in Mumbai and Pune.")).toBe("MH, India");
    expect(resolveLocation("Pune, MH, IN", "Mumbai")).toBe("Pune, MH, IN");
    expect(resolveLocation("Noida, India", "Delhi NCR")).toBe("Noida, India");
    expect(resolveLocation(null, "Mumbai")).toBeNull();
  });
});

describe("dedupe", () => {
  const job = (fields: Partial<MarketingJob>): MarketingJob => ({
    title: "SEO Executive",
    company: "Acme Pvt Ltd",
    company_brief: null,
    location: null,
    remote: null,
    posted_at: "2026-11-05T00:00:00.000Z",
    source: "naukri",
    source_url: "https://www.naukri.com/job-listings-1",
    apply_url: "https://www.naukri.com/job-listings-1",
    emails: [],
    email_source_quote: null,
    ...fields,
  });

  test("same company and similar title is one role: keeps the emailed version and the employer's link", () => {
    const kept = dedupeMarketingJobs([
      job({ apply_url: "https://acme.example/careers/seo" }),
      job({
        title: "SEO Executive (Urgent Hiring)",
        company: "ACME Private Limited",
        source: "indeed",
        emails: ["hr@acme.example"],
        email_source_quote: "Mail hr@acme.example",
        apply_url: "https://in.indeed.com/viewjob?jk=2",
      }),
      job({ title: "Social Media Manager" }),
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ source: "indeed", emails: ["hr@acme.example"], apply_url: "https://acme.example/careers/seo" });
  });

  test("the same email with a similar title merges across company spellings", () => {
    const kept = dedupeMarketingJobs([
      job({ company: "corvane.example", emails: ["info@corvane.example"], title: "Performance Marketing Specialist" }),
      job({ company: "Corvane Ventures", emails: ["info@corvane.example"], title: "Performance Marketing Specialist - Mangalore" }),
    ]);
    expect(kept).toHaveLength(1);
  });

  test("keys and title similarity", () => {
    expect(companyKey("Acme Pvt. Ltd.")).toBe(companyKey("ACME Private Limited"));
    expect(similarTitles("Sr. Digital Marketing Executive", "Senior Digital Marketing Executive")).toBe(true);
    expect(similarTitles("SEO Executive", "SEO Manager")).toBe(false);
  });
});

describe("sources", () => {
  test("board HTML becomes readable text and its links", () => {
    const html =
      '<p><strong>About Us</strong></p><p>Brickvane builds homes.<br>Mail <a href="mailto:a@b.example">a@b.example</a></p><a href="https://brickvane.example/jobs/1">Apply</a>';
    expect(htmlText(html)).toBe("About Us\nBrickvane builds homes.\nMail a@b.example\nApply");
    expect(htmlLinks(html)).toEqual(["https://brickvane.example/jobs/1"]);
    expect(htmlText("&lt;p&gt;Hi&lt;/p&gt;&lt;p&gt;There&lt;/p&gt;")).toBe("Hi\nThere");
  });

  test("searches cover every marketing term across countries, with a 7-day cut-off", () => {
    const searches = marketingSearches(7);
    expect(searches.every((search) => search.hoursOld === 168)).toBe(true);
    expect(searches.filter((search) => search.sites?.includes("indeed")).length).toBeGreaterThan(100);
    expect(searches.filter((search) => search.sites?.includes("naukri")).every((search) => search.fullDescriptions)).toBe(true);
  });
});

describe("company site briefs", () => {
  const job = {
    company: "Pelican Agri Singapore Pte Ltd",
    emails: ["hrglobal@pelicanagri.example"],
    apply_url: "https://sg.indeed.com/viewjob?jk=1",
  };

  test("uses an email domain or apply host only when it carries the company's name", () => {
    expect(companySite(job)).toBe("https://pelicanagri.example/");
    expect(companySite({ ...job, company: "Bright Signal", emails: ["hello@staffly.example"] })).toBeNull();
    expect(companySite({ ...job, emails: ["pelican.hr@gmail.com"] })).toBeNull();
    expect(companySite({ company: "Orbitfold Technologies", emails: [], apply_url: "https://www.orbitfoldtech.example/career/" })).toBe(
      "https://orbitfoldtech.example/",
    );
  });

  test("reads the homepage's own description and fills every role at that company", async () => {
    expect(siteDescription('<meta name="description" content="Pelican Agri is a leading animal health company in Asia.">')).toBe(
      "Pelican Agri is a leading animal health company in Asia.",
    );
    expect(siteDescription('<meta name="description" content="Please enable JavaScript to view this site properly.">')).toBeNull();
    const jobs = [
      { ...job, title: "SEO Executive", company_brief: null } as MarketingJob,
      { ...job, title: "Content Writer", company_brief: null } as MarketingJob,
    ];
    const read: ReadText = async (url) => ({
      url,
      status: 200,
      text: '<meta property="og:description" content="Pelican Agri makes animal health products.">',
    });
    expect(await addSiteBriefs(jobs, read)).toBe(2);
    expect(jobs.map((j) => j.company_brief)).toEqual([
      "Pelican Agri makes animal health products.",
      "Pelican Agri makes animal health products.",
    ]);
  });
});
