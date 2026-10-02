import { dossierVerifyProviderFor, reconcileProviderFor } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { desc } from "drizzle-orm";
import { headers } from "next/headers";
import { connection } from "next/server";
import { type ReactNode, Suspense } from "react";
import { CompanyRequestsList } from "@/components/settings/company-requests-list";
import { CoveragePanel } from "@/components/settings/coverage-panel";
import { PublicSlackSummary } from "@/components/settings/public-slack";
import { FeedTokensPanel, type SlackReturn, TargetsPanel } from "@/components/settings/settings-panels";
import { PageBody } from "@/components/shell/page-body";
import { PageHeader } from "@/components/shell/page-header";
import { PanelSkeleton, SkeletonLine } from "@/components/ui/skeletons";
import { Panel } from "@/components/ui/stat";
import { isPublicDemo } from "@/lib/access";
import { db } from "@/lib/db";
import { deliveryCounts } from "@/lib/delivery";
import { isLoopbackOrigin, publicOrigin } from "@/lib/origin";
import { listPresets } from "@/lib/presets";
import { listFeedTokens, listMonitors, listTargets, type TargetRow } from "@/lib/settings";
import { maskWebhookUrl, slackErrorMessage, slackManifestUrl, slackOAuthConfig, slackRedirectUri } from "@/lib/slack";
import { publicSlackMissing, subscriptionCap, subscriptionCounts } from "@/lib/slack-subscriptions";
import { readCoverage } from "./actions";

/**
 * One environment fact per hairline row: the label left, the value in mono right. Values wrap
 * rather than truncate (the tail is usually the part that says what to set), and below sm the
 * value drops under its label so a long one gets the full width.
 */
function EnvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-body-small text-black-alpha-56 dark:text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-mono-small font-normal break-words sm:text-right">{children}</dd>
    </div>
  );
}

type Search = { slack?: string; target?: string; reason?: string };

/**
 * The Slack callback's report, from the query string it redirected with. Only a target that
 * exists counts as connected, named by its stored label, and an error shows one of lib/slack's
 * own sentences, so a crafted link cannot put words in the toast.
 */
function slackReturnFrom(search: Search, targets: TargetRow[]): SlackReturn {
  if (search.slack === "connected") {
    const t = targets.find((x) => x.id === search.target);
    return t ? { status: "connected", channel: t.label ?? "Slack", target: t.id } : null;
  }
  if (search.slack === "error") return { status: "error", message: slackErrorMessage(search.reason) };
  return null;
}

