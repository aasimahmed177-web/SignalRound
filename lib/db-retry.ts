// The fetch Neon's HTTP driver sends every query through: a cap on how many run at once, and one
// retry for a query that never got an answer. Neon's serverless driver sends each
// query as its own fetch, and a cold network path now and then fails with undici's bare "fetch
// failed": nine visitor-facing error pages in one day of September 2026, each fine on reload.
// Pure apart from the fetch it wraps, so the tests drive it with a fake.

/** Network errors raised before the request left: nothing reached the database, so any query may go again. */
const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** The error a fetch throws when the network failed, as opposed to an abort or an HTTP status. */
function networkError(err: unknown): { code: string | null } | null {
  if (!(err instanceof TypeError) || !/fetch failed/i.test(err.message)) return null;
  const cause = (err as TypeError & { cause?: { code?: unknown } }).cause;
  return { code: typeof cause?.code === "string" ? cause.code : null };
}

/** Statements that only read: a SELECT, or a WITH that writes nowhere. `FOR UPDATE` counts as a write. */
function readsOnly(sql: unknown): boolean {
  if (typeof sql !== "string") return false;
  return /^\s*(select|with)\b/i.test(sql) && !/\b(insert|update|delete|merge|truncate|alter|create|drop|grant|call)\b/i.test(sql);
}

/**
 * Whether a Neon HTTP request body holds only reads. The driver posts `{ query, params }`, or
 * `{ queries: [...] }` for a batch. A failure after the request left may still have run it, so a
 * write is never sent twice.
 */
export function readOnlyBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as { query?: unknown; queries?: Array<{ query?: unknown }> };
    const statements = Array.isArray(parsed.queries) ? parsed.queries.map((q) => q?.query) : [parsed.query];
    return statements.length > 0 && statements.every(readsOnly);
  } catch {
    return false;
  }
}

/**
 * `base` with one retry after a short pause when the network failed, and only when repeating is
 * safe: the connection never opened, or every statement in the body is a read. An HTTP error
 * status, an abort, or a timeout comes back as it was.
 */
export function retryingFetch(
  base: typeof fetch,
  { retries = 1, delayMs = 150 }: { retries?: number; delayMs?: number } = {},
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await base(input, init);
      } catch (err) {
        const failed = networkError(err);
        const safe = failed !== null && ((failed.code !== null && CONNECT_CODES.has(failed.code)) || readOnlyBody(init?.body));
        if (!safe || attempt >= retries) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
      }
    }
  };
}

/**
 * `base` with at most `max` requests in flight; the rest wait their turn in arrival order. Neon's
 * HTTP driver sends each query as its own fetch and has no pool, so nothing else stops one busy
 * function instance from putting hundreds of queries on the database at once during a spike. A
 * slot frees when the response arrives, which for a query over HTTP is when the database is done.
 */
export function concurrencyLimited(base: typeof fetch, max: number): typeof fetch {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (input, init) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await base(input, init);
    } finally {
      // Hand the slot straight to the next in line, so a newcomer cannot overtake it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
