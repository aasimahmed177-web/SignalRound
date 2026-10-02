import { classifyStage, type Stage } from "@fireround/core";
import type { CompanyRequestTally } from "@fireround/core/db/schema";
import { Panel } from "@/components/ui/stat";

function summary(tally: CompanyRequestTally | null, dossierRunning: boolean): string {
  if (!tally) return "No funding rounds verified for this company.";
  if (tally.found === 0) {
    return dossierRunning ? "The funding search found no earlier rounds." : "Research found no earlier funding rounds for this company.";
  }
  const found = `Research found ${tally.found} earlier ${tally.found === 1 ? "round" : "rounds"}`;
  if (tally.verified === 0) return `${found}. None could be verified.`;
  return `${found} and verified ${tally.verified}.`;
}

/** A requested company with no verified round: what research found, why each round stayed off the page, and the rule behind it. */
export function RequestFundingHistory({ tally, dossierRunning = false }: { tally: CompanyRequestTally | null; dossierRunning?: boolean }) {
  return (
    <Panel title="Funding history">
      <div className="space-y-3 text-body-small">
        <p>{summary(tally, dossierRunning)}</p>
        {tally && tally.priors.length > 0 && (
          <ul className="divide-y divide-border-faint border-y border-border-faint">
            {tally.priors.map((prior, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tally is a fixed list written once when research finished
              <li key={i} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-6">
                <span>{prior.label}</span>
                <span className="text-muted-foreground">
                  {prior.verified ? "verified" : prior.reason}
                  {prior.source && ` · found by ${prior.source}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">Fireround only lists rounds it can check against a dated announcement.</p>
      </div>
    </Panel>
  );
}

/** A round on the page by its stage and extension flag: "seed" and "seed+" are two rounds. */
type ListedRound = { stage: Stage; is_extension: boolean };

/**
 * The rounds a request's searches and Apollo found that no announcement verified; the dossier's own
 * are listed with the rounds. One whose stage a round on the page already has is left off (a
 * database's "Series A $14.7M" beside the verified $10M Series A); the tally still counts it.
 */
export function alsoFound(tally: CompanyRequestTally | null, rounds: readonly ListedRound[] = []): CompanyRequestTally["priors"] {
  const listed = new Set(rounds.filter((r) => r.stage !== "other" && r.stage !== "undisclosed").map((r) => `${r.stage}:${r.is_extension}`));
  return (tally?.priors ?? []).filter((p) => {
    if (p.verified || p.source === "company dossier") return false;
    const { stage, isExtension } = classifyStage(p.label);
    return !listed.has(`${stage}:${isExtension}`);
  });
}

/** Under a requested company's rounds: what else research found and why it is not on the page. */
export function AlsoFound({ tally, rounds = [] }: { tally: CompanyRequestTally | null; rounds?: readonly ListedRound[] }) {
  const priors = alsoFound(tally, rounds);
  if (priors.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-border-faint px-5 py-4 text-body-small text-muted-foreground">
      <div className="text-mono-x-small text-black-alpha-32 dark:text-muted-foreground">ALSO FOUND, NOT VERIFIED</div>
      <ul className="space-y-1">
        {priors.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the tally is a fixed list written when research finished
          <li key={i}>
            <span className="text-foreground">{p.label}</span>: {p.reason}
            {p.source && ` · found by ${p.source}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
