"use client";

import type { CompanyRequestBrand, CompanyRequestStatus } from "@fireround/core/db/schema";
import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/stat";
import { dismissRequest, markFinished, markViewed, pruneRequests, requestLine, type StoredRequest } from "@/lib/company-request-history";
import type { PublicRequestStatus } from "@/lib/company-request-status";
import { loadRequests, saveRequests } from "@/lib/company-request-storage";

const POLL_MS = 5000;

type Live = { status: CompanyRequestStatus; companyUrl: string; brand: CompanyRequestBrand | null };

/** The company id a finished request's address names. */
function companyIdOf(url: string): string {
  return decodeURIComponent(url.slice("/companies/".length));
}

/** This browser's company requests, each with its logo, its live status, and a link to its company page. Hidden when there are none. */
export function YourRequests() {
  const [list, setList] = useState<StoredRequest[]>([]);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [now, setNow] = useState(0);

  useEffect(() => {
    const at = Date.now();
    const kept = pruneRequests(loadRequests(), at);
    saveRequests(kept);
    setList(kept);
    setNow(at);
  }, []);

  const openKey = list
    .filter((r) => r.finishedAt === undefined)
    .map((r) => r.id)
    .join(",");

  useEffect(() => {
    if (!openKey) return;
    let mounted = true;
    async function check() {
      const results = await Promise.all(
        openKey.split(",").map(async (id) => {
          try {
            const response = await fetch(`/api/company-requests/${encodeURIComponent(id)}`, { cache: "no-store" });
            if (response.status === 404) return { id, request: null };
            if (!response.ok) return undefined;
            return { id, request: (await response.json()) as PublicRequestStatus };
          } catch {
            return undefined;
          }
        }),
      );
      if (!mounted) return;
      const at = Date.now();
      setNow(at);
      setLive((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r?.request) next[r.id] = { status: r.request.status, companyUrl: r.request.companyUrl, brand: r.request.brand };
        }
        return next;
      });
      let stored = loadRequests();
      for (const r of results) {
        if (!r) continue;
        if (!r.request) stored = dismissRequest(stored, r.id);
        else if (r.request.status === "done" || r.request.status === "refused" || r.request.status === "failed") {
          stored = markFinished(stored, r.id, r.request.status, at);
        }
      }
      saveRequests(stored);
      setList(stored);
    }
    void check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [openKey]);

  if (list.length === 0) return null;

  return (
    <Panel title="Your requests" flush>
      <ul className="divide-y divide-border-faint text-body-small">
        {list.map((r) => {
          const known = live[r.id];
          const href = known?.companyUrl ?? `/companies/${encodeURIComponent(r.domain)}`;
          const state = known?.status ?? r.outcome ?? null;
          const line = requestLine(state, r.submittedAt, now || r.submittedAt);
          // A done company's tile is the company's own; a running one shows the early branding read; a refused one only its letter.
          const logo =
            state === "done" ? (
              <CompanyLogo id={companyIdOf(href)} name={known?.brand?.name ?? r.domain} domain={r.domain} size={20} />
            ) : state === "refused" || state === "failed" ? (
              <CompanyLogo name={r.domain} size={20} />
            ) : (
              <CompanyLogo id={r.id} kind="request" name={known?.brand?.name ?? r.domain} logoUrl={known?.brand?.logo} size={20} />
            );
          return (
            <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
              <Link href={href} className="flex min-w-0 items-center gap-2.5 text-label-medium hover:underline">
                {logo}
                <span className="truncate">{r.domain}</span>
              </Link>
              <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                <span>
                  {line}
                  {state === "done" && (
                    <>
                      {" · "}
                      <Link
                        href={href}
                        onClick={() => saveRequests(markViewed(loadRequests(), (s) => s.id === r.id, "done", Date.now()))}
                        className="text-foreground underline underline-offset-4"
                      >
                        View
                      </Link>
                    </>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Dismiss ${r.domain}`}
                  onClick={() => {
                    const next = dismissRequest(loadRequests(), r.id);
                    saveRequests(next);
                    setList(next);
                  }}
                >
                  <X />
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
