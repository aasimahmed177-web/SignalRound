"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { typingIn } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

/** Keystrokes settle this long before the URL (and so the server) hears about them. */
const DEBOUNCE_MS = 250;

/**
 * A search draft that runs ahead of its URL param by the debounce. `value` is what the URL says;
 * `write` puts a settled draft there (trimmed, and the caller resets its page). `wrote` is the last
 * value this box wrote, so its own echo is ignored (the reader may have typed on) while any other
 * change (a Link to the bare page, back and forward) replaces the draft instead of being
 * overwritten by it 250ms later. `reset` is for a caller that clears the param itself.
 */
export function useUrlSearch(value: string, write: (q: string) => void) {
  const [draft, setDraft] = useState(value);
  const wrote = useRef(value);
  // The caller's setter need not be stable; the timer calls whichever is current.
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (value !== wrote.current) {
      wrote.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = draft.trim();
      if (next === value) return;
      wrote.current = next;
      writeRef.current(next);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, value]);

  const reset = (q = "") => {
    wrote.current = q;
    setDraft(q);
  };
  return { draft, setDraft, reset };
}

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  label: string;
  className?: string;
}

/**
 * The search pill the feed and the directories share: a clear button once there is text, Escape
 * to clear, and `/` to focus it from anywhere on the page (⌘K belongs to the command palette).
 */
export function SearchBox({ value, onChange, onClear, placeholder, label, className }: SearchBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-black-alpha-40 dark:text-muted-foreground" />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onClear();
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        aria-keyshortcuts="/"
        className="peer h-8 rounded-full pointer-coarse:h-11 border-0 bg-black-alpha-4 pr-8 pl-9 text-label-small shadow-none placeholder:text-black-alpha-40 dark:bg-white/6 dark:placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onClear();
            ref.current?.focus();
          }}
          className="tap absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black-alpha-8 hover:text-foreground dark:hover:bg-white/10"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded-4 border border-border-muted px-1.5 text-mono-x-small text-muted-foreground peer-focus:hidden md:block"
        >
          /
        </kbd>
      )}
    </div>
  );
}
