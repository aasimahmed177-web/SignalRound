import type { ReactNode } from "react";
import { container, gutter } from "@/components/marketing/section";
import { contactEmail, ISSUES_URL } from "@/lib/contact";
import { cn } from "@/lib/utils";

/** An inline link inside a legal page's prose. */
export const proseLink = "text-foreground underline underline-offset-2 hover:no-underline";

/**
 * The frame for /privacy, /terms, and /support: the /slack page's head (the bracketed eyebrow, the
 * title, one framing paragraph), then a single readable column of sections.
 */
export function LegalPage({
  eyebrow,
  title,
  intro,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  /** The day the page last changed, written out ("September 29, 2026"). */
  updated?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border-faint">
      <div className={container}>
        <div className={cn("max-w-2xl pt-14 pb-10 sm:pt-20", gutter)}>
          <p className="text-mono-x-small text-black-alpha-48">
            <span className="text-black-alpha-32">[ </span>
            {eyebrow.toUpperCase()}
            <span className="text-black-alpha-32"> ]</span>
          </p>
          <h1 className="mt-4 text-[32px] leading-[36px] font-medium tracking-[-0.02em] text-balance sm:text-[44px] sm:leading-[48px]">
            {title}
          </h1>
          <p className="mt-4 text-[16px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">{intro}</p>
          {updated && <p className="mt-4 text-body-small text-muted-foreground">Last updated {updated}.</p>}
        </div>
        <div className={cn("max-w-2xl space-y-10 pb-20", gutter)}>{children}</div>
      </div>
    </section>
  );
}

/** One titled section of a legal page: a heading and its paragraphs or list. */
export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-20 space-y-3">
      <h2 id={id} className="text-title-h5">
        {title}
      </h2>
      <div className="space-y-3 text-body-medium text-muted-foreground [&_li]:pl-1 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

/** How to reach us, the same everywhere: the GitHub issues always, the email only when CONTACT_EMAIL is set. */
export function ContactLine() {
  const email = contactEmail();
  return (
    <p>
      Open an issue on{" "}
      <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={proseLink}>
        GitHub
      </a>
      {email ? (
        <>
          , or email{" "}
          <a href={`mailto:${email}`} className={proseLink}>
            {email}
          </a>
          .
        </>
      ) : (
        "."
      )}{" "}
      No account is needed for either.
    </p>
  );
}
