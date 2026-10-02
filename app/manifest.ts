import type { MetadataRoute } from "next";

/**
 * The web app manifest: the name and the flame a phone shows when the feed is added to its home
 * screen. Paper as the ground, Heat as the theme, as the favicon draws them.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fireround",
    short_name: "Fireround",
    description: "Startup funding, pre-seed to growth, checked at the source. An open-source feed built on Firecrawl.",
    start_url: "/feed",
    display: "standalone",
    background_color: "#f9f9f9",
    theme_color: "#fa5d19",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
