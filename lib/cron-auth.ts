import { tokenEquals } from "@/lib/tokens";

/**
 * The one check every /api/cron route makes: `Authorization: Bearer $CRON_SECRET`, compared in
 * constant time. With no secret configured it is open in development (a laptop's scheduler) and
 * closed in production, so a deployment that forgot the secret refuses every call rather than
 * running sweeps, backfills, and deliveries for anyone who finds the path.
 */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return tokenEquals(request.headers.get("authorization"), `Bearer ${secret}`);
}
