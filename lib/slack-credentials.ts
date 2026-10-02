import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq, inArray, ne, notLike } from "drizzle-orm";

const AAD = Buffer.from("fireround:slack-webhook:v1");

function encryptionKey(material: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from("fireround"), Buffer.from("slack-webhook"), 32));
}

export function slackWebhookKey(): string | null {
  const key = process.env.SLACK_WEBHOOK_KEY?.trim();
  return key && key.length >= 32 ? key : null;
}

export function encryptWebhook(url: string, material: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(material), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(url, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

export function decryptWebhook(ciphertext: string | null | undefined, material: string): string | null {
  const m = ciphertext?.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const iv = Buffer.from(m[1], "base64url");
    const body = Buffer.from(m[2], "base64url");
    if (iv.length !== 12 || body.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(material), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function slackWebhookTeam(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["hooks.slack.com", "hooks.slack-gov.com"].includes(parsed.hostname)) return null;
    return /^\/services\/(T[A-Z0-9]+)\//.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function migrateSlackTargets(handle: Db): Promise<number> {
  const { deliveryTargets } = schema;
  const rows = await handle
    .select()
    .from(deliveryTargets)
    .where(and(eq(deliveryTargets.channel, "slack"), ne(deliveryTargets.target, ""), notLike(deliveryTargets.target, "v1.%")));
  if (!rows.length) return 0;
  const key = slackWebhookKey();
  if (!key) throw new Error("Set SLACK_WEBHOOK_KEY to at least 32 characters before migrating Slack targets.");
  let migrated = 0;
  for (const row of rows) {
    try {
      const updated = await handle
        .update(deliveryTargets)
        .set({
          target: encryptWebhook(row.target, key),
          slackTeamId: row.slackTeamId ?? slackWebhookTeam(row.target),
          updatedAt: new Date(),
        })
        .where(and(eq(deliveryTargets.id, row.id), eq(deliveryTargets.target, row.target)))
        .returning({ id: deliveryTargets.id });
      migrated += updated.length;
    } catch {
      throw new Error("Slack target encryption migration failed; retry after checking database connectivity.");
    }
  }
  return migrated;
}

export async function revokeSlackTarget(handle: Db, id: string): Promise<void> {
  await handle
    .update(schema.deliveryTargets)
    .set({ target: "", enabled: false, updatedAt: new Date() })
    .where(and(eq(schema.deliveryTargets.id, id), eq(schema.deliveryTargets.channel, "slack")));
  await handle
    .delete(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.channel, "slack"),
        eq(schema.deliveries.target, id),
        inArray(schema.deliveries.status, ["pending", "failed"]),
      ),
    );
}
