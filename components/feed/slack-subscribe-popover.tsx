"use client";

import { useState } from "react";
import { CopyButton } from "@/components/marketing/copy-button";
import { CadencePicker, connectHref, PresetPill, StoredNote } from "@/components/slack/install-controls";
import { AddToSlackLink, SlackMark } from "@/components/slack/slack-mark";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PublicFeed } from "@/lib/public-feeds";
import type { Cadence } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

/**
 * "Slack" in the demo hero's Subscribe line when the public install is on: a popover with Add to
 * Slack (the preset in view, preselected, and how often), then the /feed command as the way that
 * needs no app. Without the install the hero keeps SlackCopy, the one-click /feed copy.
 */
export function SlackSubscribePopover({ feeds, preset, className }: { feeds: PublicFeed[]; preset: string; className?: string }) {
  const [slug, setSlug] = useState(feeds.some((f) => f.slug === preset) ? preset : (feeds[0]?.slug ?? "all"));
  const [cadence, setCadence] = useState<Cadence>("instant");
  const feed = feeds.find((f) => f.slug === slug) ?? feeds[0];
  if (!feed) return null;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "whitespace-nowrap rounded-4 text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        Slack
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[22rem] space-y-3 p-4"
        data-slack-popover
        // Focus lands on the button, not the preset select, which would wear its focus ring on every open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-add-to-slack]")?.focus();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-label-medium">
            <SlackMark className="size-4" />
            Get it in your Slack
          </p>
          <PresetPill presets={feeds} value={slug} onChange={setSlug} />
        </div>
        <CadencePicker value={cadence} onChange={setCadence} />
        <AddToSlackLink href={connectHref(slug, cadence)} className="w-full" />
        <StoredNote />
        <div className="space-y-1.5 border-t border-border-faint pt-3">
          <p className="text-label-small text-muted-foreground">No app? Paste this in any channel.</p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 font-mono text-[12px] leading-5 [overflow-wrap:anywhere]">
              <span className="font-medium text-foreground">/feed subscribe</span> <span className="text-black-alpha-72">{feed.rss}</span>
            </code>
            <CopyButton text={feed.slack} label="Copy" className="shrink-0 border border-border-muted text-foreground" />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
