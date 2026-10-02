// The verifier's notes as a reader takes them in. A verdict's notes are two kinds of line: the
// applier's record of what it changed ("leads: Eclipse (prnewswire.com)", "date 2026-09-24 (week)
// read as 2026-09-23 (day, inquirer.com)"), written by packages/core/src/records/correction.ts,
// lib/prune-investors.ts, lib/repair.ts, and the report and reject actions; and the model's own remark,
// a sentence or two of prose. The change lines have fixed shapes, so they parse into a label and
// the names or values they carry; anything that does not parse is a remark and shows as written.
// Display only: the stored lines are never rewritten (lib/prune-investors.ts reads them back).

import { normalizeInvestorKey } from "@fireround/core/client";

export interface NoteItem {
  text: string;
  /** The host the line cites for this item, when it names one. */
  host: string | null;
}

export interface ChangeNote {
  kind: "change";
  /** What changed, as a reader says it: "Lead added", "Date", "Removed". */
  label: string;
  items: NoteItem[];
  /** Why, when the line says: "not in this round", or a repair's reason. */
  detail: string | null;
  /** The stored line, for the tooltip. */
  raw: string;
}

export interface RemarkNote {
  kind: "remark";
  text: string;
  raw: string;
}

export type ParsedNote = ChangeNote | RemarkNote;

/** Splits on commas outside parentheses: "A (x.com), B (y.com)". */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A cited host is the last comma part of a trailing parenthesis that reads like a domain. */
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** "Eclipse (prnewswire.com)" is Eclipse cited to prnewswire.com; "Palette Wealth Management (PWM)" is a name. */
function cited(s: string): { body: string; parts: string[]; host: string | null } {
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(s.trim());
  if (!m) return { body: s.trim(), parts: [], host: null };
  const parts = m[2].split(",").map((p) => p.trim());
  const last = parts[parts.length - 1] ?? "";
  if (HOST.test(last)) return { body: m[1].trim(), parts: parts.slice(0, -1), host: last };
  if (last === "a source") return { body: m[1].trim(), parts: parts.slice(0, -1), host: null };
  // A parenthesis of precision words only ("(week)") belongs to the caller; anything else is part of the name.
  if (parts.every((p) => /^(?:day|week|month|unknown)$/.test(p))) return { body: m[1].trim(), parts, host: null };
  return { body: s.trim(), parts: [], host: null };
}

/** A corporate suffix after a comma ("Landolt Securities, Inc.") is the name's tail, not another name. */
const SUFFIX = /^(?:inc|llc|ltd|l\.?p|co|corp|plc|gmbh|s\.?a|n\.?v|ag)\.?(?:\s*\([^()]*\))?$/i;

function names(list: string): NoteItem[] {
  const parts: string[] = [];
  for (const p of splitTop(list)) {
    if (parts.length > 0 && SUFFIX.test(p)) parts[parts.length - 1] += `, ${p}`;
    else parts.push(p);
  }
  return parts.map((n) => {
    const c = cited(n);
    return { text: c.body, host: c.host };
  });
}

/** A date with its precision said only when it is not the day: "2026-09-24 (week)". */
function dated(iso: string, precision: string | undefined): string {
  return precision && precision !== "day" ? `${iso} (${precision})` : iso;
}

/** A change with its label, what it names, and why when the line says. */
type Change = Omit<ChangeNote, "kind" | "raw">;
const plain = (list: string): NoteItem[] => names(list).map((i) => ({ text: i.text, host: null }));

/**
 * Each line shape a writer produces, first match wins. `row` reads a lead in the row's spelling of the
 * firm. Every pattern is anchored, so order matters only for the two amount shapes: "not stated" first.
 */
