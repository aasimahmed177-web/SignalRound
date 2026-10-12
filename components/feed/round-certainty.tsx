import type { FeedRecord } from "@fireround/core";
import { classifyRoundCertainty } from "@fireround/core/client";
import { hostLabel } from "@/lib/format";

type CertaintyRow = {
  certainty?: FeedRecord["certainty"] | null;
  sources: Array<{ host: string; url: string; title?: string | null }>;
};

export function certaintyLabel(r: CertaintyRow): string | null {
  switch (r.certainty) {
    case "reported":
      return "Reported";
    case "expected":
      return "Expected";
    case "unconfirmed":
      return "Unconfirmed";
    default:
      return null;
  }
}

export function RoundCertainty({ r, className }: { r: CertaintyRow; className?: string }) {
  const label = certaintyLabel(r);
  return label ? <span className={className ?? "text-label-x-small font-normal text-muted-foreground"}>{label}</span> : null;
}

export function RoundCertaintyDetail({ r }: { r: CertaintyRow }) {
  const label = certaintyLabel(r);
  if (!label) return null;
  const source =
    r.sources.find((source) => source.title && classifyRoundCertainty(source.title) === r.certainty) ??
    (r.sources.length === 1 ? r.sources[0] : null);
  return (
    <p className="text-body-small text-muted-foreground">
      {label}
      {source && (
        <>
          {r.certainty === "reported" ? " by " : " according to "}
          <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
            {hostLabel(source.host)}
          </a>
        </>
      )}
      ; not announced.
    </p>
  );
}
