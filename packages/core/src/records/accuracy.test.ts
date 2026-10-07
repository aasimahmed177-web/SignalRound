import { describe, expect, test } from "vitest";
import {
  type AccuracyCompany,
  type AccuracyFlag,
  type AccuracyRound,
  accuracyFlags,
  advanceFounderMemory,
  compareFlags,
  droppedFounders,
  duplicatePairs,
  planFlagChanges,
  prominentCompanyIds,
  type StoredAccuracyFlag,
  usdLabel,
} from "./accuracy.ts";

const NOW = new Date("2026-09-24T05:00:00Z");
const OLD = "2026-09-20T12:00:00Z";

function round(over: Partial<AccuracyRound> & { id: string }): AccuracyRound {
  return {
    stage: "series_b",
    stageAsWritten: "Series B",
    amountUsdMillions: 100,
    amountAsWritten: "$100 million",
    announcedOn: "2025-01-10",
    datePrecision: "day",
    verification: "confirmed",
    confidence: 0.9,
    firstSeenAt: OLD,
    history: false,
    sourceTitles: ["Acme raises $100 million", "Acme's Series B"],
    leadCount: 1,
    ...over,
  };
}

function company(over: Partial<AccuracyCompany> = {}): AccuracyCompany {
  return {
    id: "acme",
    name: "Acme",
    domain: "acme.com",
    domainVerified: true,
    description: "Acme builds rockets.",
    logoUrl: "https://acme.com/logo.png",
    rounds: [round({ id: "acme:series_b:2025-01-10" })],
    dossier: { checked: true, founders: ["Ada Lovelace"] },
    previousFounders: null,
    ...over,
  };
}

const rules = (flags: AccuracyFlag[]) => flags.map((f) => f.rule).sort();
const byRule = (flags: AccuracyFlag[], rule: string) => flags.find((f) => f.rule === rule);

/**
 * OpenAI as the audit found it on 2026-09-23: no domain (a news-only website search), no dossier, a
 * "Series A" with no amount read off a Crunchbase News trend story, and its $6.6B and $40B rounds
 * filed under Other with no lead named on the first.
 */
const OPENAI_BEFORE = company({
  id: "openai",
  name: "OpenAI",
  domain: null,
  domainVerified: false,
  description: null,
  logoUrl: null,
  rounds: [
    round({
      id: "openai:other:2024-10-02",
      stage: "other",
      stageAsWritten: "funding round",
      amountUsdMillions: 6600,
      amountAsWritten: "$6.6 billion",
      announcedOn: "2024-10-02",
      leadCount: 0,
    }),
    round({
      id: "openai:other:2025-03-31",
      stage: "other",
      stageAsWritten: "funding round",
      amountUsdMillions: 40000,
      amountAsWritten: "$40 billion",
      announcedOn: "2025-03-31",
    }),
    round({
      id: "openai:series_a:2026-09-23",
      stage: "series_a",
      stageAsWritten: "Series A",
      amountUsdMillions: null,
      amountAsWritten: null,
      announcedOn: "2026-09-23",
      verification: "unverified",
      confidence: 0.64,
      firstSeenAt: "2026-09-23T01:00:00Z",
      sourceTitles: ["The Week's 10 Biggest Funding Rounds: Series A Megarounds For AI Chips And Robotics"],
    }),
  ],
  dossier: null,
});

