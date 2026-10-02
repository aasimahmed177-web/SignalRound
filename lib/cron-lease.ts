import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";

export async function claimCronTick(handle: Db, route: string, now = new Date()): Promise<boolean> {
  const tick = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const claimed = await handle
    .insert(schema.cronLeases)
    .values({ route, tick })
    .onConflictDoNothing()
    .returning({ route: schema.cronLeases.route });
  return claimed.length > 0;
}
