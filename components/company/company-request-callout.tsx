import { RequestCompanyForm } from "@/components/company/request-company-dialog";
import { websiteFromQuery } from "@/lib/company-request-ui";

export function CompanyRequestCallout({ query }: { query: string }) {
  return (
    <section className="rounded-12 border border-border-faint bg-card p-5">
      <h2 className="text-label-medium">Looking for "{query}"? It isn't in Fireround yet.</h2>
      <RequestCompanyForm key={query} initialWebsite={websiteFromQuery(query)} className="mt-4" />
    </section>
  );
}
