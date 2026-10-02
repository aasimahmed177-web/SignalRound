/** The middle dot between items on a quiet meta line: decoration, so it is hidden from screen readers and sits at separator ink. */
export function Dot() {
  return (
    <span aria-hidden className="text-black-alpha-24 dark:text-white/20">
      {" · "}
    </span>
  );
}
