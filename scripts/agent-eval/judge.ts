// How one answer is scored against the ground truth the database gives at run time.
//   correct: the answer is what the database says, so an agent can repeat it as it stands
//   partial: some of it is right (rows missing or extra, a fact off, or only a did-you-mean for a misspelling)
//   wrong:   an error, the wrong thing, or rows where the database has none
//   empty:   nothing came back where the database has an answer

export type Verdict = "correct" | "partial" | "wrong" | "empty";

/** What the database says the answer is. */
export type Expect =
  /** Every row matching the question, in any order. A page that has more after it is judged on its own length. */
  | { kind: "rows"; keys: string[]; suggest?: string }
  /** The first `n` rows by `score`, highest first; a tie at the cut lets any of the tied rows in. */
  | { kind: "top"; ranked: Array<{ key: string; score: number }>; n: number }
  /** A search for one name: the company or investor meant should come first. */
  | { kind: "match"; key: string }
  /** One company or investor, with the facts its profile should state. */
  | { kind: "entity"; key: string; facts: Record<string, Fact> }
  /** Nothing: the honest answer is that there is no such round, company or investor. */
  | { kind: "none" };

export type Fact = string | number | null | string[];

/** What came back, reduced to the keys and facts the judge compares. */
export interface Answer {
  /** HTTP status of the read (or of the provider call behind Alexandria); 0 when it never answered. */
  status: number;
  error?: string;
  keys: string[];
  hasMore: boolean;
  /** Ids a miss suggested instead (did_you_mean, or "Did you mean X (id y)" in an error). */
  suggestions: string[];
  entity?: { key: string | null; facts: Record<string, Fact> };
}

export interface Judgement {
  verdict: Verdict;
  reason: string;
  /** Returned keys the database does not have for this question, and keys it has that did not come back (10 of each at most). */
  extra?: string[];
  missing?: string[];
}

/** Rows that must all be right for "correct": at least this share of precision and recall. */
const CORRECT_SHARE = 0.95;

const share = (n: number, d: number) => (d === 0 ? 1 : n / d);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function sameFact(want: Fact, got: Fact | undefined): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    const a = new Set(want);
    const b = new Set(got);
    return a.size === b.size && [...a].every((k) => b.has(k));
  }
  if (typeof want === "number" && typeof got === "number") return Math.abs(want - got) <= Math.max(0.01, Math.abs(want) * 1e-6);
  return want === (got ?? null);
}

function describeFact(f: Fact | undefined): string {
  if (Array.isArray(f)) return `${f.length} items`;
  return f === undefined ? "missing" : JSON.stringify(f);
}

