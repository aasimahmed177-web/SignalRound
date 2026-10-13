import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CodeFrame, CodeLines } from "@/components/marketing/code";
import { CopyButton } from "@/components/marketing/copy-button";
import { container, gutter, textLink } from "@/components/marketing/section";
import { isLanding, isPublicDemo, LANDING_PATH } from "@/lib/access";
import { trackClick } from "@/lib/analytics";
import { API_ENDPOINTS } from "@/lib/api-docs";
import { mcpConfig } from "@/lib/landing";
import { siteOrigin } from "@/lib/origin";
import { LIMITS } from "@/lib/rate-limit";
import { shareMetadata } from "@/lib/share";
import { cn } from "@/lib/utils";

const TITLE = "API reference";
const DESCRIPTION =
  "Startup funding rounds, companies, investors, and funding news over plain HTTP GET: every endpoint with its parameters and a request to copy.";

export const metadata: Metadata = {
  title: TITLE,
  ...shareMetadata({ title: `${TITLE} · Fireround`, description: DESCRIPTION, image: "root", canonical: "/docs" }),
};

const code = "font-mono text-[13px] text-foreground";

/**
 * The read API in one page: an index of the endpoints, then each one with what it answers, the
 * parameters a reader reaches for first, and requests built on this instance's origin, so what a
 * reader copies works against the page they read. The parameters in full live in the OpenAPI document.
 */
export default function ApiReferencePage() {
  const origin = siteOrigin();
  const demo = isPublicDemo();
  const mcp = mcpConfig(origin);
  return (
    <section className="border-b border-border-faint">
      <div className={container}>
        <div className={cn("max-w-3xl pt-14 pb-10 sm:pt-20", gutter)}>
          <p className="text-mono-x-small text-black-alpha-48">
            <span className="text-black-alpha-32">[ </span>API<span className="text-black-alpha-32"> ]</span>
          </p>
          <h1 className="mt-4 text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]">
            {TITLE}
          </h1>
          <p className="mt-4 text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
            Funding rounds, companies, investors, and the news behind them, as JSON over plain GET requests: the same records the feed
            shows. {demo ? "No key needed. " : "Send the dashboard password as Basic auth when one is set. "}
            {LIMITS.api.limit} requests a minute per IP, and CORS is open, so a browser app can call it directly.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
            <a
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className={cn(textLink, "text-label-small")}
              {...trackClick("fireround_api_docs_opened", { location: "docs", target: "openapi" })}
            >
              OpenAPI spec <ArrowUpRight className="size-3.5 opacity-70" aria-hidden />
            </a>
            <a href="#mcp" className={cn(textLink, "text-label-small")}>
              MCP server
            </a>
          </div>
        </div>

        <nav aria-label="Endpoints" className={cn("pb-12", gutter)}>
          <ul className="divide-y divide-border-faint overflow-hidden rounded-12 border border-border-faint bg-card">
            {API_ENDPOINTS.map((e) => (
              <li key={e.id}>
                <a
                  href={`#${e.id}`}
                  className="grid gap-1 px-5 py-3 transition-colors hover:bg-black-alpha-4 sm:grid-cols-[260px_minmax(0,1fr)] sm:gap-6"
                >
                  <span className={code}>
                    <span className="text-black-alpha-48">GET </span>
                    {e.path}
                  </span>
                  <span className="truncate text-body-small text-muted-foreground">{e.summary}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-border-faint">
          {API_ENDPOINTS.map((e) => {
            const example = e.example(origin);
            return (
              <section
                key={e.id}
                id={e.id}
                aria-labelledby={`${e.id}-title`}
                className={cn(
                  "grid scroll-mt-20 gap-6 border-b border-border-faint py-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12",
                  gutter,
                )}
              >
                <div className="min-w-0 space-y-4">
                  <h2 id={`${e.id}-title`} className="font-mono text-[15px] leading-6 font-medium break-all">
                    <span className="text-black-alpha-48">GET </span>
                    {e.path}
                  </h2>
                  <p className="text-body-medium text-muted-foreground">{e.summary}</p>
                  <dl className="divide-y divide-border-faint border-y border-border-faint">
                    {e.params.map(([name, what]) => (
                      <div key={name} className="grid gap-1 py-2.5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
                        <dt className={code}>{name}</dt>
                        <dd className="text-body-small text-muted-foreground">{what}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-body-small text-muted-foreground">
                    Returns <code className={code}>{e.returns}</code>
                  </p>
                </div>
                <CodeFrame label="Request" action={<CopyButton text={example} snippet={`api_${e.id}`} />} className="self-start">
                  <CodeLines code={example} lang="shell" />
                </CodeFrame>
              </section>
            );
          })}

          <section
            id="mcp"
            aria-labelledby="mcp-title"
            className={cn("grid scroll-mt-20 gap-6 py-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12", gutter)}
          >
            <div className="min-w-0 space-y-4">
              <h2 id="mcp-title" className="text-title-h5">
                MCP server
              </h2>
              <p className="text-body-medium text-muted-foreground">
                The same records for an agent: add the server to any MCP client and it can list, search, and read rounds, companies,
                investors, and news. The tools are listed on the{" "}
                <Link
                  href={`${isLanding() ? "/" : LANDING_PATH}#mcp`}
                  className="text-foreground underline underline-offset-2 hover:no-underline"
                >
                  home page
                </Link>
                .
              </p>
            </div>
            <CodeFrame label="MCP client config" action={<CopyButton text={mcp} snippet="mcp_config" />} className="self-start">
              <CodeLines code={mcp} lang="json" label="MCP client config" />
            </CodeFrame>
          </section>
        </div>
      </div>
    </section>
  );
}
