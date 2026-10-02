import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { type ReactNode, Suspense } from "react";
import { container, gutter } from "@/components/marketing/section";
import { ManagePanel } from "@/components/slack/manage-panel";
import { PanelSkeleton, SkeletonLine } from "@/components/ui/skeletons";
import { Tag } from "@/components/ui/tag";
import { db } from "@/lib/db";
import { relativeTime } from "@/lib/format";
import { listPresets, presetOptions } from "@/lib/presets";
import { ALL_ROUNDS } from "@/lib/public-feeds";
import { postFailureMessage } from "@/lib/slack-delivery";
import {
  channelLabel,
  DAILY_POST_CAP,
  isTokenShaped,
  manageToken,
  postsLeft,
  publicSlackConfig,
  SLACK_PAGE_PATH,
  type Subscription,
  subscriptionByToken,
} from "@/lib/slack-subscriptions";
import { tokenEquals } from "@/lib/tokens";
import { cn } from "@/lib/utils";

// The token is the whole credential and it sits in the path, so the page stays out of every index
// and never sends itself as a referrer.
export const metadata: Metadata = {
  title: "Manage a Slack channel",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Search = { connected?: string; unsubscribe?: string };

/** "23 Sep 2026", the day a channel connected (from parts: en-GB's short September is "Sept"). */
function day(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
}

/** The page's opening: the channel as the title, the workspace and the day under it, the status tag. */
function Head({ sub, children }: { sub: Subscription; children?: ReactNode }) {
  const tag =
    sub.status === "active" ? (
      <Tag tone="forest">active</Tag>
    ) : sub.status === "paused" ? (
      <Tag tone="honey">paused</Tag>
    ) : (
      <Tag tone="crimson">unsubscribed</Tag>
    );
  return (
    <div className="space-y-3">
      <p className="text-mono-x-small text-black-alpha-48">
        <span className="text-black-alpha-32">[ </span>SLACK CHANNEL<span className="text-black-alpha-32"> ]</span>
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="min-w-0 text-[32px] leading-[36px] font-medium tracking-[-0.02em] break-words sm:text-[40px] sm:leading-[44px]">
          {channelLabel(sub.channelName)}
        </h1>
        {tag}
      </div>
      <p className="text-body-medium text-muted-foreground">
        {sub.teamName ? <span className="text-foreground">{sub.teamName}</span> : "Your workspace"} · connected {day(sub.createdAt)}
      </p>
      {children}
    </div>
  );
}

/** A one-line notice under the head: forest for good news, crimson for a problem. */
function Notice({ tone, children }: { tone: "forest" | "crimson"; children: ReactNode }) {
  return (
    <p
      role="status"
      className={cn(
        "rounded-12 border bg-card px-4 py-3 text-body-small",
        tone === "forest" ? "border-forest-ink/30" : "border-crimson-ink/30",
      )}
    >
      {children}
    </p>
  );
}

const againLink =
  "inline-flex h-10 items-center gap-1.5 rounded-10 bg-foreground px-4 text-label-medium text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Why the last post failed, in words; null when the last post went through. */
function lastProblem(sub: Subscription): string | null {
  if (!sub.lastError || sub.failureCount === 0) return null;
  return postFailureMessage({ ok: false, kind: "fail", code: sub.lastError });
}

function activity(sub: Subscription, now: Date): string {
  const used = DAILY_POST_CAP - postsLeft(sub, now);
  const last = sub.lastSentAt ? `last post ${relativeTime(sub.lastSentAt.toISOString())}` : "nothing posted yet";
  return `${used} of ${DAILY_POST_CAP} posts today · ${last}.`;
}

async function ManageBody({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Search> }) {
  await connection();
  const [{ token }, search] = await Promise.all([params, searchParams]);
  const config = publicSlackConfig();
  const handle = await db();
  const found = config && isTokenShaped(token) ? await subscriptionByToken(handle, token) : null;
  // A token under an old key names nothing: rotating SLACK_WEBHOOK_KEY retires every link.
  const sub = found && config && tokenEquals(manageToken(found.id, config.key), token) ? found : null;

  if (!sub) {
    return (
      <div className="space-y-4" data-manage="invalid">
        <h1 className="text-[32px] leading-[36px] font-medium tracking-[-0.02em]">This manage link is not valid.</h1>
        <p className="text-body-medium text-muted-foreground">
          Open the Manage link on any message Fireround posted in the channel. If the channel was unsubscribed, add Fireround to it again.
        </p>
        <Link href={SLACK_PAGE_PATH} className={againLink}>
          Fireround in Slack <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    );
  }

  if (sub.status === "revoked") {
    const byVisitor = sub.lastError === "unsubscribed";
    return (
      <div className="space-y-6" data-manage="revoked">
        <Head sub={sub} />
        <Notice tone="crimson">
          {byVisitor
            ? "This channel is unsubscribed. Fireround no longer posts there and has forgotten its webhook."
            : `Slack said the channel's webhook is gone (${sub.lastError ?? "removed"}), so the subscription ended and the webhook was forgotten.`}
        </Notice>
        <Link href={SLACK_PAGE_PATH} className={againLink}>
          Add Fireround to a channel <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    );
  }

  const presets = [ALL_ROUNDS, ...presetOptions(await listPresets(handle))];
  // A preset since removed still shows as what the channel gets, rather than silently reading as another.
  if (!presets.some((p) => p.slug === sub.presetSlug)) presets.push({ slug: sub.presetSlug, name: sub.presetSlug });
  const problem = lastProblem(sub);
  const channel = channelLabel(sub.channelName);
  return (
    <div className="space-y-8" data-manage="live">
      <Head sub={sub}>
        {search.connected === "1" && (
          <Notice tone="forest">
            <span className="text-label-small text-forest-ink">Connected.</span> The welcome message is in {channel}; new rounds follow it
            there.
          </Notice>
        )}
        {search.connected === "quiet" && (
          <Notice tone="crimson">
            <span className="text-label-small text-crimson-ink">Connected, but the welcome did not post.</span>{" "}
            {problem ?? "Send a test to try again."}
          </Notice>
        )}
        {search.connected !== "quiet" && problem && <Notice tone="crimson">The last post did not go through. {problem}</Notice>}
      </Head>
      <ManagePanel
        state={{
          token,
          channel,
          presetSlug: sub.presetSlug,
          includeExpected: sub.includeExpected,
          cadence: sub.cadence,
          status: sub.status,
          presets,
          activity: activity(sub, new Date()),
          askUnsubscribe: search.unsubscribe === "1",
        }}
      />
    </div>
  );
}

/**
 * One channel's page, reached from the footer of every message Fireround posts there. The token
 * in the path is the credential (lib/slack-subscriptions.ts manageToken); the page shows the
 * workspace and channel names and never the webhook.
 */
export default function ManagePage({ params, searchParams }: PageProps<"/slack/manage/[token]">) {
  return (
    <section className="border-b border-border-faint">
      <div className={container}>
        <div className={cn(gutter, "mx-auto max-w-[760px] py-14 sm:py-20")}>
          <Suspense
            fallback={
              <div className="space-y-8">
                <div className="space-y-3">
                  <SkeletonLine text="text-mono-x-small" width="w-28" />
                  <SkeletonLine text="text-[40px] leading-[44px]" width="w-48" />
                  <SkeletonLine width="w-56" />
                </div>
                <PanelSkeleton title="What this channel gets">
                  <SkeletonLine width="w-80" />
                </PanelSkeleton>
              </div>
            }
          >
            <ManageBody params={params} searchParams={searchParams as Promise<Search>} />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
