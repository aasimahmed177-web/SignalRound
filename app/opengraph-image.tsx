import { ImageResponse } from "next/og";
import { FLAME_INNER_PATH, FLAME_INNER_TRANSFORM, FLAME_OUTER_TRANSFORM, FLAME_REST_PATH } from "@/components/brand/flame-geometry";
import { words } from "@/lib/og";

export const alt = "Fireround: the open-source funding feed, built on Firecrawl";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The card a shared link unfurls into: the brand block, the landing page's headline, one line on what it is, and the address. */
export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#0a0a0a",
        color: "#fafafa",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <svg width="56" height="56" viewBox="0 0 600 600">
          <g transform={FLAME_OUTER_TRANSFORM}>
            <path d={FLAME_REST_PATH} fill="#fa5d19" />
          </g>
          <g transform={FLAME_INNER_TRANSFORM}>
            <path d={FLAME_INNER_PATH} fill="#0a0a0a" />
          </g>
        </svg>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }}>Fireround</div>
          <div style={{ fontSize: 18, color: "#a3a3a3", fontFamily: "ui-monospace, Menlo, monospace", letterSpacing: 1 }}>FUNDING FEED</div>
        </div>
      </div>
      {/* The landing page's headline, so a shared link reads the way the page it opens does. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 68, fontWeight: 600, lineHeight: 1.05, letterSpacing: -2 }}>
          <div>{words("Who just raised,")}</div>
          <div style={{ color: "#fa5d19" }}>{words("checked at the source.")}</div>
        </div>
        <div style={{ fontSize: 26, color: "#a3a3a3", lineHeight: 1.4, maxWidth: 980 }}>
          {words("Pre-seed to growth, each round linked to the pages that reported it.", { wrap: true })}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 18, color: "#737373", fontFamily: "ui-monospace, Menlo, monospace", letterSpacing: 1 }}>
          [ BUILT ON FIRECRAWL ]
        </div>
        <div style={{ fontSize: 22, color: "#a3a3a3", fontFamily: "ui-monospace, Menlo, monospace" }}>fireround.dev</div>
      </div>
    </div>,
    size,
  );
}
