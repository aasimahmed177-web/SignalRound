"use client";

import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deepDiveCompany } from "@/app/(dashboard)/companies/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Starts one deep dive on the company. In the header it reads "Deep dive"; on the dossier panel it
 * is the "Refresh" that reruns. Either way it is the priciest click on the page, so it asks first
 * and states the cost there. The dive runs in the background (the agent, then the check against its
 * sources), so the notice says it started and the dossier appears on the page when it is checked.
 */
export function DeepDiveButton({ companyId, mode = "dive" }: { companyId: string; mode?: "dive" | "refresh" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const refresh = mode === "refresh";

  const run = () => {
    setOpen(false);
    const job = deepDiveCompany(companyId).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
    toast.promise(job, {
      loading: "Starting the deep dive.",
      success: () => {
        router.refresh();
        return "Deep dive started. The dossier appears here once it is checked against its sources, usually in 5 to 10 minutes.";
      },
      error: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    });
    start(async () => {
      await job.catch(() => undefined);
    });
  };

  const Icon = pending ? Loader2 : refresh ? RefreshCw : Sparkles;
  const label = pending ? "Starting" : refresh ? "Refresh" : "Deep dive";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={refresh ? "ghost" : "outline"} size="sm" disabled={pending}>
          <Icon className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{refresh ? "Refresh the dossier?" : "Run a deep dive?"}</DialogTitle>
          <DialogDescription>
            A Firecrawl agent reads the web for this company: founders, prior rounds, customers, backers, competitors, and why the round
            matters. Every claim is then checked against the pages it came from, and only what checks out is kept.{" "}
            {refresh ? "The new dossier replaces the one on this page." : "The dossier appears on this page."}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-small">
          <dt className="text-muted-foreground">Cost</dt>
          <dd>
            about <span className="text-mono-small">300</span> credits, <span className="text-mono-small">2,500</span> at most
          </dd>
          <dt className="text-muted-foreground">Time</dt>
          <dd>5 to 10 minutes, in the background</dd>
        </dl>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={run}>{refresh ? "Refresh dossier" : "Run deep dive"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
