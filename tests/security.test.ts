// The release-review fixes, each against the route it hardened: fail-closed webhooks, shaped
// payloads, constant-time bearers, escaped feeds, and CSV cells that stay text in a spreadsheet.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import type { Firecrawl } from "firecrawl";
import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "mock" })) }));

import { NextRequest } from "next/server";
import { GET as deliveriesGet } from "../app/api/cron/deliveries/route";
import { GET as roundsGet } from "../app/api/v1/rounds/route";
import { POST as webhookPost } from "../app/api/webhooks/firecrawl/route";
import { GET as feedsGet } from "../app/feeds/[token]/[file]/route";
import { corroborateRecord } from "../lib/corroborate";
import { BASIC_CHALLENGE, basicAuthorized } from "../lib/dashboard-auth";
import { requireDashboardWith } from "../lib/dashboard-auth.server";
import { db } from "../lib/db";
import { signForTests, verifyFirecrawlSignature } from "../lib/firecrawl-webhook";
import { persistRecords } from "../lib/persist";
import { mintFeedToken } from "../lib/settings";
import { tokenEquals } from "../lib/tokens";
import { gate } from "../proxy";
import { record } from "./helpers";

const HOSTILE_NAME = "Evil <script>alert(1)</script> & Co";

beforeAll(async () => {
  const handle = await db();
  await persistRecords(
    handle,
    [
      record({
        company_name: HOSTILE_NAME,
        company_key: "evil",
        company_domain: "evil.example",
        company_website: "https://evil.example/?a=1&b=2",
        company_description: 'Sells "widgets" <b>&</b> more',
        stage: "series_a",
        announced_date: "2026-09-03",
        lead_investors: ['=HYPERLINK("https://x")', "Fund <i>Two</i>"],
        sources: [
          { url: "https://news.example/evil?x=1&y=2", host: "news.example", title: "Evil <script>raises</script> & more" },
          { url: "https://evil.example/press/series-a", host: "evil.example", title: "Evil announces Series A" },
        ],
        verification: { status: "confirmed", notes: [], url: "https://evil.example/press/series-a", sources_seen: 2 },
      }),
    ],
    "series-a-b",
    "run-security",
  );
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  await corroborateRecord(handle, searched, "evil:series_a:2026-09-03", { broad: true, maxPages: 0 });
});

function post(body: string, headers: Record<string, string> = {}) {
  return webhookPost(new Request("http://app.test/api/webhooks/firecrawl", { method: "POST", body, headers }));
}

describe("tokenEquals", () => {
  test("equal strings match; anything else, including a missing side or a length difference, does not", () => {
    expect(tokenEquals("Bearer abc", "Bearer abc")).toBe(true);
    expect(tokenEquals("Bearer abc", "Bearer abd")).toBe(false);
    expect(tokenEquals("Bearer abc", "Bearer ab")).toBe(false);
    expect(tokenEquals(null, "x")).toBe(false);
    expect(tokenEquals(undefined, undefined)).toBe(false);
    expect(tokenEquals("", "")).toBe(true);
  });

  test("the signature check still verifies through it", () => {
    expect(verifyFirecrawlSignature("body", signForTests("body", "s"), "s")).toBe(true);
    expect(verifyFirecrawlSignature("body", "sha256=zz", "s")).toBe(false);
    expect(verifyFirecrawlSignature("body", null, "s")).toBe(false);
  });
});

