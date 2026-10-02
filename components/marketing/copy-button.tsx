"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Copies a snippet and says so for a moment. The label changes with the icon, and a polite live
 * region carries "Copied" to a screen reader, since the button itself keeps focus.
 */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      className={cn(
        "tap relative inline-flex h-7 items-center gap-1.5 rounded-8 px-2 text-label-x-small text-muted-foreground outline-none transition-colors hover:bg-black-alpha-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-forest-ink" strokeWidth={2.25} aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span>{copied ? "Copied" : label}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </button>
  );
}
