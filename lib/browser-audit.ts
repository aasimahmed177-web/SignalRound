import { inspectFunnelHtml } from "@fireround/core/web";
import { type PublicText, readPublicText, resolvePublicUrl } from "@fireround/core/web/transport";
import { chromium } from "playwright";
import { type BrowserAssetClass, classifyBrowserAsset } from "./browser-asset-policy";

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
  url.hash = "";
  if (running) throw new Error("A browser audit is already running. Retry when it finishes.");
  running = true;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.timeout(45_000);
  const network: Array<{ url: string; method: string; type: string; outcome: string; assetClass?: BrowserAssetClass }> = [];
  const assetCounts: Partial<Record<BrowserAssetClass, number>> = {};
  const outcomeCounts: Record<string, number> = {};
  let observedRequests = 0;
  const warnings: string[] = [];
  try {
    // Chromium does not re-route the next hop of a fulfilled 302. Resolve the
    // entry document in the pinned transport, then navigate to its final URL.
    let entry: PublicText | undefined = await readPublicText(url.toString(), { signal, timeoutMs: 8000, maxBytes: 2_000_000 });
    const entryURL = entry.url;
    if (entryURL !== url.toString()) {
      network.push({ url: reportUrl(url.toString()), method: "GET", type: "document", outcome: "redirect" });
    }
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
    let reads = 1;
    // Includes in-flight reservations and failed reads charged at their limit.
    // This bounds decoded response text, not compressed wire traffic or redirects.
    let bytes = Buffer.byteLength(entry.text);
    await context.route("**/*", async (route) => {
      const req = route.request();
      const assetClass = classifyBrowserAsset(req.url(), req.resourceType());
      assetCounts[assetClass] = (assetCounts[assetClass] ?? 0) + 1;
      observedRequests++;
      const item = { url: reportUrl(req.url()), method: req.method(), type: req.resourceType(), assetClass, outcome: "blocked-policy" };
      if (network.length < 200) network.push(item);
      try {
        if (!browserRequestAllowed(req.method(), req.resourceType())) {
          await route.abort();
          return;
        }
        // Omit known telemetry before charging read/byte budgets. Classification
        // never bypasses the transport or allows fetch/XHR, including form apps.
        if (assetClass === "advertising" || assetClass === "analytics") {
          item.outcome = "blocked-nonessential-asset";
          await route.abort();
          return;
        }
        if (reads >= 60 || bytes >= 12_000_000) {
          item.outcome = reads >= 60 ? "blocked-read-budget" : "blocked-byte-budget";
          const warning = reads >= 60 ? "Browser request budget exhausted" : "Browser evidence byte budget exhausted";
          if (!warnings.includes(warning)) warnings.push(warning);
          await route.abort();
          return;
        }
        let response: PublicText;
        if (entry && req.url() === entryURL && req.isNavigationRequest()) {
          response = entry;
          entry = undefined;
        } else {
          reads++;
          const reservation = Math.min(2_000_000, 12_000_000 - bytes);
          bytes += reservation;
          response = await readPublicText(req.url(), { signal, timeoutMs: 8000, maxBytes: reservation });
          bytes += Buffer.byteLength(response.text) - reservation;
        }
        if (bytes > 12_000_000) {
          item.outcome = "blocked-byte-budget";
          if (!warnings.includes("Browser evidence byte budget exhausted")) warnings.push("Browser evidence byte budget exhausted");
          await route.abort();
          return;
        }
        if (response.url !== req.url()) {
          item.outcome = "blocked-subresource-redirect";
          const warning = "A redirected subresource was blocked to preserve isolated network routing";
          if (!warnings.includes(warning)) warnings.push(warning);
          await route.abort();
          return;
        }
        item.outcome = "read";
        await route.fulfill({ status: response.status, contentType: response.contentType || "text/plain", body: response.text });
      } catch (error) {
        item.outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
        await route.abort().catch(() => {});
      } finally {
        const outcome = item.outcome.startsWith("failed:") ? "failed" : item.outcome;
        outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
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
      await page.goto(entryURL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(3000);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    const frames: Array<ReturnType<typeof inspectFunnelHtml> & { frameURL: string; sourceMode: "rendered-dom" }> = [];
    if (page.frames().length > 8) warnings.push("Frame limit reached; only the first eight frames were collected");
    for (const frame of page.frames().slice(0, 8)) {
      const frameURL = frame.url();
      const inline = /^about:(?:srcdoc|blank)(?:#.*)?$/.test(frameURL);
      let sourceFrame = frame;
      while (inline && !/^https?:/.test(sourceFrame.url())) {
        const parent = sourceFrame.parentFrame();
        if (!parent) break;
        sourceFrame = parent;
      }
      // Inline documents inherit their embedding document's URL context. Never
      // report the browser's empty top-level blank page as retrieved evidence.
      if (!/^https?:/.test(frameURL) && (!inline || !/^https?:/.test(sourceFrame.url()))) continue;
      try {
        const html = await frame.content();
        if (html.length > 2_000_000) {
          warnings.push("Rendered frame exceeded evidence limit");
          continue;
        }
        frames.push({
          ...inspectFunnelHtml(html, reportUrl(sourceFrame.url())),
          frameURL: reportUrl(frameURL),
          sourceMode: "rendered-dom",
          limitations: [
            "Rendered DOM observation after script execution under the isolated browser network policy.",
            "Script references and declared events do not prove event firing or backend behavior.",
          ],
        });
      } catch {
        warnings.push("A frame detached before collection");
      }
    }
    return {
      status: !frames.length
        ? "failed"
        : warnings.length || Object.keys(outcomeCounts).some((outcome) => outcome !== "read")
          ? "partial"
          : "completed",
      mode: "isolated-render-not-live-session",
      requestedURL: url.toString(),
      finalURL: reportUrl(page.url()),
      frames,
      network,
      assetPolicy: {
        name: "omit-known-advertising-and-analytics",
        observedRequests,
        recordedRequests: network.filter((item) => item.assetClass).length,
        assetCounts,
        outcomeCounts,
        readLimit: 60,
        decodedByteLimit: 12_000_000,
      },
      warnings,
      creditsUsed: 0,
      limitations: [
        "POST, fetch/XHR, WebSockets, media and images are blocked; this intentionally changes site behavior.",
        "Known advertising/analytics hosts are skipped before budgets. Unknown hosts are not automatically classified as trackers. Form-app classification grants no extra network permissions.",
        "Request details are capped at 200 entries; aggregate counts include all observed routed requests. Blocking telemetry may change app behavior; complete form hydration is not guaranteed.",
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
