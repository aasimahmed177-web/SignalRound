"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page's server components every 15s while a run is in flight, so a RUNNING row
 * finishes on its own. `running` counts only rows inside their lane's time budget: a STALLED row
 * is not expected to finish, and polling for it would refresh the page forever.
 */
export function AutoRefresh({ running }: { running: number }) {
  const router = useRouter();
  useEffect(() => {
    if (running === 0) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
