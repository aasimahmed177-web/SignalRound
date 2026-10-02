import { priorKey } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { countParts } from "../lib/buzz";
import {
  dossierTotal,
  foldSyndicated,
  investorsByRound,
  mergeFounders,
  priorsOffRecord,
  roundAfter,
  sourcesByRound,
  totalToDate,
  unlistedBackers,
} from "../lib/company-groups";

const rounds = [{ id: "c" }, { id: "b" }, { id: "a" }];

const src = (url: string, round_ids: string[], title: string | null, published_at: string | null, host = new URL(url).host) => ({
  url,
  host,
  title,
  published_at,
  round_ids,
});

describe("sourcesByRound", () => {
  test("each round gets its own sources, in the rounds' order, newest source first", () => {
    const groups = sourcesByRound(
      rounds,
      [
        src("https://news.example/a", ["a"], "Acme raises $5M seed", "2022-01-02"),
        src("https://news.example/c1", ["c"], "Acme raises $80M Series C", "2026-09-20"),
        src("https://blog.example/c2", ["c"], "Why we backed Acme", "2026-09-22"),
      ],
      {},
    );
    expect(groups.map((g) => g.round.id)).toEqual(["c", "a"]);
    expect(groups[0].entries.map((e) => e.primary.url)).toEqual(["https://blog.example/c2", "https://news.example/c1"]);
    expect(groups[0].count).toBe(2);
  });

  test("a round with no sources is left out; a source behind two rounds is listed under both", () => {
    const shared = src("https://wire.example/acme", ["c", "b"], "Acme history", "2026-09-01");
    const groups = sourcesByRound(rounds, [shared], {});
    expect(groups.map((g) => g.round.id)).toEqual(["c", "b"]);
    expect(groups.every((g) => g.entries[0].primary === shared)).toBe(true);
  });

  test("syndicated copies fold under the best-tier publisher, and the heading still counts every copy", () => {
    const groups = sourcesByRound(
      [{ id: "c" }],
      [
        src("https://small.example/x", ["c"], "Acme raises $80M - Small Wire", "2026-09-20"),
        src("https://big.example/x", ["c"], "Acme raises $80M | Big Paper", "2026-09-21"),
        src("https://other.example/y", ["c"], "Acme profile", "2026-09-19"),
      ],
      { "big.example": 0.9, "small.example": 0.2 },
    );
    expect(groups[0].count).toBe(3);
    expect(groups[0].entries).toHaveLength(2);
    const folded = groups[0].entries.find((e) => e.also.length > 0);
    expect(folded?.primary.host).toBe("big.example");
    expect(folded?.also.map((a) => a.host)).toEqual(["small.example"]);
  });

  test("an untitled source or a section index page never folds", () => {
    const entries = foldSyndicated(
      [
        src("https://a.example/1", ["c"], null, "2026-09-01"),
        src("https://b.example/2", ["c"], null, "2026-09-02"),
        src("https://c.example/news", ["c"], "News and press releases", null),
        src("https://d.example/news", ["c"], "News and press releases", null),
      ],
      {},
    );
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.also.length === 0)).toBe(true);
  });
});

const inv = (id: string, roles: Array<[string, boolean]>, name = id) => ({
  id,
  name,
  total: roles.length,
  roles: roles.map(([round_id, lead]) => ({ round_id, lead })),
});

describe("investorsByRound", () => {
  test("leads then participants under each round, in the rounds' order; an investor on several rounds is under each", () => {
    const groups = investorsByRound(rounds, [
      inv("big", [
        ["c", true],
        ["b", false],
        ["a", false],
      ]),
      inv("angel", [["a", true]]),
      inv("growth", [["c", false]]),
      inv("second", [["b", true]]),
    ]);
    expect(groups.map((g) => g.round.id)).toEqual(["c", "b", "a"]);
    expect(groups.map((g) => [g.leads.map((i) => i.id), g.participants.map((i) => i.id)])).toEqual([
      [["big"], ["growth"]],
      [["second"], ["big"]],
      [["angel"], ["big"]],
    ]);
  });

  test("within a role, returning backers first, then by name; a round with nobody named is left out", () => {
    const groups = investorsByRound(rounds, [
      inv("zeta", [["c", false]], "Zeta"),
      inv("alpha", [["c", false]], "Alpha"),
      inv("repeat", [
        ["c", false],
        ["b", false],
      ]),
    ]);
    expect(groups.map((g) => g.round.id)).toEqual(["c", "b"]);
    expect(groups[0].participants.map((i) => i.id)).toEqual(["repeat", "alpha", "zeta"]);
    expect(investorsByRound(rounds, [])).toEqual([]);
  });
});

