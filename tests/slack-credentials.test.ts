import { readFileSync } from "node:fs";
import { schema } from "@fireround/core/db";
import { eq, sql } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import { enqueueDeliveries, flushDeliveries } from "../lib/delivery";
import { persistRecords } from "../lib/persist";
import { createTarget, getTarget, listTargets, queueTestDelivery } from "../lib/settings";
import { maskWebhookUrl } from "../lib/slack";
import { decryptWebhook, migrateSlackTargets } from "../lib/slack-credentials";
import { record, testDb } from "./helpers";

const KEY = "slack-target-test-key-material-at-least-32-characters";
const URL = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstwxyz";
let handle: Awaited<ReturnType<typeof testDb>>;

beforeEach(async () => {
  vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
  handle = await testDb();
});
afterEach(() => vi.unstubAllEnvs());

async function round() {
  const input = record({ company_name: "Acme", announced_date: new Date().toISOString().slice(0, 10), confidence: 0.9 });
  await persistRecords(handle, [input], "series-a-b", "run-1");
  const search = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  await corroborateRecord(handle, search, input.id, { broad: true, maxPages: 0 });
  return input.id;
}

describe("Slack target credentials", () => {
  test("creation encrypts, admin reads stay encrypted, and display masks the decrypted URL", async () => {
    const { id } = await createTarget(handle, { channel: "slack", target: URL });
    const [stored] = await handle.select().from(schema.deliveryTargets).where(eq(schema.deliveryTargets.id, id));
    expect(stored.target).toMatch(/^v1\./);
    expect(stored.target).not.toContain("T0001");
    expect(decryptWebhook(stored.target, KEY)).toBe(URL);
    expect(stored.slackTeamId).toBe("T0001");
    expect((await listTargets(handle))[0].target).toBe(stored.target);
    expect((await getTarget(handle, id))?.target).toBe(stored.target);
    expect(maskWebhookUrl(stored.target)).toBe("hooks.slack.com/…wxyz");
    vi.stubEnv("SLACK_WEBHOOK_KEY", "other-key-material-at-least-32-characters");
    expect(maskWebhookUrl(stored.target)).toBe("Slack webhook unavailable");
  });

  test("creation fails closed without a usable encryption key", async () => {
    for (const key of ["", "short"]) {
      vi.stubEnv("SLACK_WEBHOOK_KEY", key);
      await expect(createTarget(handle, { channel: "slack", target: URL })).rejects.toThrow("SLACK_WEBHOOK_KEY");
    }
    expect(await listTargets(handle)).toHaveLength(0);
    await createTarget(handle, { channel: "webhook", target: "https://receiver.example" });
    expect((await listTargets(handle))[0].target).toBe("https://receiver.example");
  });

  test("legacy migration is idempotent, includes disabled targets, and leaves other channels alone", async () => {
    const ddl = readFileSync("packages/core/drizzle/20260930100000_slack_target_encryption/migration.sql", "utf8");
    for (const statement of ddl.split("--> statement-breakpoint")) await handle.execute(sql.raw(statement));
    await handle.insert(schema.deliveryTargets).values([
      { id: "legacy", channel: "slack", target: URL, enabled: false },
      { id: "hook", channel: "webhook", target: "https://receiver.example" },
      { id: "revoked", channel: "slack", target: "", enabled: false },
    ]);
    expect(await migrateSlackTargets(handle)).toBe(1);
    const stored = (await getTarget(handle, "legacy"))!.target;
    expect(decryptWebhook(stored, KEY)).toBe(URL);
    expect(await migrateSlackTargets(handle)).toBe(0);
    expect((await getTarget(handle, "legacy"))!.target).toBe(stored);
    expect((await getTarget(handle, "hook"))!.target).toBe("https://receiver.example");
    expect((await getTarget(handle, "revoked"))!.target).toBe("");
    const [row] = await handle.select().from(schema.deliveryTargets).where(eq(schema.deliveryTargets.id, "legacy"));
    expect(row.slackTeamId).toBe("T0001");
  });

  test("legacy migration requires a key instead of losing the credential", async () => {
    await handle.insert(schema.deliveryTargets).values({ id: "legacy", channel: "slack", target: URL });
    vi.stubEnv("SLACK_WEBHOOK_KEY", "");
    await expect(migrateSlackTargets(handle)).rejects.toThrow("SLACK_WEBHOOK_KEY");
    vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
    expect(await migrateSlackTargets(handle)).toBe(1);
    expect(decryptWebhook((await getTarget(handle, "legacy"))!.target, KEY)).toBe(URL);
  });

  test("delivery decrypts only at send time and admin retries use the encrypted credential", async () => {
    const id = await round();
    const target = await createTarget(handle, { channel: "slack", target: URL });
    await enqueueDeliveries(handle, [id], "series-a-b");
    const send = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubEnv("SLACK_WEBHOOK_KEY", "wrong-key-material-at-least-32-characters");
    expect((await flushDeliveries(handle, "https://app.test", send)).failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    vi.stubEnv("SLACK_WEBHOOK_KEY", KEY);
    expect(await queueTestDelivery(handle, target.id)).toBe(id);
    expect((await flushDeliveries(handle, "https://app.test", send)).sent).toBe(1);
    expect(send.mock.calls[0][0]).toBe(URL);
    const [delivery] = await handle.select().from(schema.deliveries);
    expect(delivery.target).toBe(target.id);
    expect(delivery.lastError).toBeNull();
  });

  test("permanent failed posts forget credentials while transient network errors retain them", async () => {
    const id = await round();
    const target = await createTarget(handle, { channel: "slack", target: URL });
    await enqueueDeliveries(handle, [id], "series-a-b");
    await flushDeliveries(handle, "https://app.test", async () => {
      throw new Error(`network failed for ${URL}`);
    });
    const [failed] = await handle.select().from(schema.deliveries);
    expect(failed.lastError).toBe("slack: unreachable");
    expect(decryptWebhook((await getTarget(handle, target.id))!.target, KEY)).toBe(URL);
    await queueTestDelivery(handle, target.id);
    expect((await flushDeliveries(handle, "https://app.test", async () => new Response("no_service", { status: 404 }))).deadLettered).toBe(
      1,
    );
    expect(await getTarget(handle, target.id)).toMatchObject({ target: "", enabled: false });
  });
});
