import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postedEmail } from "../convex/rules.ts";
import { type FundedCompany, type FundedRun, postedContactsOnly } from "../lib/funded-founders.ts";

const CONTACT_TYPES: Record<string, string> = {
  founders: "founders",
  general: "hello",
  sales: "sales",
  press: "media",
  careers: "careers",
  support: "support",
  person: "other_role",
  other: "other_role",
};

export function fromRun(company: FundedCompany) {
  return {
    company: {
      name: company.company,
      website: company.website,
      country: company.country ?? undefined,
      // Runs from before the industry tag have none; an untagged company keeps an empty category.
      category: company.industry?.confidence ? company.industry.label : "",
      description: company.brief ?? "",
      operatingStatus: "active",
      personalizationHooks: [
        `${company.company} announced a ${company.amount ?? "new"} ${company.stage} round on ${company.announced_on}.`,
      ],
      relevanceNotes: "",
      sourceUrls: [company.funding_source_url, ...company.other_sources],
      researchedAt: new Date().toISOString(),
    },
    round: {
      stage: company.stage_key,
      stageAsWritten: company.stage,
      amountAsWritten: company.amount ?? "Undisclosed",
      currency: "AS_WRITTEN",
      announcedOn: company.announced_on,
      investors: [],
      sourceUrl: company.funding_source_url,
      sourceTitle: "",
      evidence: `${company.company} ${company.stage} ${company.amount ?? ""}`.trim(),
      verificationStatus: "reported",
    },
    contacts: company.company_emails.map((email) => ({
      email: email.email,
      contactType: CONTACT_TYPES[email.inbox] ?? "other_role",
      sourceUrl: email.source_url,
      quote: email.quote,
    })),
    founders: company.founders.map((founder) => ({
      name: founder.name,
      role: founder.role,
      sourceUrl: founder.source_url,
      quote: founder.quote,
      linkedinUrl: founder.linkedin_url ?? undefined,
      emails: founder.emails.map((email) => ({ email: email.email, sourceUrl: email.source_url, quote: email.quote })),
    })),
  };
}

/** A website Convex can key on: leads.ts takes its hostname as the company's domain. */
export function validWebsite(website: string | null | undefined): website is string {
  if (!website) return false;
  try {
    return /^https?:$/.test(new URL(website).protocol);
  } catch {
    return false;
  }
}

interface SourcedEmail {
  email: string;
  sourceUrl: string;
  quote?: string | null;
}
export interface LegacyLead {
  company: { name: string; website: string; [key: string]: unknown };
  contacts?: Array<SourcedEmail & Record<string, unknown>>;
  founders?: Array<{ emails?: SourcedEmail[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * The old leads array, held to the run file's rule: only emails whose quote shows them, only founders with one,
 * and only companies left with a posted email and a usable website.
 */
export function postedLegacyLeads(leads: LegacyLead[]): LegacyLead[] {
  return leads.flatMap((lead) => {
    if (!validWebsite(lead.company?.website)) return [];
    const contacts = (lead.contacts ?? []).filter(postedEmail);
    const founders = (lead.founders ?? [])
      .map((founder) => ({ ...founder, emails: (founder.emails ?? []).filter(postedEmail) }))
      .filter((founder) => founder.emails.length);
    return contacts.length || founders.length ? [{ ...lead, contacts, founders }] : [];
  });
}

/** Convex keys companies by website domain, so a company without a usable website is not imported. */
export function leadsFrom(parsed: unknown[] | FundedRun): Array<LegacyLead | ReturnType<typeof fromRun>> {
  return Array.isArray(parsed)
    ? postedLegacyLeads(parsed as LegacyLead[])
    : postedContactsOnly(parsed.companies)
        .filter((company) => validWebsite(company.website))
        .map(fromRun);
}

/** Pushes every lead; a failing one is recorded and the rest still go. Returns the companies that failed. */
export function pushAll<L extends { company: { name: string } }>(
  leads: L[],
  push: (lead: L) => void,
): Array<{ company: string; error: string }> {
  const failures: Array<{ company: string; error: string }> = [];
  for (const lead of leads) {
    try {
      push(lead);
    } catch (error) {
      failures.push({ company: lead.company.name, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  return failures;
}

function main() {
  // Accepts either the old leads array or a `pnpm collect:funded` run (evals/runs/funded-founders.json).
  const file = process.argv[2] ?? "data/india-funding-leads.json";
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown[] | FundedRun;
  if (!process.env.CONVEX_DEPLOY_KEY) throw new Error("CONVEX_DEPLOY_KEY is required");
  const leads = leadsFrom(parsed);
  const failures = pushAll(leads, (lead) =>
    execFileSync("pnpm", ["exec", "convex", "run", "leads:upsert", JSON.stringify(lead), "--prod"], {
      env: process.env,
      stdio: "inherit",
    }),
  );
  execFileSync("pnpm", ["exec", "convex", "run", "leads:stats", "{}", "--prod"], {
    env: process.env,
    stdio: "inherit",
  });
  if (failures.length) {
    console.error(`${failures.length} of ${leads.length} leads failed to import:`);
    for (const failure of failures) console.error(`  ${failure.company}: ${failure.error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
