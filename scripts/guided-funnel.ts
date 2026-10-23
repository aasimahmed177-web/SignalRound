import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { type BrowserContext, chromium, type Frame, type Locator } from "playwright";
import { resolvePublicUrl } from "../packages/core/src/web/transport.ts";

export const MAX_STEPS = 20;
export const SESSION_MS = 15 * 60 * 1000;

/** Explicit operator-approved activation only; never invoked by the manual runner. */
export async function activateNativeControl(control: Locator): Promise<void> {
  const native = await control.evaluate(
    (element) => element.tagName === "BUTTON" || (element.tagName === "A" && element.hasAttribute("href")),
  );
  if (!native) throw new Error("Keyboard activation requires a native button or link with href");
  await control.waitFor({ state: "visible", timeout: 5_000 });
  if (!(await control.isEnabled())) throw new Error("Cannot activate a disabled control");
  // Native keyboard activation does not require a stable bounding box: pulsing CTAs keep moving.
  await control.focus({ timeout: 5_000 });
  await control.press("Enter", { timeout: 5_000 });
}

/** Best-effort report minimization, not a guarantee that page copy contains no PII. */
export function redactText(text: string, enteredValues: string[] = []): string {
  let result = text;
  for (const value of [...new Set(enteredValues)].filter((value) => value.length >= 2).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("[entered value]");
  }
  return result
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "[number]")
    .slice(0, 12_000);
}

export function summarizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return { origin: "[non-http]", path: "", queryKeys: [] };
    return {
      origin: url.origin,
      path: redactText(decodeURIComponent(url.pathname)),
      queryKeys: [...new Set(url.searchParams.keys())].slice(0, 30).map((key) => redactText(key).slice(0, 80)),
    };
  } catch {
    return { origin: "[invalid URL]", path: "", queryKeys: [] };
  }
}

export function parseArgs(args: string[]) {
  if (args.includes("--help")) return null;
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (!args.includes("--allow-live") || positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--allow-live")) {
    throw new Error("Usage: node scripts/guided-funnel.ts <public-https-url> --allow-live (or --help)");
  }
  return { url: positional[0] };
}

async function observeFrame(frame: Frame) {
  const observation = await frame.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const controls = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")];
    return {
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 40_000),
      // Values exist transiently only to redact page echoes. Never included in report.
      enteredValues: controls
        .filter(
          (element) =>
            element instanceof HTMLTextAreaElement ||
            (element instanceof HTMLInputElement && !["checkbox", "radio", "submit", "button", "reset", "hidden"].includes(element.type)),
        )
        .map((element) => element.value)
        .filter(Boolean),
      fields: controls
        .filter(visible)
        .slice(0, 100)
        .map((element) => ({
          type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
          label:
            [...(element.labels ?? [])].map((label) => label.innerText).join(" ") || element.getAttribute("aria-label") || "[unlabelled]",
          required: element.required,
          options: element instanceof HTMLSelectElement ? [...element.options].map((option) => option.text).slice(0, 100) : [],
        })),
      buttons: [...document.querySelectorAll("button,[role=button]")]
        .filter(visible)
        .slice(0, 60)
        .map((button) => button.textContent ?? ""),
    };
  });
  const clean = (text: string) => redactText(text, observation.enteredValues);
  return {
    url: summarizeUrl(frame.url()),
    title: clean(observation.title),
    text: clean(observation.text),
    fields: observation.fields.map((field) => ({ ...field, label: clean(field.label), options: field.options.map(clean) })),
    buttons: observation.buttons.map(clean),
  };
}

export async function captureStep(context: BrowserContext) {
  const pages = [];
  for (const page of context.pages().slice(0, 5)) {
    const frames = [];
    for (const frame of page.frames().slice(0, 15)) {
      try {
        frames.push(
          await Promise.race([
            observeFrame(frame),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() => reject(new Error("Frame timed out")), 5_000);
              timer.unref();
            }),
          ]),
        );
      } catch {
        frames.push({ url: summarizeUrl(frame.url()), error: "Frame unavailable (navigation, timeout, or closed page)" });
      }
    }
    pages.push({ frames });
  }
  return { capturedAt: new Date().toISOString(), pages };
}

