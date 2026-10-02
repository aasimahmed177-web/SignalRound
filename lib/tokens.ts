import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking where they diverge, or how long the expected one is. `===`
 * returns at the first mismatched byte, which a remote caller can time; comparing the SHA-256 of each
 * side walks a fixed 32 bytes whatever the inputs. A missing side is a mismatch, never a throw.
 */
export function tokenEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
