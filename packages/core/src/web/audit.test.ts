import { expect, test, vi } from "vitest";
import { auditFunnel, inspectFunnelHtml } from "./audit.ts";
import { readDiscussion } from "./discussion.ts";

test("resolves questionnaire labels from label-for and ARIA references", () => {
  const page = inspectFunnelHtml(
    '<form><label for="age">How old are you?</label><input id="age"><span id="question">Budget?</span><input aria-labelledby="question"></form>',
    "https://example.org/",
  );
  expect(page.forms[0]?.fields.map((f) => f.label)).toEqual(["How old are you?", "Budget?"]);
});

const html =
  '<html><h1>Offer</h1><a href="/next">Continue</a><form action="/submit" method="post"><input name="email" value="private@example.com" required><select name="budget"><option>Large</option></select></form><iframe src="https://tally.so/r/demo"></iframe><video><track src="/captions.vtt" srclang="en"></video><script>fbq("track", "Lead");localStorage.setItem("score", "1")</script><script src="/app.js"></script><script src="https://third.example/pixel.js"></script></html>';
test("captures funnel evidence without prefilled values or claiming event execution", () => {
  const result = inspectFunnelHtml(html, "https://site.example/lp");
  expect(result.forms[0]?.fields[0]).toMatchObject({ name: "email", required: true });
  expect(JSON.stringify(result)).not.toContain("private@example.com");
  expect(result.declaredEvents).toEqual(["Lead"]);
  expect(result.inlineScripts[0]?.clues[0]?.certainty).toBe("source-reference-only");
  expect(result.embeds).toContainEqual(expect.objectContaining({ kind: "track", url: "https://site.example/captions.vtt" }));
});
test("audit only fetches supplied pages and same-origin script files; never forms or linked pages", async () => {
  const read = vi.fn(async (url: string) => ({
    url,
    text: url.endsWith(".js") ? 'location.replace("/thanks")' : html,
    status: 200,
    contentType: "text/html",
  }));
  const result = await auditFunnel(["https://site.example/lp"], 5, read);
  expect(read.mock.calls.map(([url]) => url)).toEqual(["https://site.example/lp", "https://site.example/app.js"]);
  expect(result.assets[0]?.clues[0]?.kind).toBe("routing");
  expect(result.journey[0]?.certainty).toBe("link-observed-not-followed");
});
test("audit validates inputs before fetching and reports failures/omissions", async () => {
  const read = vi.fn(async () => {
    throw new Error("HTTP 403");
  });
  await expect(auditFunnel(["https://site.example?email=private"], 5, read)).rejects.toThrow("query strings");
  expect(read).not.toHaveBeenCalled();
  const result = await auditFunnel(["https://site.example", "https://second.example"], 1, read);
  expect(result.status).toBe("failed");
  expect(result.omittedUrls).toHaveLength(1);
  expect(result.errors[0]?.error).toBe("HTTP 403");
});
test("discussion sample preserves parent links, caps calls and marks partial", async () => {
  const read = vi.fn(async (url: string) => ({
    url,
    text: JSON.stringify(url.includes("/1.json") ? { id: 1, title: "Story", kids: [2, 3] } : { id: 2, parent: 1, text: "<p>Opinion</p>" }),
    status: 200,
    contentType: "application/json",
  }));
  const result = await readDiscussion("https://news.ycombinator.com/item?id=1", 1, read);
  expect(result.status).toBe("partial");
  expect(result.items[1]).toMatchObject({ parent: 1, text: "Opinion" });
  expect(read).toHaveBeenCalledTimes(2);
  await expect(readDiscussion("https://news.ycombinator.com.evil.example/item?id=1", 1, read)).rejects.toThrow("currently support");
});
