// Where a visitor reaches the people behind this instance: the GitHub issues always, and an email
// address when the operator sets CONTACT_EMAIL. The legal and support pages read both from here.

import { REPO_URL } from "@/lib/landing";

export const ISSUES_URL = `${REPO_URL}/issues`;

/** CONTACT_EMAIL when it holds one mailbox; null when unset or malformed, so no page prints a broken mailto. */
export function contactEmail(): string | null {
  const email = process.env.CONTACT_EMAIL?.trim();
  return email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}
