import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

/**
 * The landing page's frame: its own top bar and foot, no dashboard sidebar. The root layout still
 * supplies the fonts, the theme, and the toaster, so the product a click away looks the same.
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-8 focus:bg-background focus:px-3 focus:py-2 focus:text-label-small focus:outline-none focus:ring-2 focus:ring-ring/50"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
