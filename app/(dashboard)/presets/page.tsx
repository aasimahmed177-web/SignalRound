import { Plus } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { PresetCard } from "@/components/presets/preset-card";
import { PresetDialog } from "@/components/presets/preset-form";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonLine } from "@/components/ui/skeletons";
import { db } from "@/lib/db";
import { isCustomPreset, listPresets } from "@/lib/presets";
import { listMonitors } from "@/lib/settings";
import { estimateSweep } from "./actions";

async function PresetsBody() {
  await connection();
  const handle = await db();
  const [presets, monitors] = await Promise.all([listPresets(handle), listMonitors(handle)]);
  const [estimates, custom] = await Promise.all([
    Promise.all(presets.map((p) => estimateSweep(p.slug))),
    Promise.all(presets.map((p) => isCustomPreset(p.slug))),
  ]);
  return (
    <PageBody width="narrow">
      {presets.map((p, i) => (
        <PresetCard
          key={p.slug}
          preset={p}
          estimate={estimates[i]}
          monitor={monitors.find((m) => m.preset_slug === p.slug) ?? null}
          custom={custom[i]}
        />
      ))}
      <p className="text-body-small text-black-alpha-56 dark:text-muted-foreground">
        A preset is a JSON file in <code className="rounded-4 bg-muted px-1.5 py-0.5 font-mono">presets/</code> or one created here: queries
        control recall, the goal controls what the monitor alerts on, stages control what the feed keeps, xAccounts are timelines the sweep
        reads. Add a file or a custom preset to add a signal; on a shared slug the file wins.
      </p>
    </PageBody>
  );
}

/** n mono lines for a query or site list, at varied widths so they read as text. */
function MonoLines({ n }: { n: number }) {
  const widths = ["w-56", "w-48", "w-64", "w-52", "w-44", "w-60", "w-40"];
  return widths.slice(0, n).map((w) => <SkeletonLine key={w} text="text-mono-small" width={w} />);
}

/**
 * One preset card while it loads: the header (name, description, stages, the run estimate), the
 * recall and precision columns, and the action footer, at the real card's paddings.
 */
function PresetCardSkeleton() {
  return (
    <div className="rounded-12 border border-border-faint bg-card" aria-hidden>
      <div className="flex flex-col gap-4 border-b border-border-faint px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <SkeletonLine text="text-title-h6" width="w-40" />
          <SkeletonLine width="w-3/4" className="mt-1" />
          <div className="mt-2 flex gap-1.5">
            <Skeleton className="h-5.5 w-16 rounded-full" />
            <Skeleton className="h-5.5 w-18 rounded-full" />
            <Skeleton className="h-5.5 w-18 rounded-full" />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start sm:items-end">
          <SkeletonLine text="text-mono-x-small" width="w-24" />
          <SkeletonLine text="text-title-h6" width="w-44" className="mt-0.5" />
          <SkeletonLine text="text-label-x-small" width="w-24" className="mt-1" />
        </div>
      </div>
      <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="space-y-1">
            <SkeletonLine text="text-mono-x-small" width="w-28" className="mb-1.5" />
            <MonoLines n={7} />
          </div>
          <div className="space-y-1">
            <SkeletonLine text="text-mono-x-small" width="w-36" className="mb-1.5" />
            <MonoLines n={2} />
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <SkeletonLine text="text-mono-x-small" width="w-28" className="mb-1.5" />
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-4/5" />
            <SkeletonLine text="text-label-x-small" width="w-64" className="mt-2" />
          </div>
          <div className="space-y-1">
            <SkeletonLine text="text-mono-x-small" width="w-36" className="mb-1.5" />
            <MonoLines n={6} />
          </div>
        </div>
      </div>
      <div className="flex gap-2 rounded-b-12 border-t border-border-faint bg-bg-lighter px-5 py-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-36 bg-black-alpha-4" />
        <Skeleton className="hidden h-8 w-56 bg-black-alpha-4 sm:block" />
      </div>
    </div>
  );
}

export const metadata = { title: "Presets" };

export default function PresetsPage() {
  return (
    <>
      <PageHeader
        section={3}
        actions={
          <PresetDialog
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" /> New preset
              </Button>
            }
          />
        }
      />
      <Suspense
        fallback={
          <PageBody width="narrow">
            <PresetCardSkeleton />
            <PresetCardSkeleton />
          </PageBody>
        }
      >
        <PresetsBody />
      </Suspense>
    </>
  );
}
