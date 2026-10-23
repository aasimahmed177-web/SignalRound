import {
  createBrowserEvidence,
  createEvidenceRedactor,
  type EvidenceJson,
  questionnairePlanSchema,
  scoreAnswers,
} from "@fireround/core/funnel";
import { type PublicText, readPublicText, resolvePublicUrl } from "@fireround/core/web/transport";
import { chromium, type Frame, type Locator, type Page } from "playwright";
import { type BrowserAssetClass, classifyBrowserAsset } from "./browser-asset-policy";

type Read = typeof readPublicText;
type ReplayDependencies = { read?: Read; channel?: string };
type NetworkItem = {
  method: string;
  type: string;
  origin: string;
  path: string;
  queryKeys: string[];
  bodyParameterNames: string[];
  assetClass: BrowserAssetClass;
  outcome: string;
};

const ALLOWED_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch"]);
const DANGEROUS_DESTINATION = /(?:checkout|payment|purchase|buy|send|message|join|book|subscribe|delete|logout|register|submit)/i;
let replayRunning = false;

function urlShape(raw: string) {
  try {
    const url = new URL(raw);
    return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].slice(0, 50) };
  } catch {
    return { origin: "[non-http]", path: "", queryKeys: [] };
  }
}

export function requestBodyParameterNames(contentType: string | undefined, body: string | null) {
  if (!body) return [];
  const keys = new Set<string>();
  if (/json/i.test(contentType ?? "")) {
    try {
      const value = JSON.parse(body) as unknown;
      const visit = (input: unknown, depth = 0) => {
        if (depth > 4 || !input || typeof input !== "object") return;
        if (Array.isArray(input)) {
          for (const item of input.slice(0, 50)) visit(item, depth + 1);
          return;
        }
        for (const [key, child] of Object.entries(input).slice(0, 100)) {
          keys.add(key.slice(0, 100));
          visit(child, depth + 1);
        }
      };
      visit(value);
    } catch {
      return [];
    }
  } else {
    try {
      for (const key of new URLSearchParams(body).keys()) keys.add(key.slice(0, 100));
    } catch {
      return [];
    }
  }
  return [...keys].slice(0, 100);
}

async function visibleLocator(page: Page, selector: string): Promise<{ frame: Frame; locator: Locator }> {
  for (const frame of page.frames().slice(0, 20)) {
    const locator = frame.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible({ timeout: 500 }))) return { frame, locator };
    } catch {
      // A frame may navigate while the search moves to the next frame.
    }
  }
  throw new Error(`No visible element matched selector: ${selector}`);
}

export async function inspectClickSafety(locator: Locator, allowedOrigins: readonly string[]) {
  const facts = await locator.evaluate((element) => {
    const form = element instanceof HTMLElement ? element.closest("form") : null;
    const buttonType =
      element instanceof HTMLButtonElement || element instanceof HTMLInputElement
        ? (element.getAttribute("type") || "submit").toLowerCase()
        : "";
    return {
      tag: element.tagName.toLowerCase(),
      buttonType,
      href: element instanceof HTMLAnchorElement ? element.href : "",
      hasForm: Boolean(form),
      formMethod: form?.getAttribute("method")?.toUpperCase() || "GET",
    };
  });
  if ((facts.tag === "button" || facts.tag === "input") && facts.buttonType === "submit")
    throw new Error("Submit controls are blocked in dry-run mode");
  if (facts.href) {
    const target = new URL(facts.href);
    if (!allowedOrigins.includes(target.origin)) throw new Error("Cross-origin clicks are blocked in dry-run mode");
    if (DANGEROUS_DESTINATION.test(`${target.pathname} ${[...target.searchParams.keys()].join(" ")}`))
      throw new Error("Potentially consequential destination blocked in dry-run mode");
  }
  return facts;
}

