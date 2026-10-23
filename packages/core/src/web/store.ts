import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.ts";

/** Persistent coordination across workflow workers; callers can inject a store in tests. */
export interface WebStateStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  compareAndSwap(key: string, expected: unknown, value: unknown): Promise<boolean>;
}
export const databaseWebState: WebStateStore = {
  async get(key) {
    const db = await getDb();
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
    return row?.value;
  },
  async put(key, value) {
    const db = await getDb();
    await db
      .insert(schema.settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  },
  async remove(key) {
    await (await getDb()).delete(schema.settings).where(eq(schema.settings.key, key));
  },
  async compareAndSwap(key, expected, value) {
    const db = await getDb();
    const rows = await db
      .update(schema.settings)
      .set({ value, updatedAt: new Date() })
      .where(sql`${schema.settings.key} = ${key} and ${schema.settings.value} = ${JSON.stringify(expected)}::jsonb`)
      .returning({ key: schema.settings.key });
    return rows.length === 1;
  },
};
