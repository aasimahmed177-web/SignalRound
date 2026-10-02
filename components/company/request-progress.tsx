"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { Panel } from "@/components/ui/stat";
import { type PublicRequestStatus, requestFinished, requestSteps } from "@/lib/company-request-status";
import { viewRequest } from "@/lib/company-request-storage";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/**
 * A requested company's page before its research is done: the steps as the workflow records them,
 * polled from the status API. When the request finishes the page refreshes once and the server
 * renders the company in place, at the same address.
 */
export function RequestProgress({ initial }: { initial: PublicRequestStatus }) {
  const router = useRouter();
  const [request, setRequest] = useState(initial);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const finished = requestFinished(request.status);

  useEffect(() => {
    if (finished) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    let mounted = true;
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/company-requests/${encodeURIComponent(request.id)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Status unavailable");
        const updated = (await response.json()) as PublicRequestStatus;
        if (!mounted) return;
        setUnavailable(false);
        setRequest(updated);
        if (updated.status === "done") router.refresh();
      } catch {
        if (mounted) setUnavailable(true);
      }
    }, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [finished, request.id, router]);

  const stopped = request.status === "refused" || request.status === "failed";
  // A refused or failed request's result counts as seen once this page shows it; a done one is seen on the company page.
  useEffect(() => {
    if (request.status === "refused" || request.status === "failed") viewRequest((r) => r.id === request.id, request.status);
  }, [request.status, request.id]);
  // The branding read is display only: it is dropped the moment the identity check refuses the site.
  const brand = stopped ? null : request.brand;

  return (
    <Panel title={stopped ? "Research stopped" : "Research status"}>
      <div className="space-y-5 text-body-small">
        {brand && (
          <div className="flex items-center gap-3 border-b border-border-faint pb-4">
            <CompanyLogo
              id={request.id}
              kind="request"
              name={brand.name ?? request.domain}
              domain={request.domain}
              logoUrl={brand.logo}
              size={40}
            />
            <div className="min-w-0">
              <p className="truncate text-label-medium">{brand.name ?? request.domain}</p>
              <p className="truncate text-muted-foreground">{request.domain}</p>
            </div>
          </div>
        )}
        {stopped ? (
          <div className="space-y-2">
            <p>{request.message ?? "Research could not verify this company."}</p>
            <p className="text-muted-foreground">
              Check the website address and{" "}
              <Link href="/companies" className="text-foreground underline underline-offset-4">
                try again
              </Link>
              , or{" "}
              <Link href={`/feed?${new URLSearchParams({ q: request.domain })}`} className="text-foreground underline underline-offset-4">
                search the feed
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <ol className="space-y-3">
              {requestSteps(request).map((step) => (
                <li key={step.key} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center" aria-hidden>
                    {step.state === "done" ? (
                      <Check className="size-4 text-foreground" />
                    ) : step.state === "current" ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Circle className="size-3 text-black-alpha-24 dark:text-white/20" />
                    )}
                  </span>
                  <span className={cn(step.state === "pending" && "text-muted-foreground")}>
                    {step.label}
                    {step.hint && <span className="text-muted-foreground">, {step.hint}</span>}
                    <span className="sr-only">
                      {step.state === "done" ? " (done)" : step.state === "current" ? " (in progress)" : " (not started)"}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="space-y-1 border-t border-border-faint pt-4 text-muted-foreground">
              {now !== null && (
                <p className="text-mono-small" aria-live="off">
                  Running for {elapsed(now - Date.parse(request.createdAt))}
                </p>
              )}
              <p>You don't need to stay on this page. Research keeps running, and this page will show the results when it's done.</p>
              {unavailable && <p role="status">Status is unavailable. Trying again.</p>}
            </div>
          </>
        )}
        <Link href="/companies" className="inline-block text-foreground underline underline-offset-4">
          Back to companies
        </Link>
      </div>
    </Panel>
  );
}