async function captureObservation(page: Page, scoreSelectors: string[], redactor: ReturnType<typeof createEvidenceRedactor>) {
  const frames = [];
  for (const frame of page.frames().slice(0, 12)) {
    try {
      const observation = await frame.evaluate((selectors) => {
        const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
        return {
          url: location.href,
          title: document.title,
          fields: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
            .filter(visible)
            .slice(0, 100)
            .map((element) => ({
              type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
              name: element.name.slice(0, 100),
              required: element.required,
              label:
                [...(element.labels ?? [])].map((label) => label.innerText).join(" ") ||
                element.getAttribute("aria-label") ||
                element.getAttribute("placeholder") ||
                "[unlabelled]",
            })),
          buttons: [...document.querySelectorAll("button,[role=button],a[href]")]
            .filter(visible)
            .slice(0, 80)
            .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200)),
          scores: selectors.flatMap((selector) =>
            [...document.querySelectorAll(selector)]
              .filter(visible)
              .slice(0, 10)
              .map((element) => ({ selector, text: element.textContent?.trim().slice(0, 500) ?? "" })),
          ),
          storageKeys: {
            local: Object.keys(localStorage).slice(0, 100),
            session: Object.keys(sessionStorage).slice(0, 100),
          },
        };
      }, scoreSelectors);
      frames.push({ ...observation, url: urlShape(observation.url) });
    } catch {
      frames.push({ unavailable: true });
    }
  }
  const redacted = redactor.redact({ finalUrl: urlShape(page.url()), frames });
  redactor.assertSafe(redacted);
  return redacted;
}

