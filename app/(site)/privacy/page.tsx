import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, LegalPage, LegalSection, proseLink } from "@/components/marketing/legal";
import { digestsConfigured } from "@/lib/digest";
import { shareMetadata } from "@/lib/share";
import { SLACK_STATE_MAX_AGE } from "@/lib/slack";

const TITLE = "Privacy";
const DESCRIPTION =
  "What Fireround stores about visitors and subscribers, how long it keeps it, and how to have it deleted. No account, no tracking cookies.";

export const metadata: Metadata = {
  title: TITLE,
  ...shareMetadata({ title: `${TITLE} · Fireround`, description: DESCRIPTION, image: "root", canonical: "/privacy" }),
};

/**
 * What this instance stores, stated from the code: the Slack subscription row (lib/slack-subscriptions.ts),
 * the rate limiter's hashed keys (lib/rate-limit.ts), a company request's hashed requester
 * (lib/company-requests.ts), email digest targets when digests are configured (lib/digest.ts), the
 * host's request logs, and the cookieless Vercel analytics the root layout loads. Change a store
 * there, change this page.
 */
export default function PrivacyPage() {
  const email = digestsConfigured();
  const requests = process.env.COMPANY_REQUESTS === "1";
  return (
    <LegalPage
      eyebrow="Privacy"
      title="What we store, and for how long."
      intro="Fireround is a public funding feed run by Firecrawl. You can read it, query the API, and subscribe to its feeds without an account. This page lists everything the site keeps about the people who use it."
      updated="September 29, 2026"
    >
      <LegalSection id="reading" title="Reading the site">
        <p>
          There is no sign-up and no tracking cookie. The site uses Vercel Web Analytics and Speed Insights, which count page views and
          measure page speed without cookies. Your light or dark theme choice stays in your browser&apos;s local storage and is never sent
          to us.
        </p>
        <p>
          The one cookie we set ourselves is for Add to Slack: it carries your picks through Slack&apos;s screen, expires after{" "}
          {Math.round(SLACK_STATE_MAX_AGE / 60)} minutes, and is cleared when you come back.
        </p>
      </LegalSection>

      <LegalSection id="logs" title="Request logs and rate limits">
        <p>
          Our host, Vercel, keeps a log of each request (IP address, user agent, path, time, and response status). We use it to debug and to
          stop abuse, and it is kept for the retention period of our Vercel plan.
        </p>
        <p>
          To keep the free API, feeds, and MCP server available, we count requests per IP address. The count is stored under a SHA-256 hash
          of the address, never the address itself, and counts older than a day are deleted as the limiter runs.
        </p>
        {requests && (
          <p>
            If you ask Fireround to research a company, we keep the website you submitted and a SHA-256 hash of your IP address with the
            request, to enforce the daily cap. The request and what it found are public on the company&apos;s page.
          </p>
        )}
      </LegalSection>

      <LegalSection id="slack" title="Slack">
        <p>When you add Fireround to a Slack channel, we store:</p>
        <ul>
          <li>the workspace name and ID, and the channel name and ID;</li>
          <li>the incoming webhook Slack issues for that channel, encrypted (AES-256-GCM);</li>
          <li>
            the Slack IDs of the app&apos;s bot user and of the person who approved the install, so that when Slack revokes those
            credentials we can find and delete the webhook;
          </li>
          <li>
            your preferences: the watchlist, how often to post, whether to include expected rounds, and whether the channel is paused;
          </li>
          <li>delivery records: when we last posted, how many posts went out today, and a short error code when a post fails.</li>
        </ul>
        <p>
          Beyond that opaque user ID we store nothing about who clicked the button: no name, no email address. When you unsubscribe, or
          Slack tells us the channel or the app is gone, we delete the webhook and stop posting. The row with the workspace and channel
          names and IDs stays, marked as ended, so the per-workspace limits hold and a reinstall keeps its manage link. Ask us and we will
          delete it.
        </p>
      </LegalSection>

      {email && (
        <LegalSection id="email" title="Email digests">
          <p>
            An email digest exists only when an operator of this site sets one up; there is no public sign-up. For each digest we store the
            email address, its watchlist and filters, the cadence, and when the last one was sent. Digests are sent through Resend. Every
            digest has an unsubscribe link that turns it off at once. The address stays until an operator deletes it or you ask us to.
          </p>
        </LegalSection>
      )}

      <LegalSection id="processors" title="Who else handles it">
        <ul>
          <li>Vercel hosts the site and keeps the request logs and analytics.</li>
          <li>PlanetScale hosts the database.</li>
          <li>Slack receives the posts for the channels you connect.</li>
          {email && <li>Resend sends the email digests.</li>}
          <li>
            Firecrawl reads the public web pages the feed is built from. None of the data on this page is sent to it
            {requests ? ", except a company website you submit for research" : ""}.
          </li>
        </ul>
        <p>We do not sell any of it, and we do not use it for advertising.</p>
      </LegalSection>

      <LegalSection id="feed-data" title="The data in the feed">
        <p>
          The funding records come from public reporting: news articles, company announcements, and public filings. They name companies,
          investors, and sometimes people as those sources name them, and every record links to its sources. To correct or remove a record,
          follow the{" "}
          <Link href="/support#corrections" className={proseLink}>
            corrections process
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="deletion" title="Retention and deletion">
        <ul>
          <li>Rate-limit counts: deleted after about a day.</li>
          <li>Request logs: kept for our Vercel plan&apos;s log retention period.</li>
          <li>Slack webhook: deleted when the channel unsubscribes or is removed.</li>
          <li>Slack workspace and channel names and IDs, and preferences: kept until you ask us to delete them.</li>
          {email && <li>Email digest addresses: kept until an operator deletes the digest or you ask us to.</li>}
          {requests && <li>Company requests: kept with the public request.</li>}
        </ul>
        <p>
          To have something deleted, tell us the Slack workspace and channel{email ? ", or the email address" : ""}, and we will delete it
          and confirm.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <ContactLine />
        <p>
          More ways to reach us are on the{" "}
          <Link href="/support" className={proseLink}>
            support page
          </Link>
          . When what we store changes, this page changes with it, and the date at the top says when.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
