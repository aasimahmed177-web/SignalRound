"use client";

import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { FLAME_INNER_PATH, FLAME_INNER_TRANSFORM, FLAME_OUTER_TRANSFORM, FLAME_REST_PATH, FLAME_VIEW_BOX } from "./flame-geometry";

// The lit Firecrawl flame: the marketing site's 15-frame SMIL morph of the outline, which is what makes
// it look lit rather than an icon with a pulse on it. The resting path ships with this module so a mark
// always draws a correct flame; the frames load on their own chunk and the mark starts moving when they
// land. Geometry and frames are extracted from the served site header, never redrawn (flame-geometry.ts).

export type FlameSize = "sm" | "md" | "lg" | "inherit";

const SIZE_CLASS: Record<FlameSize, string> = {
  sm: "size-3.5",
  md: "size-5",
  lg: "size-9",
  inherit: "",
};

type FlameMorph = typeof import("./flame-morph");

// One in-flight import for the whole app, however many marks mount at once.
let morphChunk: Promise<FlameMorph> | null = null;
function loadMorph(): Promise<FlameMorph> {
  morphChunk ??= import("./flame-morph");
  return morphChunk;
}

/**
 * The morph frames once their chunk has landed, or null until then. Null forever under
 * prefers-reduced-motion: SMIL is invisible to CSS, so the <animate> must not render at all.
 */
function useFlameMorph(enabled: boolean): FlameMorph | null {
  const [morph, setMorph] = useState<FlameMorph | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let mounted = true;
    void loadMorph().then((chunk) => {
      if (mounted) setMorph(chunk);
    });
    return () => {
      mounted = false;
    };
  }, [enabled]);
  return morph;
}

/** The flame mark, still by default; `live` runs the morph. Decorative: the accessible name belongs to what wraps it. */
export function FlameMark({ size = "md", live = false, className }: { size?: FlameSize; live?: boolean; className?: string }): ReactNode {
  // useId carries colons, legal in a fragment reference but not worth the risk inside url().
  const maskId = `flame-mask-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const morph = useFlameMorph(live);
  return (
    <svg viewBox={FLAME_VIEW_BOX} className={cn("block shrink-0", SIZE_CLASS[size], className)} aria-hidden="true" focusable="false">
      {/* One heat-filled rect seen through a mask: the outline keeps, the inner notch punches out, so the
          mark carries no ground of its own and reads the same on the card, in dark mode, or in a button. */}
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="600" height="600">
        <g transform={FLAME_OUTER_TRANSFORM}>
          <path d={FLAME_REST_PATH} fill="#ffffff" fillRule="nonzero">
            {morph ? (
              <animate
                attributeName="d"
                begin="0s"
                dur={morph.FLAME_TIMING.dur}
                calcMode={morph.FLAME_TIMING.calcMode}
                keyTimes={morph.FLAME_TIMING.keyTimes}
                keySplines={morph.FLAME_TIMING.keySplines}
                values={morph.FLAME_VALUES}
                repeatCount="indefinite"
                fill="freeze"
              />
            ) : null}
          </path>
        </g>
        <g transform={FLAME_INNER_TRANSFORM}>
          <path d={FLAME_INNER_PATH} fill="#000000" fillRule="nonzero" />
        </g>
      </mask>
      {/* Heat in both themes: the flame is never recolored. */}
      <rect x="0" y="0" width="600" height="600" className="fill-heat-100" mask={`url(#${maskId})`} />
    </svg>
  );
}
