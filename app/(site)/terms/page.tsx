import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, LegalPage, LegalSection, proseLink } from "@/components/marketing/legal";
import { REPO_URL } from "@/lib/landing";
import { LIMITS } from "@/lib/rate-limit";
import { shareMetadata } from "@/lib/share";
import { DAILY_POST_CAP } from "@/lib/slack-subscriptions";

const TITLE = "Terms";
const DESCRIPTION =
  "The terms for using Fireround: the MIT-licensed code, the funding data and its sources, fair use of the API and feeds, and no warranty.";

export const metadata: Metadata = {
  title: TITLE,
  ...shareMetadata({ title: `${TITLE} · Fireround`, description: DESCRIPTION, image: "root", canonical: "/terms" }),
};

/** "60 per minute", "10 per 10 minutes": a limit as the page says it, from the limiter's own table. */
function rate(limit: { limit: number; windowMs: number }): string {
  const minutes = Math.round(limit.windowMs / 60_000);
  if (minutes === 1) return `${limit.limit} per minute`;
  if (minutes % 1440 === 0) return `${limit.limit} per ${minutes === 1440 ? "day" : `${minutes / 1440} days`}`;
  return `${limit.limit} per ${minutes} minutes`;
}

/** The terms of the hosted instance. The rate limits are read from lib/rate-limit.ts, so the page never quotes a stale figure. */
export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Terms"
      title="Using Fireround."
      intro="SignalRound is an open-source funding intelligence app. By using the site, the API, the feeds, the MCP server, or the Slack posts, you agree to these terms."
      updated="September 29, 2026"
    >
      <LegalSection id="code" title="The code">
        <p>
          The source code is open under the{" "}
          <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={proseLink}>
            MIT license
          </a>
          . You may run, change, and redistribute it under that license. Your own copy is yours to operate, and these terms cover only this
          site.
        </p>
      </LegalSection>

      <LegalSection id="data" title="The data">
        <p>
          Each record is extracted automatically from public reporting and links to the pages it came from. The data is provided as is. It
          may contain errors, omissions, or out-of-date figures, so check the linked sources before you rely on a record. It is not
          investment advice.
        </p>
        <p>
          You may use, copy, and republish the records. Attribution to Fireround, with a link to this site, is appreciated. The articles,
          announcements, and filings we link to belong to their publishers; we show a short excerpt and link to the original, and the
          publisher&apos;s own terms govern the original.
        </p>
        <p>
          Found a mistake? The{" "}
          <Link href="/support#corrections" className={proseLink}>
            corrections process
          </Link>{" "}
          explains how to report it.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>The API, feeds, and MCP server are free to use within fair limits. Per IP address, the current limits are:</p>
        <ul>
          <li>API pages (JSON and JSONL): {rate(LIMITS.api)}.</li>
          <li>Full CSV exports: {rate(LIMITS.export)}.</li>
          <li>MCP calls: {rate(LIMITS.mcp)}.</li>
        </ul>
        <p>
          A request over a limit gets HTTP 429 with a Retry-After header. Limits can change. Please do not work around them (for example by
          rotating addresses), load the site in ways that degrade it for others, or use the data to spam or harass the people and companies
          it names. We may block traffic that does. For bulk use, run your own copy.
        </p>
        <p>
          Add Fireround only to Slack channels you are allowed to add apps to. A channel receives at most {DAILY_POST_CAP} posts a day, and
          every post links to manage or unsubscribe.
        </p>
      </LegalSection>

      <LegalSection id="warranty" title="No warranty">
        <p>
          The site, the data, and the code are provided &quot;as is&quot;, without warranty of any kind, express or implied, including
          fitness for a particular purpose and accuracy. To the extent the law allows, the site operator is not liable for any loss arising
          from your use of them. We may change, pause, or stop the service at any time.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes and contact">
        <p>When these terms change, this page changes with them, and the date at the top says when.</p>
        <ContactLine />
        <p>
          How we handle data is on the{" "}
          <Link href="/privacy" className={proseLink}>
            privacy page
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
