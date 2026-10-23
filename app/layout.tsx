import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ProductAnalytics } from "@/components/product-analytics";
import { Toaster } from "@/components/ui/sonner";
import { feedAlternateTypes } from "@/lib/feed-discovery";
import { siteOrigin } from "@/lib/origin";
import "./globals.css";

// Inter stands in for Suisse (licensed) per the NativeWebClient brand reference; Geist Mono for numbers and labels.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
// The Latin subset, not the `geist` package's full variable file. Its fallbacks stay monospace, as the
// package had them: the default adjusted fallback is metric-matched Arial, which would unalign figures.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
  adjustFontFallback: false,
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
});

export const metadata: Metadata = {
  // Social images and canonical tags resolve against the origin the sitemap names; APP_ORIGIN is what webhooks and Slack links use too.
  metadataBase: new URL(siteOrigin()),
  title: { default: "SignalRound", template: "%s · SignalRound" },
  description:
    "Funding intelligence from open-web and social signals, researched into structured, deduped, verified records with a dashboard, API, and MCP server.",
  applicationName: "SignalRound",
  alternates: { types: feedAlternateTypes() },
  openGraph: {
    title: "SignalRound",
    description:
      "Funding announcements and public startup contacts collected from public feeds and first-party websites without scraping credits.",
    type: "website",
    siteName: "SignalRound",
  },
  twitter: { card: "summary_large_image", title: "SignalRound", description: "Evidence-first funding intelligence, built on FireRound." },
};

/**
 * Vercel Web Analytics and Speed Insights, cookieless, only on a Vercel production build. Their
 * scripts live at /_vercel/* and exist only there: elsewhere a self-hosted clone would 404 on
 * every page, and `next dev` would fetch a debug script from Vercel's CDN.
 */
const VERCEL_INSIGHTS = process.env.VERCEL === "1" && process.env.NODE_ENV === "production";

/** PostHog product analytics, only with NEXT_PUBLIC_POSTHOG_KEY set (lib/analytics.ts); a clone without it loads none of it. */
const PRODUCT_ANALYTICS = Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <NuqsAdapter>{children}</NuqsAdapter>
          <Toaster />
        </ThemeProvider>
        {VERCEL_INSIGHTS && (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        )}
        {PRODUCT_ANALYTICS && <ProductAnalytics />}
      </body>
    </html>
  );
}
