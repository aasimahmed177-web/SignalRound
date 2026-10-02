// Syndicated copies of one article, folded for a source list. Pure, so the feed row (a client
// component) and tests share it without pulling the store into the browser bundle.

/**
 * A wire release republished word for word (Business Wire on Yahoo Finance, Business Insider, and
 * a dozen more) is one piece of evidence, so copies fold to their first line with the other hosts
 * under it. The headline is compared without a trailing " | Publisher" or " - Publisher" and without
 * punctuation or case; a short or missing title never folds, so two different pages never merge.
 */
export function foldCopies<S extends { url: string; host: string; title: string | null }>(sources: S[]): Array<{ primary: S; also: S[] }> {
  const key = (title: string | null) => {
    if (!title) return null;
    const k = title
      .toLowerCase()
      .replace(/\s+[|\-·]\s+[^|\-·]{2,40}$/, "")
      .replace(/[^a-z0-9$]+/g, " ")
      .trim();
    return k.length >= 24 ? k : null;
  };
  const out: Array<{ primary: S; also: S[] }> = [];
  const byKey = new Map<string, { primary: S; also: S[] }>();
  for (const s of sources) {
    const k = key(s.title);
    const hit = k ? byKey.get(k) : undefined;
    if (hit) hit.also.push(s);
    else {
      const entry = { primary: s, also: [] as S[] };
      out.push(entry);
      if (k) byKey.set(k, entry);
    }
  }
  return out;
}
