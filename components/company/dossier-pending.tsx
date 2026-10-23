"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PublicRequestStatus } from "@/lib/company-request-status";
import { dossierPending } from "@/lib/company-request-status";

const POLL_MS = 10_000;

/**
 * On a finished request's company page while its Deep dive still runs: one quiet line, gone once the
 * dossier lands, when the page refreshes once to pick up what it added.
 */
export function DossierPending({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(true);

  useEffect(() => {
    if (!pending) return;
    let mounted = true;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/company-requests/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!response.ok) return;
        const request = (await response.json()) as PublicRequestStatus;
        if (!mounted || dossierPending(request)) return;
        setPending(false);
        router.refresh();
      } catch {}
    }, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [id, pending, router]);

  if (!pending) return null;
  return (
    <p className="text-body-small text-muted-foreground" role="status">
      Still researching: a company dossier from native web tools's Agent may add earlier rounds and founders. Usually a few more minutes.
    </p>
  );
}
