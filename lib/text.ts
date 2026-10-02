// Display helpers for extracted prose. Extraction keeps a source's casing, so a description
// often arrives mid-sentence ("a sales prospecting platform based in Europe"). The stored value
// stays as written; these tidy it only where it is rendered.

/**
 * The string with its first letter upper-cased when it reads as a lowercase sentence start.
 * A first word that already carries a capital ("eBay", "iRobot"), a digit ("3d printing"), or a
 * dot between letters ("stripe.com") is a name or a domain written that way on purpose, and is
 * left alone; so is anything that does not start with a letter. Nullish passes through, so
 * `capitalizeFirst(c.description) ?? c.domain` still falls back.
 */
export function capitalizeFirst(text: string): string;
export function capitalizeFirst(text: string | null): string | null;
export function capitalizeFirst(text: string | null | undefined): string | null | undefined;
export function capitalizeFirst(text: string | null | undefined): string | null | undefined {
  if (!text || !/^\p{Ll}/u.test(text)) return text;
  const firstWord = text.split(/\s/, 1)[0];
  if (/[\p{Lu}\d]/u.test(firstWord) || /\.\p{L}/u.test(firstWord)) return text;
  return text.charAt(0).toLocaleUpperCase("en") + text.slice(1);
}

/** A count with thousands grouped ("1,565"), so a directory tally reads like the presets' estimates. */
export function groupDigits(n: number): string {
  return n.toLocaleString("en-US");
}
