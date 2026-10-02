import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { container, gutter } from "@/components/marketing/section";
import { SlackPreview, SlackPreviewSkeleton } from "@/components/marketing/slack-preview";
import { SlackSubscribe, SlackSubscribeSkeleton } from "@/components/marketing/slack-subscribe";
import { isPublicDemo } from "@/lib/access";
import { cachedPresets, cachedSlackPreviews } from "@/lib/cached";
import { publicOrigin } from "@/lib/origin";
import { presetOptions } from "@/lib/presets";
import { publicFeeds } from "@/lib/public-feeds";
import { shareMetadata } from "@/lib/share";
import { cadenceWords } from "@/lib/slack-messages";
import { connectErrorMessage, DAILY_POST_CAP, publicSlackConfig } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

const TITLE = "Fireround in your Slack";
const DESCRIPTION =
  "New funding rounds in a Slack channel of your choice: each round as it is found, or one digest each morning. Add to Slack, or paste a /feed command.";

export const metadata: Metadata = {
  title: TITLE,
  ...shareMetadata({ title: TITLE, description: DESCRIPTION, image: "root", canonical: "/slack" }),
};

type Search = { error?: string };

/** What a channel can expect, in three short lines under the button. */
const FACTS = [
  {
    name: "Each round",
    body: "Each round we find that matches the watchlist you picked, posted as soon as it's found. If many land at once, you get the five largest and a count of the rest.",
  },
  {
    name: "Daily digest",
    body: `${cadenceWords("daily")[0].toUpperCase()}${cadenceWords("daily").slice(1)}: the largest rounds, then what is trending.`,
  },
  {
    name: "Manage",
    body: `Every message links to a page where you can change what you get, pause, send a test, or unsubscribe. At most ${DAILY_POST_CAP} posts a day.`,
  },
];

/** A caption over a preview: small, mono, the label ink (decoration-grade words, docs/design.md). */
function Caption({ children }: { children: React.ReactNode }) {
  return <p className="text-mono-x-small text-black-alpha-32 uppercase">{children}</p>;
}

async function SlackBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const [search, h] = await Promise.all([searchParams, headers()]);
  const origin = publicOrigin(h);
  // The same for every visitor on this origin: shared cache entries (lib/cached.ts).
  const [presets, previews] = await Promise.all([cachedPresets(), cachedSlackPreviews(origin)]);
  const install = publicSlackConfig() !== null;
  // Only the known reason codes print their sentence; anything else reads as a generic miss.
  const error = connectErrorMessage(search.error);
  const now = new Date().toISOString();
  return (
    <div className={cn("grid gap-10 pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14", gutter)}>
      <div className="min-w-0 space-y-6">
        {error && (
          <p role="alert" data-slack-error className="rounded-12 border border-crimson-ink/30 bg-card px-4 py-3 text-body-small">
            <span className="text-label-small text-crimson-ink">Not connected.</span> {error}
          </p>
        )}
        <SlackSubscribe feeds={publicFeeds(origin, presetOptions(presets))} install={install} headingLevel={2} />
        <ul className="divide-y divide-border-faint border-y border-border-faint">
          {FACTS.filter((f) => install || f.name !== "Manage").map((f) => (
            <li key={f.name} className="grid gap-1 py-3.5 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-6">
              <span className="text-label-medium">{f.name}</span>
              <p className="text-body-small text-muted-foreground">{f.body}</p>
            </li>
          ))}
        </ul>
        <p className="text-body-small text-muted-foreground">
          What a channel stores and how to have it deleted is on the{" "}
          <Link href="/privacy" className="text-foreground underline underline-offset-2">
            privacy page
          </Link>
          . Questions or a wrong round:{" "}
          <Link href="/support" className="text-foreground underline underline-offset-2">
            support
          </Link>
          . Use is covered by the{" "}
          <Link href="/terms" className="text-foreground underline underline-offset-2">
            terms
          </Link>
          .
        </p>
      </div>
      <div className="min-w-0 space-y-6">
        <div className="space-y-2">
          <Caption>The first message</Caption>
          <SlackPreview message={previews.welcome} sentAt={now} inert />
        </div>
        {previews.digest && (
          <div className="space-y-2">
            <Caption>A morning digest</Caption>
            <SlackPreview message={previews.digest} sentAt={now} inert />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The public Add to Slack's own page: the button with its pickers, what a channel gets, and the
 * welcome and a digest drawn from the live store. A failed install lands here with a reason code
 * (lib/slack-subscriptions.ts connectErrorMessage). Demo mode only: a private instance connects
 * Slack from Settings.
 */
export default function SlackPage({ searchParams }: PageProps<"/slack">) {
  if (!isPublicDemo()) notFound();
  return (
    <section className="border-b border-border-faint">
      <div className={container}>
        <div className={cn("max-w-2xl pt-14 pb-10 sm:pt-20", gutter)}>
          <p className="text-mono-x-small text-black-alpha-48">
            <span className="text-black-alpha-32">[ </span>SLACK<span className="text-black-alpha-32"> ]</span>
          </p>
          <h1 className="mt-4 text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]">
            New funding rounds, in your channel.
          </h1>
          <p className="mt-4 text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
            Choose which rounds you want and how often, then pick a channel. Each post shows the amount, the lead investor, and links to the
            articles that reported it.
          </p>
        </div>
        <Suspense
          fallback={
            <div className={cn("grid gap-10 pb-20 lg:grid-cols-2 lg:gap-14", gutter)}>
              <SlackSubscribeSkeleton install />
              <SlackPreviewSkeleton />
            </div>
          }
        >
          <SlackBody searchParams={searchParams as Promise<Search>} />
        </Suspense>
      </div>
    </section>
  );
}
