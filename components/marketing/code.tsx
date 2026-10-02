import type { ReactNode } from "react";
import { type Token, type TokenKind, tokenizeJson, tokenizeShell } from "@/lib/code-tokens";
import { cn } from "@/lib/utils";

/**
 * Token inks. Strings take the one warm colour, as firecrawl.dev sets them; everything a reader
 * copies clears AA through the ink tokens, and only punctuation and the gutter sit on the label step.
 */
const INK: Record<TokenKind, string> = {
  plain: "text-black-alpha-72",
  key: "text-foreground",
  string: "text-heat-ink",
  number: "text-forest-ink",
  literal: "text-forest-ink",
  punct: "text-black-alpha-32",
  command: "text-foreground font-medium",
  flag: "text-muted-foreground",
  comment: "text-black-alpha-32",
};

export type CodeLang = "shell" | "json";

function tokenize(line: string, lang: CodeLang): Token[] {
  const tokens = lang === "json" ? tokenizeJson(line) : tokenizeShell(line);
  const runs: Token[] = [];
  for (const token of tokens) {
    const last = runs.at(-1);
    if (last?.kind === token.kind) last.text += token.text;
    else runs.push({ ...token });
  }
  return runs;
}

/**
 * Highlighted lines with a line-number gutter, server-rendered: no highlighter ships to the
 * browser. Lines are tokenized one at a time, which holds for pretty-printed JSON and for shell,
 * where nothing the page shows spans a line. Shell wraps a long line under itself, so a phone reads
 * the whole URL; JSON keeps its indentation and scrolls sideways instead, as a focusable region
 * so a keyboard can scroll it too.
 */
export function CodeLines({
  code,
  lang,
  numbered = true,
  label,
  className,
}: {
  code: string;
  lang: CodeLang;
  numbered?: boolean;
  /** The scroll region's name, for JSON. */
  label?: string;
  className?: string;
}) {
  const lines = code.split("\n");
  const wrap = lang === "shell";
  const body = (
    <code className={cn("grid", !wrap && "min-w-max")}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity in a fixed snippet
        <span key={i} className="flex">
          {numbered && (
            <span aria-hidden className="w-10 shrink-0 select-none pr-4 text-right text-black-alpha-32 tabular-nums">
              {i + 1}
            </span>
          )}
          <span className={cn("min-w-0 pr-5", !numbered && "pl-5")}>
            {tokenize(line, lang).map((t, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line
              <span key={j} className={INK[t.kind]}>
                {t.text}
              </span>
            ))}
            {line === "" && "\u200b"}
          </span>
        </span>
      ))}
    </code>
  );
  const type = "py-4 font-mono text-[13px] leading-6";
  if (wrap) return <pre className={cn(type, "whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>{body}</pre>;
  return (
    <section
      aria-label={label ?? "Code"}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls sideways must take focus so a keyboard can scroll it
      tabIndex={0}
      className={cn("overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset", className)}
    >
      <pre className={type}>{body}</pre>
    </section>
  );
}

/** Three quiet dots, the window chrome firecrawl.dev puts on its code and product frames. */
export function WindowDots() {
  return (
    <span aria-hidden className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full border border-border-muted" />
      <span className="size-2.5 rounded-full border border-border-muted" />
      <span className="size-2.5 rounded-full border border-border-muted" />
    </span>
  );
}

/** A framed snippet: the chrome bar (dots, a label, an action such as Copy), then the lines. */
export function CodeFrame({
  label,
  action,
  children,
  className,
}: {
  label?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-12 border border-border-faint bg-card", className)}>
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border-faint pr-2 pl-4">
        <div className="flex min-w-0 items-center gap-4">
          <WindowDots />
          {label && <span className="truncate text-mono-x-small text-black-alpha-32">{label}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
