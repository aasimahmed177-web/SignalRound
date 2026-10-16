// The link-preview cards' shared parts: the house frame (the root card's Graphite ground, the lit
// flame beside the name, the native-collector line), the fonts, a logo fetch that can only
// ever fall back, and a render that never fails the request. A card is 1200x630 PNG.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement, ReactNode } from "react";
import { FLAME_INNER_PATH, FLAME_INNER_TRANSFORM, FLAME_OUTER_TRANSFORM, FLAME_REST_PATH } from "@/components/brand/flame-geometry";
import { isPublicDemo } from "@/lib/access";
import { MAX_ASPECT, svgAspect, svgLeavesNoMark } from "@/lib/logo";
import { pngLeavesNoMark } from "@/lib/png-ink";
import { safeFetch } from "@/lib/safe-fetch";

export const OG_SIZE = { width: 1200, height: 630 };

const PAD_X = 72;
const TILE = 112;
const HEADING_GAP = 32;
/** Satori only ellipsizes a box with a width, so the name column gets the card's width less the tile. */
const TEXT_WIDTH = OG_SIZE.width - 2 * PAD_X - TILE - HEADING_GAP;

/**
 * Satori's font engine (opentype.js) applies Geist's GPOS class kerning to pairs that include
 * U+0020, so a space after "e", "y" or "d" renders almost twice as wide as the rest. The no-break
 * space draws at the same width without the kerning. Text that wraps (`wrap`) also gets a
 * zero-width space after each, so it still breaks at words; single-line text does not, since
 * letter-spacing lands on every character and a second one would tighten a tracked heading's gaps.
 * Every string a card draws goes through this.
 */
export function words(text: string, { wrap = false }: { wrap?: boolean } = {}): string {
  return text.replace(/ +/g, wrap ? "\u00a0\u200b" : "\u00a0");
}

export const INK = {
  ground: "#0a0a0a",
  text: "#fafafa",
  muted: "#a3a3a3",
  faint: "#737373",
  hairline: "#262626",
  tile: "#171717",
  flame: "#fa5d19",
  forest: "#42c366",
} as const;

export const SANS = "Geist";
export const MONO = "Geist Mono";

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500 | 600; style: "normal" };

const FONT_FILES: Array<{ name: string; file: string; weight: Font["weight"] }> = [
  { name: SANS, file: "geist-sans/Geist-Regular.ttf", weight: 400 },
  { name: SANS, file: "geist-sans/Geist-SemiBold.ttf", weight: 600 },
  { name: MONO, file: "geist-mono/GeistMono-Regular.ttf", weight: 400 },
  { name: MONO, file: "geist-mono/GeistMono-Medium.ttf", weight: 500 },
];

let fonts: Promise<Font[]> | null = null;

/**
 * Geist and Geist Mono from the installed `geist` package, read once per process. A host that did
 * not ship the files gets an empty list, and next/og draws in its bundled sans instead.
 */
export function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async ({ name, file, weight }) => {
      const buf = await readFile(join(process.cwd(), "node_modules/geist/dist/fonts", file));
      return {
        name,
        weight,
        style: "normal" as const,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      };
    }),
  ).catch(() => []);
  return fonts;
}

const FAVICON_SERVICE = "https://www.google.com/s2/favicons";
const LOGO_TIMEOUT_MS = 1500;
const LOGO_MAX_BYTES = 512 * 1024;

type Sniffed = { mime: string; width: number | null; height: number | null };

/** The formats next/og rasterizes reliably, read from the bytes (a server's content-type lies often enough). */
function sniff(bytes: Uint8Array): Sniffed | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47)
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", width: null, height: null };
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head))
    return { mime: "image/svg+xml", width: null, height: null };
  return null; // ICO, WebP, AVIF, HTML error pages: the monogram draws instead
}

/**
 * One candidate: fetched with a short timeout, sniffed, sized, and returned as a data URI or null.
 * Never throws. A PNG or SVG that leaves no mark on white (all white, or empty) is refused, and
 * `square` also refuses a wide wordmark, which a square tile would squash to a sliver.
 */
