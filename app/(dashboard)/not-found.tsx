import { NotFoundBody } from "@/components/shell/not-found-body";
import { PageBody } from "@/components/shell/page-body";

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
