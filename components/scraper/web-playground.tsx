"use client";

import { useState, useTransition } from "react";
import { runWebTool } from "@/app/(dashboard)/scraper/actions";
import { summarizeWebResult, type WebResultSummary } from "@/lib/web-result-summary";

const operationHelp: Record<string, string> = {
  scrape: "Read public page text and links directly. JavaScript-only pages may need browser mode.",
  extract:
    "Extract matching text with a CSS selector using local Scrapling. Requires the optional Python parser. The page is fetched directly; no model or external reader receives it.",
  audit:
    "Enter up to 10 URLs, one per line. Collect copy, forms, CTAs and script clues without executing scripts or submitting forms. Tracking code does not prove an event fired.",
  browser:
    "Requires local Chrome. Reads rendered pages and frames; blocks submissions, fetch/XHR, media and images. Expect partial coverage, not a full journey replay.",
  discussion:
    "Read a public Hacker News thread or GitHub issue / PR conversation. PR reviews and inline review comments are excluded. Posts are unverified statements.",
  adaptive: "Read public GitHub repository metadata, RSS/Atom feeds or webpage text. This does not unlock login-gated content.",
  reader:
    "External opt-in: running this sends your public URL to Jina Reader, which has its own limits. Use a canonical URL without query parameters. No login cookies are sent.",
  map: "Discover website links within the requested limit. Review partial results and errors in the response.",
  crawl: "Read same-origin pages up to two levels deep. Results may be partial when the limit is reached or pages fail.",
  search:
    "Sends your query to the configured external search provider. Providers may block or rate-limit requests; empty results do not prove there are no matches.",
};

export function WebPlayground() {
  const [pending, start] = useTransition();
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState("scrape");
  const [summary, setSummary] = useState<WebResultSummary | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [allowExternalSharing, setAllowExternalSharing] = useState(false);
  const needsSharingConsent = mode === "reader" || mode === "search";
  const field = "rounded-8 border border-border-faint bg-background p-3 text-body-medium";
  return (
    <section className="space-y-5 rounded-16 border border-border-faint bg-card p-5 sm:p-6">
      <p className="text-body-small text-muted-foreground">
        Read public websites without Firecrawl credits or a model key. Choose an operation to see its scope and limits.
      </p>
      <details className="rounded-8 border border-border-faint p-3 text-body-small">
        <summary className="cursor-pointer">Need to walk through a registration or questionnaire?</summary>
        <p className="mt-3 text-muted-foreground">
          Use the local guided browser from the repository terminal (Node 24+ and Chrome required). Replace the example URL with your
          approved target. This is manual interaction, not automatic journey replay.
        </p>
        <pre className="my-3 overflow-auto rounded-8 bg-background p-3">pnpm audit:guided https://example.com --allow-live</pre>
        <p className="text-muted-foreground">
          Interact in Chrome; press Enter in the terminal after each step to capture it, then q to save. Reports are saved in
          data/guided-audits. Live submissions and tracking are enabled: only perform authorized actions. Paid offers are not automatically
          blocked. Review reports before sharing. The dashboard browser operation remains read-only.
        </p>
      </details>
      <form
        className="flex flex-col gap-3"
        onReset={(event) => event.preventDefault()}
        action={(data) => {
          setOutput("");
          setError("");
          setSummary(null);
          setElapsed(null);
          const started = performance.now();
          start(async () => {
            try {
              const response = await runWebTool(
                String(data.get("mode")),
                String(data.get("input")),
                Number(data.get("limit")),
                data.get("allowExternalSharing") === "on",
                String(data.get("selector") ?? ""),
              );
              if (!response.ok) setError(response.error);
              else {
                setOutput(JSON.stringify(response.value, null, 2));
                setSummary(summarizeWebResult(response.value));
              }
            } catch {
              setError("The request could not complete. Try a smaller crawl or retry.");
            } finally {
              setElapsed((performance.now() - started) / 1000);
              setAllowExternalSharing(false);
            }
          });
        }}
      >
        <label className="flex min-w-0 flex-col gap-2 text-body-small sm:flex-row sm:items-center">
          Operation
          <select
            name="mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setAllowExternalSharing(false);
            }}
            aria-describedby="operation-help"
            disabled={pending}
            className={`${field} min-w-0 max-w-full sm:ml-3`}
          >
            <option value="scrape">Scrape page</option>
            <option value="extract">Extract selected text (local Scrapling)</option>
            <option value="audit">Funnel evidence audit (multiple URLs)</option>
            <option value="browser">Rendered page + frames (isolated browser)</option>
            <option value="discussion">Discussion (Hacker News / GitHub)</option>
            <option value="adaptive">Adaptive read (web / GitHub / feeds)</option>
            <option value="reader">Agent Reach Reader (external Jina)</option>
            <option value="map">Map website</option>
            <option value="crawl">Crawl website</option>
            <option value="search">Search web</option>
          </select>
        </label>
        <p id="operation-help" className="text-body-small text-muted-foreground">
          {operationHelp[mode]}
        </p>
        {needsSharingConsent && (
          <label className="flex items-start gap-2 text-body-small">
            <input
              type="checkbox"
              name="allowExternalSharing"
              required
              checked={allowExternalSharing}
              disabled={pending}
              onChange={(event) => setAllowExternalSharing(event.target.checked)}
            />
            {mode === "reader"
              ? "I approve sending this public URL to Jina Reader for this run."
              : "I approve sending this query to the configured external search provider for this run."}
          </label>
        )}
        <label className="text-body-small" htmlFor="web-input">
          Website URL or search query
        </label>
        <textarea
          id="web-input"
          name="input"
          rows={3}
          required
          maxLength={2000}
          placeholder="https://example.com"
          disabled={pending}
          className={field}
        />
        {mode === "extract" && (
          <label className="flex flex-col gap-2 text-body-small">
            CSS selector
            <input name="selector" required maxLength={500} placeholder="article h2, .company-name" disabled={pending} className={field} />
          </label>
        )}
        <label className="text-body-small">
          Page / search / comment limit
          <input name="limit" type="number" min={1} max={25} defaultValue={5} disabled={pending} className={`${field} ml-3 w-24`} />
        </label>
        <button
          type="submit"
          disabled={pending || (needsSharingConsent && !allowExternalSharing)}
          className="self-start rounded-8 bg-signal-blue px-5 py-3 text-label-medium text-white disabled:opacity-60"
        >
          {pending ? "Reading the web…" : "Run"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-crimson-ink">
          {error}
          {elapsed !== null && ` (${elapsed.toFixed(1)}s)`}
        </p>
      )}
      {output && (
        <div className="space-y-3">
          <p role="status" className="text-body-small">
            {summary?.status === "failed" ? "Failed" : summary?.status === "partial" ? "Partial result" : "Completed"}
            {summary?.count !== undefined && ` · ${summary.count} ${summary.unit}`}
            {summary?.provider && ` · ${summary.provider}`}
            {elapsed !== null && ` · ${elapsed.toFixed(1)}s`}
            <span className="mt-1 block text-muted-foreground">{summary?.detail}</span>
          </p>
          <button
            type="button"
            className="rounded-8 border px-3 py-2"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([output], { type: "application/json" }));
              const link = document.createElement("a");
              link.href = url;
              link.download = "signalround-web-result.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download JSON
          </button>
          <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded-8 bg-background p-4 text-sm">{output}</pre>
        </div>
      )}
    </section>
  );
}
