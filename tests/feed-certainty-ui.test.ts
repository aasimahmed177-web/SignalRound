import type { FeedRecord } from "@fireround/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { certaintyLabel, RoundCertainty, RoundCertaintyDetail } from "../components/feed/round-certainty";
import { feedCertainty } from "../lib/feed-certainty";
import { defaultFeedView } from "../lib/round-sort";

const round = (certainty?: FeedRecord["certainty"]) => ({
  certainty,
  sources: [{ host: "www.example.com", url: "https://www.example.com/story" }],
});

describe("feed certainty filter", () => {
  test("defaults to early reports while unconfirmed requires an explicit opt-in", () => {
    for (const raw of [undefined, null, "", "reported", "expected", "unconfirmed", "ALL"]) {
      expect(feedCertainty(raw)).toBe("current");
    }
    expect(feedCertainty("announced")).toBe("announced");
    expect(feedCertainty("all")).toBe("all");
    expect(defaultFeedView(true, { certainty: "all" })).toBe("latest");
  });
});

describe("round certainty copy", () => {
  test("does not decorate announced or legacy rounds", () => {
    for (const certainty of [undefined, "announced"] as const) {
      expect(certaintyLabel(round(certainty))).toBeNull();
      expect(renderToStaticMarkup(createElement(RoundCertainty, { r: round(certainty) }))).toBe("");
      expect(renderToStaticMarkup(createElement(RoundCertaintyDetail, { r: round(certainty) }))).toBe("");
    }
  });

  test.each([
    ["reported", "Reported", "Reported by"],
    ["expected", "Expected", "Expected according to"],
    ["unconfirmed", "Unconfirmed", "Unconfirmed according to"],
  ] as const)("shows quiet %s text and a linked source, not an announcement", (certainty, label, detail) => {
    expect(certaintyLabel(round(certainty))).toBe(label);
    const cell = renderToStaticMarkup(createElement(RoundCertainty, { r: round(certainty) }));
    expect(cell).toContain(label);
    expect(cell).not.toContain("badge");
    const expanded = renderToStaticMarkup(createElement(RoundCertaintyDetail, { r: round(certainty) }));
    expect(expanded).toContain(detail);
    expect(expanded).toContain('href="https://www.example.com/story"');
    expect(expanded).toContain("example.com");
    expect(expanded).toContain("not announced.");
  });

  test("does not invent a source when none is stored", () => {
    expect(renderToStaticMarkup(createElement(RoundCertaintyDetail, { r: { certainty: "expected", sources: [] } }))).toContain(
      "Expected; not announced.",
    );
  });

  test("links the source whose title supports the expected state, not an earlier conflicting report", () => {
    const html = renderToStaticMarkup(
      createElement(RoundCertaintyDetail, {
        r: {
          certainty: "expected",
          sources: [
            { host: "finance.example", url: "https://finance.example/raises", title: "Acme raises $10 billion" },
            { host: "journal.example", url: "https://journal.example/seeks", title: "Acme seeks $10 billion" },
          ],
        },
      }),
    );
    expect(html).toContain('href="https://journal.example/seeks"');
    expect(html).not.toContain('href="https://finance.example/raises"');
  });
});
