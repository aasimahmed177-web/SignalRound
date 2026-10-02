import { ChevronRight } from "lucide-react";
import { VerifiedMark } from "@/components/confidence";
import { XLogo } from "@/components/x-logo";
import { type BuiltWithStep, builtWithSteps } from "@/lib/built-with";
import type { FeedRow } from "@/lib/persist";

const STEP_LABEL: Record<string, string> = {
  search: "SEARCH",
  scrape: "SCRAPE",
  json: "JSON",
  verify: "VERIFY",
  branding: "BRANDING",
  alexandria: "ALEXANDRIA",
  agent: "AGENT",
};

/** The step's bracket word; the X step wears X's logomark, which a screen reader still reads as "X". */
function StepLabel({ step }: { step: BuiltWithStep["key"] }) {
  return step === "x" ? <XLogo className="size-[0.9em]" /> : STEP_LABEL[step];
}

/** The verify step wears the same mark and status word the table cell does. */
function VerifyMark({ r }: { r: FeedRow }) {
  const status = r.verification?.status;
  const verified = status === "confirmed" || status === "corrected";
  return (
    <span className="flex items-center gap-1">
      <VerifiedMark verification={r.verification} sources={r.sources.length} count={false} />
      {verified && <span>{status === "corrected" ? "corrected" : "confirmed"}</span>}
    </span>
  );
}

/**
 * The trace behind a native disclosure, one step per line. The feed's expanded row already carries
 * the company, investors, verdict, and sources; the trace answers "how", which few readers ask, so
 * it waits closed rather than adding another row of mono to the detail.
 */
function Disclosure({ r, steps }: { r: FeedRow; steps: BuiltWithStep[] }) {
  return (
    <details className="group">
      <summary className="-mx-1 flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-4 px-1 text-label-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        How this record was built
        <span className="text-mono-x-small normal-case text-muted-foreground">{steps.length} steps</span>
      </summary>
      <ol className="mt-2 grid gap-x-4 gap-y-1 pl-5 text-body-small sm:grid-cols-[auto_1fr]">
        {steps.map((s) => (
          <li key={s.key} className="contents">
            <span className="text-mono-x-small leading-5 text-muted-foreground">
              <StepLabel step={s.key} />
            </span>
            <span className="mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground sm:mb-0">
              {s.key === "verify" && <VerifyMark r={r} />}
              <span className="min-w-0 break-words text-foreground/80">{s.fact}</span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * The pipeline a row passed through: how it was found, what was read, the schema it landed in, the
 * read-back, and the homepage's logo and colour. By default one strip of `[ STEP ] fact` tokens;
 * `disclosure` folds the same steps behind a closed "How this record was built" toggle.
 */
export function BuiltWith({
  r,
  dossier = false,
  disclosure = false,
  xPeople = 0,
}: {
  r: FeedRow;
  dossier?: boolean;
  disclosure?: boolean;
  /** People the Trending lane found posting about the round on X. */
  xPeople?: number;
}) {
  const steps = builtWithSteps(r, { dossier, xPeople });
  if (disclosure) return <Disclosure r={r} steps={steps} />;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">
      <span>[ BUILT WITH ]</span>
      {steps.map((s) => (
        // On a phone a step wraps as a unit: the bracketed label never splits, the fact wraps under it.
        <span key={s.key} className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5">
          <span className="text-black-alpha-24">·</span>
          <span className="whitespace-nowrap">
            [ <StepLabel step={s.key} /> ]
          </span>
          {s.key === "verify" && <VerifyMark r={r} />}
          <span className="min-w-0 break-words normal-case text-black-alpha-56">{s.fact}</span>
        </span>
      ))}
    </div>
  );
}