const RULES: Array<[RegExp, (m: RegExpExecArray, row: (items: NoteItem[]) => NoteItem[]) => Change]> = [
  [
    /^leads: (.+)$/,
    (m, row) => {
      const items = row(names(m[1]));
      return { label: items.length > 1 ? "Leads added" : "Lead added", items, detail: null };
    },
  ],
  [/^page leads: (.+)$/, (m, row) => ({ label: "Page leads", items: row(names(m[1])), detail: null })],
  [
    /^not leads: (.+)$/,
    (m, row) => {
      const items = row(plain(m[1]));
      return { label: items.length > 1 ? "Now participants" : "Now a participant", items, detail: null };
    },
  ],
  [/^not investors in this round: (.+)$/, (m) => ({ label: "Removed", items: plain(m[1]), detail: "not in this round" })],
  [
    /^not supported for this round: (.+)$/,
    (m) => ({ label: "Removed", items: plain(m[1]), detail: "no source places them in this round" }),
  ],
  [
    /^stage (.+) read as (.+)$/,
    (m) => {
      const to = cited(m[2]);
      return { label: "Stage", items: [{ text: `${m[1]} → ${to.body}`, host: to.host }], detail: null };
    },
  ],
  [
    /^the page calls it an extension (.+)$/,
    (m) => {
      const c = cited(m[1]);
      const label = cited(c.body).body.replace(/^\((.*)\)$/, "$1");
      return { label: "Stage", items: [{ text: `extension (${label})`, host: c.host }], detail: null };
    },
  ],
  [
    /^amount (.+) not stated (for this round|by any source)$/,
    (m) => ({ label: "Amount removed", items: [{ text: m[1], host: null }], detail: `not stated ${m[2]}` }),
  ],
  [
    /^amount (.+?) read as (.+)$/,
    (m) => {
      const to = cited(m[2]);
      return m[1] === "none"
        ? { label: "Amount added", items: [{ text: to.body, host: to.host }], detail: null }
        : { label: "Amount", items: [{ text: `${m[1]} → ${to.body}`, host: to.host }], detail: null };
    },
  ],
  // "date 2026-09-24 (week) read as 2026-09-23 (day, inquirer.com)", with lib/repair.ts's ": why" after it.
  [
    /^date (\S+)(?: \((\w+)\))? read as (\S+)(?: \(([^()]*)\))?(?:: (.+))?$/,
    (m) => {
      const [, from, fromPrecision, to, tag, why] = m;
      const parts = (tag ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const host = parts.find((p) => HOST.test(p)) ?? null;
      const toPrecision = parts.find((p) => /^(?:day|week|month|unknown)$/.test(p));
      const value =
        from === "none"
          ? dated(to, toPrecision)
          : from === to && toPrecision === "day"
            ? `${to}, the exact day (was ${fromPrecision ?? "approximate"})`
            : `${dated(from, fromPrecision)} → ${dated(to, toPrecision)}`;
      return { label: from === "none" ? "Date added" : "Date", items: [{ text: value, host }], detail: why ?? null };
    },
  ],
  [
    /^date (\S+) confirmed to the day \(was (\w+)\)(.*)$/,
    (m) => ({
      label: "Date",
      items: [{ text: `${m[1]}, the exact day (was ${m[2]})`, host: cited(m[3].trim() || "x").host }],
      detail: null,
    }),
  ],
  [
    /^headquarters (.+)$/,
    (m) => {
      const c = cited(m[1]);
      return { label: "HQ added", items: [{ text: c.body, host: c.host }], detail: null };
    },
  ],
  [/^reported: (.+)$/, (m) => ({ label: "Reported", items: [{ text: m[1], host: null }], detail: null })],
  [/^rejected: (.+)$/, (m) => ({ label: "Rejected", items: [{ text: m[1], host: null }], detail: null })],
];

/**
 * One note line, parsed. `investors` is the row's syndicate: a lead the line names in the verdict's
 * spelling ("Emergence Capital") reads in the row's ("Emergence") when the two are one firm.
 */
export function parseNote(raw: string, investors: string[] = []): ParsedNote {
  const text = raw.trim();
  const row = (items: NoteItem[]) =>
    items.map((i) => {
      const key = normalizeInvestorKey(i.text);
      const match = key ? investors.find((n) => normalizeInvestorKey(n) === key) : undefined;
      return match ? { ...i, text: match } : i;
    });
  for (const [pattern, read] of RULES) {
    const m = pattern.exec(text);
    if (m) return { kind: "change", ...read(m, row), raw };
  }
  // Status lines ("no source could be read", "model error: …") and the model's remark read as sentences.
  return { kind: "remark", text: text.charAt(0).toUpperCase() + text.slice(1), raw };
}

/** The notes, parsed: the changes first in the order written, then the remarks. */
export function parseNotes(notes: string[], investors: string[] = []): { changes: ChangeNote[]; remarks: RemarkNote[] } {
  const parsed = notes.map((n) => parseNote(n, investors));
  return {
    changes: parsed.filter((p): p is ChangeNote => p.kind === "change"),
    remarks: parsed.filter((p): p is RemarkNote => p.kind === "remark"),
  };
}
