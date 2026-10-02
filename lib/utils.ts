import { createCn } from "cn/config";

/**
 * The house type utilities (globals.css) are named `text-<style>`, which a stock tailwind-merge
 * reads as text colors: `cn("text-mono-x-small", "text-heat-100")` would drop the type class.
 * Registering them as font-size classes makes them conflict with each other and with `text-sm`,
 * and with nothing else. Every component composes classes through this `cn`, the ui primitives
 * included, so a type class survives whatever color follows it.
 */
export const HOUSE_TYPE_STYLES = [
  "title-h4",
  "title-h5",
  "title-h6",
  "body-medium",
  "body-small",
  "label-medium",
  "label-small",
  "label-x-small",
  "mono-small",
  "mono-x-small",
] as const;

export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: [...HOUSE_TYPE_STYLES] }] } },
});
