// The News page's day headers: relative for the last two days, a short weekday date after.

import { describe, expect, test } from "vitest";
import { dayHeading, newsDay } from "../lib/news-format";

const now = new Date("2026-09-22T23:30:00Z");

describe("dayHeading", () => {
  test("the last two UTC days read as words", () => {
    expect(dayHeading("2026-09-22", now)).toBe("Today");
    expect(dayHeading("2026-09-21", now)).toBe("Yesterday");
  });

  test("older days read as weekday, day, month", () => {
    expect(dayHeading("2026-09-20", now)).toBe("Sun 20 Sep");
    expect(dayHeading("2026-01-05", now)).toBe("Mon 5 Jan");
  });

  test("another year carries the year", () => {
    expect(dayHeading("2025-12-31", now)).toBe("Wed 31 Dec 2025");
  });

  test("a key that is not a date comes back as written", () => {
    expect(dayHeading("undated", now)).toBe("undated");
  });
});

describe("on the reader's calendar", () => {
  test("a timestamp counts under the day it fell on in the given calendar; a date stays as written", () => {
    expect(newsDay("2026-09-24T00:30:00Z")).toBe("2026-09-24");
    expect(newsDay("2026-09-24")).toBe("2026-09-24");
    expect(newsDay("2026-09-24", { utc: false })).toBe("2026-09-24");
  });
  test("dayHeading's today follows the calendar it is asked for", () => {
    // 23:30 UTC on the 22nd is the 22nd in UTC; the local calendar is whatever the runner's zone says, so compare to it.
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(dayHeading(localToday, now, { utc: false })).toBe("Today");
    expect(dayHeading("2026-09-22", now, { utc: true })).toBe("Today");
  });
});
