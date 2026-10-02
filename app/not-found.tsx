import Link from "next/link";
import { FlameMark } from "@/components/brand/flame-mark";
import NotFound from "./(dashboard)/not-found";

/**
 * An unmatched URL outside every route (`/does-not-exist`) lands here rather than in the dashboard
 * group's own not-found, so it wears the house brand and body instead of Next's bare black page.
 *
 * Deliberately not the dashboard shell: this boundary is part of every page's payload, the landing
 * page's included, and every client component it names is preloaded there. Wrapped in the
 * dashboard layout, it shipped the sidebar, the phone menu, and the command palette to every visitor.
 */
export default function RootNotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border-faint">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center px-4 lg:px-8">
          <Link
            href="/"
            aria-label="Fireround home"
            className="flex items-center gap-2.5 rounded-8 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FlameMark size="lg" live className="-ml-1 size-8" />
            <span className="text-label-medium">Fireround</span>
          </Link>
        </div>
      </header>
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        <NotFound />
      </main>
    </div>
  );
}