describe("countParts", () => {
  test("the long form stops the X part at 'on' for the logomark, singular and plural, zeros left out", () => {
    expect(countParts({ people: 13, outlets: 6, hn_points: 40 })).toEqual([
      { key: "x", n: 13, words: "people on" },
      { key: "outlets", n: 6, words: "outlets" },
      { key: "hn", n: 40, words: "HN points" },
    ]);
    expect(countParts({ people: 1, outlets: 1, hn_points: 1 }).map((p) => p.words)).toEqual(["person on", "outlet", "HN point"]);
    expect(countParts({ people: 0, outlets: 2, hn_points: 0 }).map((p) => p.key)).toEqual(["outlets"]);
    expect(countParts(null)).toEqual([]);
  });
});

describe("mergeFounders", () => {
  test("the dossier's founders keep their order and background and take YC's LinkedIn by name; YC-only founders follow", () => {
    const merged = mergeFounders(
      [
        { name: "Andy Lapsa", role: "CEO & Co-founder", background: "Blue Origin propulsion." },
        { name: "Tom Feldman", role: null, background: null },
      ],
      [
        { name: "tom  feldman", title: "Founder", linkedin_url: "https://linkedin.com/in/tom" },
        { name: "José Ruiz", title: "Founder", linkedin_url: null },
        { name: "Andy Lapsa", title: "Founder", linkedin_url: "https://linkedin.com/in/andy" },
      ],
    );
    expect(merged).toEqual([
      { name: "Andy Lapsa", role: "CEO & Co-founder", background: "Blue Origin propulsion.", linkedin_url: "https://linkedin.com/in/andy" },
      { name: "Tom Feldman", role: "Founder", background: null, linkedin_url: "https://linkedin.com/in/tom" },
      { name: "José Ruiz", role: "Founder", background: null, linkedin_url: null },
    ]);
  });

  test("with no dossier founders it is YC's list", () => {
    expect(mergeFounders([], [{ name: "Ada", title: null, linkedin_url: "https://linkedin.com/in/ada" }])).toEqual([
      { name: "Ada", role: null, background: null, linkedin_url: "https://linkedin.com/in/ada" },
    ]);
  });
});

describe("unlistedBackers", () => {
  test("a backer an investor already names, however suffixed, is left out", () => {
    expect(
      unlistedBackers(
        ["Glade Brook Capital Partners", "Point72 Ventures", "National Science Foundation", "University of Michigan", "NFX"],
        ["Glade Brook", "Point72", "NFX"],
      ),
    ).toEqual(["National Science Foundation", "University of Michigan"]);
  });

  test("the dossier's own repeats fold to one", () => {
    expect(unlistedBackers(["Washington Harbour Partners LP", "Washington Harbour Partners"], [])).toEqual([
      "Washington Harbour Partners LP",
    ]);
  });
});

