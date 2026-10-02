import { cn } from "@/lib/utils";

/**
 * X's logomark where X is named as the place posts came from ("13 people on X", the On X block, the
 * Built with strip). It draws in the text colour at about the text's cap height and sits on the
 * baseline, so it reads as the word it replaces; the label keeps "X" for a screen reader. Never
 * recoloured: monochrome, whatever ink the surrounding text wears.
 */
export function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="X"
      focusable="false"
      className={cn("inline-block size-[0.8em] shrink-0 align-[-0.1em]", className)}
    >
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}
