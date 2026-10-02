import { SiteFooter } from "@/components/marketing/site-footer";
import { landingHome, SiteHeader } from "@/components/marketing/site-header";

/**
 * The public site pages (privacy, terms, support, and a digest's unsubscribe) wear the landing page's frame, so
 * a visitor arriving from a link lands on the product's public face, not the dashboard.
 * The header's section anchors point back at the landing page.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const home = landingHome();
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader anchorBase={home} />
      <main id="content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter anchorBase={home} />
    </div>
  );
}
