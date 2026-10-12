import { describe, expect, test } from "vitest";
import { type Answer, type Fact, judge, readAnswer, score } from "../scripts/agent-eval/judge";
import { days, questions } from "../scripts/agent-eval/questions";

const answer = (a: Partial<Answer>): Answer => ({ status: 200, keys: [], hasMore: false, suggestions: [], ...a });

describe("agent eval judge", () => {
  test("rows: the whole set is correct, a share is partial, none of it is wrong, nothing is empty", () => {
    const want = { kind: "rows" as const, keys: ["a", "b", "c"] };
    expect(judge(want, answer({ keys: ["c", "a", "b"] })).verdict).toBe("correct");
    expect(judge(want, answer({ keys: ["a", "b"] })).verdict).toBe("partial");
    expect(judge(want, answer({ keys: ["a", "b", "c", "x"] })).verdict).toBe("partial");
    expect(judge(want, answer({ keys: ["x"] })).verdict).toBe("wrong");
    expect(judge(want, answer({})).verdict).toBe("empty");
    expect(judge({ kind: "rows", keys: [] }, answer({ keys: ["x"] })).verdict).toBe("wrong");
    expect(judge({ kind: "rows", keys: [] }, answer({})).verdict).toBe("correct");
  });

  test("rows: a first page with more after it is judged on its own length", () => {
    const want = { kind: "rows" as const, keys: ["a", "b", "c", "d"] };
    expect(judge(want, answer({ keys: ["a", "b"], hasMore: true })).verdict).toBe("correct");
    expect(judge(want, answer({ keys: ["a", "x"], hasMore: true })).verdict).toBe("partial");
  });

  test("rows: a misspelling earns partial credit for suggesting the right name", () => {
    const want = { kind: "rows" as const, keys: ["acme:seed:2026-01-01"], suggest: "acme" };
    expect(judge(want, answer({ suggestions: ["acme"] })).verdict).toBe("partial");
    expect(judge(want, answer({ suggestions: ["other"] })).verdict).toBe("empty");
  });

  test("top: a tie at the cut lets any tied row in, but every row above it must be there", () => {
    const want = {
      kind: "top" as const,
      n: 2,
      ranked: [
        { key: "a", score: 3 },
        { key: "b", score: 2 },
        { key: "c", score: 2 },
        { key: "d", score: 1 },
      ],
    };
    expect(judge(want, answer({ keys: ["a", "c"] })).verdict).toBe("correct");
    expect(judge(want, answer({ keys: ["a", "b", "d"] })).verdict).toBe("correct");
    expect(judge(want, answer({ keys: ["b", "c"] })).verdict).toBe("partial");
    expect(judge(want, answer({ keys: ["d"] })).verdict).toBe("wrong");
  });

  test("match: first is correct, listed lower or suggested is partial", () => {
    const want = { kind: "match" as const, key: "sequoia" };
    expect(judge(want, answer({ keys: ["sequoia", "sequoia-india"] })).verdict).toBe("correct");
    expect(judge(want, answer({ keys: ["sequoia-india", "sequoia"] })).verdict).toBe("partial");
    expect(judge(want, answer({ suggestions: ["sequoia"] })).verdict).toBe("partial");
    expect(judge(want, answer({ keys: ["sequel"] })).verdict).toBe("wrong");
  });

  test("entity: every fact must match; a 404 that suggests it is partial", () => {
    const want = { kind: "entity" as const, key: "ramp", facts: { total_raised_usd_millions: 3100, investors: ["a", "b"] } };
    const found = (facts: Record<string, Fact>) => answer({ entity: { key: "ramp", facts } });
    expect(judge(want, found({ total_raised_usd_millions: 3100, investors: ["b", "a"] })).verdict).toBe("correct");
    expect(judge(want, found({ total_raised_usd_millions: 3000, investors: ["a", "b"] })).verdict).toBe("partial");
    expect(judge(want, answer({ entity: { key: "ramp-2", facts: {} } })).verdict).toBe("wrong");
    expect(judge(want, answer({ status: 404, error: "not found", suggestions: ["ramp"] })).verdict).toBe("partial");
    expect(judge(want, answer({ status: 404, error: "not found" })).verdict).toBe("empty");
  });

  test("an error other than a 404 is wrong; none is correct only when nothing comes back", () => {
    expect(judge({ kind: "rows", keys: ["a"] }, answer({ status: 400, error: "since must be a real date" })).verdict).toBe("wrong");
    expect(judge({ kind: "none" }, answer({ status: 404, error: "not found" })).verdict).toBe("correct");
    expect(judge({ kind: "none" }, answer({ keys: ["a"] })).verdict).toBe("wrong");
  });

  test("score counts correct as one and partial as a half", () => {
    expect(score(["correct", "partial", "wrong", "empty"])).toBe(37.5);
  });
});

describe("agent eval answers", () => {
  test("a page of rounds reads its ids and whether more follow", () => {
    const a = readAnswer("rounds/search", 200, { data: [{ id: "a:seed:2026-01-01" }], next_cursor: "x" });
    expect(a).toMatchObject({ keys: ["a:seed:2026-01-01"], hasMore: true });
  });

  test("news is keyed by article URL", () => {
    expect(readAnswer("news/latest", 200, { data: [{ url: "https://x.test/a" }], next_cursor: null }).keys).toEqual(["https://x.test/a"]);
  });

  test("a 404 reads its suggestions from did_you_mean and from the message", () => {
    const api = readAnswer("companies/profile", 404, {
      error: "No company. Did you mean Supabase (id supabase)?",
      did_you_mean: [{ id: "supabase" }],
    });
    expect(api.suggestions).toContain("supabase");
    const viaAlexandria = readAnswer("investors/profile", 404, {
      error: "fireround: No investor. Did you mean Sequoia Capital (id sequoia)?",
    });
    expect(viaAlexandria.suggestions).toEqual(["sequoia"]);
  });

  test("a company profile reads its total, rounds, latest day and investors", () => {
    const a = readAnswer("companies/profile", 200, {
      id: "ramp",
      total_raised_usd_millions: 3100,
      rounds: [{ announced_on: "2026-10-01" }, { announced_on: "2025-01-01" }],
      investors: [{ id: "founders" }],
    });
    expect(a.entity).toEqual({
      key: "ramp",
      facts: { total_raised_usd_millions: 3100, rounds: 2, latest_announced_on: "2026-10-01", investors: ["founders"] },
    });
  });
});

describe("agent eval questions", () => {
  test("ids are unique and every capability is asked", () => {
    const qs = questions(days(new Date("2026-10-11T12:00:00Z")));
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    expect(new Set(qs.map((q) => q.capability)).size).toBe(9);
  });

  test("date phrases resolve in UTC", () => {
    const d = days(new Date("2026-10-11T23:30:00Z"));
    expect(d).toMatchObject({ today: "2026-10-11", monthStart: "2026-10-01", quarterStart: "2026-10-01" });
    expect(d.ago(7)).toBe("2026-10-04");
    expect(days(new Date("2026-08-15T00:00:00Z")).quarterStart).toBe("2026-07-01");
  });
});
