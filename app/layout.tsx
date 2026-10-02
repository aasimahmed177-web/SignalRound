import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "@/components/ui/sonner";
import { siteOrigin } from "@/lib/origin";
import "./globals.css";

// Inter stands in for Suisse (licensed) per the Firecrawl brand reference; Geist Mono for numbers and labels.
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
  title: { default: "Fireround", template: "%s · Fireround" },
  description:
    "Funding announcements from across the open web, pre-seed to growth, extracted with Firecrawl into structured, deduped, verified records: a dashboard, a feed, an API, and an MCP server.",
  applicationName: "Fireround",
  openGraph: {
    title: "Fireround",
    description:
      "Funding announcements from across the open web, pre-seed to growth, extracted with Firecrawl into structured, deduped, verified records.",
    type: "website",
    siteName: "Fireround",
  },
  twitter: { card: "summary_large_image", title: "Fireround", description: "The open-source funding feed, built on Firecrawl." },
};

/**
 * Vercel Web Analytics and Speed Insights, cookieless, only on a Vercel production build. Their
 * scripts live at /_vercel/* and exist only there: elsewhere a self-hosted clone would 404 on
 * every page, and `next dev` would fetch a debug script from Vercel's CDN.
 */
const VERCEL_INSIGHTS = process.env.VERCEL === "1" && process.env.NODE_ENV === "production";

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
      </body>
    </html>
  );
}
