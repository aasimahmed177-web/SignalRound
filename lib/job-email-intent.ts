// Whether an email printed in a job posting is the inbox to apply to, or only a contact for something else:
// reasonable adjustments, data protection, general questions about the role, a recruiter's partnership desk, an
// Indigenous-employment team, help when the online form fails. Read from the line the address appears on and from
// the address's own local part. An address with no context (a bare "Email: x@y") counts as an application inbox.

export type EmailIntent = "apply" | "contact_only";

/** Local parts that are never an application inbox, whatever the line around them says. */
const NEVER_APPLY_LOCAL =
  /^(?:privacy|data-?privacy|data-?protection|dataprotection|dpo|gdpr|legal|security|accessibility|accessible|access|inclusion|diversity|indigenous[._-]?employment|no-?reply|do-?not-?reply|donotreply|abuse|compliance|complaints?|press|media|investors?|pre-?employment-?checks[\w.-]*|recruiting-?partnerships?|recruitmentpartners?|agency|agencies|suppliers?|vendors?|applicationassistance|application-?assistance)$/i;

/** The line plainly asks for an application at this address: send/share/email a CV, résumé, portfolio or application. */
const APPLY_STRONG =
  /\b(?:send|share|email|e-mail|mail|submit|forward|drop|return|attach)\b[^.!?]{0,80}\b(?:cv|cvs|resume|resumes|résumé|résumés|curriculum vitae|cover letter|portfolio|application form|applications?)\b|\b(?:how to apply|apply now|to apply|apply (?:at|to|via|by|with|here|through)|applications? (?:should|must|can|may) be (?:sent|emailed|submitted))\b|^\W*apply\b|\bcv\b[^.!?]{0,20}\bto\b/i;

/** The line gives the address for something other than applying. */
const CONTACT_ONLY =
  /\b(?:adjustments?|accommodations?|disab\w+|accessib\w+|wheelchair|alternative format|different format|difficult(?:y|ies)|technical (?:support|issues?|problems?)|assistance|support (?:with|you|through|requirements?)|additional support|specific support|support requirements|anything you need|discuss your needs|general (?:and additional )?(?:inquir|enquir)\w*|questions?|quer(?:y|ies)|enquir\w*|inquir\w*|informal (?:discussion|chat|conversation|enquir\w*|inquir\w*)|confidential (?:discussion|chat|conversation|inquiry|enquiry)|further (?:information|details|info)|more information|find out more|know more|learn more|legitimacy|verify (?:the|that)|sender's identity|sender’s identity|data (?:processing|protection|privacy)|personal data|privacy|gdpr|indigenous|aboriginal|torres strait|recruit(?:ment|ing) partners?(?:hips?)?|agency (?:partners?|submissions?)|standard agreement|contact officer|complaint|pre-employment checks|advise [^.]{0,60}of your intention)\b/i;

/** The pieces of the quote that mention this email: each email's own line when the quote joins several. */
function contextFor(email: string, quote: string): string {
  const lower = email.toLowerCase();
  const pieces = quote
    .split(/\s+…\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const own = pieces.filter((piece) => piece.toLowerCase().includes(lower));
  return (own.length ? own : pieces).join(" ");
}

/** "apply" when the posting gives this address to send an application to; "contact_only" when it is for anything else. */
export function classifyEmailIntent(email: string, quote: string | null | undefined): EmailIntent {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  if (NEVER_APPLY_LOCAL.test(local)) return "contact_only";
  const context = contextFor(email, quote ?? "");
  if (!context) return "apply";
  if (APPLY_STRONG.test(context)) {
    // "need assistance to apply", "adjustments to help you apply": the apply words serve the support request.
    const support = /\b(?:adjustments?|assistance|accessib\w+|disab\w+|difficult(?:y|ies)|wheelchair|alternative format)\b/i;
    return support.test(context) && !/\b(?:send|share|email|submit|forward)\b[^.!?]{0,40}\b(?:cv|resume|résumé|portfolio)\b/i.test(context)
      ? "contact_only"
      : "apply";
  }
  return CONTACT_ONLY.test(context) ? "contact_only" : "apply";
}

/** Splits a posting's emails into application inboxes and contact-only addresses, keeping each list's order. */
export function splitEmailIntent(emails: string[], quote: string | null | undefined): { apply: string[]; contactOnly: string[] } {
  const apply: string[] = [];
  const contactOnly: string[] = [];
  for (const email of emails) (classifyEmailIntent(email, quote) === "apply" ? apply : contactOnly).push(email);
  return { apply, contactOnly };
}
