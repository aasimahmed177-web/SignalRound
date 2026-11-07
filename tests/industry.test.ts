import { describe, expect, test } from "vitest";
import { classifyIndustry } from "../lib/industry";

const HOME = "https://example.com/";
const NEWS = "https://news.example/raise";
const brief = (text: string, headline = "") =>
  classifyIndustry([
    { text, url: HOME, weight: 3 },
    { text: headline, url: NEWS, weight: 2 },
  ]);

describe("industry tag", () => {
  test.each([
    ["Personalised tutoring and exam prep for school students across India.", "edtech"],
    ["AI scribe that writes clinical notes so doctors can spend time with patients.", "healthcare"],
    ["The SaaS platform that helps clinics and hospitals schedule patients.", "healthcare"],
    ["Proptech platform helping landlords manage rental properties and tenants.", "real_estate"],
    ["A hiring marketplace matching job seekers with recruiters in days.", "hiring_marketplace"],
    ["Workflow automation for sales teams, built for B2B enterprises.", "b2b_saas"],
    ["A social app for creators to share short videos.", "consumer_app"],
    ["A performance marketing agency for venture-backed brands.", "agency"],
    ["Cross-border payments and lending for small businesses.", "fintech"],
    ["D2C skincare brand selling through its online store.", "ecommerce"],
    ["Carbon removal and energy storage for a net-zero grid.", "climate"],
    ["We build satellites and robotics for orbital servicing.", "deeptech"],
  ])("%s → %s", (text, label) => {
    const industry = brief(text);
    expect(industry.label).toBe(label);
    expect(industry.confidence).toBeGreaterThan(0);
    expect(text).toContain(industry.evidence_quote);
    expect(industry.source_url).toBe(HOME);
  });

  test("empty or unclear text is other with confidence 0", () => {
    for (const text of ["", "   ", null, "We are a team of builders on a mission."])
      expect(brief(text as string)).toEqual({ label: "other", confidence: 0, evidence_quote: null, source_url: null });
  });

  test("a tie between two industries is not guessed", () => {
    expect(brief("Payments for students.").label).toBe("other");
  });

  test("the headline decides when the homepage has no brief", () => {
    const industry = brief("", "Fintech startup Coinmoss raises $4M seed to expand payments");
    expect(industry).toMatchObject({ label: "fintech", source_url: NEWS });
    expect(industry.evidence_quote).toBe("Fintech startup Coinmoss raises $4M seed to expand payments");
  });

  test("the evidence quote is the sentence that decided it, as written", () => {
    const industry = brief("Founded in 2024. Quarkle builds quantum chips for data centres. Based in Berlin.");
    expect(industry).toMatchObject({ label: "deeptech", evidence_quote: "Quarkle builds quantum chips for data centres." });
  });

  test("a decimal point does not end the quoted sentence", () => {
    expect(brief("", "Orebit Digital raises $7.5M Series A as crypto trading grows").evidence_quote).toBe(
      "Orebit Digital raises $7.5M Series A as crypto trading grows",
    );
  });

  test("a text without a source url is ignored", () => {
    expect(classifyIndustry([{ text: "Online tutoring for students", url: null, weight: 3 }]).label).toBe("other");
  });
});
