import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { readPublicText } from "@fireround/core/web/transport";

const HTML_BYTES = 2_000_000;
const OUTPUT_BYTES = 650_000;
const WORKER_TIMEOUT_MS = 10_000;

/** Optional offline parser. Only Node's public, DNS-pinned transport reads the website. */
export async function extractWithScrapling(url: string, selector: string, limit = 10) {
  const python = process.env.SCRAPLING_PYTHON;
  if (!python || !isAbsolute(python)) {
    throw new Error("Configure SCRAPLING_PYTHON with an absolute virtualenv Python path to enable local CSS extraction.");
  }
  if (typeof selector !== "string" || !selector.trim() || selector.length > 500) {
    throw new Error("CSS selector must contain 1–500 characters.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Limit must be an integer from 1 to 25.");
  const page = await readPublicText(url, { maxBytes: HTML_BYTES, timeoutMs: 15_000 });
  if (page.status < 200 || page.status >= 300) throw new Error(`Website returned HTTP ${page.status}.`);
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(page.contentType)) {
    throw new Error("CSS extraction requires an HTML response.");
  }
  if (Buffer.byteLength(page.text) > HTML_BYTES) throw new Error("HTML exceeds the 2 MB extraction limit.");
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, ["-I", join(process.cwd(), "scripts", "scrapling-extract.py")], {
      shell: false,
      env: { LANG: "C.UTF-8", NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finished = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => finish(new Error("Local CSS extraction timed out.")), WORKER_TIMEOUT_MS);
    child.on("error", () => finish(new Error("Cannot start SCRAPLING_PYTHON; check the configured interpreter.")));
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > OUTPUT_BYTES) finish(new Error("Local CSS extraction exceeded its output limit."));
      else chunks.push(chunk);
    });
    // Drain diagnostics without leaking local paths, package internals, or site text into the UI.
    child.stderr.resume();
    child.stdin.on("error", () => finish(new Error("Local CSS extraction worker input failed.")));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("Local CSS extraction worker failed.")));
    child.stdin.end(JSON.stringify({ html: page.text, selector, limit }));
  });
  let result: { ok?: boolean; code?: string; items?: unknown; truncated?: unknown };
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error("Local CSS extraction returned invalid JSON.");
  }
  if (result?.ok !== true) {
    if (result?.code === "missing_package")
      throw new Error("Scrapling is not installed in SCRAPLING_PYTHON. Install scripts/requirements-scrapling.txt in that virtualenv.");
    if (result?.code === "invalid_selector") throw new Error("Scrapling could not parse this CSS selector.");
    throw new Error("Local CSS extraction failed.");
  }
  if (
    !Array.isArray(result.items) ||
    result.items.length > limit ||
    result.items.some((text) => typeof text !== "string" || text.length > 4000) ||
    typeof result.truncated !== "boolean"
  ) {
    throw new Error("Local CSS extraction returned an invalid result.");
  }
  return {
    provider: "scrapling-local" as const,
    url: page.url,
    status: page.status,
    fetchedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(page.text).digest("hex"),
    selector,
    items: result.items as string[],
    truncated: result.truncated,
  };
}
