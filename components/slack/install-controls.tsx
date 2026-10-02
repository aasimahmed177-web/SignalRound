"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import type { Cadence } from "@/lib/slack-subscriptions";
import { cn } from "@/lib/utils";

/** The public install's start, with the visitor's picks; the route re-checks both. */
export function connectHref(preset: string, cadence: Cadence): string {
  return `/api/slack/connect?${new URLSearchParams({ preset, cadence })}`;
}

const CADENCE_OPTIONS: Array<{ value: Cadence; label: string; hint: string }> = [
  { value: "instant", label: "Each round", hint: "as it is found" },
  { value: "daily", label: "Daily digest", hint: "07:00 UTC" },
];

/**
 * How often a channel hears from Fireround, as two radio buttons drawn as a segmented control:
 * native inputs, so arrow keys and screen readers work without a library.
 */
export function CadencePicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Cadence;
  onChange: (next: Cadence) => void;
  disabled?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn("min-w-0", className)} disabled={disabled}>
      <legend className="sr-only">How often</legend>
      <div className="grid grid-cols-2 gap-1 rounded-10 bg-black-alpha-4 p-1 dark:bg-white/6">
        {CADENCE_OPTIONS.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col items-start rounded-8 px-3 py-1.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
              value === o.value ? "bg-card shadow-xs dark:bg-white/10" : "hover:bg-black-alpha-4 dark:hover:bg-white/6",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span className="text-label-small text-foreground">{o.label}</span>
            <span className="truncate text-label-x-small font-normal text-muted-foreground">{o.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The preset pill: the browser's own select with a chevron drawn over it, sized to the chosen name. */
export function PresetPill({
  presets,
  value,
  onChange,
  label = "Rounds to post",
  disabled,
}: {
  presets: Array<{ slug: string; name: string }>;
  value: string;
  onChange: (slug: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex max-w-full">
      <NativeSelect
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 max-w-full cursor-pointer appearance-none truncate rounded-full pointer-coarse:h-11 field-sizing-content border-0 bg-black-alpha-4 pr-8.5 pl-3 text-label-small text-foreground outline-none hover:bg-black-alpha-8 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default dark:bg-white/6 dark:scheme-dark dark:hover:bg-white/10"
      >
        {presets.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
      <ChevronDownIcon aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

/** The one line on what the install keeps, shown wherever the button is; /privacy says it in full. */
export function StoredNote() {
  return (
    <p className="text-label-x-small font-normal text-black-alpha-56 dark:text-muted-foreground">
      We store the workspace and channel names and IDs, the channel&apos;s webhook (encrypted), Slack install IDs, your picks, and when we
      last posted. Every message links to manage or unsubscribe.{" "}
      <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
        Privacy
      </Link>
    </p>
  );
}
