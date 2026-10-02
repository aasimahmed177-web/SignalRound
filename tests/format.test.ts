// Lane labels as the Runs table reads them.

import { describe, expect, test } from "vitest";
import { approxDate, feedTitle, laneLabel, precisionNote, roundStageLabel, stageAsWrittenNote, stageLabel, stageOf } from "../lib/format";

describe("laneLabel", () => {
  test("lane markers read as their lane; a pasted URL is Manual; a query is Search with the text as detail", () => {
    expect(laneLabel("manual")).toEqual({ label: "Manual" });
    expect(laneLabel("formd")).toEqual({ label: "Form D" });
    expect(laneLabel("corroborate")).toEqual({ label: "Corroboration" });
    expect(laneLabel("monitor:mon-1")).toEqual({ label: "Monitor" });
    expect(laneLabel("watch:techcrunch.com")).toEqual({ label: "Watch: techcrunch.com" });
    expect(laneLabel("series a funding rounds")).toEqual({ label: "Search", detail: "series a funding rounds" });
    expect(laneLabel(null)).toBeNull();
  });
});
describe("roundStageLabel", () => {
  test("a round the record could not name reads as what the page called it, or Funding round", () => {
    expect(roundStageLabel({ stage: "other", stage_as_written: "funding round" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "new financing" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "undisclosed", stage_as_written: "undisclosed" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "Form D (equity)" })).toBe("Form D (equity)");
    expect(roundStageLabel({ stage: "other", stage_as_written: "strategic investment" })).toBe("Strategic investment");
  });

  test("a figure the page wrote into the label is the amount's, never the stage (Brahma AI's 'USD 150 million fu...')", () => {
    expect(roundStageLabel({ stage: "other", stage_as_written: "USD 150 Million funding round" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "$50 million" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "$106M" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "€100 million round" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "$103M round of financing" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "$56 million financing" })).toBe("Funding round");
    expect(roundStageLabel({ stage: "other", stage_as_written: "Rs 10 crore ($1.2 million) strategic round" })).toBe("Strategic round");
    expect(roundStageLabel({ stage: "series_d_plus", stage_as_written: "$300M Series E" })).toBe("Series E");
    // A digit that is not a figure stays.
    expect(roundStageLabel({ stage: "other", stage_as_written: "Form D (equity)" })).toBe("Form D (equity)");
  });

  test("a named stage is its label whatever the page wrote", () => {
    expect(roundStageLabel({ stage: "growth", stage_as_written: "funding round" })).toBe("Growth");
    expect(roundStageLabel({ stage: "series_a", stage_as_written: "Series A extension" })).toBe("Series A");
  });

  test("a round in the D+ bucket shows its own letter when the page wrote a clean one (P1-15)", () => {
    expect(roundStageLabel({ stage: "series_d_plus", stage_as_written: "Series H" })).toBe("Series H");
    expect(roundStageLabel({ stage: "series_d_plus", stage_as_written: "series f2" })).toBe("Series F2");
    expect(stageOf({ stage: "series_d_plus", stage_as_written: "Series E" })).toBe("Series E");
    // Nothing clean to show: the bucket stays.
    expect(roundStageLabel({ stage: "series_d_plus", stage_as_written: "late-stage round" })).toBe("Series D+");
    expect(roundStageLabel({ stage: "series_d_plus", stage_as_written: "Series D+" })).toBe("Series D+");
    // The filter's own label never changes.
    expect(stageLabel("series_d_plus")).toBe("Series D+");
  });
});

describe("approxDate", () => {
  test("a month-precision day is the month it names, not the month before (Synapse Analytics's September round)", () => {
    expect(approxDate("2026-09-01", "month")).toBe("~ 2026-09");
    expect(precisionNote("month")).toContain("in this month");
    expect(approxDate("2026-09-21", "week")).toBe("~ 2026-09-21");
    expect(approxDate("2026-09-21", "day")).toBe("2026-09-21");
    expect(approxDate(null, "day")).toBe("undated");
  });
});

describe("stageAsWrittenNote", () => {
  test("the page's words only when they say more than the label", () => {
    expect(stageAsWrittenNote({ stage: "growth", stage_as_written: "latest funding round" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "other", stage_as_written: "Strategic investment" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_a", stage_as_written: "series a" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_d_plus", stage_as_written: "Series F" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_d_plus", stage_as_written: "late-stage round" })).toBe("late-stage round");
    expect(stageAsWrittenNote({ stage: "seed", stage_as_written: "seed extension" })).toBe("seed extension");
    expect(stageAsWrittenNote({ stage: "seed", stage_as_written: "$20 million seed" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_a", stage_as_written: "$120m Series A" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "seed", stage_as_written: "seed round" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_a", stage_as_written: "Series A round" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_b", stage_as_written: "Series B funding" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "series_b", stage_as_written: "Series B financing" })).toBeNull();
    expect(stageAsWrittenNote({ stage: "seed", stage_as_written: "seed extension round" })).toBe("seed extension round");
    expect(stageAsWrittenNote({ stage: "seed", stage_as_written: "pre-seed round" })).toBe("pre-seed round");
    expect(stageAsWrittenNote({ stage: "series_a", stage_as_written: "Series A2" })).toBe("Series A2");
  });
});

describe("feedTitle", () => {
  test("says what is in view instead of promising this week, verified", () => {
    expect(feedTitle({ view: "latest", stages: [], filtered: false })).toBe("The latest funding rounds");
    expect(feedTitle({ view: "trending", stages: [], filtered: false })).toBe("The rounds people are discussing now");
    expect(feedTitle({ view: "latest", q: "groq", stages: [], filtered: false })).toBe('Funding rounds matching "groq"');
    expect(feedTitle({ view: "latest", stages: ["seed"], filtered: false })).toBe("Seed rounds");
    expect(feedTitle({ view: "latest", stages: ["seed", "series_a"], filtered: true })).toBe(
      "Seed and Series A rounds matching your filters",
    );
    expect(feedTitle({ view: "latest", stages: ["seed", "series_a", "series_b"], filtered: false })).toBe("Funding rounds");
    expect(feedTitle({ view: "latest", stages: [], filtered: true })).toBe("Funding rounds matching your filters");
    expect(feedTitle({ view: "trending", stages: ["seed"], filtered: false })).toBe("Seed rounds people are discussing");
  });
  test("a long search term is cut on a word", () => {
    expect(feedTitle({ view: "latest", q: "a very long search term that keeps going and going", stages: [], filtered: false })).toBe(
      'Funding rounds matching "a very long search term that keeps..."',
    );
  });
});
