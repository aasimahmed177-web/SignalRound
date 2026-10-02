import { TAG_ENTITY_DETAILS } from "./entity-tags.ts";
import { siteOrigin } from "./origin.ts";

export async function invalidateScriptEntityPages(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  if (!process.env.CRON_SECRET || (!process.env.APP_ORIGIN && !process.env.VERCEL_URL)) {
    throw new Error("CRON_SECRET and APP_ORIGIN are required to invalidate detail caches after a database write");
  }
  const response = await fetch(`${siteOrigin()}/api/cache/invalidate`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ tags: [TAG_ENTITY_DETAILS] }),
  });
  if (!response.ok) throw new Error(`Entity cache invalidation failed (${response.status})`);
}