async function fetchImage(url: string, minSide: number, { square = false }: { square?: boolean } = {}): Promise<string | null> {
  try {
    // A stored logo URL came off a third-party page: never a private address, at any hop (lib/safe-fetch.ts).
    const res = await safeFetch(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS), headers: { accept: "image/*" } });
    if (!res?.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > LOGO_MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;
    const kind = sniff(bytes);
    if (!kind) return null;
    if (kind.width !== null && kind.height !== null && Math.min(kind.width, kind.height) < minSide) return null;
    if (square && kind.width && kind.height && Math.max(kind.width / kind.height, kind.height / kind.width) > MAX_ASPECT) return null;
    // A white or empty file would draw a blank tile; the next candidate, or the monogram, reads better.
    if (kind.mime === "image/png" && pngLeavesNoMark(bytes) === true) return null;
    if (kind.mime === "image/svg+xml") {
      const text = new TextDecoder().decode(bytes);
      if (svgLeavesNoMark(text)) return null;
      const aspect = svgAspect(text);
      if (square && aspect !== null && Math.max(aspect, 1 / aspect) > MAX_ASPECT) return null;
    }
    return `data:${kind.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The logo for a card's square tile, or null for the monogram. The favicon service goes first when
 * there is a domain: it answers square at 128px, which is the tile's shape, where a stored logo is
 * as often a wide wordmark or a white variant for a dark header (Zeliq's is). The stored logo is
 * the fallback, minus files named for a dark ground. Both fetch at once under a short timeout, so a
 * slow host costs the card at most ~1.5s and never fails it. NEXT_PUBLIC_FAVICON_FALLBACK=off skips
 * the service here too.
 */
export async function loadLogo({ domain, logoUrl }: { domain?: string | null; logoUrl?: string | null }): Promise<string | null> {
  const service =
    domain && process.env.NEXT_PUBLIC_FAVICON_FALLBACK !== "off"
      ? fetchImage(`${FAVICON_SERVICE}?domain=${encodeURIComponent(domain)}&sz=128`, 32)
      : Promise.resolve(null);
  // A logo the branding read found drawn inline in the page (an inline SVG) is stored as a small data URI.
  const stored = /^data:image\//i.test(logoUrl ?? "")
    ? Promise.resolve(logoUrl ?? null)
    : logoUrl && /^https?:\/\//i.test(logoUrl) && !/white|negative|inverse/i.test(logoUrl)
      ? fetchImage(logoUrl, 24, { square: true })
      : Promise.resolve(null);
  const [a, b] = await Promise.all([service, stored]);
  return a ?? b;
}

/**
 * The logo on a light tile (logos are drawn for a light ground), or the monogram on the card's own tile.
 * `ui` is the page's variant (components/company-logo.tsx): the logo fills a square white ground the
 * page rounds and borders itself, and the monogram is a mid-grey letter on nothing, so the page's
 * themed tile shows through and it reads in light and dark alike.
 */
export function LogoTile({ src, mark, size = 112, ui = false }: { src: string | null; mark: string; size?: number; ui?: boolean }) {
  if (ui) {
    const pad = Math.round(size * 0.12);
    return src ? (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff" }}>
        <img src={src} alt="" width={size - 2 * pad} height={size - 2 * pad} style={{ objectFit: "contain" }} />
      </div>
    ) : (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#7c7c7c",
          fontFamily: MONO,
          fontWeight: 500,
          fontSize: Math.round(size * (mark.length > 1 ? 0.4 : 0.5)),
          letterSpacing: mark.length > 1 ? -3 : 0,
        }}
      >
        {mark}
      </div>
    );
  }
  if (src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: Math.round(size * 0.2),
          background: "#ffffff",
          padding: Math.round(size * 0.14),
          flexShrink: 0,
        }}
      >
        <img
          src={src}
          alt=""
          width={size - 2 * Math.round(size * 0.14)}
          height={size - 2 * Math.round(size * 0.14)}
          style={{ objectFit: "contain" }}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: Math.round(size * 0.2),
        background: INK.tile,
        border: `2px solid ${INK.hairline}`,
        color: INK.muted,
        fontFamily: MONO,
        fontWeight: 500,
        fontSize: Math.round(size * (mark.length > 1 ? 0.36 : 0.46)),
        letterSpacing: mark.length > 1 ? -2 : 0,
        flexShrink: 0,
      }}
    >
      {mark}
    </div>
  );
}

/** The lit flame, as the root card and the sidebar draw it: on its own, never boxed or recolored. */
export function Flame({ size }: { size: number }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: rasterized by next/og; there is no DOM to read a title
    <svg width={size} height={size} viewBox="0 0 600 600">
      <g transform={FLAME_OUTER_TRANSFORM}>
        <path d={FLAME_REST_PATH} fill={INK.flame} />
      </g>
      <g transform={FLAME_INNER_TRANSFORM}>
        <path d={FLAME_INNER_PATH} fill={INK.ground} />
      </g>
    </svg>
  );
}

/** Native collector mark used in link previews. */
function NativeCollectorMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ fontFamily: MONO, fontSize: 16, color: INK.faint, letterSpacing: 1 }}>{words("DIRECT WEB")}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Flame size={30} />
        <div style={{ fontFamily: SANS, fontSize: 21, color: INK.text, fontWeight: 600 }}>{words("SignalRound")}</div>
      </div>
    </div>
  );
}

/** A bracket tag in the house style: short uppercase mono, "[ COMPANY ]". */
export function Tag({ children }: { children: string }) {
  return <div style={{ fontFamily: MONO, fontSize: 18, color: INK.faint, letterSpacing: 1 }}>{words(`[ ${children} ]`)}</div>;
}

/** The frame every card shares: the brand block and a tag on top, the content, then the footer line and the lockup. */
export function CardFrame({ tag, children, footer }: { tag: string; children: ReactNode; footer?: { text: string; check?: boolean } }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: `56px ${PAD_X}px`,
        background: INK.ground,
        color: INK.text,
        fontFamily: SANS,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Flame size={44} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.5 }}>Fireround</div>
            <div style={{ fontSize: 14, color: INK.muted, fontFamily: MONO, letterSpacing: 1 }}>{words("FUNDING FEED")}</div>
          </div>
        </div>
        <Tag>{tag}</Tag>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 36 }}>{children}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${INK.hairline}`,
          paddingTop: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 22, color: INK.muted }}>
          {footer?.check && <Check />}
          {footer && <span>{words(footer.text)}</span>}
        </div>
        <NativeCollectorMark />
      </div>
    </div>
  );
}

