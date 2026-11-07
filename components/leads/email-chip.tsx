import { ArrowUpRight, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A posted email as a mailto chip. Hover or focus shows the line it was printed in and the page it came from, so
 * every address can be checked against its source before anyone writes to it.
 */
export function EmailChip({
  email,
  sourceUrl,
  quote,
  label,
  className,
}: {
  email: string;
  sourceUrl: string | null;
  quote: string | null;
  /** A short tag before the address, e.g. "careers". */
  label?: string | null;
  className?: string;
}) {
  return (
    <span className={cn("group/email relative inline-flex max-w-full items-center", className)}>
      <a
        href={`mailto:${email}`}
        title={quote ? `“${quote}”${sourceUrl ? ` (${hostOf(sourceUrl)})` : ""}` : undefined}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-signal-blue/10 px-2.5 py-1 text-label-small text-signal-blue transition-colors hover:bg-signal-blue/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
      >
        <Mail className="size-3.5 shrink-0" />
        {label && <span className="shrink-0 text-mono-x-small uppercase tracking-[0.08em] opacity-70">{label}</span>}
        <span className="truncate">{email}</span>
      </a>
      {(quote || sourceUrl) && (
        <span className="absolute top-full left-0 z-30 hidden w-80 max-w-[calc(100vw-2rem)] pt-1.5 group-focus-within/email:block group-hover/email:block">
          <span className="block rounded-12 border border-border-faint bg-popover p-3 text-popover-foreground shadow-lg">
            {quote && <span className="block text-body-small leading-relaxed text-black-alpha-72 dark:text-white/72">“{quote}”</span>}
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex max-w-full items-center gap-1 text-label-small text-signal-blue underline-offset-4 hover:underline"
              >
                <span className="truncate">Printed on {hostOf(sourceUrl)}</span>
                <ArrowUpRight className="size-3.5 shrink-0" />
              </a>
            )}
          </span>
        </span>
      )}
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Where ${email} is printed`}
          className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 text-mono-x-small text-black-alpha-48 sm:hidden"
        >
          source <ArrowUpRight className="size-3" />
        </a>
      )}
    </span>
  );
}

/** The source link shown beside a chip on touch screens, where nothing hovers. */
export function SourceLink({ url, children }: { url: string; children?: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-label-small text-black-alpha-56 underline-offset-4 hover:text-foreground hover:underline"
    >
      <span className="truncate">{children ?? hostOf(url)}</span>
      <ArrowUpRight className="size-3.5 shrink-0" />
    </a>
  );
}

export { hostOf };