async function runProfile(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  plan: ReturnType<typeof questionnairePlanSchema.parse>,
  profile: (typeof plan.profiles)[number],
  read: Read,
) {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.addInitScript(() => {
    document.addEventListener("submit", (event) => event.preventDefault(), true);
    HTMLFormElement.prototype.submit = () => {};
    HTMLFormElement.prototype.requestSubmit = () => {};
    Object.defineProperty(globalThis, "RTCPeerConnection", { value: undefined });
  });
  const redactor = createEvidenceRedactor(Object.values(profile.answers));
  const network: NetworkItem[] = [];
  const signal = AbortSignal.timeout(55_000);
  const start = await read(plan.startUrl, { signal, timeoutMs: 10_000, maxBytes: 2_000_000 });
  let cachedEntry: PublicText | undefined = start;
  let reads = 1;
  let bytes = Buffer.byteLength(start.text);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const shape = urlShape(request.url());
    const assetClass = classifyBrowserAsset(request.url(), request.resourceType());
    const headers = request.headers();
    const item: NetworkItem = {
      method: request.method(),
      type: request.resourceType(),
      ...shape,
      bodyParameterNames: requestBodyParameterNames(headers["content-type"], request.postData()),
      assetClass,
      outcome: "blocked-policy",
    };
    if (network.length < 400) network.push(item);
    try {
      if (!["GET", "HEAD"].includes(request.method())) {
        item.outcome = "blocked-write";
        await route.abort();
        return;
      }
      if (!plan.allowedOrigins.includes(shape.origin)) {
        item.outcome = "blocked-origin";
        await route.abort();
        return;
      }
      if (!ALLOWED_TYPES.has(request.resourceType()) || assetClass === "advertising" || assetClass === "analytics") {
        item.outcome = "blocked-nonessential-asset";
        await route.abort();
        return;
      }
      if (reads >= 80 || bytes >= 16_000_000) {
        item.outcome = reads >= 80 ? "blocked-read-budget" : "blocked-byte-budget";
        await route.abort();
        return;
      }
      let response: PublicText;
      if (cachedEntry && request.url() === start.url && request.isNavigationRequest()) {
        response = cachedEntry;
        cachedEntry = undefined;
      } else {
        reads++;
        const reservation = Math.min(2_000_000, 16_000_000 - bytes);
        bytes += reservation;
        response = await read(request.url(), { signal, timeoutMs: 8_000, maxBytes: reservation });
        bytes += Buffer.byteLength(response.text) - reservation;
      }
      if (response.url !== request.url()) {
        item.outcome = "blocked-redirect";
        await route.abort();
        return;
      }
      if (!/(?:html|javascript|json|css|xml|text)/i.test(response.contentType)) {
        item.outcome = "blocked-content-type";
        await route.abort();
        return;
      }
      item.outcome = "read";
      await route.fulfill({
        status: response.status,
        contentType: response.contentType,
        body: request.method() === "HEAD" ? "" : response.text,
      });
    } catch {
      item.outcome = "failed-read";
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
  const steps: Array<{ id: string; action: string; outcome: string; evidence?: ReturnType<typeof createBrowserEvidence> }> = [];
  try {
    await page.goto(start.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(500);
    for (const step of plan.steps) {
      try {
        if (step.action !== "observe") {
          const { locator } = await visibleLocator(page, step.selector);
          if (step.action === "fill") await locator.fill(profile.answers[step.answerKey], { timeout: 5_000 });
          else if (step.action === "select") {
            const answer = profile.answers[step.answerKey];
            await locator.selectOption(step.by === "label" ? { label: answer } : { value: answer }, { timeout: 5_000 });
          } else if (step.action === "check") {
            const shouldCheck = /^(?:true|1|yes|on)$/i.test(profile.answers[step.answerKey]);
            if (shouldCheck) await locator.check({ timeout: 5_000 });
            else await locator.uncheck({ timeout: 5_000 });
          } else {
            await inspectClickSafety(locator, plan.allowedOrigins);
            await locator.click({ timeout: 5_000 });
          }
        } else if (step.selector) await visibleLocator(page, step.selector);
        await page.waitForTimeout(250);
        const observation = await captureObservation(page, plan.scoreSelectors, redactor);
        const evidence = createBrowserEvidence(
          {
            observedAt: new Date().toISOString(),
            mode: "observation-only",
            level: "runtime-function-invoked",
            source: { kind: "runtime", locator: step.selector ?? "document" },
            payload: { stepId: step.id, action: step.action, observation },
          },
          redactor,
        );
        steps.push({ id: step.id, action: step.action, outcome: "observed", evidence });
      } catch (error) {
        steps.push({ id: step.id, action: step.action, outcome: `stopped: ${error instanceof Error ? error.message : String(error)}` });
        break;
      }
    }
    const computed = plan.scoring ? scoreAnswers(plan.scoring, profile.answers) : null;
    const finalObservation = (await captureObservation(page, plan.scoreSelectors, redactor)) as EvidenceJson;
    return {
      id: profile.id,
      label: profile.label,
      status: steps.length === plan.steps.length && steps.every((step) => step.outcome === "observed") ? "completed" : "partial",
      steps,
      computed,
      finalObservation,
      network,
      blockedWrites: network.filter((item) => item.outcome === "blocked-write").length,
    };
  } finally {
    await context.close();
  }
}

/**
 * Automated questionnaire interaction up to the submission boundary. It never submits a form:
 * non-GET/HEAD requests, submit controls, WebSockets, downloads and dangerous destinations are blocked.
 * GET cannot be proven side-effect-free; use only on an authorized target.
 */
export async function runQuestionnaireDryRun(input: unknown, dependencies: ReplayDependencies = {}) {
  if (replayRunning) throw new Error("A questionnaire replay is already running");
  const plan = questionnairePlanSchema.parse(input);
  const start = await resolvePublicUrl(plan.startUrl);
  if (!plan.allowedOrigins.includes(start.url.origin)) throw new Error("Resolved start origin is not allowed");
  replayRunning = true;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      channel: dependencies.channel ?? process.env.NATIVE_BROWSER_CHANNEL ?? "chrome",
      headless: true,
      chromiumSandbox: true,
      timeout: 15_000,
      proxy: { server: "http://127.0.0.1:9" },
      args: ["--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    const trials = [];
    for (const profile of plan.profiles) trials.push(await runProfile(browser, plan, profile, dependencies.read ?? readPublicText));
    const baseline = trials[0];
    return {
      status: trials.every((trial) => trial.status === "completed") ? "completed" : "partial",
      mode: "interactive-dry-run",
      requestedURL: urlShape(plan.startUrl),
      trials: trials.map((trial, index) => ({
        ...trial,
        comparison:
          trial.computed && baseline.computed
            ? {
                baseline: index === 0,
                scoreDelta: trial.computed.score - baseline.computed.score,
                routeChanged: trial.computed.route !== baseline.computed.route,
              }
            : null,
      })),
      creditsUsed: 0,
      limitations: [
        "Dry-run only: non-GET/HEAD requests and submit controls are blocked; no form submission is transmitted. GET cannot be proven side-effect-free.",
        "Computed scores come only from the supplied declarative model. Observed score text is browser evidence, not an extracted scoring rule.",
        "GET/XHR hydration is routed through the pinned public-network reader and limited to approved origins, 80 reads and 16 MB per profile.",
        "A response or visible route does not prove CRM persistence, server-side scoring, CAPI delivery or ad-platform acknowledgement.",
      ],
    };
  } finally {
    await browser?.close().catch(() => {});
    replayRunning = false;
  }
}