describe("accuracyFlags", () => {
  test("a clean company raises nothing", () => {
    expect(accuracyFlags(company(), NOW)).toEqual([]);
  });

  test("OpenAI before the fix: every shape the audit found is flagged, with the safe remedies named", () => {
    const flags = accuracyFlags(OPENAI_BEFORE, NOW);
    expect(rules(flags)).toEqual(
      [
        "no_domain",
        "no_description",
        "no_logo",
        "stage_regression",
        "list_only",
        "unverified",
        "dossier_missing",
        "stage_other_large",
        "no_lead_large",
      ].sort(),
    );
    const regression = byRule(flags, "stage_regression");
    expect(regression?.severity).toBe("high");
    expect(regression?.subjects).toEqual(["openai:series_a:2026-09-23"]);
    expect(regression?.reason).toContain("Series A (2026-09-23) after a verified unlettered $40B round on 2025-03-31");
    expect(byRule(flags, "list_only")?.subjects).toEqual(["openai:series_a:2026-09-23"]);
    expect(byRule(flags, "stage_other_large")?.subjects).toEqual(["openai:other:2024-10-02", "openai:other:2025-03-31"]);
    expect(byRule(flags, "no_lead_large")?.subjects).toEqual(["openai:other:2024-10-02"]);
    expect(byRule(flags, "no_domain")?.remedy).toBe("profile");
    expect(byRule(flags, "dossier_missing")?.remedy).toBe("dossier");
    // The unverified trend-story row has sat for a day: high, and named with its state.
    expect(byRule(flags, "unverified")?.severity).toBe("high");
    expect(byRule(flags, "unverified")?.reason).toContain("Series A (2026-09-23), unverified");
  });

  test("OpenAI after the fix: a verified domain, growth stages, a checked dossier with founders: nothing left but what is true", () => {
    const after = company({
      ...OPENAI_BEFORE,
      domain: "openai.com",
      domainVerified: true,
      description: "OpenAI builds AI models and ChatGPT.",
      logoUrl: "https://openai.com/logo.svg",
      rounds: OPENAI_BEFORE.rounds.slice(0, 2).map((r) => ({ ...r, stage: "growth" as const, leadCount: 1 })),
      dossier: { checked: true, founders: ["Sam Altman", "Greg Brockman", "Ilya Sutskever"] },
    });
    expect(accuracyFlags(after, NOW)).toEqual([]);
  });

  test("Anthropic's misdated Series B: a lettered round with an amount after its Series F reads as misdated", () => {
    const anthropic = company({
      id: "anthropic",
      rounds: [
        round({
          id: "anthropic:series_d_plus:2025-09-02",
          stage: "series_d_plus",
          stageAsWritten: "Series F",
          amountUsdMillions: 13_000,
          announcedOn: "2025-09-02",
          history: true,
        }),
        round({
          id: "anthropic:series_b:2026-08-31",
          stage: "series_b",
          stageAsWritten: "Series B",
          amountUsdMillions: 500,
          amountAsWritten: "$500 million",
          announcedOn: "2026-08-31",
        }),
      ],
    });
    const f = byRule(accuracyFlags(anthropic, NOW), "stage_regression");
    expect(f?.severity).toBe("medium");
    expect(f?.subjects).toEqual(["anthropic:series_b:2026-08-31"]);
    expect(f?.reason).toContain("misdated");
    // Dated where it belongs (2022), it sits before the Series F and nothing is flagged.
    const fixed = { ...anthropic, rounds: [anthropic.rounds[0], { ...anthropic.rounds[1], announcedOn: "2022-04-29" }] };
    expect(byRule(accuracyFlags(fixed, NOW), "stage_regression")).toBeUndefined();
  });

  test("a company moving on is not a regression: a bigger later letter, a letter after an unlettered growth round, one letter back", () => {
    const moving = (rounds: AccuracyRound[]) => byRule(accuracyFlags(company({ rounds }), NOW), "stage_regression");
    // DayOne: a $4.5B Series C after its $1.2B Series B (the billion-dollar rule would call the B late-stage).
    expect(
      moving([
        round({ id: "b", stage: "series_b", amountUsdMillions: 1200, announcedOn: "2024-10-29" }),
        round({ id: "c", stage: "series_c", stageAsWritten: "Series C", amountUsdMillions: 4500, announcedOn: "2026-06-05" }),
      ]),
    ).toBeUndefined();
    // Wonder: a Series D after a $600M unlettered round filed as growth.
    expect(
      moving([
        round({ id: "g", stage: "growth", stageAsWritten: "funding round", amountUsdMillions: 600, announcedOn: "2025-05-06" }),
        round({ id: "d", stage: "series_d_plus", stageAsWritten: "Series D", amountUsdMillions: 650, announcedOn: "2026-07-16" }),
      ]),
    ).toBeUndefined();
    // One letter back, or a larger round two letters back, is left alone too.
    expect(
      moving([
        round({ id: "b", stage: "series_b", amountUsdMillions: 65, announcedOn: "2025-10-06" }),
        round({ id: "a", stage: "series_a", stageAsWritten: "Series A follow-on", amountUsdMillions: 16, announcedOn: "2026-06-26" }),
      ]),
    ).toBeUndefined();
    expect(
      moving([
        round({ id: "d", stage: "series_d_plus", amountUsdMillions: 100, announcedOn: "2024-01-01" }),
        round({ id: "b", stage: "series_b", amountUsdMillions: 400, announcedOn: "2026-01-01" }),
      ]),
    ).toBeUndefined();
  });

  test("a real duplicate pair: one round read twice under two labels a week apart", () => {
    const c = company({
      rounds: [
        round({
          id: "tekever:series_d_plus:2026-09-23",
          stage: "series_d_plus",
          stageAsWritten: "Series D",
          amountUsdMillions: 580,
          announcedOn: "2026-09-23",
        }),
        round({
          id: "tekever:growth:2026-09-16",
          stage: "growth",
          stageAsWritten: "funding round",
          amountUsdMillions: 560,
          announcedOn: "2026-09-16",
        }),
        round({ id: "tekever:series_c:2024-05-01", stage: "series_c", amountUsdMillions: 575, announcedOn: "2024-05-01" }),
      ],
    });
    const f = byRule(accuracyFlags(c, NOW), "possible_duplicate");
    expect(f?.subjects).toEqual(["tekever:growth:2026-09-16", "tekever:series_d_plus:2026-09-23"]);
    expect(f?.severity).toBe("high");
    // Amounts a fifth apart are two rounds, and so are equal amounts 31 days apart.
    expect(duplicatePairs([round({ id: "a", amountUsdMillions: 100 }), round({ id: "b", amountUsdMillions: 80 })])).toEqual([]);
    expect(duplicatePairs([round({ id: "a", announcedOn: "2026-01-01" }), round({ id: "b", announcedOn: "2026-02-01" })])).toEqual([]);
  });

  test("the profile rules: an unverified domain is a flag with the refresh remedy; a missing logo alone is not", () => {
    const f = accuracyFlags(company({ domainVerified: false }), NOW);
    expect(rules(f)).toEqual(["no_domain"]);
    expect(f[0].reason).toContain("acme.com");
    expect(f[0].subjects).toEqual(["unverified acme.com"]);
    expect(rules(accuracyFlags(company({ logoUrl: null }), NOW))).toEqual(["no_logo"]);
    expect(rules(accuracyFlags(company({ description: null }), NOW))).toEqual(["no_description"]);
  });

  test("a round under the publish bar gets a day's grace; a verified one under it is low severity", () => {
    const fresh = round({ id: "r1", confidence: 0.6, firstSeenAt: "2026-09-23T12:00:00Z" });
    expect(accuracyFlags(company({ rounds: [fresh] }), NOW)).toEqual([]);
    const aged = { ...fresh, firstSeenAt: "2026-09-22T12:00:00Z" };
    const f = byRule(accuracyFlags(company({ rounds: [aged] }), NOW), "unverified");
    expect(f?.severity).toBe("low");
    expect(f?.reason).toContain("confidence 0.60");
    // A history row promoted from its own announcement is verified whatever its verdict field says.
    expect(accuracyFlags(company({ rounds: [round({ id: "h", verification: null, history: true })] }), NOW)).toEqual([]);
  });

  test("the dossier rules: unchecked, no founders, and founders dropped since the last dossier", () => {
    expect(byRule(accuracyFlags(company({ dossier: { checked: false, founders: [] } }), NOW), "dossier_missing")?.severity).toBe("medium");
    const none = accuracyFlags(company({ dossier: { checked: true, founders: [] } }), NOW);
    expect(rules(none)).toEqual(["dossier_no_founders"]);
    expect(none[0].remedy).toBe("dossier");
    const dropped = accuracyFlags(
      company({
        dossier: { checked: true, founders: ["Sam Altman"] },
        previousFounders: ["Sam Altman", "Greg Brockman", "Ilya Sutskever"],
      }),
      NOW,
    );
    expect(rules(dropped)).toEqual(["founders_dropped"]);
    expect(dropped[0].subjects).toEqual(["greg brockman", "ilya sutskever"]);
    expect(dropped[0].remedy).toBeNull();
  });
});

