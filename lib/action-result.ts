/**
 * What an action that can fail for a reason the reader should see returns: never a throw.
 * In production Next swaps a thrown action error's message for boilerplate, so the reason
 * travels in the result. The reader is the authenticated operator, so the message is useful,
 * not a leak.
 */
export type ActionResult<T = void> = (T extends void ? { ok: true } : { ok: true } & T) | { ok: false; error: string };

export async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<{ value: T }>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A failure whose message was written for the visitor who caused it (a bad manage link, a paused channel). */
export class PublicError extends Error {}

/**
 * attempt for an action a visitor may call: only a PublicError's message reaches them. Anything else
 * (a driver error quotes its query and parameters) becomes one sentence, and the log keeps the rest.
 */
export async function attemptPublic<T>(fn: () => Promise<T>): Promise<ActionResult<{ value: T }>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof PublicError) return { ok: false, error: err.message };
    console.error("action failed", err);
    return { ok: false, error: "Something went wrong on our side. Try again in a moment." };
  }
}
