import type { Metadata } from "next";
import { NotFoundBody } from "@/components/shell/not-found-body";
import { PageBody } from "@/components/shell/page-body";

/** The tab names the miss: "Not found · Fireround" (the root layout's title template). */
export const metadata: Metadata = { title: "Not found" };

/**
 * A missing company, investor, or page, in the house shape: the shell stays, the body says what is
 * not here and offers the search (components/shell/not-found-body.tsx).
 */
export default function NotFound() {
  return (
    <PageBody width="narrow">
      <NotFoundBody />
    </PageBody>
  );
}