/** A labelled figure: the uppercase mono label, the value, and a quiet line under it. */
export function Figure({ label, value, hint, grow = 1 }: { label: string; value: string; hint?: string | null; grow?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flexGrow: grow, flexBasis: 0, minWidth: 0 }}>
      <div style={{ fontFamily: MONO, fontSize: 16, color: INK.faint, letterSpacing: 1 }}>{words(label)}</div>
      <div
        style={{
          fontSize: value.length > 18 ? 28 : value.length > 14 ? 32 : 36,
          fontWeight: 600,
          letterSpacing: -0.8,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {words(value)}
      </div>
      {hint && (
        <div
          style={{ fontFamily: MONO, fontSize: 18, color: INK.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {words(hint)}
        </div>
      )}
    </div>
  );
}

/**
 * The heading block: the tile, the name (stepped down for a long one), and a line under it. `flame`
 * is the house company (lib/house.ts): the lit flame stands in the tile's place, on its own.
 */
export function Heading({
  logo,
  mark,
  name,
  line,
  flame = false,
}: {
  logo: string | null;
  mark: string;
  name: string;
  line?: string | null;
  flame?: boolean;
}) {
  const nameSize = name.length > 40 ? 38 : name.length > 30 ? 44 : name.length > 22 ? 54 : 64;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: HEADING_GAP }}>
      {flame ? (
        <div style={{ display: "flex", width: TILE, height: TILE, flexShrink: 0 }}>
          <Flame size={TILE} />
        </div>
      ) : (
        <LogoTile src={logo} mark={mark} size={TILE} />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: TEXT_WIDTH }}>
        <div
          style={{
            fontSize: nameSize,
            fontWeight: 600,
            letterSpacing: -1.5,
            lineHeight: 1.05,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {words(name)}
        </div>
        {line && (
          <div
            style={{
              display: "block",
              width: TEXT_WIDTH,
              fontSize: 26,
              color: INK.muted,
              lineHeight: 1.35,
              lineClamp: 2,
              overflow: "hidden",
            }}
          >
            {words(line, { wrap: true })}
          </div>
        )}
      </div>
    </div>
  );
}

/** The green check the dashboard wears on a verified round, drawn as a path. */
export function Check({ size = 22 }: { size?: number }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: rasterized by next/og; there is no DOM to read a title
    <svg
      width={size}
      height={size}
      style={{ marginRight: 12 }}
      viewBox="0 0 24 24"
      fill="none"
      stroke={INK.forest}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Where a card lands when the id is unknown or a render fails: the brand, one line, the lockup. */
export function GenericCard({ tag, headline, line }: { tag: string; headline: string; line: string }) {
  return (
    <CardFrame tag={tag}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ fontSize: 56, fontWeight: 600, lineHeight: 1.1, letterSpacing: -1.5, maxWidth: 1000 }}>{words(headline)}</div>
        <div style={{ fontSize: 26, color: INK.muted, lineHeight: 1.4, maxWidth: 1000 }}>{words(line, { wrap: true })}</div>
      </div>
    </CardFrame>
  );
}

/**
 * How long a rendered card may be reused. On a public demo a card is the same for everyone, and
 * each one costs a database read, a logo fetch, and a Satori render, which unfurlers and social
 * crawlers ask for again and again: the CDN keeps it an hour and serves it stale for a day while it
 * redraws. A private instance keeps next/og's default, so no shared cache ever holds its cards.
 */
export function cardCacheControl(publicDemo: boolean = isPublicDemo()): string | null {
  return publicDemo ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" : null;
}

/**
 * Renders the first element that rasterizes, buffered, so a logo next/og cannot decode drops to the
 * next attempt (the monogram, then the generic card) instead of failing the response mid-stream.
 */
export async function renderCard(attempts: Array<() => ReactElement>): Promise<Response> {
  const loaded = await loadFonts();
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = new ImageResponse(attempt(), { ...OG_SIZE, fonts: loaded.length ? loaded : undefined });
      const body = await res.arrayBuffer();
      if (body.byteLength === 0) continue;
      const headers = new Headers(res.headers);
      const cacheControl = cardCacheControl();
      if (cacheControl) headers.set("cache-control", cacheControl);
      return new Response(body, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      console.warn("[og] card render failed, trying the next fallback:", message);
    }
  }
  return new Response(process.env.NODE_ENV === "development" ? errors.join("\n") : null, {
    status: 500,
    headers: { "cache-control": "no-store" },
  });
}
