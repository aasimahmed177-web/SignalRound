import { v } from "convex/values";

export const stage = v.union(v.literal("pre_seed"), v.literal("seed"), v.literal("series_a"), v.literal("series_b"), v.literal("series_c"));

/** founders: a founders@/ceo@ inbox; founder_personal: an address a public page shows as a named founder's own. */
export const contactType = v.union(
  v.literal("hello"),
  v.literal("sales"),
  v.literal("business"),
  v.literal("info"),
  v.literal("contact"),
  v.literal("media"),
  v.literal("other_role"),
  v.literal("founders"),
  v.literal("founder_personal"),
  v.literal("careers"),
  v.literal("support"),
);

export const jobStatus = v.union(v.literal("open"), v.literal("closed"));

/** An email a job posting prints: the page it is on and the text there that shows it. */
export const postedJobEmail = v.object({ email: v.string(), sourceUrl: v.string(), quote: v.string() });
