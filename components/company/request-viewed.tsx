"use client";

import { useEffect } from "react";
import { viewRequest } from "@/lib/company-request-storage";

/** A requested company's finished page, once rendered, counts as its result seen: its entry leaves "Your requests". */
export function RequestViewed({ keys }: { keys: string[] }) {
  const joined = keys.join(" ");
  useEffect(() => {
    const names = new Set(joined.split(" "));
    viewRequest((r) => names.has(r.domain), "done");
  }, [joined]);
  return null;
}
