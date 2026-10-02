import { Tag } from "@/components/ui/tag";
import type { SubscriptionCounts } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

/**
 * Settings → Delivery's line on the public Add to Slack: whether it is on (and what is missing if
 * not), then counts only. An admin never sees a visitor's workspace, channel, or webhook here; the
 * visitor manages their channel from its own link.
 */
export function PublicSlackSummary({
  demo,
  missing,
  counts,
  cap,
  manifestUrl,
}: {
  demo: boolean;
  missing: string[];
  counts: SubscriptionCounts;
  cap: number;
  /** Slack's create-from-manifest link with both redirect URLs, for an operator switching it on. */
  manifestUrl: string;
}) {
  const on = demo && missing.length === 0;
  const figure = (n: number, label: string) => (
    <span className="whitespace-nowrap">
      <span className="font-mono text-foreground tabular-nums">{n}</span> {label}
    </span>
  );
  return (
    <div className="mt-6 space-y-2 border-t border-border-faint pt-5" data-public-slack>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-label-small">Public Add to Slack</h3>
        <Tag tone={on ? "forest" : "muted"}>{on ? "on" : "off"}</Tag>
      </div>
      <p className="text-body-small text-muted-foreground">
        {on
          ? `Visitors subscribe their own channels from the landing page and the feed; each is managed from its own link. Up to ${cap} channels.`
          : !demo
            ? "Only in demo mode (PUBLIC_DEMO=1). This instance connects Slack as delivery targets above."
            : `Off until ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set (docs/slack.md, Public Add to Slack).`}
        {demo && missing.includes("SLACK_CLIENT_ID") && (
          <>
            {" "}
            <a href={manifestUrl} target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">
              Create the public app
            </a>
          </>
        )}
      </p>
      <p className={cn("flex flex-wrap gap-x-3 gap-y-1 text-body-small text-muted-foreground")}>
        {figure(counts.active, "active")}
        <span className="text-black-alpha-24">·</span>
        {figure(counts.instant, "each round")}
        {figure(counts.daily, "daily")}
        <span className="text-black-alpha-24">·</span>
        {figure(counts.paused, "paused")}
        {figure(counts.revoked, "ended")}
        <span className="text-black-alpha-24">·</span>
        {figure(counts.workspaces, counts.workspaces === 1 ? "workspace" : "workspaces")}
        {figure(counts.queued, "queued")}
      </p>
    </div>
  );
}
