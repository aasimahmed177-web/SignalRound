// One source count per round on every surface (P1-3): the badge, the open row, the RSS item, the
// share card, and Slack all read lib/source-count.ts.
import { describe, expect, test } from "vitest";
import { readAgainst, sourceCount, sourcesRead } from "../lib/source-count";

const row = (listed: number, status: string | null, seen?: number) => ({
  sources: Array.from({ length: listed }, (_, i) => i),
  verification: status ? { status, sources_seen: seen } : null,
});

describe("source counts", () => {
  test("the count is the list; the verdict's reach is capped at it and said only when fewer", () => {
    // Wealthcome: two sources listed, the verdict read one before corroboration added the second.
    expect(sourceCount(row(2, "confirmed", 1))).toBe(2);
    expect(sourcesRead(row(2, "confirmed", 1))).toBe(1);
    expect(readAgainst(row(2, "confirmed", 1))).toBe("1 of 2 sources");
    expect(readAgainst(row(2, "corrected", 2))).toBe("2 sources");
    expect(readAgainst(row(1, "confirmed"))).toBe("1 source");
    // Pruned since the read: the claim shrinks to what the row still lists.
    expect(readAgainst(row(3, "confirmed", 5))).toBe("3 sources");
    // Never verified: no claim at all.
    expect(readAgainst(row(2, "unverified", 2))).toBeNull();
    expect(readAgainst(row(2, null))).toBeNull();
  });
});
