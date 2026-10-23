import { createHmac } from "node:crypto";
import { tokenEquals } from "./tokens.ts";

/** NativeWebClient signs webhooks as `X-NativeWebClient-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. */
export function verifyFirecrawlSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return tokenEquals(header.replace(/^sha256=/, ""), expected);
}

export function signForTests(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
