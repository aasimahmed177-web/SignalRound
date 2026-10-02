"use client";

import { Pause, Play, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveSubscription, sendSubscriptionTest, setSubscriptionPaused, unsubscribe } from "@/app/(slack)/slack/actions";
import { CadencePicker, StoredNote } from "@/components/slack/install-controls";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/stat";
import type { ActionResult } from "@/lib/action-result";
import type { Cadence } from "@/lib/slack-subscriptions";

export interface ManageState {
  token: string;
  /** "#deals", ready to print. */
  channel: string;
  presetSlug: string;
  includeExpected: boolean;
  cadence: Cadence;
  status: "active" | "paused";
  presets: Array<{ slug: string; name: string }>;
  /** Server-rendered words: "3 of 50 posts today · last post 2 hours ago". */
  activity: string;
  /** Opened from a message's Unsubscribe link: ask straight away. */
  askUnsubscribe: boolean;
}

/**
 * The manage page's controls for one live channel: what it receives, a test, pause and resume,
 * and unsubscribe behind a confirmation. Every action sends the page's token and nothing else the
 * server trusts; a refusal comes back as a sentence for the toast.
 */
export function ManagePanel({ state }: { state: ManageState }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preset, setPreset] = useState(state.presetSlug);
  const [cadence, setCadence] = useState<Cadence>(state.cadence);
  const [includeExpected, setIncludeExpected] = useState(state.includeExpected);
  const { confirm, dialog } = useConfirm();
  const asked = useRef(false);
  const dirty = preset !== state.presetSlug || cadence !== state.cadence || includeExpected !== state.includeExpected;

  const run = (label: string, fn: () => Promise<ActionResult>, done: string, description?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(`${label} did not go through`, { description: r.error, duration: 10_000 });
        return;
      }
      toast.success(done, description ? { description } : undefined);
      router.refresh();
    });

  const leave = async () => {
    const ok = await confirm({
      title: `Unsubscribe ${state.channel}?`,
      description:
        "Fireround stops posting there and forgets the channel's webhook. To get rounds again, add Fireround to the channel again.",
      confirmLabel: "Unsubscribe",
    });
    if (!ok) return;
    run("Unsubscribe", () => unsubscribe(state.token), `Unsubscribed ${state.channel}`, "Nothing more will post there.");
  };

  // A message's Unsubscribe link lands here with ?unsubscribe=1: ask once, then drop the query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per arrival from the link.
  useEffect(() => {
    if (!state.askUnsubscribe || asked.current) return;
    asked.current = true;
    router.replace(window.location.pathname, { scroll: false });
    void leave();
  }, []);

  const paused = state.status === "paused";
  return (
    <div className="space-y-4">
      <Panel title="What this channel gets" code="PRESET · CADENCE">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              "Saving",
              () => saveSubscription(state.token, { preset, cadence, includeExpected }),
              "Saved",
              "The next post follows the new choice.",
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="manage-preset" className="text-label-small">
              Rounds
            </label>
            <NativeSelect
              id="manage-preset"
              value={preset}
              disabled={pending}
              onChange={(e) => setPreset(e.target.value)}
              className="h-9 w-full sm:w-80"
            >
              {state.presets.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <span className="text-label-small">How often</span>
            <CadencePicker value={cadence} onChange={setCadence} disabled={pending} className="sm:w-80" />
          </div>
          <label className="flex items-center gap-2 text-label-small">
            <input type="checkbox" checked={includeExpected} onChange={(e) => setIncludeExpected(e.target.checked)} disabled={pending} />
            Include expected rounds (not yet closed)
          </label>
          <Button type="submit" variant="default" disabled={!dirty || pending}>
            Save
          </Button>
        </form>
      </Panel>
      <Panel title="Channel">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending || paused}
            onClick={() =>
              run(
                "The test",
                () => sendSubscriptionTest(state.token),
                `Test sent to ${state.channel}`,
                "The newest round, as the channel gets it.",
              )
            }
          >
            <Send className="size-3.5" /> Send a test
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                paused ? "Resuming" : "Pausing",
                () => setSubscriptionPaused(state.token, !paused),
                paused ? `${state.channel} resumed` : `${state.channel} paused`,
                paused ? "New rounds post there again." : "Nothing posts until you resume.",
              )
            }
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void leave()}>
            <Trash2 className="size-3.5" /> Unsubscribe
          </Button>
        </div>
        <p className="mt-4 text-body-small text-muted-foreground">{state.activity}</p>
      </Panel>
      <StoredNote />
      {dialog}
    </div>
  );
}