describe("droppedFounders", () => {
  test("spelling, case, and a middle initial are the same founder", () => {
    expect(droppedFounders(["Samuel H. Altman", "Élodie Martin"], ["samuel altman", "Elodie Martin"])).toEqual([]);
    expect(droppedFounders(["A", "B"], ["A"])).toEqual(["B"]);
  });
});

describe("prominentCompanyIds", () => {
  test("the top N by largest round and by total, plus every $100M round, biggest first", () => {
    const sizes = [
      { id: "small", largest: 5, total: 5 },
      { id: "many", largest: 40, total: 400 },
      { id: "big", largest: 900, total: 900 },
      { id: "hundred", largest: 100, total: 100 },
      { id: "none", largest: null, total: null },
    ];
    expect(prominentCompanyIds(sizes, 1)).toEqual(["big", "hundred"]);
    expect(prominentCompanyIds(sizes, 2)).toEqual(["big", "hundred", "many"]);
    expect(prominentCompanyIds(sizes, 10)).toEqual(["big", "hundred", "many", "small"]);
  });
});

describe("planFlagChanges", () => {
  const f = (rule: AccuracyFlag["rule"], subjects: string[]): AccuracyFlag => ({
    rule,
    severity: "high",
    reason: "x",
    subjects,
    remedy: null,
  });
  const stored = (over: Partial<StoredAccuracyFlag>): StoredAccuracyFlag => ({
    companyId: "acme",
    rule: "no_domain",
    subjects: ["no domain"],
    clearedAt: null,
    dismissedAt: null,
    dismissedSubjects: null,
    ...over,
  });

  test("new, still open, and auto-cleared when the condition no longer holds", () => {
    const plan = planFlagChanges(
      [stored({}), stored({ rule: "no_logo" })],
      [
        { companyId: "acme", flag: f("no_domain", ["no domain"]) },
        { companyId: "acme", flag: f("no_description", ["no description"]) },
      ],
    );
    expect(plan.writes.map((w) => [w.flag.rule, w.state])).toEqual([
      ["no_domain", "open"],
      ["no_description", "new"],
    ]);
    expect(plan.clears).toEqual([{ companyId: "acme", rule: "no_logo" }]);
  });

  test("a dismissal holds while the flag is about the same things, and reopens on a new subject", () => {
    const dismissed = stored({ rule: "no_lead_large", subjects: ["r1", "r2"], dismissedAt: NOW, dismissedSubjects: ["r1", "r2"] });
    expect(planFlagChanges([dismissed], [{ companyId: "acme", flag: f("no_lead_large", ["r1"]) }]).writes[0].state).toBe("dismissed");
    expect(planFlagChanges([dismissed], [{ companyId: "acme", flag: f("no_lead_large", ["r1", "r3"]) }]).writes[0].state).toBe("reopened");
    // A dismissed flag whose condition cleared clears too; seen again later, it is new.
    expect(planFlagChanges([dismissed], []).clears).toEqual([{ companyId: "acme", rule: "no_lead_large" }]);
    const cleared = { ...dismissed, clearedAt: NOW };
    expect(planFlagChanges([cleared], [{ companyId: "acme", flag: f("no_lead_large", ["r1"]) }]).writes[0].state).toBe("new");
    expect(planFlagChanges([cleared], []).clears).toEqual([]);
  });
});