async function SettingsBody({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const handle = await db();
  const [tokens, rawTargets, counts, presets, monitors, coverage, search, requestHeaders, subscriptions, requests] = await Promise.all([
    listFeedTokens(handle),
    listTargets(handle),
    deliveryCounts(handle),
    listPresets(),
    listMonitors(handle),
    readCoverage(),
    searchParams,
    headers(),
    subscriptionCounts(handle),
    process.env.COMPANY_REQUESTS === "1"
      ? handle
          .select({
            id: schema.companyRequests.id,
            domain: schema.companyRequests.domain,
            status: schema.companyRequests.status,
            companyId: schema.companyRequests.companyId,
            tally: schema.companyRequests.tally,
            dossierStatus: schema.companyRequests.dossierStatus,
            dossierStartedAt: schema.companyRequests.dossierStartedAt,
            dossierFinishedAt: schema.companyRequests.dossierFinishedAt,
            createdAt: schema.companyRequests.createdAt,
          })
          .from(schema.companyRequests)
          .orderBy(desc(schema.companyRequests.createdAt))
          .limit(20)
      : Promise.resolve([]),
  ]);
  // A Slack webhook URL posts to its channel, so it never leaves the server whole.
  const targets = rawTargets.map((t) => (t.channel === "slack" ? { ...t, target: maskWebhookUrl(t.target) } : t));
  const origin = publicOrigin(requestHeaders);
  const slack = {
    configured: slackOAuthConfig() !== null,
    origin,
    manifestUrl: slackManifestUrl(origin),
    redirectUri: slackRedirectUri(origin),
    loopback: isLoopbackOrigin(origin),
    vercel: process.env.VERCEL === "1",
  };
  // The forms and lists show names; the slug is what they send and store.
  const presetNames = presets.map((p) => ({ slug: p.slug, name: p.name }));
  const hasKey = Boolean(process.env.FIRECRAWL_API_KEY && process.env.FIRECRAWL_API_KEY !== "fc-YOUR-API-KEY");
  const reconciler = reconcileProviderFor();
  const dossierChecker = dossierVerifyProviderFor();
  return (
    <PageBody width="narrow">
      <CoveragePanel setting={coverage} presets={presets} monitors={monitors.length} />
      <Panel title="Environment" code="KEYS">
        <dl className="-my-2.5 divide-y divide-border-faint">
          <EnvRow label="Firecrawl key">
            {hasKey ? "set (FIRECRAWL_API_KEY)" : <span className="text-crimson-ink">missing: set FIRECRAWL_API_KEY</span>}
          </EnvRow>
          <EnvRow label="Verification">
            {reconciler ? (
              `reconcile: ${reconciler.modelId} via ${reconciler.provider}, every source read together`
            ) : (
              <span title="Set AI_GATEWAY_API_KEY (or an OpenAI, OpenRouter, or Anthropic key) to read each record against all of its sources with a model.">
                judge: Firecrawl reads the primary page (no model key set)
              </span>
            )}
          </EnvRow>
          <EnvRow label="Dossier check">
            {dossierChecker ? (
              `${dossierChecker.modelId} via ${dossierChecker.provider}, every claim against its sources (DOSSIER_VERIFY_MODEL overrides)`
            ) : (
              <span className="text-black-alpha-56 dark:text-muted-foreground">
                off: no model key is set, so no dossier is saved (the deep dive refuses to start)
              </span>
            )}
          </EnvRow>
          <EnvRow label="Database">{process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "embedded PGlite under ./data"}</EnvRow>
          <EnvRow label="Webhook signature">
            {process.env.FIRECRAWL_WEBHOOK_SECRET
              ? "verified (FIRECRAWL_WEBHOOK_SECRET)"
              : "not set: monitor webhooks are refused in production"}
          </EnvRow>
          <EnvRow label="Webhook bearer">{process.env.WEBHOOK_BEARER_TOKEN ? "required on every monitor webhook" : "not set"}</EnvRow>
          <EnvRow label="Dashboard password">
            {process.env.DASHBOARD_PASSWORD ? (
              "set: Basic auth on the dashboard and /api/v1"
            ) : (
              <span className={process.env.NODE_ENV === "production" ? "text-crimson-ink" : undefined}>
                not set: anyone who reaches this URL can run sweeps and spend credits (DASHBOARD_PASSWORD)
              </span>
            )}
          </EnvRow>
          <EnvRow label="Slack app">
            {slack.configured ? (
              "set: Add to Slack is on (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_WEBHOOK_KEY)"
            ) : (
              <span className="text-black-alpha-56 dark:text-muted-foreground">
                not set: needs SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_WEBHOOK_KEY (at least 32 characters)
              </span>
            )}
          </EnvRow>
          <EnvRow label="Slack events">
            {process.env.SLACK_SIGNING_SECRET?.trim()
              ? "verified: /api/webhooks/slack (SLACK_SIGNING_SECRET)"
              : "not set: uninstall and token revocation events are refused (SLACK_SIGNING_SECRET)"}
          </EnvRow>
          <EnvRow label="Public Slack">
            {publicSlackMissing().length === 0 ? (
              isPublicDemo() ? (
                "on: visitors can add their own channels (SLACK_WEBHOOK_KEY encrypts each webhook)"
              ) : (
                "configured, but only offered in demo mode (PUBLIC_DEMO=1)"
              )
            ) : (
              <span className="text-black-alpha-56 dark:text-muted-foreground">off: needs {publicSlackMissing().join(", ")}</span>
            )}
          </EnvRow>
          <EnvRow label="Cron">
            {process.env.CRON_SECRET ? (
              "set: the scheduled sweep and delivery ticks are gated (CRON_SECRET)"
            ) : process.env.NODE_ENV === "production" ? (
              <span className="text-crimson-ink">
                not set: the cron routes refuse every call, so nothing sweeps on a schedule (CRON_SECRET)
              </span>
            ) : (
              <span className="text-black-alpha-56 dark:text-muted-foreground">not set: open in development</span>
            )}
          </EnvRow>
        </dl>
      </Panel>
      <FeedTokensPanel tokens={tokens} presets={presetNames} />
      {process.env.COMPANY_REQUESTS === "1" && <CompanyRequestsList requests={requests} />}
      <TargetsPanel
        targets={targets}
        presets={presetNames}
        counts={counts}
        emailReady={Boolean(process.env.RESEND_API_KEY && process.env.DIGEST_FROM)}
        slack={slack}
        slackReturn={slackReturnFrom(search, rawTargets)}
        publicSlack={
          <PublicSlackSummary
            demo={isPublicDemo()}
            missing={publicSlackMissing()}
            counts={subscriptions}
            cap={subscriptionCap()}
            manifestUrl={slackManifestUrl(origin, { public: true })}
          />
        }
      />
    </PageBody>
  );
}

/** Label-and-value rows under a hairline each, the estimate's and the environment's shape. */
function RowsSkeleton({ labels }: { labels: string[] }) {
  return (
    <ul className="divide-y divide-border-faint">
      {labels.map((w) => (
        <li key={w} className="flex items-center justify-between gap-4 py-2.5">
          <SkeletonLine width={w.split(":")[0]} />
          <SkeletonLine text="text-mono-small" width={w.split(":")[1]} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The settings page's shape while it loads: the coverage panel (four rung cards, then the monthly
 * estimate), then the environment and feed token panels.
 */
function SettingsSkeleton() {
  return (
    <PageBody width="narrow">
      <PanelSkeleton title="Coverage">
        <SkeletonLine width="w-96" />
        <SkeletonLine text="text-label-x-small" width="w-36" className="mt-1 mb-4 py-[3px]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {["lite", "standard", "deep", "max"].map((k) => (
            <div key={k} className="rounded-12 border border-border-faint p-4">
              <SkeletonLine text="text-label-medium" width="w-16" />
              <SkeletonLine text="text-title-h6" width="w-28" className="mt-2" />
              <SkeletonLine width="w-24" />
              <div className="mt-2">
                <SkeletonLine width="w-full" />
                <SkeletonLine width="w-full" />
                <SkeletonLine width="w-2/3" />
              </div>
            </div>
          ))}
        </div>
        <SkeletonLine text="text-mono-x-small" width="w-28" className="mt-6 mb-1" />
        <RowsSkeleton labels={["w-48:w-28", "w-24:w-12", "w-56:w-12", "w-60:w-8", "w-44:w-12", "w-52:w-12", "w-28:w-12"]} />
      </PanelSkeleton>
      <PanelSkeleton title="Environment">
        <div className="-my-2.5">
          <RowsSkeleton labels={["w-24:w-48", "w-20:w-72", "w-16:w-56", "w-32:w-64", "w-28:w-40", "w-36:w-60", "w-20:w-64", "w-10:w-52"]} />
        </div>
      </PanelSkeleton>
    </PageBody>
  );
}

export const metadata = { title: "Settings" };

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <>
      <PageHeader section={6} />
      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsBody searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </>
  );
}
