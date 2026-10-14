import { expect, test } from "vitest";
import { articleKey, samePageKey } from "./normalize.ts";

test("an article's AMP copies and tracked addresses share its key", () => {
  const page = articleKey("https://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection/");
  for (const copy of [
    "https://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection/amp/",
    "https://securityweek.com/harmonic-raises-50m-for-ai-data-protection/amp",
    "https://amp.securityweek.com/harmonic-raises-50m-for-ai-data-protection",
    "https://www.securityweek.com/amp/harmonic-raises-50m-for-ai-data-protection",
    "https://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection?amp",
    "https://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection?amp=1&utm_source=x",
    "https://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection?outputType=amp",
    "http://www.securityweek.com/harmonic-raises-50m-for-ai-data-protection#top",
  ])
    expect(articleKey(copy), copy).toBe(page);
  expect(articleKey("https://www.techinasia.com/news/acme-raises.amp.html")).toBe(
    articleKey("https://www.techinasia.com/news/acme-raises.html"),
  );
});

test("a page that only mentions amp keeps its own key, and a page without AMP keys as samePageKey", () => {
  for (const url of [
    "https://news.example/amplitude-raises",
    "https://news.example/amp-robotics-raises",
    "https://ampere.example/blog/series-b",
  ])
    expect(articleKey(url), url).toBe(samePageKey(url));
  expect(articleKey("https://news.example/a?id=amp")).not.toBe(articleKey("https://news.example/a"));
  expect(articleKey("https://news.example/a?outputType=print")).not.toBe(articleKey("https://news.example/a"));
});
