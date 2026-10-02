import { headers } from "next/headers";
import { connection } from "next/server";
import { SlackSubscribe } from "@/components/marketing/slack-subscribe";
import { isPublicDemo } from "@/lib/access";
import { cachedPresets } from "@/lib/cached";
import { publicOrigin } from "@/lib/origin";
import { presetOptions } from "@/lib/presets";
import { publicFeeds } from "@/lib/public-feeds";
import { publicSlackConfig } from "@/lib/slack-subscriptions";

/**
 * The delivery section's "Get it in your Slack", server-rendered: every preset (custom ones
 * included, from the shared cache) and the instance's own origin, read at request time behind a Suspense boundary. The
 * public feeds only answer in demo mode, so a private instance's landing page draws nothing here.
 * Add to Slack leads the card only when the public install is configured (the Slack app and
 * SLACK_WEBHOOK_KEY); otherwise the card offers the /feed command and the raw feeds alone.
 */
export async function LiveSlackSubscribe() {
  if (!isPublicDemo()) return null;
  await connection();
  const [presets, h] = await Promise.all([cachedPresets(), headers()]);
  return <SlackSubscribe feeds={publicFeeds(publicOrigin(h), presetOptions(presets))} install={publicSlackConfig() !== null} />;
}
