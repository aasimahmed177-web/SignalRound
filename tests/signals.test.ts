import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { ingestSignal, listSignalInbox, parseSignalInput, setSignalStatus } from "../lib/signals";
import { testDb } from "./helpers";

const INPUT = {
  channel: "X",
  url: "https://x.com/example/status/42",
  title: "Example may be raising a Series A",
  summary: "A founder thanked a new investor.",
  company: "Example",
  confidence: 0.63,
  tags: ["series-a", "series-a"],
  metadata: { post_id: "42" },
};

describe("signal inbox", () => {
  test("normalizes a worker payload and rejects unusable observations", () => {
    expect(parseSignalInput(INPUT)).toMatchObject({ channel: "x", confidence: 0.63 });
    expect(() => parseSignalInput({ channel: "X spaces", url: "not a url", title: "Maybe" })).toThrow();
    expect(() => parseSignalInput({ channel: "web", url: "https://example.com" })).toThrow(/title or summary/i);
  });

  test("deduplicates repeat sightings without changing the analyst decision", async () => {
    const handle = await testDb();
    const first = await ingestSignal(handle, parseSignalInput(INPUT));
    await setSignalStatus(handle, first.id, "researching");
    const second = await ingestSignal(handle, parseSignalInput({ ...INPUT, summary: "The post now names Sample Ventures." }));

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: "researching", seenCount: 2, summary: "The post now names Sample Ventures." });
    expect(second.tags).toEqual(["series-a"]);
    expect(await handle.select().from(schema.signalObservations)).toHaveLength(1);
    expect((await listSignalInbox(handle)).counts).toMatchObject({ all: 1, researching: 1 });
  });
});
