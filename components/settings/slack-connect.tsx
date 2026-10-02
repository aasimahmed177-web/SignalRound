"use client";

import { ArrowUpRight, Rss, TriangleAlert } from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { newSlackFeedCommand } from "@/app/(dashboard)/settings/actions";
import { Disclosure } from "@/components/settings/disclosure";
import { CopyButton, Field, type PresetOption, presetName, SECONDARY, Secret } from "@/components/settings/shared";
import { AddToSlackLink, SlackMark } from "@/components/slack/slack-mark";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

/** What the page knows about Slack: whether the OAuth app is configured, and the facts the setup card shows. */
export interface SlackSetup {
  /** OAuth credentials and the webhook encryption key are set. */
  configured: boolean;
  /** This instance's public origin (APP_ORIGIN, else the request's). */
  origin: string;
  /** Slack's create-from-manifest deep link, prefilled for this origin. */
  manifestUrl: string;
  redirectUri: string;
  /** The origin is localhost: Slack can neither redirect to it over https nor fetch its feeds. */
  loopback: boolean;
  /** Running on Vercel, so the credentials go in the project's environment variables. */
  vercel: boolean;
}

/** Vercel's own documented deep link: it asks which team and project, then opens Environment Variables. */
const VERCEL_ENV_URL =
  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables";

/** The admin install: the channel becomes a delivery target (the public one is components/slack). */
export function AddToSlackButton() {
  return <AddToSlackLink href="/api/slack/install" />;
}

/** A numbered step: the mono numeral in the gutter, the title, then the detail. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2">
      <span className="pt-px text-mono-small text-black-alpha-32 tabular-nums">{String(n).padStart(2, "0")}</span>
      <div className="min-w-0 space-y-2">
        <div className="text-label-small">{title}</div>
        {children}
      </div>
    </li>
  );
}

function EnvName({ name }: { name: string }) {
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-6 border border-border-faint bg-background px-2">
      <code className="text-mono-small font-normal">{name}</code>
      <CopyButton value={name} label={`Copy ${name}`} />
    </span>
  );
}

/** The origin note: Slack's documented rule is an https redirect URL, and its servers cannot fetch localhost. */
function LoopbackNote({ origin }: { origin: string }) {
  return (
    <p className={cn("flex gap-2 text-body-small", SECONDARY)}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-honey-ink" />
      <span>
        This instance answers at <code className="font-mono">{origin}</code>. Slack requires an https redirect URL and its servers cannot
        fetch a feed from localhost, so Add to Slack and <code className="font-mono">/feed</code> need a public URL: deploy, or run a tunnel
        (ngrok, cloudflared) and set <code className="font-mono">APP_ORIGIN</code> to it. Pasting a webhook URL works from here.
      </span>
    </p>
  );
}

/** The manifest creates the app; the environment holds its credentials and encryption key. */
function SetupCard({ setup }: { setup: SlackSetup }) {
  return (
    <div className="rounded-12 border border-border-faint p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-label-medium">Connect Slack in two minutes</div>
        <Tag tone="faint">SETUP</Tag>
      </div>
      <ol className="space-y-4">
        <Step n={1} title="Create the Slack app">
          <p className={cn("text-body-small", SECONDARY)}>
            Opens Slack with Fireround's manifest filled in: the name, the one <code className="font-mono">incoming-webhook</code> scope,
            and this redirect URL. Pick your workspace, then Create.
          </p>
          <code className="block text-mono-small font-normal break-all">{setup.redirectUri}</code>
          <Button variant="outline" size="sm" asChild>
            <a href={setup.manifestUrl} target="_blank" rel="noopener noreferrer">
              <SlackMark className="size-3.5" /> Create the Slack app <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        </Step>
        <Step n={2} title="Copy its credentials into the environment">
          <p className={cn("text-body-small", SECONDARY)}>
            On the app's Basic Information page, under App Credentials, copy the Client ID, Client Secret, and Signing Secret into:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <EnvName name="SLACK_CLIENT_ID" />
            <EnvName name="SLACK_CLIENT_SECRET" />
            <EnvName name="SLACK_SIGNING_SECRET" />
          </div>
          <p className={cn("text-body-small", SECONDARY)}>
            Generate a random secret of at least 32 characters for <code className="font-mono">SLACK_WEBHOOK_KEY</code>. It encrypts every
            saved Slack webhook; keep it stable across deploys.
          </p>
          {setup.vercel ? (
            <Button variant="outline" size="sm" asChild>
              <a href={VERCEL_ENV_URL} target="_blank" rel="noopener noreferrer">
                Open Vercel environment variables <ArrowUpRight className="size-3.5" />
              </a>
            </Button>
          ) : (
            <p className={cn("text-body-small", SECONDARY)}>
              In <code className="font-mono">.env</code> on your own machine, or your host's environment settings.
            </p>
          )}
        </Step>
        <Step n={3} title={setup.vercel ? "Redeploy" : "Redeploy, or restart the server"}>
          <p className={cn("text-body-small", SECONDARY)}>
            This card becomes an Add to Slack button. In Slack's Event Subscriptions, verify the request URL{" "}
            <code className="font-mono">{setup.origin}/api/webhooks/slack</code> and subscribe to{" "}
            <code className="font-mono">app_uninstalled</code> and <code className="font-mono">tokens_revoked</code> so Fireround forgets
            disconnected credentials. Then pick a channel with Add to Slack.
          </p>
        </Step>
      </ol>
    </div>
  );
}

