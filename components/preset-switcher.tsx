"use client";

import { parseAsString, useQueryState } from "nuqs";
import { PRESET_PARAM } from "@/lib/preset-param";
import type { PresetOption } from "@/lib/presets";
import { cn } from "@/lib/utils";

export { PRESET_PARAM };
export const presetParser = parseAsString.withDefault("");

/**
 * A row of chips over the presets: All, then each preset by name, in the feed's chip vocabulary
 * (h-8 pills, ink fill when active). State is the `preset` URL param (empty means all), written
 * without a shallow update so the server re-renders.
 */
export function PresetSwitcher({ presets, className }: { presets: PresetOption[]; className?: string }) {
  const [preset, setPreset] = useQueryState(PRESET_PARAM, presetParser.withOptions({ shallow: false }));
  const options: PresetOption[] = [{ slug: "", name: "All" }, ...presets];
  return (
    // The type style sits on the group (buttons inherit font under preflight) so the merge below
    // does not read it as a text color and drop it against text-background.
    <div role="tablist" aria-label="Watchlist" className={cn("flex flex-wrap items-center gap-1.5 text-label-small", className)}>
      {options.map((o) => {
        const active = preset === o.slug;
        return (
          <button
            key={o.slug || "all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setPreset(o.slug || null)}
            className={cn(
              "tap relative h-8 whitespace-nowrap rounded-full px-3 transition-colors",
              active
                ? "bg-foreground text-background"
                : "bg-black-alpha-4 text-black-alpha-56 hover:bg-black-alpha-8 hover:text-foreground dark:bg-white/6 dark:text-muted-foreground dark:hover:bg-white/10",
            )}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}
