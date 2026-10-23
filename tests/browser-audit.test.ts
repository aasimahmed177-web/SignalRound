import { readPublicText } from "@fireround/core/web/transport";
import { beforeEach, expect, test, vi } from "vitest";
import { classifyBrowserAsset } from "../lib/browser-asset-policy";
import { auditRenderedPage, browserRequestAllowed, reportUrl } from "../lib/browser-audit";

test("asset classification uses exact hosts or dot-separated subdomains, not substrings", () => {
  expect(classifyBrowserAsset("https://a.doubleclick.net/tag.js", "script")).toBe("advertising");
  expect(classifyBrowserAsset("https://GOOGLE-ANALYTICS.COM./tag.js", "script")).toBe("analytics");
  for (const host of ["notdoubleclick.net", "doubleclick.net.evil.example", "example.org"]) {
    expect(classifyBrowserAsset(`https://${host}/tally.so.js`, "script")).toBe("app-asset");
  }
  expect(classifyBrowserAsset("https://tally.so/embed/test", "document")).toBe("form-app");
  expect(classifyBrowserAsset("https://tally.so/api/test", "fetch")).toBe("other");
});

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "preserves form script budget when 100 ad scripts precede an embedded questionnaire",
  async () => {
    vi.mocked(readPublicText).mockImplementation(async (url) => {
      if (url === "https://1.1.1.1/")
        return {
          url,
          status: 200,
          contentType: "text/html",
          text: `<html><body>${Array.from({ length: 100 }, (_, i) => `<script src="https://ad.doubleclick.net/tag.js?id=${i}"></script>`).join("")}<iframe src="https://tally.so/embed/fixture"></iframe></body></html>`,
        };
      if (url === "https://tally.so/embed/fixture")
        return {
          url,
          status: 200,
          contentType: "text/html",
          text: '<html><body><div id="form"></div><script src="/form-app.js"></script></body></html>',
        };
      if (url === "https://tally.so/form-app.js")
        return {
          url,
          status: 200,
          contentType: "text/javascript",
          text: `document.getElementById('form').innerHTML='<form><label>Income source<select name="income"><option>Job</option><option>None</option></select></label><input name="budget" required></form>'; fetch('/api/never',{method:'POST'}).catch(()=>{});`,
        };
      throw new Error("Unexpected transport request");
    });
    const result = await auditRenderedPage("https://1.1.1.1/");
    const frame = result.frames.find((f) => f.frameURL === "https://tally.so/embed/fixture");
    expect(frame?.forms[0]?.fields.map((field) => field.name)).toEqual(["income", "budget"]);
    expect(vi.mocked(readPublicText).mock.calls.map(([url]) => url)).toEqual([
      "https://1.1.1.1/",
      "https://tally.so/embed/fixture",
      "https://tally.so/form-app.js",
    ]);
    expect(result.assetPolicy.assetCounts.advertising).toBe(100);
    expect(result.assetPolicy.outcomeCounts["blocked-nonessential-asset"]).toBe(100);
    expect(result.assetPolicy.outcomeCounts["blocked-policy"]).toBeGreaterThanOrEqual(1);
    expect(result.assetPolicy.outcomeCounts.read).toBe(3);
    expect(result.status).toBe("partial");
    expect(result.warnings).not.toContain("Browser request budget exhausted");
  },
  30_000,
);

