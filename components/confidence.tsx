import { Check, Circle, X } from "lucide-react";
import { roundCheck } from "@/lib/buzz";
import type { FeedRow } from "@/lib/persist";
import { readAgainst, sourcesRead } from "@/lib/source-count";
import { cn } from "@/lib/utils";

/** The score with its tone dot: forest at publish, honey when flagged, crimson in review. Detail views only; the tables show the check. */
export function Confidence({ value }: { value: number }) {
  const tone = value >= 0.75 ? "bg-accent-forest" : value >= 0.5 ? "bg-accent-honey" : "bg-accent-crimson";
  return (
    <span className="inline-flex items-center gap-1.5 text-mono-small">
      <span className={cn("size-1.5 rounded-full", tone)} aria-hidden />
      {value.toFixed(2)}
    </span>
  );
}

/**
 * What a reader can act on in a row: whether the record was read back against its sources, and against
 * how many. A forest check for confirmed or corrected, an open circle for not yet, a crimson cross for a
 * record the sources contradicted; the count is the sources on the row. The score stays in the detail.
 */
export function VerifiedMark({
  verification,
  sources,
  count = true,
}: {
  verification: FeedRow["verification"];
  sources: number;
  /** The glyph alone, with the words in the tooltip, where a count sits nearby already (the Built with trace). */
  count?: boolean;
}) {
  const status = verification?.status ?? "unverified";
  const verified = status === "confirmed" || status === "corrected";
  const contradicted = status === "contradicted" || status === "not_news";
  // The count is the sources listed; the verdict's reach says "1 of 2" when it read fewer (lib/source-count.ts).
  const seen = sources;
  const reach = readAgainst({ sources: Array.from({ length: sources }), verification }) ?? "";
  const title = verified
    ? count
      ? `${status === "corrected" ? "Verified and corrected" : "Verified"} against ${reach}`
      : `${status === "corrected" ? "Corrected against" : "Confirmed across"} ${reach}`
    : contradicted
      ? "The sources contradict this record"
      : count
        ? "Developing: still being confirmed"
        : "Developing";
  return (
    <span className="inline-flex items-center gap-1.5 text-mono-small" title={title}>
      {verified ? (
        <Check className="size-3.5 text-forest-ink" strokeWidth={2.5} aria-label="verified" />
      ) : contradicted ? (
        <X className="size-3.5 text-crimson-ink" strokeWidth={2.5} aria-label="contradicted" />
      ) : (
        <Circle className="size-3 text-black-alpha-32" strokeWidth={2} aria-label="developing" />
      )}
      {count && <span className={cn(!verified && "text-muted-foreground")}>{seen}</span>}
    </span>
  );
}

/**
 * A circle half filled: the flagged row's glyph, between the verified check and the open circle of
 * a row never read. Neutral ink, so a Developing row reads as a fact about the row, not a warning.
 */
export function HalfCircle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden>
      <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 1.25a4.75 4.75 0 0 0 0 9.5z" fill="currentColor" />
    </svg>
  );
}

/**
 * The Round cell's check, one quiet family: a glyph and the source count, muted, with what the glyph
 * means in the tooltip and for a screen reader. A forest check for verified, a half-filled circle
 * for a Developing row (flagged), an open circle for a row never read, a crimson
 * cross for a record its sources contradict (an admin's rows only). The verdict is in the open row.
 */
export function RoundCheckMark({
  r,
  compact = false,
  className,
}: {
  r: Pick<FeedRow, "verification" | "sources" | "disposition">;
  /** The glyph and the figure only, "✓ 6", for a phone's meta line; the noun stays for a screen reader. */
  compact?: boolean;
  className?: string;
}) {
  const c = roundCheck(r);
  const noun = c.sources === 1 ? "source" : "sources";
  // The screen reader hears the tooltip's reach: "Verified against 1 of 2 sources" when the verdict read fewer than the row lists.
  const read = c.kind === "verified" ? sourcesRead(r) : null;
  const count = (
    <>
      <span className="font-mono">{c.sources}</span> {compact ? <span className="sr-only">{noun}</span> : noun}
    </>
  );
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-label-x-small font-normal", className)}
      title={c.title}
    >
      {c.kind === "verified" ? (
        <Check className="size-3 text-forest-ink" strokeWidth={2.5} aria-hidden />
      ) : c.kind === "flagged" ? (
        <HalfCircle className="size-3 text-black-alpha-48" />
      ) : c.kind === "contradicted" ? (
        <X className="size-3 text-crimson-ink" strokeWidth={2.5} aria-hidden />
      ) : (
        <Circle className="size-3 text-black-alpha-48" strokeWidth={2} aria-hidden />
      )}
      <span className="text-muted-foreground">
        {c.kind === "verified" && (
          <span className="sr-only">Verified against {read !== null && read < c.sources ? `${read} of ` : ""}</span>
        )}
        {c.kind === "flagged" && <span className="sr-only">Developing, </span>}
        {c.kind === "unverified" && <span className="sr-only">Developing, </span>}
        {c.kind === "contradicted" ? "contradicted" : count}
      </span>
    </span>
  );
}
