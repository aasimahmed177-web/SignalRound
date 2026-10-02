import { Tag } from "@/components/ui/tag";
import type { RoundRow } from "@/lib/persist";

/**
 * The word for a round that is not on the feed, for the admin who can see it: REVIEW, or REJECTED
 * in crimson. A round on the feed needs no word: published and flagged rows both read through the
 * Round cell's check (a flagged row as Developing), so a visitor never sees a status tag.
 */
export function DispositionTag({ value }: { value: RoundRow["disposition"] }) {
  if (value === "review") return <Tag>REVIEW</Tag>;
  if (value === "rejected") return <Tag tone="crimson">REJECTED</Tag>;
  return null;
}

/** The investor's part in a round: LEAD in heat, PART quiet. */
export function RoleTag({ lead }: { lead: boolean }) {
  return lead ? <Tag tone="heat">LEAD</Tag> : <Tag tone="faint">PART</Tag>;
}
