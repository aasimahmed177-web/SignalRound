"use client";

import { Check, RotateCcw, Search, X } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { changeSignalStatus } from "@/app/(dashboard)/signals/actions";
import type { SignalStatus } from "@/lib/signals";
import { cn } from "@/lib/utils";

function ActionButton({
  children,
  onClick,
  disabled,
  quiet = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-8 px-2.5 text-label-small transition-colors disabled:cursor-wait disabled:opacity-50",
        quiet
          ? "text-black-alpha-56 hover:bg-black-alpha-4 hover:text-foreground dark:text-muted-foreground dark:hover:bg-white/6"
          : "bg-signal-ink text-white hover:bg-signal-ink/88 dark:bg-white dark:text-signal-ink dark:hover:bg-white/88",
      )}
    >
      {children}
    </button>
  );
}

export function SignalActions({ id, status }: { id: string; status: SignalStatus }) {
  const [pending, startTransition] = useTransition();
  const update = (next: SignalStatus) => {
    startTransition(async () => {
      const result = await changeSignalStatus(id, next);
      if (!result.ok) toast.error(result.error);
    });
  };

  if (status === "matched") {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 text-label-small text-proof-green">
        <Check className="size-3.5" /> Verified record
      </span>
    );
  }

  if (status === "dismissed") {
    return (
      <ActionButton onClick={() => update("new")} disabled={pending}>
        <RotateCcw className="size-3.5" /> Reopen
      </ActionButton>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {status === "new" ? (
        <ActionButton onClick={() => update("researching")} disabled={pending}>
          <Search className="size-3.5" /> Investigate
        </ActionButton>
      ) : (
        <ActionButton onClick={() => update("new")} disabled={pending} quiet>
          <RotateCcw className="size-3.5" /> Return
        </ActionButton>
      )}
      <ActionButton onClick={() => update("dismissed")} disabled={pending} quiet>
        <X className="size-3.5" /> Dismiss
      </ActionButton>
    </div>
  );
}
