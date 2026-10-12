"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { missingPage } from "@/lib/not-found";

/**
 * The 404 card both not-found boundaries share. It reads the address the reader typed, so a missing
 * company says so and offers a company search started with the words from the link; any other miss
 * searches the rounds. A plain GET form: it works before hydration and needs no state.
 */
export function NotFoundBody() {
  const page = missingPage(usePathname());
  return (
    <section className="rounded-12 border border-border-faint bg-card p-8 sm:p-10">
      <div className="text-mono-x-small text-black-alpha-32">[ 404 ]</div>
      <h1 className="mt-3 text-title-h4">{page.title}</h1>
      <p className="mt-2 max-w-prose text-body-medium text-muted-foreground">{page.body}</p>
      <form action={page.searchAction} method="get" role="search" className="mt-6 flex max-w-md items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{page.searchLabel}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            name="q"
            type="search"
            defaultValue={page.prefill}
            placeholder={page.searchLabel}
            className="h-10 w-full rounded-8 border border-border-muted bg-background pr-3 pl-9 text-body-medium outline-none placeholder:text-muted-foreground focus-visible:border-heat-100 focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </label>
        <Button type="submit" variant="outline" className="h-10">
          Search
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/feed">Open the feed</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/overview">Overview</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/docs">API reference</Link>
        </Button>
      </div>
    </section>
  );
}
