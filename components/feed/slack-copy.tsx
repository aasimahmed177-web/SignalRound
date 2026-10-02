"use client";

import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * "Slack" in the demo hero's Subscribe line: one click copies the /feed command for the preset in
 * view, and a toast says where to paste it and what Slack's RSS app will post. It matches the
 * landing page's "Get it in your Slack". Without a clipboard the toast carries the command itself.
 */
export function SlackCopy({ command, className }: { command: string; className?: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Copied the Slack command", {
        description: "Paste it in any Slack channel. Slack's RSS app posts each new round as a link.",
      });
    } catch {
      toast("Copy this into any Slack channel", { description: command, duration: 12000 });
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={command}
      aria-label="Copy the Slack /feed command"
      className={cn(
        "tap relative whitespace-nowrap rounded-4 text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      Slack
    </button>
  );
}