describe("POST /api/webhooks/firecrawl", () => {
  const signed = JSON.stringify({ success: true, type: "monitor.check.completed", id: "sec-evt-1", data: [] });

  test("a body that is not JSON, or not an event, is a 400 with one line and no stack", async () => {
    const notJson = await post("not json");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "body is not JSON" });

    const noId = await post(JSON.stringify({ type: "monitor.page", data: [] }));
    expect(noId.status).toBe(400);
    const body = (await noId.json()) as { error: string };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).not.toMatch(/\n|at /);

    expect((await post(JSON.stringify({ id: "x", type: "monitor.page", data: "nope" }))).status).toBe(400);
  });

  test("a monitor.page entry without a url or monitorId is a 400 before anything is written, so a retry is not a duplicate", async () => {
    const bad = JSON.stringify({ id: "sec-evt-page", type: "monitor.page", data: [{ monitorId: "m", checkId: "c", status: "new" }] });
    expect((await post(bad)).status).toBe(400);
    const good = JSON.stringify({
      id: "sec-evt-page",
      type: "monitor.page",
      data: [{ monitorId: "m", checkId: "c", url: "https://a.example/post", status: "new" }],
    });
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, started: 1 });
  });

  test("with neither secret configured: open in development, closed in production", async () => {
    delete process.env.FIRECRAWL_WEBHOOK_SECRET;
    delete process.env.WEBHOOK_BEARER_TOKEN;
    expect((await post(signed)).status).toBe(200);

    vi.stubEnv("NODE_ENV", "production");
    try {
      const closed = await post(JSON.stringify({ success: true, type: "monitor.check.completed", id: "sec-evt-2", data: [] }));
      expect(closed.status).toBe(401);
      expect(await closed.json()).toEqual({ error: "unauthorized" });

      // A configured secret opens production again, for a correctly signed request only.
      process.env.FIRECRAWL_WEBHOOK_SECRET = "prod-secret";
      const body = JSON.stringify({ success: true, type: "monitor.check.completed", id: "sec-evt-3", data: [] });
      expect((await post(body, { "x-firecrawl-signature": signForTests(body, "prod-secret") })).status).toBe(200);
      expect((await post(body, { "x-firecrawl-signature": signForTests(body, "other") })).status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
      delete process.env.FIRECRAWL_WEBHOOK_SECRET;
    }
  });
});

describe("GET /api/cron/deliveries", () => {
  test("a wrong bearer is unauthorized when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    try {
      expect((await deliveriesGet(new Request("http://app.test/api/cron/deliveries"))).status).toBe(401);
      expect(
        (await deliveriesGet(new Request("http://app.test/api/cron/deliveries", { headers: { authorization: "Bearer s3cre" } }))).status,
      ).toBe(401);
      const ok = await deliveriesGet(new Request("http://app.test/api/cron/deliveries", { headers: { authorization: "Bearer s3cret" } }));
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe("GET /feeds/{token}/{preset}.{rss|atom|json} escapes what the web wrote", () => {
  test("a title with <script> and & comes out escaped in RSS, Atom, and JSON Feed", async () => {
    const handle = await db();
    const token = await mintFeedToken(handle, "security", "series-a-b");
    const ctx = (file: string) => ({ params: Promise.resolve({ token, file }) });

    for (const format of ["rss", "atom"]) {
      const xml = await (await feedsGet(new Request("http://app.test/feeds/x/y"), ctx(`series-a-b.${format}`))).text();
      expect(xml, format).not.toContain("<script>");
      expect(xml, format).toContain("Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co raises");
      // The description is HTML on purpose; the scraped values inside it are not.
      expect(xml, format).toContain("<strong>Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co raised");
      expect(xml, format).toContain("<p>Sells &quot;widgets&quot; &lt;b&gt;&amp;&lt;/b&gt; more · evil.example</p>");
      expect(xml, format).toContain("Fund &lt;i&gt;Two&lt;/i&gt;");
      // Sources are named by host; the scraped URL's & is escaped inside the href.
      expect(xml, format).toContain('<a href="https://news.example/evil?x=1&amp;y=2">news.example</a>');
    }

    const json = (await (await feedsGet(new Request("http://app.test/feeds/x/y"), ctx("series-a-b.json"))).json()) as {
      items: Array<{ title: string; content_html: string }>;
    };
    const item = json.items.find((i) => i.title.includes("Evil"));
    expect(item?.title).toContain("Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
    expect(item?.content_html).not.toContain("<script>");
    expect(item?.content_html).toContain("<strong>Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co raised");
  });

  test("a token scoped to one preset cannot read another, and an unscoped token reads any known preset", async () => {
    const handle = await db();
    const scoped = await mintFeedToken(handle, "seed only", "seed");
    const scopedCtx = (file: string) => ({ params: Promise.resolve({ token: scoped, file }) });

    const wrong = await feedsGet(new Request("http://app.test/feeds/x/y"), scopedCtx("series-a-b.rss"));
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe("not found");
    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), scopedCtx("seed.rss"))).status).toBe(200);

    const open = await mintFeedToken(handle, "all presets", null);
    const openCtx = (file: string) => ({ params: Promise.resolve({ token: open, file }) });
    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), openCtx("series-a-b.rss"))).status).toBe(200);
    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), openCtx("seed.rss"))).status).toBe(200);
    // A made-up slug is the same 404 as a bad token.
    expect((await feedsGet(new Request("http://app.test/feeds/x/y"), openCtx("not-a-preset.rss"))).status).toBe(404);
  });
});

