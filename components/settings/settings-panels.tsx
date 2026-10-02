"use client";

import { Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, type TransitionStartFunction, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addTarget,
  flushNow,
  newFeedToken,
  removeTarget,
  revokeToken,
  sendTest,
  toggleTarget,
  toggleTargetExpected,
} from "@/app/(dashboard)/settings/actions";
import { Disclosure } from "@/components/settings/disclosure";
import { Field, type PresetOption, presetName, SECONDARY, Secret, withToast } from "@/components/settings/shared";
import { SlackConnect, type SlackSetup } from "@/components/settings/slack-connect";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import type { DigestCadence } from "@/lib/digest";
import { floorLabel, relativeTime } from "@/lib/format";
import type { FeedTokenRow, TargetRow } from "@/lib/settings";
import { cn } from "@/lib/utils";

export function FeedTokensPanel({ tokens, presets }: { tokens: FeedTokenRow[]; presets: PresetOption[] }) {
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState(presets[0]?.slug ?? "series-a-b");
  const [includeExpected, setIncludeExpected] = useState(false);
  const [minted, setMinted] = useState<string[] | null>(null);
  const { confirm, dialog } = useConfirm();

  const revoke = async (t: FeedTokenRow) => {
    const ok = await confirm({
      title: `Revoke ${t.label ?? "this token"}?`,
      description: "Every URL minted with it stops working at once. Readers and automations using it need a new URL.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    withToast(
      start,
      "Revoking token",
      () => revokeToken(t.token_hash),
      () => ({ title: "Token revoked", description: t.label ?? undefined }),
    );
  };

  return (
    <Panel title="Feed URLs" code="RSS · ATOM · JSON">
      <p className={cn("text-body-small", SECONDARY)}>
        A private RSS, Atom, and JSON feed per destination; the token in the URL is the secret.
      </p>
      <Disclosure summary="How feed URLs work" className="mt-1 mb-4">
        <p>
          Feed readers, Slack's <code className="font-mono">/feed</code>, Zapier, and Make fetch these without credentials, so anyone with
          the URL can read the feed. Mint one per destination so each can be revoked on its own if it leaks.
        </p>
      </Disclosure>
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          withToast(
            start,
            "Minting token",
            () => newFeedToken(label, preset, includeExpected),
            () => ({ title: "Feed URLs minted", description: "Copy them now; they are shown once." }),
            (r) => {
              setMinted(r.value.urls);
              setLabel("");
            },
          );
        }}
      >
        <Field label="Label" htmlFor="token-label">
          <Input
            id="token-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Slack #deals"
            className="h-8 text-body-small"
          />
        </Field>
        <Field label="Preset" htmlFor="token-preset">
          <NativeSelect id="token-preset" value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full">
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex items-center gap-2 text-label-small sm:col-span-2">
          <input type="checkbox" checked={includeExpected} onChange={(e) => setIncludeExpected(e.target.checked)} />
          Include expected rounds (not yet closed)
        </label>
        <Button type="submit" disabled={pending} className="justify-self-start">
          <Plus className="size-3.5" /> Mint token
        </Button>
      </form>
      {minted && (
        <div className="mt-3">
          <Secret label="FEED URLS" values={minted} />
        </div>
      )}
      {tokens.length > 0 && (
        <ul className="mt-4 divide-y divide-border-faint border-t border-border-faint">
          {tokens.map((t) => (
            <li key={t.token_hash} className="flex min-h-12 items-center gap-3 py-2 text-body-small">
              <div className="min-w-0 flex-1">
                <div className={cn("truncate", t.revoked_at ? cn("line-through", SECONDARY) : "text-label-small")}>
                  {t.label ?? "default"}
                </div>
                <div className={cn("truncate text-label-x-small font-normal", SECONDARY)}>
                  {presetName(presets, t.preset_slug)} · {t.include_expected ? "includes expected · " : ""}
                  <span className="font-mono">{t.token_hash.slice(0, 8)}</span> · {relativeTime(t.created_at)}
                </div>
              </div>
              {t.revoked_at ? (
                <Tag tone="faint">revoked</Tag>
              ) : (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => revoke(t)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </Panel>
  );
}

type Channel = "slack" | "webhook" | "email";

const PLACEHOLDER: Record<Channel, string> = {
  slack: "https://hooks.slack.com/services/...",
  webhook: "https://your-app.example/hooks/funding",
  email: "you@yourcompany.com",
};

const CHANNEL_NAME: Record<Channel, string> = { slack: "Slack", webhook: "Webhook", email: "Email digest" };

/**
 * One target form, drawn twice: Slack-only under "Paste a webhook URL instead", and webhook or
 * email below it. Where it goes on the first row, what it gets on the second; one column on a phone.
 */
function TargetForm({
  channels,
  idPrefix,
  presets,
  emailReady,
  pending,
  start,
  onSecret,
}: {
  channels: Channel[];
  idPrefix: string;
  presets: PresetOption[];
  emailReady: boolean;
  pending: boolean;
  start: TransitionStartFunction;
  onSecret: (secret: string | null) => void;
}) {
  const [channel, setChannel] = useState<Channel>(channels[0]);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState("");
  const [minConf, setMinConf] = useState("0.5");
  const [includeExpected, setIncludeExpected] = useState(false);
  const [cadence, setCadence] = useState<DigestCadence>("weekly");
  const id = (name: string) => `${idPrefix}-${name}`;
  const single = channels.length === 1;

  return (
    <>
      <form
        className="grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          withToast(
            start,
            "Adding target",
            () => addTarget({ channel, target, label, presetSlug: preset, minConfidence: Number(minConf), includeExpected, cadence }),
            (r) => ({
              title: "Target added",
              description: r.value.secret ? "Copy the signing secret now; it is shown once." : label || undefined,
            }),
            (r) => {
              onSecret(r.value.secret);
              setTarget("");
              setLabel("");
            },
          );
        }}
      >
        {!single && (
          <Field label="Type" htmlFor={id("type")} className="sm:col-span-1">
            <NativeSelect id={id("type")} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="w-full">
              {channels.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_NAME[c]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field
          label={channel === "email" ? "Address" : channel === "slack" ? "Webhook URL" : "URL"}
          htmlFor={id("destination")}
          className={single ? "sm:col-span-4" : "sm:col-span-3"}
        >
          <Input
            id={id("destination")}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={PLACEHOLDER[channel]}
            type={channel === "email" ? "email" : "text"}
            className="h-8 text-body-small"
          />
        </Field>
        <Field label="Label" htmlFor={id("label")} className="sm:col-span-2">
          <Input
            id={id("label")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={channel === "slack" ? "#deals" : "Deals channel"}
            className="h-8 text-body-small"
          />
        </Field>
        <Field label="Preset" htmlFor={id("preset")} className="sm:col-span-2">
          <NativeSelect id={id("preset")} value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full">
            <option value="">All presets</option>
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Receives" htmlFor={id("floor")} className="sm:col-span-2">
          <NativeSelect id={id("floor")} value={minConf} onChange={(e) => setMinConf(e.target.value)} className="w-full">
            <option value="0.75">Verified only</option>
            <option value="0.5">Verified and checked</option>
            <option value="0">Everything</option>
          </NativeSelect>
        </Field>
        {channel === "email" ? (
          <Field label="Cadence" htmlFor={id("cadence")} className="sm:col-span-1">
            <NativeSelect
              id={id("cadence")}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as DigestCadence)}
              className="w-full"
            >
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
            </NativeSelect>
          </Field>
        ) : (
          <div className="hidden sm:col-span-1 sm:block" aria-hidden />
        )}
        <label className="flex items-center gap-2 text-label-small sm:col-span-3">
          <input type="checkbox" checked={includeExpected} onChange={(e) => setIncludeExpected(e.target.checked)} />
          Include expected rounds (not yet closed)
        </label>
        <div className="flex items-end sm:col-span-1 sm:justify-end">
          <Button type="submit" disabled={pending || !target}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      </form>
      {channel === "email" && !emailReady && (
        <p className={cn("mt-2 text-body-small", SECONDARY)}>
          <span className="text-crimson-ink">Not sending yet:</span> set <code className="font-mono">RESEND_API_KEY</code> and{" "}
          <code className="font-mono">DIGEST_FROM</code> in the environment. Rows for email targets wait in the outbox until then.
        </p>
      )}
    </>
  );
}

/** What the Slack callback sent back in the query string, read once by the page. */
export type SlackReturn = { status: "connected"; channel: string; target: string } | { status: "error"; message: string } | null;

export function TargetsPanel({
  targets,
  presets,
  counts,
  emailReady,
  slack,
  slackReturn,
  publicSlack,
}: {
  /** Slack webhook URLs arrive masked; the page never sends one whole. */
  targets: TargetRow[];
  presets: PresetOption[];
  counts: Record<string, number>;
  /** RESEND_API_KEY and DIGEST_FROM are both set, so an email target can send. */
  emailReady: boolean;
  slack: SlackSetup;
  slackReturn: SlackReturn;
  /** The public Add to Slack's status and counts, rendered on the server (never a channel or a webhook). */
  publicSlack?: ReactNode;
}) {
  const [pending, start] = useTransition();
  const [secret, setSecret] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(slackReturn?.status === "connected" ? slackReturn.target : null);
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const announced = useRef(false);
  const freshRow = useRef<HTMLLIElement>(null);

  const name = (t: TargetRow) => t.label ?? t.channel;

  const test = (t: TargetRow) =>
    withToast(
      start,
      `Sending a test to ${name(t)}`,
      () => sendTest(t.id),
      (r) =>
        !r.value.round
          ? { title: "No record to send yet", description: "Run a sweep first; the test sends the latest record." }
          : r.value.failed > 0 || r.value.error
            ? null
            : { title: `Test sent to ${name(t)}` },
      (r) => {
        // A delivery that failed downstream is still an action that returned: say so as an error.
        if (r.value.round && (r.value.failed > 0 || r.value.error))
          toast.error(`Test to ${name(t)} failed`, { description: r.value.error ?? `${r.value.failed} failed` });
      },
    );

  // The Slack round trip ends here: say how it went once, point at the new row, and drop the
  // query so a reload does not say it again. The test stays a click, never automatic.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per return from Slack.
  useEffect(() => {
    if (!slackReturn || announced.current) return;
    announced.current = true;
    if (slackReturn.status === "error") {
      toast.error("Slack not connected", { description: slackReturn.message, duration: 10_000 });
    } else {
      const t = targets.find((x) => x.id === slackReturn.target);
      toast.success(`Slack connected to ${slackReturn.channel}`, {
        description: "Verified and checked rounds from every preset post there. Send a test to see one.",
        duration: 12_000,
        action: t ? { label: "Send a test", onClick: () => test(t) } : undefined,
      });
      freshRow.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    router.replace("/settings", { scroll: false });
  }, []);

  const remove = async (t: TargetRow) => {
    const ok = await confirm({
      title: `Delete ${name(t)}?`,
      description: "It stops receiving records, and anything still queued for it is dropped. Its signing secret cannot be recovered.",
      confirmLabel: "Delete target",
    });
    if (!ok) return;
    withToast(
      start,
      "Deleting target",
      () => removeTarget(t.id),
      () => ({ title: "Target deleted", description: name(t) }),
      () => {
        if (fresh === t.id) setFresh(null);
      },
    );
  };

  const formProps = { presets, emailReady, pending, start, onSecret: setSecret };

  return (
    <Panel
      title="Delivery"
      code="SLACK · WEBHOOKS · EMAIL"
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            withToast(
              start,
              "Flushing the outbox",
              () => flushNow(),
              (r) => ({ title: `Sent ${r.value.sent}`, description: `${r.value.failed} failed, ${r.value.deadLettered} dead-lettered` }),
            )
          }
        >
          <RefreshCw className="size-3.5" /> Flush outbox
        </Button>
      }
    >
      <p className={cn("text-body-small", SECONDARY)}>Each target gets every new or updated record it accepts, once.</p>
      <Disclosure summary="How delivery works" className="mt-1 mb-5">
        <p>
          A target receives verified records only (published rows), verified and checked (published and flagged), or everything, from one
          preset or all of them.
        </p>
        <p>
          Slack targets post Block Kit through an incoming webhook, made by Add to Slack or pasted. Webhook targets receive a Standard
          Webhooks request (<code className="font-mono">webhook-id</code>, <code className="font-mono">webhook-timestamp</code>,{" "}
          <code className="font-mono">webhook-signature</code>) signed with the secret shown once at creation. Email targets collect their
          rows and receive one digest a day or a week, sent through Resend.
        </p>
      </Disclosure>
      <SlackConnect
        setup={slack}
        presets={presets}
        pasteForm={<TargetForm channels={["slack"]} idPrefix="slack-target" {...formProps} />}
      />
      {publicSlack}
      <div className="mt-6 space-y-3 border-t border-border-faint pt-5">
        <h3 className="text-label-small">Webhook or email digest</h3>
        <TargetForm channels={["webhook", "email"]} idPrefix="target" {...formProps} />
      </div>
      {secret && (
        <div className="mt-3">
          <Secret label="WEBHOOK SIGNING SECRET" values={[secret]} />
        </div>
      )}
      {targets.length > 0 && (
        <ul className="mt-5 divide-y divide-border-faint border-t border-border-faint">
          {targets.map((t) => {
            const isFresh = t.id === fresh;
            return (
              <li
                key={t.id}
                ref={isFresh ? freshRow : undefined}
                className={cn(
                  "flex min-h-12 items-center gap-3 py-2 text-body-small",
                  isFresh && "-mx-2 rounded-8 bg-heat-4 px-2 ring-1 ring-heat-40",
                )}
              >
                <Switch
                  checked={t.enabled}
                  disabled={pending}
                  aria-label={`${name(t)} enabled`}
                  onCheckedChange={(v) =>
                    withToast(
                      start,
                      v ? "Turning on" : "Turning off",
                      () => toggleTarget(t.id, v),
                      () => ({ title: v ? "Target on" : "Target off", description: name(t) }),
                    )
                  }
                />
                {/* Name and type on top, destination and what it receives under it: one shape at every width. */}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("truncate", t.label ? "text-label-small" : SECONDARY)} title={t.label ?? undefined}>
                      {t.label ?? "Unlabeled"}
                    </span>
                    <Tag>{t.channel}</Tag>
                    {isFresh && <Tag tone="heat">new</Tag>}
                  </div>
                  <div
                    className={cn("truncate text-mono-small font-normal", SECONDARY)}
                    title={t.channel === "slack" ? undefined : t.target}
                  >
                    {t.target}
                  </div>
                  <div className={cn("truncate text-label-x-small font-normal", SECONDARY)}>
                    {presetName(presets, t.preset_slug)} · {floorLabel(t.min_confidence)}
                  </div>
                  <label className="flex items-center gap-2 text-label-x-small">
                    <input
                      type="checkbox"
                      checked={t.include_expected}
                      disabled={pending}
                      onChange={(e) =>
                        withToast(
                          start,
                          "Updating target",
                          () => toggleTargetExpected(t.id, e.target.checked),
                          () => ({ title: "Target updated" }),
                        )
                      }
                    />
                    Include expected rounds
                  </label>
                </div>
                <span className="flex shrink-0 items-center justify-end gap-1">
                  <Button size="sm" variant={isFresh ? "outline" : "ghost"} disabled={pending} onClick={() => test(t)}>
                    {isFresh && <Send className="size-3.5" />}
                    {isFresh ? "Send a test" : "Send test"}
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={pending} onClick={() => remove(t)} aria-label={`Delete ${name(t)}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className={cn("mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-label-x-small font-normal", SECONDARY)}>
        <Tag>outbox</Tag>
        {["pending", "sent", "failed", "dead_letter"].map((k) => (
          <span key={k}>
            {k.replace("_", " ")} <span className="font-mono tabular-nums">{counts[k] ?? 0}</span>
          </span>
        ))}
      </div>
      {dialog}
    </Panel>
  );
}
