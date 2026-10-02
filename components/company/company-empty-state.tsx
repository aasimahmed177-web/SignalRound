import Link from "next/link";
import { Button } from "@/components/ui/button";

export function CompanyEmptyState({ q }: { q: string }) {
  return (
    <div className="rounded-12 border border-dashed border-border-muted p-12 text-center text-body-small text-muted-foreground">
      {q ? (
        <p>
          No company matches "{q}".{" "}
          <Link href="/companies" className="text-foreground underline underline-offset-4">
            Show every company
          </Link>{" "}
          or{" "}
          <Link href={`/feed?${new URLSearchParams({ q })}`} className="text-foreground underline underline-offset-4">
            search the feed
          </Link>
          .
        </p>
      ) : (
        <p>No companies yet. A company shows here once one of its rounds publishes to the feed.</p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {!q && (
          <Button asChild variant="outline" size="sm">
            <Link href="/feed">Open the feed</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
