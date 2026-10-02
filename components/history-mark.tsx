import { Tag } from "@/components/ui/tag";

/** What the mark means, for the tooltip and a screen reader. */
export const HISTORY_NOTE =
  "An earlier round, from the company's own announcement, found while researching the company. Checked like any round, but not new, so it stays out of the daily feed and alerts; a date range shows it.";

/**
 * The quiet word on a history row (lib/history.ts): an earlier round promoted from the company's
 * dossier. Faint, like PART, since the row is as verified as any other; it only says the feed did
 * not catch it as news. Nothing for a feed row.
 */
export function HistoryMark({ history, reportedLater = false }: { history?: boolean; reportedLater?: boolean }) {
  if (!history) return null;
  const note = reportedLater
    ? "This round was announced before Fireround first saw it. It stays in the company's history, not in Latest, Trending, or alerts."
    : HISTORY_NOTE;
  return (
    <span title={note} className="inline-flex">
      <Tag tone="faint">{reportedLater ? "REPORTED LATER" : "HISTORY"}</Tag>
      <span className="sr-only">: {note}</span>
    </span>
  );
}
