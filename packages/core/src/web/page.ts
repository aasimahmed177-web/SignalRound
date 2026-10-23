import { load } from "cheerio";
import type { Document } from "./types.ts";

export function httpUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Preserve source links and publication metadata separately from the readable body. */
export function parseHtmlPage(html: string, url: string, mainContent = true): Document {
  const $ = load(html);
  const metadata: NonNullable<Document["metadata"]> = { sourceURL: url, url, title: $("title").first().text().trim(), statusCode: 200 };
  $("meta[name],meta[property]").each((_, element) => {
    const key = $(element).attr("property") ?? $(element).attr("name");
    const value = $(element).attr("content");
    if (key && value) metadata[key] = value;
  });
  metadata.description = String(metadata.description ?? metadata["og:description"] ?? "");
  metadata.ogSiteName = String(metadata["og:site_name"] ?? "");
  metadata.ogTitle = metadata["og:title"];
  metadata.publishedTime = metadata["article:published_time"];
  metadata.modifiedTime = metadata["article:modified_time"];
  const faviconHref = $("link[rel~='icon']").first().attr("href");
  const favicon = faviconHref ? httpUrl(faviconHref, url) : null;
  if (favicon) metadata.favicon = favicon;
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const link = httpUrl($(element).attr("href") ?? "", url);
    if (link) links.add(link);
  });
  const logoRaw = $("header img[alt*='logo' i],img[class*='logo' i],img[alt*='logo' i]").first().attr("src");
  const logo = logoRaw ? httpUrl(logoRaw, url) : null;
  const branding = {
    brandName: metadata.ogSiteName || undefined,
    logo: logo ?? undefined,
    images: { logo: logo ?? undefined },
    colors: { primary: typeof metadata["theme-color"] === "string" ? metadata["theme-color"] : undefined },
  };
  $("script,style,noscript,template,svg,iframe").remove();
  if (mainContent) $("nav,footer,aside,[role='navigation']").remove();
  const preferred = mainContent ? $("article,main,[role='main']").first() : $("body");
  const root = preferred.length && preferred.text().trim().length > 150 ? preferred : $("body");
  root.find("a[href]").each((_, element) => {
    const text = $(element).text().trim();
    const href = httpUrl($(element).attr("href") ?? "", url);
    if (text && href) {
      $(element).text(`[${text}](${href})`);
      $(element).replaceWith($(element).contents());
    }
  });
  // Text nodes are inserted as text, so markup in source text can never become executable markup.
  root.find("h1,h2,h3,h4,h5,h6").each((_, element) => {
    const heading = $(element);
    heading.prepend(`\n\n${"#".repeat(Number(element.tagName.slice(1)))} `).append("\n\n");
  });
  root.find("p,div,section,article,main,li,tr,blockquote,pre").each((_, element) => {
    $(element).prepend("\n").append("\n");
  });
  root.find("br").replaceWith("\n");
  const markdown = root
    .text()
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, html, links: [...links], metadata, branding };
}
