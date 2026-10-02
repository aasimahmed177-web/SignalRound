import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { revokeSlackTarget } from "./slack-credentials.ts";
import { revokeSubscription } from "./slack-subscriptions.ts";

export function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret || !timestamp || !/^\d+$/.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const eventSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("app_uninstalled") }),
    z.object({
      type: z.literal("tokens_revoked"),
      tokens: z.object({ bot: z.array(z.string()).optional(), oauth: z.array(z.string()).optional() }),
    }),
  ]),
});

export async function receiveSlackEvent(handle: Db, payload: unknown): Promise<void> {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return;
  const { team_id: teamId, event } = parsed.data;
  const matches = (botUserId: string | null, userId: string | null) =>
    event.type === "app_uninstalled" ||
    Boolean(
      (event.tokens.bot?.length && (botUserId === null || event.tokens.bot.includes(botUserId))) ||
        (event.tokens.oauth?.length && (userId === null || event.tokens.oauth.includes(userId))),
    );
  const targets = await handle
    .select()
    .from(schema.deliveryTargets)
    .where(and(eq(schema.deliveryTargets.channel, "slack"), eq(schema.deliveryTargets.slackTeamId, teamId)));
  for (const target of targets) {
    if (matches(target.slackBotUserId, target.slackUserId)) await revokeSlackTarget(handle, target.id);
  }
  const subscriptions = await handle.select().from(schema.slackSubscriptions).where(eq(schema.slackSubscriptions.teamId, teamId));
  for (const subscription of subscriptions) {
    if (matches(subscription.botUserId, subscription.userId)) await revokeSubscription(handle, subscription.id, event.type);
  }
}
