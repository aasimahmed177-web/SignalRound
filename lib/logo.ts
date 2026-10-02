// How a logo reaches a page: always through this instance's /api/logo route, never a company's own
// host or a third-party favicon service from the reader's browser. The route draws a same-origin PNG
// tile with the monogram as its fallback, and the CDN caches it. Pure, so the client tile, the route,
// and the tests share one reading.

export type LogoKind = "company" | "investor" | "host" | "request";

/** Words a firm's name carries that say nothing about which firm it is. */
const ARTICLES = new Set(["the", "a", "an"]);

/**
 * Up to two initials for an investor's monogram: "Insight Partners" is IP, "Y Combinator" YC, and a
 * one-word firm keeps its single letter. Two letters are how a firm or a person is usually
 * abbreviated, so the tile reads as an investor beside a company's one-letter tile.
 */
export function investorInitials(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, " ")
    .split(/[\s\-_/&.,]+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const kept = words.length > 1 && ARTICLES.has(words[0].toLowerCase()) ? words.slice(1) : words;
  const letters = kept
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  return letters || name.trim().charAt(0).toUpperCase() || "?";
}

/** A company's or a host's monogram: its first letter. */
export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/**
 * The tile's address. A company or investor is looked up by id; a host (a publisher on /news) by its
 * domain alone. `ui` asks for the page's variant: a transparent monogram the page's own themed tile
 * shows through, where Slack gets an opaque one.
 */
export function logoSrc(kind: LogoKind, id: string): string {
  const path = `/api/logo/${encodeURIComponent(id)}`;
  return kind === "company" ? `${path}?ui=1` : `${path}?kind=${kind}&ui=1`;
}

/** An SVG's width over its height, from the viewBox or the root's width and height; null when it says neither. */
export function svgAspect(svg: string): number | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  const [w, h] = box
    ? [Number(box[1]), Number(box[2])]
    : [Number(/\bwidth\s*=\s*["']?([\d.]+)/i.exec(root)?.[1]), Number(/\bheight\s*=\s*["']?([\d.]+)/i.exec(root)?.[1])];
  return w > 0 && h > 0 ? w / h : null;
}

const WHITE = /^(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*[\d.]+\s*)?\))$/i;

/**
 * Whether an SVG draws only in white: a logo for a dark header (Ultraviolette stores
 * `uv-full-white-logo.svg`), invisible on the light tile. Every colour it names is white, and it
 * names at least one; an SVG that names none paints in black by default and shows.
 */
export function svgLeavesNoMark(svg: string): boolean {
  const colors = [...svg.matchAll(/\b(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(rgba?\([^)]*\)|[^"';)\s>]+)/gi)]
    .map((m) => m[1].trim())
    .filter((c) => !/^(?:none|transparent|currentcolor|inherit|url\()/i.test(c));
  return colors.length > 0 && colors.every((c) => WHITE.test(c));
}

/** Past this, a stored logo is a wordmark, which a square tile would squash; the monogram reads better. */
export const MAX_ASPECT = 1.8;
