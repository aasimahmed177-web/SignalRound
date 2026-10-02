// Page-wide shortcuts (the search box's `/`, the review queue's letters) listen on the window;
// this is the one rule for when a keystroke is not theirs to take.

/** True when a keystroke is meant for a field, an open dialog, or a menu, so a bare shortcut key there is left alone. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest("[role=dialog], [role=menu], [role=listbox]") !== null
  );
}
