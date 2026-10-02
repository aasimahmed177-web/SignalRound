"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept in sync with the viewport. The server snapshot is `false`
 * (no viewport there); use it only for state that first renders on the client.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
