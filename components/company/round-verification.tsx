"use client";

import { ChevronDown } from "lucide-react";
import { createContext, type ReactNode, useContext, useId, useState } from "react";
import { cn } from "@/lib/utils";

const Fold = createContext<{ open: boolean; toggle: () => void; id: string } | null>(null);

function useFold() {
  const fold = useContext(Fold);
  if (!fold) throw new Error("RoundFoldToggle and RoundFoldPanel belong inside a RoundFold");
  return fold;
}

/**
 * One round with how it was verified folded under it. The round's own check mark ("✓ 4 sources")
 * is the toggle, so a page of rounds reads as rounds, with no extra line each; the verdict, the
 * score, the verifier's notes and the Built with strip open under the row on request. In a table
 * the fold is the round's own <tbody>, so the toggle in one row and the panel in the next share it.
 */
export function RoundFold({ as: As = "tbody", className, children }: { as?: "tbody" | "div"; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Fold.Provider value={{ open, toggle: () => setOpen((o) => !o), id }}>
      <As className={className}>{children}</As>
    </Fold.Provider>
  );
}

/** The check mark as a button: the mark and its count, then a small chevron that turns when open. */
export function RoundFoldToggle({ children }: { children: ReactNode }) {
  const { open, toggle, id } = useFold();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={id}
      onClick={toggle}
      className="group tap relative -mx-1 inline-flex min-h-6 items-center gap-1 rounded-4 px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-heat-100"
    >
      <span className="sr-only">How this was verified: </span>
      {children}
      <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
    </button>
  );
}

/** What opens under the round: a full-width row in a table (`colSpan`), a block anywhere else. */
export function RoundFoldPanel({ colSpan, children }: { colSpan?: number; children: ReactNode }) {
  const { open, id } = useFold();
  const body = <div className="space-y-2 border-l border-border-faint pl-4">{children}</div>;
  if (colSpan)
    return (
      <tr id={id} hidden={!open}>
        <td colSpan={colSpan} className="px-5 pt-0 pb-4">
          {body}
        </td>
      </tr>
    );
  return (
    <div id={id} hidden={!open}>
      {body}
    </div>
  );
}
