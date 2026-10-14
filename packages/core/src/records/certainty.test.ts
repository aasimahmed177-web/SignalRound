// What a round's own sentence says about whether it closed, from the launch-day feed audit's rows.

import { describe, expect, test } from "vitest";
import { assertedRoundCertainty, classifyRoundCertainty } from "./certainty.ts";

describe("talks and an opened raise stay expected", () => {
  test.each([
    // DeepSeek, 2026-10-06 to 13: a round being enlarged and still closing, however it is reported.
    "DeepSeek is considering expanding its latest funding round to as much as 100 billion yuan ($14.9 billion), double its earlier target, with state-backed funds and corporate investors jostling for stakes, people familiar with the matter told CNBC.",
    "AI startup DeepSeek is considering doubling the size of its latest funding round to as much as 100 billion yuan ($14.9 billion)...",
    "DeepSeek is close to securing at least 80 billion yuan ($12 billion) in its latest round of funding.",
    "large model company DeepSeek will complete its latest round of financing shortly, with the planned amount increasing from the previously announced 50 billion yuan to approximately 100 billion yuan",
    // Eudaemon, 2026-10-13: the company opened a raise, it did not close one.
    "Eudaemon has now launched a further $10 million funding round to support clinical trials, regulatory clearances, manufacturing scale-up and commercialisation.",
    "Eudaemon has opened a further $10 million funding round to support its commercialisation plans.",
    "Morphotonics announces the launch of its Series B financing round, marking a significant endorsement of its mission to elevate global display technology.",
  ])("%s", (sentence) => {
    expect(assertedRoundCertainty(sentence)).toBe("expected");
    expect(classifyRoundCertainty(sentence, null, "announced", "reported")).toBe("expected");
  });
});

describe("a closed round stays announced", () => {
  test.each([
    // Scanntech's own release, 2026-10-13, and its headline.
    "Scanntech today announced a $180 million Series F investment led by L Catterton.",
    "Scanntech Announces $180 Million Series F Financing",
    // A sentence that closes one round and opens the next is the closed round's.
    "Swish has closed a $3.2 million pre-seed round and is opening its Seed round today, backed by Aristagora VC.",
  ])("%s", (sentence) => {
    expect(assertedRoundCertainty(sentence)).toBe("announced");
  });

  test("a company launching with its money is no opened raise", () => {
    expect(assertedRoundCertainty("Acme has launched with $10 million in seed funding.")).toBeNull();
  });
});
