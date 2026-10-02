"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { dismissAccuracy, reopenAccuracy } from "@/app/(dashboard)/review/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/**
 * Dismiss asks for a note first: the next person to see the flag (or the flag reopening on a new
 * round) should know why it was let go. Reopen undoes a dismissal.
 */
export function AccuracyFlagAction({
  companyId,
  rule,
  label,
  mode,
}: {
  companyId: string;
  rule: string;
  label: string;
  mode: "dismiss" | "reopen";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (mode === "reopen") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-8 sm:h-7"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await reopenAccuracy({ companyId, rule });
            if (!res.ok) {
              toast.error("Could not reopen the flag", { description: res.error });
              return;
            }
            toast(`Reopened: ${label}`);
            router.refresh();
          })
        }
      >
        <RotateCcw className="size-3.5" /> Reopen
      </Button>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-8 sm:h-7" onClick={() => setOpen(true)} aria-expanded={false}>
        <X className="size-3.5" /> Dismiss
      </Button>
    );
  }

  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return;
        start(async () => {
          const res = await dismissAccuracy({ companyId, rule, note: note.trim() });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          toast.success(`Dismissed: ${label}`, { description: "It stays quiet while it is about the same rounds." });
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <Input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Why it is fine as it is"
        aria-label={`Why dismiss: ${label}`}
        className="h-8 min-w-0 flex-1 text-body-small sm:max-w-sm"
      />
      <Button type="submit" size="sm" className="h-8 sm:h-7" disabled={pending || !note.trim()}>
        <Check className="size-3.5" /> Dismiss
      </Button>
      <Button type="button" size="sm" variant="ghost" className={cn("h-8 sm:h-7", SECONDARY)} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p className="w-full text-body-small text-crimson-ink">{error}</p>}
    </form>
  );
}