export function judge(expect: Expect, answer: Answer): Judgement {
  if (answer.error && answer.status !== 404) return { verdict: "wrong", reason: `error ${answer.status}: ${answer.error.slice(0, 160)}` };

  if (expect.kind === "none") {
    if (answer.keys.length === 0 && !answer.entity) return { verdict: "correct", reason: "nothing, as the database has nothing" };
    return {
      verdict: "wrong",
      reason: `returned ${answer.entity ? `entity ${answer.entity.key}` : `${answer.keys.length} rows`} where the database has none`,
    };
  }

  if (expect.kind === "entity") {
    if (!answer.entity) {
      if (answer.suggestions.includes(expect.key)) return { verdict: "partial", reason: `not found, but suggested ${expect.key}` };
      return { verdict: "empty", reason: `not found (${answer.status}); expected ${expect.key}` };
    }
    if (answer.entity.key !== expect.key) return { verdict: "wrong", reason: `returned ${answer.entity.key}, expected ${expect.key}` };
    const off = Object.entries(expect.facts)
      .filter(([k, want]) => !sameFact(want, answer.entity?.facts[k]))
      .map(([k, want]) => `${k}: got ${describeFact(answer.entity?.facts[k])}, db ${describeFact(want)}`);
    return off.length
      ? { verdict: "partial", reason: off.join("; ") }
      : { verdict: "correct", reason: `${expect.key}, every fact matches` };
  }

  if (expect.kind === "match") {
    if (answer.keys[0] === expect.key) return { verdict: "correct", reason: `${expect.key} first` };
    const at = answer.keys.indexOf(expect.key);
    if (at > 0) return { verdict: "partial", reason: `${expect.key} at position ${at + 1}` };
    if (answer.suggestions.includes(expect.key)) return { verdict: "partial", reason: `not listed, but suggested ${expect.key}` };
    if (answer.keys.length === 0) return { verdict: "empty", reason: `no rows; expected ${expect.key}` };
    return { verdict: "wrong", reason: `${answer.keys.length} rows without ${expect.key}` };
  }

  if (expect.kind === "rows") {
    const want = new Set(expect.keys);
    if (answer.keys.length === 0) {
      if (want.size === 0) return { verdict: "correct", reason: "nothing, as the database has nothing" };
      if (expect.suggest && answer.suggestions.includes(expect.suggest))
        return { verdict: "partial", reason: `no rows, but suggested ${expect.suggest}` };
      return { verdict: "empty", reason: `no rows; the database has ${want.size}` };
    }
    if (want.size === 0) return { verdict: "wrong", reason: `${answer.keys.length} rows where the database has none` };
    const hits = answer.keys.filter((k) => want.has(k)).length;
    const precision = share(hits, answer.keys.length);
    const recall = share(hits, answer.hasMore ? Math.min(want.size, answer.keys.length) : want.size);
    const reason = `${hits} of ${answer.keys.length} returned rows match; ${answer.hasMore ? "first page" : "all pages"} covers ${pct(recall)} of ${want.size} in the database`;
    const got = new Set(answer.keys);
    const diff = {
      extra: answer.keys.filter((k) => !want.has(k)).slice(0, 10),
      missing: answer.hasMore ? [] : expect.keys.filter((k) => !got.has(k)).slice(0, 10),
    };
    if (hits === 0) return { verdict: "wrong", reason, ...diff };
    return { verdict: precision >= CORRECT_SHARE && recall >= CORRECT_SHARE ? "correct" : "partial", reason, ...diff };
  }

  const n = Math.min(expect.n, expect.ranked.length);
  if (n === 0) {
    return answer.keys.length === 0
      ? { verdict: "correct", reason: "nothing, as the database has nothing" }
      : { verdict: "wrong", reason: `${answer.keys.length} rows where the database has none` };
  }
  const got = answer.keys.slice(0, n);
  if (got.length === 0) return { verdict: "empty", reason: `no rows; the database ranks ${expect.ranked.length}` };
  const cut = expect.ranked[n - 1]?.score ?? 0;
  const may = new Set(expect.ranked.filter((r) => r.score >= cut).map((r) => r.key));
  const must = expect.ranked.filter((r) => r.score > cut).map((r) => r.key);
  const inTop = got.filter((k) => may.has(k)).length;
  const missing = must.filter((k) => !got.includes(k));
  const reason = `${inTop} of top ${n} right${missing.length ? `; missing ${missing.slice(0, 3).join(", ")}` : ""}`;
  const diff = { extra: got.filter((k) => !may.has(k)).slice(0, 10), missing: missing.slice(0, 10) };
  if (inTop === 0) return { verdict: "wrong", reason, ...diff };
  return { verdict: inTop === n && got.length === n && missing.length === 0 ? "correct" : "partial", reason, ...diff };
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * One response reduced to what the judge compares, the same for the public API's JSON and for
 * Alexandria's cleaned copy of it: the rows' keys (a news article's URL, anything else's id), whether
 * a next page exists, a profile's facts, and the ids a miss suggested instead.
 */
export function readAnswer(capability: string, status: number, body: unknown): Answer {
  const b = obj(body);
  const error = text(b.error) ?? (status >= 400 ? `status ${status}` : undefined);
  const suggestions = [
    ...list(b.did_you_mean).map((s) => text(s.id)),
    ...[...(error ?? "").matchAll(/\(id ([^)]+)\)/g)].map((m) => m[1] ?? null),
  ].filter((s): s is string => Boolean(s));
  if (error) return { status, error, keys: [], hasMore: false, suggestions };
  if (capability === "companies/profile" || capability === "investors/profile") {
    const facts: Record<string, Fact> =
      capability === "companies/profile"
        ? {
            total_raised_usd_millions: typeof b.total_raised_usd_millions === "number" ? b.total_raised_usd_millions : null,
            rounds: list(b.rounds).length,
            latest_announced_on: text(list(b.rounds)[0]?.announced_on),
            investors: list(b.investors).map((i) => text(i.id) ?? ""),
          }
        : {
            rounds_led: typeof obj(b.totals).rounds_led === "number" ? (obj(b.totals).rounds_led as number) : null,
            rounds_participated:
              typeof obj(b.totals).rounds_participated === "number" ? (obj(b.totals).rounds_participated as number) : null,
          };
    return { status, keys: [], hasMore: false, suggestions, entity: { key: text(b.id), facts } };
  }
  const key = capability === "news/latest" ? "url" : "id";
  return {
    status,
    keys: list(b.data)
      .map((r) => text(r[key]))
      .filter((k): k is string => Boolean(k)),
    hasMore: (b.next_cursor ?? null) !== null || (b.next_page ?? null) !== null,
    suggestions,
  };
}

/** correct counts 1, partial a half. */
export function score(verdicts: Verdict[]): number {
  if (verdicts.length === 0) return 0;
  const points = verdicts.reduce((n, v) => n + (v === "correct" ? 1 : v === "partial" ? 0.5 : 0), 0);
  return Math.round((points / verdicts.length) * 1000) / 10;
}