describe("DASHBOARD_PASSWORD", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  test("basicAuthorized: the right password with any username passes; anything else fails", () => {
    expect(basicAuthorized(`Basic ${b64("fireround:secret")}`, "secret")).toBe(true);
    expect(basicAuthorized(`Basic ${b64("anyone:secret")}`, "secret")).toBe(true);
    expect(basicAuthorized(`basic ${b64("u:secret")}`, "secret")).toBe(true);
    expect(basicAuthorized(`Basic ${b64("fireround:wrong")}`, "secret")).toBe(false);
    expect(basicAuthorized(null, "secret")).toBe(false);
    expect(basicAuthorized("Bearer abc", "secret")).toBe(false);
    expect(basicAuthorized("Basic !!!not-base64", "secret")).toBe(false);
    expect(basicAuthorized(`Basic ${b64("nocolonhere")}`, "secret")).toBe(false);
    // A password may itself contain a colon; the split is on the first one.
    expect(basicAuthorized(`Basic ${b64("u:p:a:ss")}`, "p:a:ss")).toBe(true);
    expect(basicAuthorized(`Basic ${b64("u:p:a:ss")}`, "p")).toBe(false);
  });

  test("proxy passes through with no password set, and demands it otherwise", () => {
    // The matcher is a build-time static, so the function itself is what is exercised here.
    delete process.env.DASHBOARD_PASSWORD;
    expect(gate(new NextRequest("http://app.test/feed")).headers.get("x-middleware-next")).toBe("1");
    process.env.DASHBOARD_PASSWORD = "secret";
    try {
      const denied = gate(new NextRequest("http://app.test/feed"));
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe(BASIC_CHALLENGE["www-authenticate"]);
      const allowed = gate(new NextRequest("http://app.test/feed", { headers: { authorization: `Basic ${b64("u:secret")}` } }));
      expect(allowed.headers.get("x-middleware-next")).toBe("1");
    } finally {
      delete process.env.DASHBOARD_PASSWORD;
    }
  });

  test("requireDashboardWith throws when a password is set and the request lacks it", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(() => requireDashboardWith(null)).not.toThrow();
    process.env.DASHBOARD_PASSWORD = "secret";
    try {
      expect(() => requireDashboardWith(null)).toThrow("Unauthorized: the dashboard password was not sent.");
      expect(() => requireDashboardWith(`Basic ${b64("u:other")}`)).toThrow("Unauthorized: the dashboard password was not sent.");
      expect(() => requireDashboardWith(`Basic ${b64("u:secret")}`)).not.toThrow();
    } finally {
      delete process.env.DASHBOARD_PASSWORD;
    }
  });
});

describe("GET /api/v1/rounds?format=csv", () => {
  test("a cell that opens with a formula character is neutralized with a leading quote", async () => {
    const csv = await (await roundsGet(new Request("http://app.test/api/v1/rounds?format=csv&company=evil.example"))).text();
    const row = csv.split("\n")[1];
    // lead_investors joined with "; " and quoted for the comma-free but quote-bearing content.
    expect(row).toContain(`"'=HYPERLINK(""https://x""); Fund <i>Two</i>"`);
    expect(row).not.toContain(",=HYPERLINK");
  });
});
