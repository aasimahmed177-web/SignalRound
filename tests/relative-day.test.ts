import { describe, expect, test } from "vitest";
import { relativeDay } from "../lib/format";

// 02:08 UTC on Sep 24 is still the evening of Sep 23 in the Americas: the case that read "yesterday".
const now = new Date("2026-09-24T02:08:00Z");

describe("relativeDay", () => {
  test("counts calendar days, not hours: a date is a day as written", () => {
    expect(relativeDay("2026-09-24", { now, utc: true })).toBe("today");
    expect(relativeDay("2026-09-23", { now, utc: true })).toBe("yesterday");
    expect(relativeDay("2026-09-20", { now, utc: true })).toBe("4d ago");
    expect(relativeDay("2026-09-12", { now, utc: true })).toBe("Sep 12");
    expect(relativeDay("2026-09-30", { now, utc: true })).toBe("today");
  });

  test("a timestamp becomes the day it fell on", () => {
    expect(relativeDay("2026-09-23T23:50:00Z", { now, utc: true })).toBe("yesterday");
    expect(relativeDay("2026-09-24T00:10:00Z", { now, utc: true })).toBe("today");
  });

  test("nothing, or nothing readable, is undated", () => {
    expect(relativeDay(null)).toBe("undated");
    expect(relativeDay("not a date")).toBe("undated");
  });
});
