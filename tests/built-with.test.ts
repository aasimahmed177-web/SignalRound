// The Built with strip reads a row into the native web tools primitives it passed through.

import { describe, expect, test } from "vitest";
import { type BuiltWithInput, builtWithSteps } from "../lib/built-with";

function row(partial: Partial<BuiltWithInput> = {}): BuiltWithInput {
  return {
    sources: [{ host: "news.example", query: "series a funding rounds" }],
    evidence_quotes: ["Acme raised $20M."],
    verification: { status: "confirmed", verifier: "gateway:openai/gpt-5.6-luna", sources_seen: 4 },
    enrichment: { verified: true },
    alexandria: null,
    ...partial,
  };
}

const fact = (steps: ReturnType<typeof builtWithSteps>, key: string) => steps.find((s) => s.key === key)?.fact;

describe("builtWithSteps", () => {
  test("search: the query's text stays out (it is the instance's own tuning); a lane marker reads as its lane", () => {
    expect(fact(builtWithSteps(row()), "search")).toBe("found by native web tools search");
    const long = row({ sources: [{ host: "news.example", query: "q".repeat(80) }] });
    expect(fact(builtWithSteps(long), "search")).toBe("found by native web tools search");
    expect(fact(builtWithSteps(row({ sources: [{ host: "news.example", query: "search" }] })), "search")).toBe(
      "found by native web tools search",
    );
    for (const [query, expected] of [
      ["monitor:mon-1", "found by a monitor"],
      ["check:chk-1", "found by a monitor"],
      ["watch:techcrunch.com", "found on a watched publisher"],
      ["corroborate", "found while cross-checking another source"],
      ["formd", "from a Form D filing"],
      ["manual", "added by hand from its URL"],
      ["x:@acme", "found on X: @acme"],
      ["agent:gap-fill", "found by the research agent"],
      [null, "found by native web tools search"],
    ] as const) {
      expect(fact(builtWithSteps(row({ sources: [{ host: "news.example", query }] })), "search")).toBe(expected);
    }
  });

  test("scrape: the source count with up to three deduped hosts", () => {
    const steps = builtWithSteps(
      row({
        sources: [
          { host: "a.example", query: null },
          { host: "www.b.example", query: null },
          { host: "www.b.example", query: null },
          { host: "c.example", query: null },
          { host: "d.example", query: null },
        ],
      }),
    );
    expect(fact(steps, "scrape")).toBe("5 pages read: a.example, b.example, c.example");
    expect(fact(builtWithSteps(row({ sources: [{ host: "a.example", query: null }] })), "scrape")).toBe("1 page read: a.example");
  });

  test("json: names the sentence when the row carries one", () => {
    expect(fact(builtWithSteps(row()), "json")).toBe("round read into a schema, with the sentence that states it");
    expect(fact(builtWithSteps(row({ evidence_quotes: [] })), "json")).toBe("round extracted with a schema");
  });

  test("verify: model read-back, judge read-back, and unread", () => {
    // The fixture lists one source and its verdict read four: the list is the count (lib/source-count.ts).
    expect(fact(builtWithSteps(row()), "verify")).toBe("checked against 1 source");
    const grown = row({
      sources: [
        { host: "a.example", query: null },
        { host: "b.example", query: null },
      ],
      verification: { status: "confirmed", verifier: "model", sources_seen: 1 },
    });
    expect(fact(builtWithSteps(grown), "verify")).toBe("checked against 1 of 2 sources");
    expect(fact(builtWithSteps(row({ verification: { status: "confirmed", verifier: "judge" } })), "verify")).toBe(
      "checked against its page with native web tools",
    );
    expect(fact(builtWithSteps(row({ verification: null })), "verify")).toBe("not yet checked against its sources");
    // No sources_seen falls back to the row's own source count.
    const noSeen = row({
      sources: [
        { host: "a.example", query: null },
        { host: "b.example", query: null },
      ],
      verification: { status: "corrected", verifier: "openai/gpt-5.6" },
    });
    expect(fact(builtWithSteps(noSeen), "verify")).toBe("checked against 2 sources");
  });

  test("branding: verified homepage, unmatched homepage, no enrichment omits the step", () => {
    expect(fact(builtWithSteps(row()), "branding")).toBe("logo and colour from the homepage");
    expect(fact(builtWithSteps(row({ enrichment: { verified: false } })), "branding")).toBeUndefined();
    expect(builtWithSteps(row({ enrichment: null })).map((s) => s.key)).not.toContain("branding");
  });

  test("alexandria: a step when YC matched, none when it did not", () => {
    expect(builtWithSteps(row()).map((s) => s.key)).not.toContain("alexandria");
    expect(fact(builtWithSteps(row({ alexandria: { yc: { batch: "Summer 2022" } } })), "alexandria")).toBe(
      "founders and batch from Y Combinator from its public profile",
    );
    expect(builtWithSteps(row({ alexandria: { yc: null } })).map((s) => s.key)).not.toContain("alexandria");
  });

  test("agent: only when the company has a dossier", () => {
    expect(builtWithSteps(row()).map((s) => s.key)).not.toContain("agent");
    expect(fact(builtWithSteps(row(), { dossier: true }), "agent")).toBe("company research by the native web tools agent");
  });

  test("x: only when the Trending lane found people posting about the round, before the agent step", () => {
    expect(builtWithSteps(row()).map((s) => s.key)).not.toContain("x");
    expect(builtWithSteps(row(), { xPeople: 0 }).map((s) => s.key)).not.toContain("x");
    expect(fact(builtWithSteps(row(), { xPeople: 14 }), "x")).toBe("posts from 14 people, found with native web tools search");
    expect(fact(builtWithSteps(row(), { xPeople: 1 }), "x")).toBe("posts from 1 person, found with native web tools search");
    expect(
      builtWithSteps(row(), { xPeople: 3, dossier: true })
        .map((s) => s.key)
        .slice(-2),
    ).toEqual(["x", "agent"]);
  });
});
