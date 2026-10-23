/** Conservative, explicit host list, not a general-purpose tracker detector. */
const advertisingHosts = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "trc.taboola.com",
  "ads-twitter.com",
];
const analyticsHosts = ["google-analytics.com", "googletagmanager.com", "clarity.ms", "static.hotjar.com"];
const formHosts = ["tally.so"];

export type BrowserAssetClass = "form-app" | "document" | "app-asset" | "advertising" | "analytics" | "media" | "decorative" | "other";

function matches(host: string, domains: string[]) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function classifyBrowserAsset(raw: string, type: string): BrowserAssetClass {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "other";
  }
  if (matches(host, advertisingHosts)) return "advertising";
  if (matches(host, analyticsHosts)) return "analytics";
  if (["document", "script", "stylesheet"].includes(type) && matches(host, formHosts)) return "form-app";
  if (type === "document") return "document";
  if (["script", "stylesheet"].includes(type)) return "app-asset";
  if (type === "media") return "media";
  if (["image", "font"].includes(type)) return "decorative";
  return "other";
}
