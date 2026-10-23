import { inspectFunnelHtml } from "@fireround/core/web";
import { readPublicText, resolvePublicUrl } from "@fireround/core/web/transport";
import { chromium } from "playwright";

export function browserRequestAllowed(method: string, type: string) {
  return method === "GET" && ["document", "script", "stylesheet"].includes(type);
}
export function reportUrl(raw: string) {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "[redacted]");
    u.hash = "";
    return u.toString();
  } catch {
    return "[non-http URL]";
  }
}
let running = false;
/** Isolated renderer, not live journey replay. Node's pinned transport owns HTTP egress. */
export async function auditRenderedPage(raw: string) {
  const { url } = await resolvePublicUrl(raw);
  if (url.search) throw new Error("Use a canonical URL without query strings.");
  if (running) throw new Error("A browser audit is already running. Retry when it finishes.");
  running = true;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.timeout(45_000);
  const network: Array<{ url: string; method: string; type: string; outcome: string }> = [];
  const warnings: string[] = [];
  try {
    browser = await chromium.launch({
      channel: process.env.NATIVE_BROWSER_CHANNEL || "chrome",
      headless: true,
      chromiumSandbox: true,
      timeout: 15_000,
      proxy: { server: "http://127.0.0.1:9" },
      args: ["--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    const instance = browser;
    watchdog = setTimeout(() => {
      void instance.close().catch(() => {});
    }, 40_000);
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
      document.addEventListener("submit", (event) => event.preventDefault(), true);
      HTMLFormElement.prototype.submit = () => {};
      HTMLFormElement.prototype.requestSubmit = () => {};
      Object.defineProperty(globalThis, "RTCPeerConnection", { value: undefined });
    });
    let reads = 0;
    let bytes = 0;
    await context.route("**/*", async (route) => {
      const req = route.request();
      const item = { url: reportUrl(req.url()), method: req.method(), type: req.resourceType(), outcome: "blocked-policy" };
      if (network.length < 200) network.push(item);
      try {
        if (!browserRequestAllowed(req.method(), req.resourceType()) || reads >= 60 || bytes >= 12_000_000) {
          await route.abort();
          return;
        }
        reads++;
        const response = await readPublicText(req.url(), { signal, timeoutMs: 8000, maxBytes: 2_000_000 });
        bytes += Buffer.byteLength(response.text);
        if (bytes > 12_000_000) throw new Error("Browser evidence byte budget exceeded");
        if (response.url !== req.url()) {
          item.outcome = "redirect";
          await route.fulfill({ status: 302, headers: { location: response.url } });
          return;
        }
        item.outcome = "read";
        await route.fulfill({ status: response.status, contentType: response.contentType || "text/plain", body: response.text });
      } catch (error) {
        item.outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    context.on("page", (popup) => {
      if (popup !== page) void popup.close();
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(3000);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    const frames: Array<ReturnType<typeof inspectFunnelHtml>> = [];
    for (const frame of page.frames().slice(0, 8)) {
      if (!/^https?:/.test(frame.url())) continue;
      try {
        const html = await frame.content();
        if (html.length > 2_000_000) {
          warnings.push("Rendered frame exceeded evidence limit");
          continue;
        }
        frames.push(inspectFunnelHtml(html, reportUrl(frame.url())));
      } catch {
        warnings.push("A frame detached before collection");
      }
    }
    return {
      status: !frames.length ? "failed" : warnings.length || network.some((n) => n.outcome !== "read") ? "partial" : "completed",
      mode: "isolated-render-not-live-session",
      requestedURL: url.toString(),
      finalURL: reportUrl(page.url()),
      frames,
      network,
      warnings,
      creditsUsed: 0,
      limitations: [
        "POST, fetch/XHR, WebSockets, media and images are blocked; this intentionally changes site behavior.",
        "No logins, existing cookies, form input, clicks or submissions. No runtime conversion claims.",
        "Rendered DOM is sampled after three seconds, up to eight frames. This is not full journey replay.",
      ],
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    running = false;
  }
}
