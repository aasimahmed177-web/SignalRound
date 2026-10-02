import type { CompanyRequestStatus, CompanyRequestTally } from "@fireround/core/db/schema";
import Link from "next/link";
import { Panel } from "@/components/ui/stat";
import { requestCompanyPath } from "@/lib/company-request-status";

export interface RecentCompanyRequest {
  id: string;
  domain: string;
  status: CompanyRequestStatus;
  companyId: string | null;
  tally: CompanyRequestTally | null;
  dossierStatus: "running" | "done" | "failed" | null;
  dossierStartedAt: Date | null;
  dossierFinishedAt: Date | null;
  createdAt: Date;
}

/** How long the Deep dive ran, or that it is still running: real dive durations for the operator. */
export function dossierNote(r: Pick<RecentCompanyRequest, "dossierStatus" | "dossierStartedAt" | "dossierFinishedAt">): string | null {
  if (!r.dossierStatus) return null;
  if (r.dossierStatus === "running" || !r.dossierStartedAt || !r.dossierFinishedAt)
    return r.dossierStatus === "running" ? "dossier running" : `dossier ${r.dossierStatus}`;
  const seconds = Math.round((r.dossierFinishedAt.getTime() - r.dossierStartedAt.getTime()) / 1000);
  const took = seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
  return r.dossierStatus === "done" ? `dossier ${took}` : `dossier failed after ${took}`;
}

export function CompanyRequestsList({ requests }: { requests: RecentCompanyRequest[] }) {
  return (
    <Panel title="Company requests" flush>
      {requests.length === 0 ? (
        <p className="px-5 py-4 text-body-small text-muted-foreground">No company requests yet.</p>
      ) : (
        <ul className="divide-y divide-border-faint">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-body-small">
              <div className="min-w-0">
                <Link href={requestCompanyPath(request)} className="font-medium text-foreground hover:underline">
                  {request.domain}
                </Link>
                <div className="text-muted-foreground">
                  <time dateTime={request.createdAt.toISOString()}>
                    {request.createdAt.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC
                  </time>
                </div>
              </div>
              <span className="text-mono-small text-muted-foreground">
                {request.status}
                {request.tally && ` · found ${request.tally.found}, verified ${request.tally.verified}`}
                {dossierNote(request) && ` · ${dossierNote(request)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
