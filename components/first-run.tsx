"use client";

import { ArrowUpRight, Flame } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { startSweep } from "@/app/(dashboard)/presets/actions";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

/**
 * What an empty store shows instead of zeros: what a sweep does, what it costs, and one button that runs
 * the first one. The page refreshes itself while the sweep runs so the first rows appear without a reload.
 */
export function FirstRun({
  hasKey,
  presetSlug,
  presetName,
  estimate,
  readOnly = false,
}: {
  hasKey: boolean;
  presetSlug: string;
  presetName: string;
  estimate: string;
  /** A demo visitor: the sweep button stays admin-only, so the action column leaves. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [started, router]);
  return (
    <section className="rounded-12 border border-border-faint bg-card">
      <div className="flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
        <div className="min-w-0 max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
            <span className="grid size-6 place-items-center rounded-6 bg-heat-100 text-white">
              <Flame className="size-3.5" strokeWidth={2.25} />
            </span>
            [ FIRST RUN ]
          </div>
          <h2 className="text-title-h5">Nothing here yet. A sweep fills it.</h2>
          <p className="mt-2 text-body-medium text-muted-foreground">
            One sweep searches the web for the last week of {presetName} rounds, reads matching articles directly, extracts each round with
            its evidence, checks it against its sources, and lands it here with a logo and a description. About ten minutes, {estimate}.
            After that the schedule keeps it fresh (Vercel Cron on Vercel; elsewhere <code className="text-mono-small">pnpm start</code>{" "}
            with <code className="text-mono-small">CRON_SECRET</code> set), and Presets lets you widen or narrow the net.
          </p>
          {!hasKey && (
            <p className="mt-3 text-body-small text-crimson-ink">
              Structured funding verification needs a configured model. You can discover real startups and public contact emails now in{" "}
              <Link href="/signals" className="underline">
                Signals
              </Link>
              , without a model or scraping credits.
            </p>
          )}
        </div>
        <div className={cn("flex shrink-0 flex-col items-start gap-3 lg:items-end", readOnly && "hidden")}>
          {started ? (
            <>
              <Tag tone="heat">SWEEP RUNNING</Tag>
              <p className="text-body-small text-muted-foreground lg:text-right">
                Rows appear here as they land; this page refreshes on its own.{" "}
                <Link href="/runs" className="underline">
                  Watch the run
                </Link>
                .
              </p>
            </>
          ) : (
            <>
              <Button
                disabled={!hasKey || pending}
                onClick={() =>
                  start(async () => {
                    const r = await startSweep(presetSlug, "week");
                    if (r.ok) setStarted(r.value.runId);
                    else setError(r.error);
                  })
                }
              >
                {pending ? "Starting" : "Run the first sweep"}
              </Button>
              {error && <p className="text-body-small text-crimson-ink lg:text-right">{error}</p>}
              <Link href="/presets" className="inline-flex items-center gap-1 text-body-small text-muted-foreground hover:text-foreground">
                Or pick a preset first <ArrowUpRight className="size-3.5" />
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
