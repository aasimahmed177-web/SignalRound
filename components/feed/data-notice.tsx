import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The honest line about the data: machine-extracted, sourced, fallible. A visitor to the public
 * demo has no Report button on a row, so `report` adds a link to the corrections process on
 * /support, which answers on this site whether or not GitHub does and carries the issues link and
 * the contact email. Muted and small, but on `muted-foreground`, so it still clears AA.
 */
export function DataNotice({ report = true, className }: { report?: boolean; className?: string }) {
  return (
    <p className={cn("text-body-small text-muted-foreground", className)}>
      Records are extracted automatically from public reporting and link to their sources. They can contain errors.
      {report && (
        <>
          {" "}
          <Link
            href="/support#corrections"
            className="tap relative inline-flex min-h-6 items-center rounded-4 whitespace-nowrap text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Report an error
          </Link>
        </>
      )}
    </p>
  );
}
