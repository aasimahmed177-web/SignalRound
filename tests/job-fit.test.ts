import { describe, expect, test } from "vitest";
import { DEFAULT_FIT, listArg, rankJobs, scoreFit } from "../lib/job-fit";
import type { MarketingJob } from "../lib/marketing-jobs";

const NOW = new Date("2026-11-07T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const job = (fields: Partial<MarketingJob>): MarketingJob => ({
  title: "Marketing Manager",
  company: "Acme",
  company_brief: null,
  location: "Bengaluru, KA, India",
  remote: false,
  posted_at: daysAgo(0),
  source: "indeed",
  source_url: "https://in.indeed.com/viewjob?jk=1",
  apply_url: "https://in.indeed.com/viewjob?jk=1",
  emails: [],
  email_source_quote: null,
  ...fields,
});
const CONFIG = { ...DEFAULT_FIT, locations: listArg("Bengaluru, Mumbai,Remote") };

describe("job fit", () => {
  test("fixture jobs rank by fit", () => {
    const jobs = [
      job({ title: "Marketing Intern", company: "intern" }),
      job({ title: "Senior SEO Manager", company: "stale", posted_at: daysAgo(6) }),
      job({ title: "Performance Marketing Lead", company: "london", location: "London, ENG, UK" }),
      job({
        title: "Head of Growth Marketing",
        company: "best",
        emails: ["jobs@best.example"],
        email_source_quote: "Send your CV to jobs@best.example",
        apply_url: "https://best.example/careers/head-growth",
      }),
      job({ title: "Content Marketing Manager", company: "remote", location: "Remote, India", remote: true }),
      job({
        title: "Brand Manager",
        company: "adjustments",
        emails: ["hr@adj.example"],
        email_source_quote: "If you need reasonable adjustments to support your application, contact hr@adj.example",
      }),
    ];
    expect(rankJobs(jobs, CONFIG, NOW).map((j) => j.company)).toEqual(["best", "remote", "adjustments", "stale", "intern"]);
  });

  test("reasons name each deciding rule", () => {
    const best = scoreFit(
      job({
        title: "Head of Brand",
        location: "Mumbai, MH, India",
        posted_at: daysAgo(1),
        emails: ["hr@x.example"],
        email_source_quote: "Apply: hr@x.example",
        apply_url: "https://acme.example/careers",
      }),
      CONFIG,
      NOW,
    );
    expect(best.reasons).toEqual([
      "freshness: 1d old (+17)",
      "seniority: head (+20)",
      "location: Mumbai (+20)",
      "posted email (+15)",
      "direct employer apply link (+10)",
    ]);
    expect(best.score).toBe(82);

    const weak = scoreFit(
      job({
        title: "Assistant Marketing Manager",
        location: "Pune, MH, India",
        emails: ["careers@x.example"],
        email_source_quote: "For general and additional inquiries, you can reach us at careers@x.example.",
      }),
      CONFIG,
      NOW,
    );
    expect(weak.reasons).toEqual([
      "freshness: 0d old (+20)",
      "seniority: below target (-20)",
      "location: outside Bengaluru, Mumbai, Remote (-50)",
      "posted email (+15)",
      "email intent: general and additional inquiries, not applications (-20)",
      "aggregator-only apply link (-10)",
    ]);
  });

  test("geography is a hard filter: wanted metros, or remote open to India or anywhere", () => {
    const where = (location: string, remote = false) =>
      rankJobs([job({ location, remote })], CONFIG, NOW)[0]?.fit.reasons.find((r) => r.startsWith("location"));
    expect(where("Navi Mumbai, Mumbai (All Areas), India")).toBe("location: Mumbai (+20)");
    expect(where("Bangalore")).toBe("location: Bengaluru (+20)");
    expect(where("GJ, India", true)).toBe("location: remote, India (+15)");
    expect(where("Anywhere in the World", true)).toBe("location: remote, anywhere (+10)");
    for (const [location, remote] of [
      ["Remote, USA", true],
      ["Remote (United States)", true],
      ["Manila, P00, Philippines", true],
      ["Johannesburg, GP, South Africa", true],
      ["Remote, Malaysia", true],
      ["Anywhere (US only)", true],
      ["MH, India", false],
      ["Nagpur, MH, India", false],
      ["Noida, India", false],
      ["Remote", false],
    ] as const)
      expect(where(location, remote), location).toBeUndefined();
    expect(scoreFit(job({ location: "Lagos, LA, Nigeria" }), CONFIG, NOW).reasons).toContain(
      "location: outside Bengaluru, Mumbai, Remote (-50)",
    );
  });

  test("one row per apply link; a shared careers page keeps different roles", () => {
    const ranked = rankJobs(
      [
        job({ company: "Larchmont", title: "Growth Marketing Manager", apply_url: "https://hr.larchmont.example/jobs/gmm-6ony1" }),
        job({
          company: "Larchmont",
          title: "Growth Marketing Manager",
          apply_url: "https://hr.larchmont.example/jobs/gmm-6ony1?source=Indeed&utm_medium=x",
        }),
        job({ company: "Lead", title: "Content Lead", apply_url: "https://ilead.example/vacancies/" }),
        job({ company: "Lead", title: "SEO Manager", apply_url: "https://ilead.example/vacancies" }),
        job({ company: "A", apply_url: "https://in.indeed.com/viewjob?jk=1" }),
        job({ company: "B", apply_url: "https://in.indeed.com/viewjob?jk=2" }),
      ],
      CONFIG,
      NOW,
    );
    expect(ranked.map((j) => j.company)).toEqual(["Larchmont", "Lead", "Lead", "A", "B"]);
  });

  test("defaults: any location adds no location rule; senior executives count as senior", () => {
    const fit = scoreFit(job({ title: "Senior Marketing Executive", location: "Lagos" }), DEFAULT_FIT, NOW);
    expect(fit.reasons.some((r) => r.startsWith("location"))).toBe(false);
    expect(fit.reasons).toContain("seniority: senior (+20)");
    expect(listArg("any")).toEqual([]);
  });
});
