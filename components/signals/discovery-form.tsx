"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useState, useTransition } from "react";
import { discoverSignals } from "@/app/(dashboard)/signals/actions";

export function DiscoveryForm() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ message: string; warnings: string[]; error?: boolean } | null>(null);
  return (
    <section className="rounded-16 border border-signal-blue/20 bg-card p-5 sm:p-6" aria-labelledby="discovery-heading">
      <div className="mb-4 flex items-start gap-3">
        <Search className="mt-1 size-5 text-signal-blue" />
        <div>
          <h2 id="discovery-heading" className="text-title-h5">
            Find startups
          </h2>
          <p className="mt-1 text-body-small text-muted-foreground">
            Search funding news or read a company website. Public business emails include the page where they were found.
          </p>
        </div>
      </div>
      <form
        action={(data) => {
          setResult(null);
          start(async () => {
            const response = await discoverSignals(String(data.get("query") ?? ""));
            if (!response.ok) setResult({ message: response.error, warnings: [], error: true });
            else
              setResult({
                message: `${response.value.stored} observation${response.value.stored === 1 ? "" : "s"} saved · ${response.value.contacts} public email${response.value.contacts === 1 ? "" : "s"} found`,
                warnings: response.value.warnings,
              });
          });
        }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <label className="sr-only" htmlFor="discovery-query">
          Startup search or website
        </label>
        <input
          id="discovery-query"
          name="query"
          maxLength={240}
          disabled={pending}
          placeholder="AI startups seed funding, or https://company.com"
          className="min-w-0 flex-1 rounded-8 border border-border-faint bg-background px-3 py-3 text-body-medium outline-none focus-visible:ring-2 focus-visible:ring-signal-blue disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-8 bg-signal-blue px-5 py-3 text-label-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
        >
          {pending && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />}
          {pending ? "Reading sources…" : "Search live"}
        </button>
      </form>
      <p className="mt-3 text-body-small text-muted-foreground">
        Leave blank for recent funding feeds. Up to 5 results. No scraping credits, no generated contacts, no emails sent. A search can take
        a few minutes.
      </p>
      {result && (
        <div role={result.error ? "alert" : "status"} className="mt-4 border-t border-border-faint pt-4 text-body-small">
          <p className={result.error ? "text-crimson-ink" : "text-foreground"}>{result.message}</p>
          {!!result.warnings.length && (
            <details className="mt-2 text-muted-foreground">
              <summary>Source notes ({result.warnings.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {[...new Set(result.warnings)].map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {!result.error && (
            <p className="mt-2 text-muted-foreground">
              These are observations, not verified funding records. Emails are publicly listed, not deliverability-tested.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