export async function main(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.log(
      "Usage: node scripts/guided-funnel.ts <public-url> --allow-live\nManual local browser audit: Enter captures a step; q finishes. Max 20 steps / 15 minutes.\nNo automated clicks or submissions. Fresh Chrome profile. No API key.\nLive websites execute normal requests and tracking. Only visit trusted sites.\nInitial URL validation is not a network sandbox. Report redaction is best-effort; review before sharing.\nFree webinar only: do not accept paid upsells, purchase, join groups, or send messages.",
    );
    return;
  }
  await resolvePublicUrl(parsed.url);
  console.log(
    "LIVE BROWSER: normal website requests/tracking are enabled. Interact manually; no automatic submissions.\nFree webinar only: decline paid offers; no checkout, purchases, group joins, or messages.\nPress Enter in this terminal to record each step; q finishes. Reports may contain page text: review before sharing.",
  );
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const abort = new AbortController();
  browser.on("disconnected", () => abort.abort());
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const stop = () => {
    abort.abort();
    void browser.close();
  };
  const timer = setTimeout(stop, SESSION_MS);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const steps: unknown[] = [];
  const network = new Map<string, { method: string; url: ReturnType<typeof summarizeUrl>; resource: string; count: number }>();
  let requestsOmitted = 0;
  let output = "";
  try {
    const root = resolve("data/guided-audits");
    await mkdir(root, { recursive: true, mode: 0o700 });
    output = await mkdtemp(`${root}/session-`);
    const context = await browser.newContext({ acceptDownloads: false });
    context.on("request", (request) => {
      const summary = { method: request.method(), url: summarizeUrl(request.url()), resource: request.resourceType() };
      const key = JSON.stringify(summary);
      const existing = network.get(key);
      if (existing) existing.count++;
      else if (network.size < 500) network.set(key, { ...summary, count: 1 });
      else requestsOmitted++;
    });
    context.on("page", (page) => page.on("dialog", (dialog) => void dialog.dismiss()));
    const page = await context.newPage();
    await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {
      console.log("Initial navigation did not finish. Inspect the browser; continue manually if appropriate.");
    });
    while (!abort.signal.aborted && steps.length < MAX_STEPS && browser.isConnected()) {
      const answer = await terminal.question(`Step ${steps.length + 1}/${MAX_STEPS}: Enter to capture, q to finish > `, {
        signal: abort.signal,
      });
      if (answer.trim().toLowerCase() === "q") break;
      if (answer.trim()) {
        console.log("Use Enter or q; terminal text is never executed.");
        continue;
      }
      steps.push(await captureStep(context));
      console.log(`Captured step ${steps.length}.`);
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    terminal.close();
    await browser.close();
    if (output) {
      const file = `${output}/report.json`;
      await writeFile(
        file,
        JSON.stringify(
          {
            mode: "manual-local-audit",
            completedAt: new Date().toISOString(),
            limitations: [
              "No automated journey completion or purchase blocking",
              "Initial public URL check only; not a browser network sandbox",
              "Best-effort redaction; manually review before sharing",
              "Maximum 5 tabs, 15 frames per tab, bounded text and 500 distinct request summaries",
              "No request/response bodies, headers, cookies, screenshots, or input values saved",
            ],
            steps,
            network: [...network.values()],
            requestsOmitted,
          },
          null,
          2,
        ),
        { mode: 0o600, flag: "wx" },
      );
      console.log(`Saved ${steps.length} steps to ${file}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Guided audit failed. Check Chrome installation, public URL, and local write access. No raw error details logged.");
    process.exitCode = 1;
  });
}
