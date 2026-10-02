import { Suspense } from "react";
import { CommandPalette } from "@/components/search/command-palette";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { isLanding, isPublicDemo, viewer } from "@/lib/access";
import { dashboardPassword } from "@/lib/dashboard-auth";
import { visibleNav } from "@/lib/nav";

// The prerendered shell shows the visitor list in demo mode and the full list otherwise; the
// viewer's list streams in behind Suspense and only ever adds the admin sections an authed
// request is owed. The palette offers the same list the sidebar shows. With LANDING=1 the brand
// links back to the landing page at `/`, the one way out of the dashboard to the product's front.
const FALLBACK_HREFS = visibleNav({ demo: isPublicDemo(), admin: false }).map((n) => n.href);
const HOME = isLanding() ? "/" : undefined;
const REQUESTS_ENABLED = process.env.COMPANY_REQUESTS === "1";

async function ViewerShell() {
  const v = await viewer();
  const hrefs = visibleNav(v).map((n) => n.href);
  // Sign in only exists when there is an admin tier to sign in to: a password-less demo has none.
  const signIn = v.demo && !v.admin && dashboardPassword() !== null;
  return (
    <>
      <Sidebar hrefs={hrefs} signIn={signIn} home={HOME} />
      <MobileNav hrefs={hrefs} signIn={signIn} home={HOME} />
      <CommandPalette hrefs={hrefs} requestsEnabled={REQUESTS_ENABLED} />
    </>
  );
}

/** Column below `lg` (top bar over the page), row at `lg` and up (rail beside the page). Both shells render; CSS picks one. */
export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row lg:items-start">
      {/* The first stop for a keyboard: past the rail's dozen links to the page itself. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-8 focus:bg-background focus:px-3 focus:py-2 focus:text-label-small focus:outline-none focus:ring-2 focus:ring-ring/50"
      >
        Skip to content
      </a>
      <Suspense
        fallback={
          <>
            <Sidebar hrefs={FALLBACK_HREFS} home={HOME} />
            <MobileNav hrefs={FALLBACK_HREFS} home={HOME} />
            <CommandPalette hrefs={FALLBACK_HREFS} requestsEnabled={REQUESTS_ENABLED} />
          </>
        }
      >
        <ViewerShell />
      </Suspense>
      <main id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none lg:min-h-dvh">
        {children}
      </main>
    </div>
  );
}
