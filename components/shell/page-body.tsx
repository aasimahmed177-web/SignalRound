import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageBodyProps {
  children: ReactNode;
  className?: string;
  /** Tables and feeds run wide; forms and reading pages sit narrower. */
  width?: "wide" | "narrow";
}

/**
 * The one content column under a PageHeader: the same horizontal padding as the header so left
 * edges line up, one vertical rhythm (24px between blocks), and `min-w-0` so a wide table inside
 * shrinks or scrolls instead of pushing the column past the viewport.
 */
export function PageBody({ children, className, width = "wide" }: PageBodyProps) {
  return (
    <div className={cn("mx-auto w-full min-w-0 space-y-6 px-4 py-6 lg:px-8", width === "wide" ? "max-w-7xl" : "max-w-5xl", className)}>
      {children}
    </div>
  );
}
