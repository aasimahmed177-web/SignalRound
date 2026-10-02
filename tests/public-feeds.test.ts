import { describe, expect, test } from "vitest";
import { ALL_ROUNDS, publicFeeds } from "../lib/public-feeds";

describe("public feeds", () => {
  test("All rounds leads, each preset follows, and every command subscribes the preset's RSS on this origin", () => {
    const feeds = publicFeeds("https://fireround.dev", [
      { slug: "series-a-b", name: "Series A and B" },
      { slug: "seed", name: "Seed and pre-seed" },
    ]);
    expect(feeds.map((f) => f.name)).toEqual([ALL_ROUNDS.name, "Series A and B", "Seed and pre-seed"]);
    expect(feeds[0]).toEqual({
      slug: "all",
      name: "All rounds",
      rss: "https://fireround.dev/feeds/public/all.rss",
      atom: "https://fireround.dev/feeds/public/all.atom",
      json: "https://fireround.dev/feeds/public/all.json",
      slack: "/feed subscribe https://fireround.dev/feeds/public/all.rss",
    });
    expect(feeds[2].slack).toBe("/feed subscribe https://fireround.dev/feeds/public/seed.rss");
  });

  test("a preset that claims the 'all' slug does not appear twice", () => {
    expect(publicFeeds("http://x.test", [{ slug: "all", name: "Everything" }]).map((f) => f.slug)).toEqual(["all"]);
  });
});
