"use client";

import Link from "next/link";
import { useEffect } from "react";
import { PageBody } from "@/components/shell/page-body";
import { Button } from "@/components/ui/button";

/**
 * A segment that threw, in the house shape: the shell stays, the body says so plainly and offers the
 * retry. Never the error's own text: in production a Server Component's message is Next's
 * boilerplate, and a client one can be anything. The digest is the reference that matches the
 * server log (instrumentation.ts), kept small for a bug report.
 */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // A client-side throw never reaches the server log; the console is where a developer looks for it.
    console.error(error);
  }, [error]);
  return (
    <PageBody width="narrow">
      <section className="rounded-12 border border-border-faint bg-card p-8 sm:p-10">
        <div className="text-mono-x-small text-black-alpha-32">[ ERROR ]</div>
        <h1 className="mt-3 text-title-h4">This page didn't load.</h1>
        <p className="mt-2 max-w-prose text-body-medium text-muted-foreground">
          Something went wrong while reading the data behind it. It is usually brief, so try again in a moment.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => retry()}>Try again</Button>
          <Button asChild variant="outline">
            <Link href="/feed">Open the feed</Link>
          </Button>
        </div>
        {error.digest && <p className="mt-6 text-mono-x-small text-black-alpha-32">Reference {error.digest}</p>}
      </section>
    </PageBody>
  );
}
