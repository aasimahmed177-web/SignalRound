export type FeedCertainty = "current" | "announced" | "all";

export function feedCertainty(raw: string | null | undefined): FeedCertainty {
  if (raw === "all" || raw === "announced") return raw;
  return "current";
}
