import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The browser's own select, dressed to sit beside an Input in a settings form: the same height,
 * the same hairline, the same radius. The filter toolbar uses FilterSelect (a pill) instead.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn("h-8 max-w-full rounded-8 border border-input bg-card px-2.5 text-body-small", className)} {...props} />;
}
