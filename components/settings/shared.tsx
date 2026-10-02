"use client";

import { Copy } from "lucide-react";
import { type ReactNode, type TransitionStartFunction, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";

// The pieces the settings panels share: the Feed URLs and Delivery panels and the Slack block.

/** What the page passes for each preset: the slug is stored and sent, the name is what a reader sees. */
export interface PresetOption {
  slug: string;
  name: string;
}

/** A preset slug as its name; a slug that no longer matches a preset (deleted since) shows as itself. */
export function presetName(presets: PresetOption[], slug: string | null): string {
  if (!slug) return "All presets";
  return presets.find((p) => p.slug === slug)?.name ?? slug;
}

type Result = { ok: true } | { ok: false; error: string };

/**
 * Every settings action reports through one toast: loading while the server works, then the
 * success line or the error. Returns the result so a form can clear itself or show a secret.
 */
export function withToast<R extends Result>(
  start: TransitionStartFunction,
  loading: string,
  fn: () => Promise<R>,
  done: (r: Extract<R, { ok: true }>) => { title: string; description?: string } | null,
  after?: (r: Extract<R, { ok: true }>) => void,
) {
  start(async () => {
    const id = toast.loading(loading);
    try {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error, { id });
        return;
      }
      const ok = r as Extract<R, { ok: true }>;
      const message = done(ok);
      if (message) toast.success(message.title, { id, description: message.description });
      else toast.dismiss(id);
      after?.(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id });
    }
  });
}

export const SECONDARY = "text-black-alpha-56 dark:text-muted-foreground";

/** A small label over its control; the form rows are built from these. */
export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className={cn("text-label-x-small", SECONDARY)}>
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A copy icon with a toast either way; the fallback is selecting the text by hand. */
export function CopyButton({ value, label = "Copy", onCopied }: { value: string; label?: string; onCopied?: () => void }) {
  return (
    <button
      type="button"
      className={cn("shrink-0 hover:text-foreground", SECONDARY)}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            onCopied?.();
            toast.success("Copied");
          },
          () => toast.error("Could not copy; select the text instead."),
        );
      }}
      aria-label={label}
    >
      <Copy className="size-3.5" />
    </button>
  );
}

/** A value shown once (a feed URL, a signing secret, a /feed command), each line with its copy button. */
export function Secret({ label, values }: { label: string; values: string[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="rounded-8 border border-heat-40 bg-heat-4 p-3">
      <div className="mb-1.5">
        <Tag tone="heat">{label} · SHOWN ONCE</Tag>
      </div>
      <ul className="space-y-1">
        {values.map((v) => (
          <li key={v} className="flex items-center gap-2">
            <code className="min-w-0 flex-1 text-mono-small font-normal break-all">{v}</code>
            <CopyButton value={v} onCopied={() => setCopied(v)} />
            {copied === v && <Tag>copied</Tag>}
          </li>
        ))}
      </ul>
    </div>
  );
}
