"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * The one place an action reports back: a quiet card bottom-right in the house look (card ground,
 * faint hairline, Inter body). Call `toast()`, `toast.success()`, `toast.error()`, or
 * `toast.promise()` from "sonner" anywhere under the root layout.
 */
export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "system"}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-12 !border !border-border-faint !bg-card !text-foreground !shadow-sm !text-body-small !font-sans",
          description: "!text-muted-foreground",
          actionButton: "!bg-foreground !text-background",
          cancelButton: "!bg-muted !text-foreground",
        },
      }}
      {...props}
    />
  );
}