vi.mock("@fireround/core/web/transport", async (original) => ({
  ...(await original<typeof import("@fireround/core/web/transport")>()),
  readPublicText: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(readPublicText).mockReset();
});
test("browser policy blocks writes and unneeded network channels", () => {
  expect(browserRequestAllowed("GET", "document")).toBe(true);
  expect(browserRequestAllowed("GET", "script")).toBe(true);
  for (const type of ["fetch", "xhr", "image", "media", "websocket"]) expect(browserRequestAllowed("GET", type)).toBe(false);
  expect(browserRequestAllowed("POST", "document")).toBe(false);
  expect(reportUrl("https://example.org/?email=private@example.com#secret")).not.toContain("private@example.com");
});
test("private destinations are rejected before browser launch", async () => {
  await expect(auditRenderedPage("http://127.0.0.1/")).rejects.toThrow();
});
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "renders dynamic forms and frames without transmitting a POST",
  async () => {
    vi.mocked(readPublicText).mockImplementation(async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      text: url.endsWith("/frame")
        ? '<html><body><h1>Questionnaire</h1><form><input name="budget"></form></body></html>'
        : '<html><body><div id="app"></div><script>document.getElementById("app").innerHTML=\'<form><input name="email"></form><iframe src="/frame"></iframe>\'; fetch("/submit",{method:"POST",body:"test"}).catch(()=>{});</script></body></html>',
    }));
    const result = await auditRenderedPage("https://1.1.1.1/");
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]?.forms[0]?.fields[0]?.name).toBe("email");
    expect(result.frames[1]?.forms[0]?.fields[0]?.name).toBe("budget");
    expect(result.network).toContainEqual(expect.objectContaining({ method: "POST", outcome: "blocked-policy" }));
    expect(vi.mocked(readPublicText).mock.calls.map(([url]) => url)).not.toContain("https://1.1.1.1/submit");
  },
  30_000,
);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "captures inline rendered frames with honest provenance and treats redirects as successful",
  async () => {
    vi.mocked(readPublicText).mockImplementation(async (url) => ({
      url: url === "https://1.1.1.1/" ? "https://1.1.1.1/landing" : url,
      status: 200,
      contentType: "text/html",
      text: `<html><body><h1>Landing</h1>
        <iframe srcdoc="<form><input name='inline-budget'></form><a href='/next'>Continue</a>"></iframe>
        <iframe id="blank"></iframe>
        <script>document.getElementById('blank').contentDocument.body.innerHTML = '<form><input name="blank-budget"></form>';</script>
        </body></html>`,
    }));
    const result = await auditRenderedPage("https://1.1.1.1/");
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.frames).toHaveLength(3);
    const inline = result.frames.find((frame) => frame.frameURL === "about:srcdoc");
    const blank = result.frames.find((frame) => frame.frameURL === "about:blank");
    expect(inline?.forms[0]?.fields[0]?.name).toBe("inline-budget");
    expect(blank?.forms[0]?.fields[0]?.name).toBe("blank-budget");
    expect(inline?.url).toBe("https://1.1.1.1/landing");
    expect(inline?.links[0]?.url).toBe("https://1.1.1.1/next");
    expect(result.frames.every((frame) => frame.sourceMode === "rendered-dom")).toBe(true);
    expect(JSON.stringify(result.frames)).not.toContain("never executed");
    expect(result.network).toContainEqual(expect.objectContaining({ outcome: "redirect" }));
    expect(vi.mocked(readPublicText).mock.calls).toHaveLength(1);
  },
  30_000,
);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "fails closed on redirected subresources and reports omitted frames",
  async () => {
    vi.mocked(readPublicText).mockImplementation(async (url) => ({
      url: url.endsWith(".js") ? "https://1.1.1.1/redirected.js" : url,
      status: 200,
      contentType: url.endsWith(".js") ? "text/javascript" : "text/html",
      text: url.endsWith(".js")
        ? "document.body.innerHTML = 'should not run';"
        : `<html><body><h1>Safe fixture</h1><script src="/script.js"></script>${'<iframe srcdoc="<h1>Inline</h1>"></iframe>'.repeat(9)}</body></html>`,
    }));
    const result = await auditRenderedPage("https://1.1.1.1/#ignored-fragment");
    expect(result.status).toBe("partial");
    expect(result.frames).toHaveLength(8);
    expect(result.frames[0]?.headings).toContain("Safe fixture");
    expect(result.warnings).toContain("Frame limit reached; only the first eight frames were collected");
    expect(result.network).toContainEqual(expect.objectContaining({ outcome: "blocked-subresource-redirect" }));
    expect(result.requestedURL).toBe("https://1.1.1.1/");
  },
  30_000,
);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "reserves decoded-text budget before concurrent resource reads",
  async () => {
    const html = `<html><body><h1>Concurrent budget fixture</h1>${Array.from({ length: 12 }, (_, i) => `<script async src="/large-${i}.js"></script>`).join("")}</body></html>`;
    const reservations: number[] = [];
    let active = 0;
    let peak = 0;
    vi.mocked(readPublicText).mockImplementation(async (url, options) => {
      if (url === "https://1.1.1.1/") return { url, status: 200, contentType: "text/html", text: html };
      const maxBytes = options?.maxBytes ?? 0;
      reservations.push(maxBytes);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active--;
      return { url, status: 200, contentType: "text/javascript", text: `/*${"x".repeat(maxBytes - 4)}*/` };
    });
    const result = await auditRenderedPage("https://1.1.1.1/");
    expect(peak).toBeGreaterThan(1);
    expect(reservations.length).toBeGreaterThan(1);
    expect(reservations.every((size) => size > 0 && size <= 2_000_000)).toBe(true);
    expect(reservations.reduce((total, size) => total + size, Buffer.byteLength(html))).toBeLessThanOrEqual(12_000_000);
    expect(result.status).toBe("partial");
    expect(result.network).toContainEqual(expect.objectContaining({ outcome: "blocked-byte-budget" }));
    expect(result.warnings).toContain("Browser evidence byte budget exhausted");
  },
  30_000,
);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "reports request-budget truncation separately from policy blocks",
  async () => {
    vi.mocked(readPublicText).mockImplementation(async (url) => ({
      url,
      status: 200,
      contentType: url.endsWith(".js") ? "text/javascript" : "text/html",
      text: url.endsWith(".js")
        ? "void 0;"
        : `<html><body><h1>Budget fixture</h1>${Array.from({ length: 65 }, (_, index) => `<script src="/script-${index}.js"></script>`).join("")}</body></html>`,
    }));
    const result = await auditRenderedPage("https://1.1.1.1/");
    expect(result.status).toBe("partial");
    expect(result.warnings).toContain("Browser request budget exhausted");
    expect(result.network).toContainEqual(expect.objectContaining({ outcome: "blocked-read-budget" }));
    expect(vi.mocked(readPublicText).mock.calls).toHaveLength(60);
  },
  30_000,
);