/**
 * Put a /feed command on the clipboard while the server still mints its token. Safari only lets
 * a click write to the clipboard during the click, so the write starts now with the text as a
 * promise (ClipboardItem takes one); browsers without that wait for the text and write it.
 */
async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return true;
    } catch {
      // Fall through to the plain write.
    }
  }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

/** The no-app path: a feed token for one preset, subscribed with Slack's RSS app. */
function FeedSubscribe({ presets }: { presets: PresetOption[] }) {
  const [pending, start] = useTransition();
  const [preset, setPreset] = useState(presets[0]?.slug ?? "series-a-b");
  const [command, setCommand] = useState<string | null>(null);

  const subscribe = () => {
    const label = `Slack /feed · ${presetName(presets, preset)}`;
    const minted = newSlackFeedCommand(label, preset).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.value.command;
    });
    const copied = copyWhenReady(minted);
    start(async () => {
      try {
        const cmd = await minted;
        setCommand(cmd);
        const ok = await copied;
        toast.success(ok ? "Copied the /feed command" : "Feed minted", {
          description: ok
            ? "Paste it in the Slack channel and send it. Slack's RSS app posts each new round there."
            : "Copy the command below, paste it in the Slack channel, and send it.",
          duration: 8000,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end">
        <div className="min-w-0">
          <div className="text-label-small">No Slack app? Use Slack's /feed</div>
          <p className={cn("text-body-small", SECONDARY)}>
            Mints a private feed for one preset and copies the command that subscribes a channel.
          </p>
        </div>
        <Field label="Preset" htmlFor="slack-feed-preset">
          <NativeSelect id="slack-feed-preset" value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full">
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button variant="outline" disabled={pending} onClick={subscribe} className="justify-self-start">
          <Rss className="size-3.5" /> Copy /feed command
        </Button>
      </div>
      {command && <Secret label="SLACK COMMAND" values={[command]} />}
    </div>
  );
}

/**
 * Slack at the top of Delivery: the one-click install when the app is configured, the setup card
 * when it is not, the /feed path that needs no app at all, and the paste-a-webhook form last.
 */
export function SlackConnect({ setup, presets, pasteForm }: { setup: SlackSetup; presets: PresetOption[]; pasteForm: ReactNode }) {
  return (
    <section className="space-y-4" aria-labelledby="slack-heading">
      <div className="flex items-baseline gap-3">
        <h3 id="slack-heading" className="text-label-small">
          Slack
        </h3>
        <Tag tone="faint">{setup.configured ? "APP CONFIGURED" : "NO APP YET"}</Tag>
      </div>
      {setup.configured ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <AddToSlackButton />
          <p className={cn("text-body-small", SECONDARY)}>
            Pick a channel on Slack's screen. It lands below as a target that gets verified and checked rounds from every preset.
          </p>
        </div>
      ) : (
        <SetupCard setup={setup} />
      )}
      {setup.loopback && <LoopbackNote origin={setup.origin} />}
      <FeedSubscribe presets={presets} />
      <Disclosure summary="Paste a webhook URL instead">
        <p>
          From an incoming webhook you made yourself (api.slack.com/apps, Incoming Webhooks). Set SLACK_WEBHOOK_KEY first. The URL is
          encrypted and masked once saved.
        </p>
        <div className="pt-1 text-foreground">{pasteForm}</div>
      </Disclosure>
    </section>
  );
}
