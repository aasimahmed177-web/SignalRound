import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The ink steps are theme-aware (globals.css), so tones need no `dark:` twin. A tag is a word a
 * reader acts on (PART, revoked, a slug), so no tone drops below the label step: `faint` keeps
 * the label ink and only dims its brackets, which is all that separates it from `muted`.
 */
const TONES = {
  muted: "text-black-alpha-32",
  faint: "text-black-alpha-32",
  honey: "text-honey-ink",
  heat: "text-heat-ink",
  forest: "text-forest-ink",
  crimson: "text-crimson-ink",
} as const;

export type TagTone = keyof typeof TONES;

interface TagProps {
  tone?: TagTone;
  className?: string;
  /** Keep the content's own case: slugs, hosts, and ids read wrong in uppercase. */
  preserveCase?: boolean;
  children: ReactNode;
}

/**
 * The house bracket tag: mono, uppercase, `[ LIKE THIS ]`. One vocabulary for every small status
 * word in the product (REVIEW, UPDATED, DEFAULT, LEAD) so a reader learns it once.
 */
export function Tag({ tone = "muted", className, preserveCase, children }: TagProps) {
  const bracket = tone === "faint" ? "opacity-40" : "opacity-60";
  return (
    <span className={cn("whitespace-nowrap text-mono-x-small", preserveCase && "normal-case", TONES[tone], className)}>
      <span className={bracket}>[ </span>
      {children}
      <span className={bracket}> ]</span>
    </span>
  );
}
