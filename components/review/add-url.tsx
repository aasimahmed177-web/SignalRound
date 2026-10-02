"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ingestUrl } from "@/app/(dashboard)/review/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

const MUTED = "text-black-alpha-56 dark:text-muted-foreground";

/** Paste an article the sweep missed; it is read like a monitor alert and lands here or on the feed. */
export function AddUrl({ presets }: { presets: Array<{ slug: string; name: string }> }) {
  const [url, setUrl] = useState("");
  const [presetSlug, setPresetSlug] = useState(presets[0]?.slug ?? "series-a-b");
  const [note, setNote] = useState<{ error?: string; runId?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const r = await ingestUrl({ url, presetSlug });
      if (r.ok) {
        setNote({ runId: r.value.runId });
        setUrl("");
      } else {
        setNote({ error: r.error });
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://example.com/startup-raises-series-a"
          className="flex-1"
          aria-label="Article URL"
        />
        <NativeSelect value={presetSlug} onChange={(e) => setPresetSlug(e.target.value)} aria-label="Preset" className="sm:w-48">
          {presets.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
        <Button onClick={submit} disabled={pending || url.trim() === ""}>
          {pending ? "Reading" : "Read it"}
        </Button>
      </div>
      {note?.runId && (
        <p className={cn("text-body-small", MUTED)}>
          Reading… it lands here or on the feed in a minute or two. Run{" "}
          <Link href="/runs" className="underline underline-offset-2 hover:text-foreground">
            {note.runId}
          </Link>{" "}
          on Runs.
        </p>
      )}
      {note?.error && <p className="text-body-small text-heat-100">{note.error}</p>}
    </div>
  );
}
