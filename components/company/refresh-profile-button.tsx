"use client";

import { Loader2, RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { type ReenrichActionResult, reenrichCompany } from "@/app/(dashboard)/companies/actions";
import { Button } from "@/components/ui/button";

const COST_HINT = "Rereads the homepage, verified against the record; about 10 to 25 credits";

/**
 * Clears the stored profile (and the logo, website, and domain the old search guessed) and runs
 * the enrichment step once for this company. The repair for a profile that describes a namesake.
 * Cheap enough to skip a confirm; the outcome lands in a toast, where a long reason has room.
 */
export function RefreshProfileButton({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = () => {
    const id = toast.loading("Rereading the homepage");
    start(async () => {
      try {
        const r = await reenrichCompany(companyId);
        if (!r.ok) throw new Error(r.error);
        const v: ReenrichActionResult = r.value;
        router.refresh();
        if (v.status === "verified") {
          toast.success(`Profile rebuilt from ${v.website ?? "the homepage"}`, {
            id,
            description: `${v.creditsEstimated} credits`,
          });
        } else {
          toast.error("No homepage passed the identity check", { id, description: v.error ?? "Nothing was written." });
        }
      } catch (err) {
        toast.error("Profile refresh failed", { id, description: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  const Icon = pending ? Loader2 : RotateCw;
  return (
    <Button variant="ghost" size="sm" onClick={run} disabled={pending} title={COST_HINT}>
      <Icon className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
      {pending ? "Verifying" : "Refresh profile"}
    </Button>
  );
}
