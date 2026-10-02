"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/** The quiet square icon button the shell uses for its own controls (theme, menu, search). */
export const shellIconButton =
  "tap relative grid size-8 place-items-center rounded-8 text-black-alpha-56 hover:bg-black-alpha-4 hover:text-foreground dark:text-muted-foreground dark:hover:bg-white/6";

/**
 * Light or dark, whichever the page is not. Its own module so the landing page can carry it
 * without the sidebar's command palette coming along in the bundle.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="size-8" />;
  const dark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light" : "Switch to dark"}
      className={shellIconButton}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