test("compareFlags puts high severity first, then the rule order", () => {
  const list = [
    { severity: "low" as const, rule: "no_lead_large" as const },
    { severity: "high" as const, rule: "possible_duplicate" as const },
    { severity: "high" as const, rule: "no_domain" as const },
  ].sort(compareFlags);
  expect(list.map((x) => x.rule)).toEqual(["no_domain", "possible_duplicate", "no_lead_large"]);
});

test("usdLabel", () => {
  expect([usdLabel(580), usdLabel(40_000), usdLabel(1300), usdLabel(6.6), usdLabel(0.5)]).toEqual([
    "$580M",
    "$40B",
    "$1.3B",
    "$6.6M",
    "$500K",
  ]);
});

describe("advanceFounderMemory", () => {
  test("the first dossier has nothing to compare; a rewrite compares against the last; the same dossier keeps its comparison", () => {
    const first = advanceFounderMemory(null, { at: "2026-09-01T00:00:00.000Z", founders: ["A", "B"] });
    expect(first.previous).toBeNull();
    expect(first.changed).toBe(true);
    const rewrite = advanceFounderMemory(first.memory, { at: "2026-09-20T00:00:00.000Z", founders: ["A"] });
    expect(rewrite.previous).toEqual(["A", "B"]);
    expect(rewrite.memory.previousFounders).toEqual(["A", "B"]);
    const again = advanceFounderMemory(rewrite.memory, { at: "2026-09-20T00:00:00.000Z", founders: ["A"] });
    expect(again.changed).toBe(false);
    expect(again.previous).toEqual(["A", "B"]);
  });
});
