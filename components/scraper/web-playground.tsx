"use client";

import { useState, useTransition } from "react";
import { runWebTool } from "@/app/(dashboard)/scraper/actions";

export function WebPlayground() {
  const [pending, start] = useTransition();
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const field = "rounded-8 border border-border-faint bg-background p-3 text-body-medium";
  return (
    <section className="space-y-5 rounded-16 border border-border-faint bg-card p-5 sm:p-6">
      <p className="text-body-small text-muted-foreground">
        Direct website reads with no scraping credits or model key. Crawls follow same-origin links up to two levels deep. JavaScript-only
        pages may return limited content; search providers may rate-limit requests.
      </p>
      <p className="text-body-small text-muted-foreground">
        Funnel audit accepts up to 10 canonical URLs (one per line). It collects copy, forms, CTAs, embeds and script clues without
        submitting forms or executing scripts. Declared tracking code does not prove an event fired. Login-gated social content is not
        unlocked.
      </p>
      <p className="text-body-small text-muted-foreground">
        Adaptive read returns structured public GitHub repository info and RSS/Atom entries, or reads normal webpages directly. Agent Reach
        Reader sends your public URL to Jina Reader, an external service with its own limits. Use canonical URLs without query parameters.
        No login cookies are sent. Every scrape reports its provider and retrieval time. Browser mode requires local Chrome and blocks
        submissions, fetch/XHR, media and images; it reports partial coverage, not full journey replay.
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
        action={(data) => {
          setOutput("");
          setError("");
          start(async () => {
            try {
              const response = await runWebTool(String(data.get("mode")), String(data.get("input")), Number(data.get("limit")));
              if (!response.ok) setError(response.error);
              else setOutput(JSON.stringify(response.value, null, 2));
            } catch {
              setError("The request could not complete. Try a smaller crawl or retry.");
            }
          });
        }}
      >
        <label className="text-body-small">
          Operation
          <select name="mode" disabled={pending} className={`${field} ml-3`}>
            <option value="scrape">Scrape page</option>
            <option value="audit">Funnel evidence audit (multiple URLs)</option>
            <option value="browser">Rendered page + frames (isolated browser)</option>
            <option value="discussion">Forum discussion (Hacker News)</option>
            <option value="adaptive">Adaptive read (web / GitHub / feeds)</option>
            <option value="reader">Agent Reach Reader (external Jina)</option>
            <option value="map">Map website</option>
            <option value="crawl">Crawl website</option>
            <option value="search">Search web</option>
          </select>
        </label>
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
        <label className="text-body-small">
          Page / search / comment limit
          <input name="limit" type="number" min={1} max={25} defaultValue={5} disabled={pending} className={`${field} ml-3 w-24`} />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-8 bg-signal-blue px-5 py-3 text-label-medium text-white disabled:opacity-60"
        >
          {pending ? "Reading the web…" : "Run"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-crimson-ink">
          {error}
        </p>
      )}
      {output && (
        <div className="space-y-3">
          <p role="status" className="text-body-small">
            Response ready. Partial crawls list errors and remaining discovered URLs.
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
