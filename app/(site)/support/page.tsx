import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, proseLink } from "@/components/marketing/legal";
import { contactEmail, ISSUES_URL } from "@/lib/contact";
import { REPO_URL } from "@/lib/landing";
import { shareMetadata } from "@/lib/share";

const TITLE = "Support";
const DESCRIPTION = "How to reach Fireround without an account, report an error in a funding record, and manage what you receive.";

export const metadata: Metadata = {
  title: TITLE,
  ...shareMetadata({ title: `${TITLE} · Fireround`, description: DESCRIPTION, image: "root", canonical: "/support" }),
};

/**
 * Where a visitor asks for help. It is the target of every "Report an error" link, so it works even
 * when GitHub does not: the email address (CONTACT_EMAIL) is printed when set, and the issues link
 * is always there.
 */
export default function SupportPage() {
  const email = contactEmail();
  return (
    <LegalPage
      eyebrow="Support"
      title="Get in touch."
      intro="No account is needed. Report an error in a round, ask about your Slack channel, or ask anything else about Fireround."
    >
      <LegalSection id="contact" title="Contact">
        <ul>
          {email && (
            <li>
              Email{" "}
              <a href={`mailto:${email}`} className={proseLink}>
                {email}
              </a>
              .
            </li>
          )}
          <li>
            Open an issue on{" "}
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={proseLink}>
              GitHub
            </a>
            . Issues are public, so leave out anything private{email ? " and email us instead" : ""}.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="corrections" title="Report an error">
        <p>Records are extracted automatically from public reporting, so some will be wrong. To correct one, send us:</p>
        <ul>
          <li>the link to the round or company on Fireround;</li>
          <li>what is wrong: the amount, the stage, the date, an investor, or a round that is not a real funding round;</li>
          <li>a source that shows the right value, such as the company&apos;s own announcement or a news article.</li>
        </ul>
        <p>
          We check the report against the sources. If it holds, we correct the record or remove it, and the page and the API show the
          change. If you represent the company, saying so and writing from an address on its domain helps us confirm it.
        </p>
      </LegalSection>

      <LegalSection id="subscriptions" title="Slack and feeds">
        <p>
          Every Slack post links to its channel&apos;s manage page, where you can change the watchlist, pause, send a test, or unsubscribe.
          Lost the link? Tell us the workspace and channel names and we will help. RSS, Atom, and JSON Feed subscriptions are managed in
          your reader.
        </p>
      </LegalSection>

      <LegalSection id="more" title="Security, privacy, and self-hosting">
        <p>
          Report a vulnerability privately as described in the{" "}
          <a href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer" className={proseLink}>
            security policy
          </a>
          , not in a public issue. What we store and how to have it deleted is on the{" "}
          <Link href="/privacy" className={proseLink}>
            privacy page
          </Link>
          ; the{" "}
          <Link href="/terms" className={proseLink}>
            terms
          </Link>{" "}
          cover the data and the API. To run your own copy, start with the{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={proseLink}>
            README
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
