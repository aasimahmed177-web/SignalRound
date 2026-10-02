"use client";

import { type ReactNode, useId, useState } from "react";

/**
 * A list that shows its first `initial` items and folds the rest behind one toggle. The items are
 * rendered on the server and passed in with their keys; only the open state lives here. With
 * nothing to fold it is a plain list with no control. The toggle's words arrive as strings: a server
 * component cannot hand a function across to a client one.
 */
export function ShowMore({
  items,
  initial,
  more,
  less,
  className,
}: {
  items: ReactNode[];
  initial: number;
  /** The closed toggle's words ("+4 more", "Show all 9 sources"). */
  more: string;
  less: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Folding one item saves no space: the toggle takes the line the item would have.
  const folds = items.length - initial > 1;
  return (
    <>
      <ul id={id} className={className}>
        {folds && !open ? items.slice(0, initial) : items}
      </ul>
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-2 rounded-4 text-label-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {open ? less : more}
        </button>
      )}
    </>
  );
}
