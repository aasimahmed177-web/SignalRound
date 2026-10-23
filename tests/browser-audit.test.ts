import { readPublicText } from "@fireround/core/web/transport";
import { expect, test, vi } from "vitest";
import { auditRenderedPage, browserRequestAllowed, reportUrl } from "../lib/browser-audit";

vi.mock("@fireround/core/web/transport", async (original) => ({
  ...(await original<typeof import("@fireround/core/web/transport")>()),
  readPublicText: vi.fn(),
}));
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