describe("priorsOffRecord", () => {
  const round = (stage_as_written: string, value: number | null, announced_on: string | null) => ({
    stage_as_written,
    amount: { value, currency: value === null ? null : "USD", as_written: value === null ? null : `$${value}`, usd_millions: value },
    announced_on,
    lead_investors: [],
    other_investors: [],
    disposition: "publish",
    history: false,
    first_seen_at: "2026-09-01T00:00:00Z",
  });
  const prior = (stage_as_written: string, amount_as_written: string | null, announced_date: string | null) => ({
    stage_as_written,
    amount_as_written,
    announced_date,
    lead_investors: [],
  });

  test("a prior round the page already lists is dropped; one it does not is kept", () => {
    const rounds = [round("Series D", 510, "2025-10-08"), round("Series A", 65, "2021-12-15")];
    const kept = priorsOffRecord(
      [prior("Seed", "$9.1 million", null), prior("Series A", "$65 million", "2021-12-15"), prior("Series D", null, null)],
      rounds,
    );
    expect(kept.map((p) => p.stage_as_written)).toEqual(["Seed"]);
  });

  test("a prior round the history lane searched without finding a page, or found too vague, is left out", () => {
    const seriesC = prior("Series C", null, "2023-01-23");
    const vague = prior("Investment", null, "2021");
    const kept = priorsOffRecord(
      [vague, seriesC, prior("Seed", "$2 million", "2020-03-01")],
      [],
      new Set([priorKey(seriesC), priorKey(vague)]),
    );
    expect(kept.map((p) => p.stage_as_written)).toEqual(["Seed"]);
  });

  test("a dossier's Series E is not the record's Series D, and a letter the record already carries reads as a plain round", () => {
    // Anthropic (P1-14): the dossier called Amazon's $2.75B tranche of March 2024 a "Series E"; the
    // record's Series D is two months earlier and its sourced Series E is the $3.5B round of 2025.
    const rounds = [round("Series E", 3500, "2025-03-03"), round("Series D", null, "2024-01-21")];
    const kept = priorsOffRecord([prior("Series D", "$1.25B", null), prior("Series E", "$2.75B", "2024-03-27")], rounds);
    expect(kept).toEqual([
      { stage_as_written: "Funding round", amount_as_written: "$2.75B", announced_date: "2024-03-27", lead_investors: [] },
    ]);
  });

  test("kept rounds read newest first, like the rounds above them", () => {
    const kept = priorsOffRecord([prior("Pre-seed", null, "2019"), prior("Seed", "$2 million", "2020-03-01")], []);
    expect(kept.map((p) => p.stage_as_written)).toEqual(["Seed", "Pre-seed"]);
  });
});

describe("totalToDate", () => {
  test("the funding to date a round's page stated, in dollars, only when it is more than the round", () => {
    const series = (total: string | null, usd: number | null = 75) => ({
      financing_total_as_written: total,
      amount: { usd_millions: usd },
    });
    expect(totalToDate(series("$117 million"))).toBe(117);
    expect(totalToDate(series("$117 million", null))).toBe(117);
    expect(totalToDate(series("$76 million"))).toBeNull();
    expect(totalToDate(series("€117 million"))).toBeNull();
    expect(totalToDate(series(null))).toBeNull();
    expect(totalToDate({ amount: { usd_millions: 75 } })).toBeNull();
  });
});

describe("dossierTotal", () => {
  const round = (stage_as_written: string, value: number, announced_on: string, history = false) => ({
    stage_as_written,
    amount: { value, currency: "USD", as_written: `$${value} million`, usd_millions: value },
    announced_on,
    lead_investors: [],
    other_investors: [],
    disposition: "publish",
    history,
    // Recorded the day after it was announced.
    first_seen_at: `${announced_on.slice(0, 8)}${String(Number(announced_on.slice(8)) + 1).padStart(2, "0")}T09:00:00Z`,
  });
  const seriesB = round("Series B", 75, "2026-09-22");

  test("a total below one of our rounds alone is stale: Firecrawl's $16.2M against its $75M Series B", () => {
    expect(dossierTotal("$16.2M", [seriesB], 75, "2026-09-24T00:00:00Z")).toBeNull();
  });

  test("a total written before a round was recorded leaves that round out", () => {
    expect(dossierTotal("$120 million", [seriesB], 75, "2026-08-01T00:00:00Z")).toBeNull();
    expect(roundAfter([seriesB], "2026-08-01T00:00:00Z")?.stage_as_written).toBe("Series B");
    expect(roundAfter([seriesB], "2026-09-24T00:00:00Z")).toBeNull();
    // A history round comes out of the dossier itself: it never outdates it.
    expect(roundAfter([round("Seed", 8, "2026-09-22", true)], "2026-08-01T00:00:00Z")).toBeNull();
  });

  test("a total no more than the rounds here add up to says nothing the Total raised card does not", () => {
    expect(dossierTotal("$75 million", [seriesB], 75, "2026-09-24")).toBeNull();
  });

  test("a total above ours stays: the rounds the record has not caught yet", () => {
    expect(dossierTotal("$91.2 million", [seriesB], 75, "2026-09-24")).toBe("$91.2 million");
  });

  test("with no rounds to weigh it against, the total stands", () => {
    expect(dossierTotal("€40 million", [], null, "2026-09-23")).toBe("€40 million");
    expect(dossierTotal(null, [seriesB], 75, "2026-09-24")).toBeNull();
  });
});
