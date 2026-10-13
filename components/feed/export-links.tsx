"use client";

import { STAGES } from "@fireround/core/client";
import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";

/** The feed's URL params in the read API's vocabulary; anything the API would 400 on stays behind. */
function exportQuery(sp: URLSearchParams): URLSearchParams {
  const qs = new URLSearchParams();
  for (const key of ["q", "sector", "preset"]) {
    const v = sp.get(key);
    if (v) qs.set(key, v);
  }
  // The feed drops a stage it does not know; the API would refuse the whole request.
  const stages = (sp.get("stage") ?? "").split(",").filter((s) => (STAGES as readonly string[]).includes(s));
  if (stages.length) qs.set("stage", stages.join(","));
  // The feed's "Unread only" reads new and updated rows; the API spells both.
  if (sp.get("status") === "new") qs.set("status", "new,updated");
  const min = Number(sp.get("min"));
  if (Number.isFinite(min) && min > 0) qs.set("min_usd", String(min));
  if (sp.get("sort") === "amount") qs.set("sort", "amount");
  return qs;
}

/** CSV and JSON links that carry the current filters and sort. */
export function ExportLinks() {
  const base = `/api/v1/rounds?${exportQuery(new URLSearchParams(useSearchParams().toString())).toString()}`;
  return (
    <>
      <Button asChild variant="outline" size="sm">
        {/* No limit: the CSV is the whole filtered set; the JSON link is the API's largest page. */}
        <a href={`${base}&format=csv`} onClick={() => track("fireround_export_clicked", { format: "csv" })}>
          <Download className="size-3.5" /> CSV
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={`${base}&limit=200`} onClick={() => track("fireround_export_clicked", { format: "json" })}>
          JSON
        </a>
      </Button>
    </>
  );
}
