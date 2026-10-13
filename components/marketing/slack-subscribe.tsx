"use client";

import { ArrowUpRight } from "lucide-react";
import { Fragment, useId, useState } from "react";
import { CopyButton } from "@/components/marketing/copy-button";
import { CadencePicker, connectHref, PresetPill, StoredNote } from "@/components/slack/install-controls";
import { AddToSlackLink } from "@/components/slack/slack-mark";
import { track } from "@/lib/analytics";
import type { PublicFeed } from "@/lib/public-feeds";
import type { Cadence } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

/**
 * "Get it in your Slack" for a visitor to the public demo. With the public install switched on
 * (`install`), Add to Slack leads: pick a preset and how often, pick a channel on Slack's screen,
 * and the channel gets the full card. The /feed command stays under it as the no-app way (Slack's
 * RSS app posts a link, not the card). Without the install only the /feed command and the raw
 * feeds show. Every URL arrives rendered from the server; the only client work is the switches.
 */
export function SlackSubscribe({
  feeds,
  install = false,
  className,
  headingLevel = 3,
}: {
  feeds: PublicFeed[];
  install?: boolean;
  className?: string;
  /** 3 inside a landing section; 2 on /slack, where it sits right under the page's h1. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const [slug, setSlug] = useState(feeds[0]?.slug ?? "all");
  const [cadence, setCadence] = useState<Cadence>("instant");
  const id = useId();
  const feed = feeds.find((f) => f.slug === slug) ?? feeds[0];
  if (!feed) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-slack-subscribe={install ? "install" : "feed"}
      className={cn("min-w-0 overflow-hidden rounded-12 border border-border-faint bg-card", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-faint py-2 pr-2 pl-4">
        <Heading id={`${id}-title`} className="text-label-medium">
          Get it in your Slack
        </Heading>
        <PresetPill presets={feeds} value={slug} onChange={setSlug} />
      </div>
      {install && (
        <div className="space-y-3 border-b border-border-faint px-4 py-4">
          <CadencePicker value={cadence} onChange={setCadence} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <AddToSlackLink href={connectHref(slug, cadence)} preset={slug} />
            <p className="min-w-0 flex-1 basis-48 text-body-small text-muted-foreground">
              Slack asks which channel to post in. Every message has a link to change or stop it.
            </p>
          </div>
          <StoredNote />
        </div>
      )}
      {install && <p className="px-4 pt-3 text-label-small text-muted-foreground">No app? Paste this in any channel instead.</p>}
      <div className={cn("flex items-start gap-3 pr-2 pl-4", install ? "pt-1.5 pb-3" : "py-3")}>
        {/* Wraps under itself on a phone, so the whole URL stays readable and nothing scrolls sideways. */}
        <code data-slack-command className="min-w-0 flex-1 py-0.5 font-mono text-[13px] leading-6 [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">/feed subscribe</span> <span className="text-black-alpha-72">{feed.rss}</span>
        </code>
        <CopyButton
          text={feed.slack}
          label="Copy"
          snippet="slack_command"
          className="shrink-0 border border-border-muted text-foreground"
        />
      </div>
      <div className="space-y-2 border-t border-border-faint px-4 py-3 text-body-small text-muted-foreground">
        {install ? (
          <p>Slack's RSS app posts each new round as a link, on its own schedule.</p>
        ) : (
          <p>
            <span className="text-foreground">Paste it in any Slack channel.</span> Slack's RSS app posts each new round as a link. The rich
            card needs a self-hosted instance with Add to Slack.
          </p>
        )}
        <p>
          Or read it raw:{" "}
          {(
            [
              ["RSS", feed.rss, "rss"],
              ["Atom", feed.atom, "atom"],
              ["JSON Feed", feed.json, "json_feed"],
            ] as const
          ).map(([label, href, channel], i) => (
            <Fragment key={label}>
              {i > 0 && " · "}
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={() => track("fireround_subscribe_clicked", { channel, preset: slug })}
                className="inline-flex items-center gap-0.5 rounded-4 whitespace-nowrap text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {label}
                <ArrowUpRight className="size-3 opacity-60" aria-hidden />
              </a>
            </Fragment>
          ))}
        </p>
      </div>
    </section>
  );
}

/** The card's shape while the presets and the origin stream in. */
export function SlackSubscribeSkeleton({ install = false }: { install?: boolean }) {
  return <div aria-hidden className={cn("rounded-12 border border-border-faint bg-card", install ? "h-[392px]" : "h-[196px]")} />;
}
