"use client";

import { useState } from "react";
import { initialOf, type LogoKind, logoSrc } from "@/lib/logo";
import { cn } from "@/lib/utils";

interface CompanyLogoProps {
  name: string;
  /** The company's id, which the logo route looks it up by. Without one the tile is looked up by `domain` alone. */
  id?: string;
  /** Whose id it is; an investor tile passes "investor". */
  kind?: Exclude<LogoKind, "host">;
  domain?: string | null;
  /** The logo the enrichment step stored; only its presence matters here, the route fetches it. */
  logoUrl?: string | null;
  /** Pixel size of the tile; 20 in rows, 32 in detail. */
  size?: number;
  /** The monogram's letters when no image shows; the name's first letter unless set. */
  mark?: string;
  className?: string;
}

/** The tile's frame: a hairline, the corner, and the themed ground a transparent monogram shows through. */
const TILE =
  "inline-flex shrink-0 select-none items-center justify-center rounded-6 border border-border-faint bg-black-alpha-4 dark:bg-white/6";

/**
 * A company's (or an investor's, or a publisher's) square tile, always drawn by this instance's
 * /api/logo route (lib/logo.ts): same origin, cached, with the blank-logo and wordmark checks done
 * once on the server. The reader's browser never contacts a company's site or a favicon service,
 * so a page no longer logs a CORS error per logo. With no domain and no stored logo there is nothing
 * to fetch, and the monogram draws here; a tile that fails to load falls back to it too.
 */
export function CompanyLogo({ name, id, kind = "company", domain, logoUrl, size = 20, mark, className }: CompanyLogoProps) {
  const src = domain || logoUrl ? (id ? logoSrc(kind, id) : domain ? logoSrc("host", domain) : null) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const box = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) };

  if (!src || failed === src) {
    const letters = mark ?? initialOf(name);
    // Two letters share the width one had, so they step down a size to stay inside the tile.
    const monogram = letters.length > 1 ? { ...box, fontSize: Math.max(8, Math.round(size * 0.4)) } : box;
    return (
      <span
        aria-hidden
        style={monogram}
        className={cn(
          TILE,
          "font-mono font-medium text-black-alpha-48 dark:text-muted-foreground",
          letters.length > 1 && "tracking-tighter",
          className,
        )}
      >
        {letters}
      </span>
    );
  }
  // A logo tile is a white square (logos are drawn for a light ground); in dark mode it dims a little so it does not glare.
  return (
    <img
      key={src}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
      style={box}
      className={cn(TILE, "overflow-hidden object-cover dark:brightness-[0.88]", className)}
    />
  );
}
