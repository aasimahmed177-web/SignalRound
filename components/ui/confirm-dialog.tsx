"use client";

import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  /** The verb on the destructive button: "Delete preset", "Revoke". */
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * The one confirmation every destructive action goes through, in place of `window.confirm`.
 * `confirm()` resolves true on the destructive button and false on cancel, Escape, or the overlay,
 * so a call site reads `if (!(await confirm({...}))) return;`. Render `dialog` once in the
 * component that owns the actions.
 */
export function useConfirm(): { confirm: (options: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  // Kept after close so the copy does not blank out during the exit animation.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  // Opened from code, not a Trigger, so Radix has nowhere to return focus: remember where the reader was.
  const returnTo = useRef<HTMLElement | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // A second call while one is open cancels the first rather than leaving its promise hanging.
    resolver.current?.(false);
    // A menu item unmounts as the menu closes, so a call from one hands focus back to the menu's trigger.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menuTrigger = active?.closest("[role=menu]")?.getAttribute("aria-labelledby");
    returnTo.current = (menuTrigger ? document.getElementById(menuTrigger) : null) ?? active;
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const dialog = (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialogPrimitive.Content
          onCloseAutoFocus={(e) => {
            if (!returnTo.current?.isConnected) return;
            e.preventDefault();
            returnTo.current.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <div className="flex flex-col gap-2">
            <AlertDialogPrimitive.Title className="text-label-medium">{options?.title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="text-body-small text-muted-foreground">
              {options?.description}
            </AlertDialogPrimitive.Description>
          </div>
          <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline" size="sm">
                {options?.cancelLabel ?? "Cancel"}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant="destructive" size="sm" onClick={() => settle(true)}>
                {options?.confirmLabel ?? "Delete"}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );

  return { confirm, dialog };
}
