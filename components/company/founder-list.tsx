import { ArrowUpRight } from "lucide-react";
import type { FounderLine } from "@/lib/company-groups";

/**
 * The company's founders, one list wherever it sits: the name links to the LinkedIn page YC lists
 * (via Alexandria), then the role, then the dossier's one line of background. `via` is the YC page
 * the links came from, credited once under the list when any founder carries one.
 */
export function FounderList({ founders, via }: { founders: FounderLine[]; via: string | null }) {
  return (
    <>
      <ul className="space-y-1.5">
        {founders.map((f) => (
          <li key={f.name}>
            {f.linkedin_url ? (
              <a
                href={f.linkedin_url}
                target="_blank"
                rel="noreferrer"
                title={`${f.name} on LinkedIn`}
                className="group inline-flex items-center gap-0.5 hover:underline"
              >
                {f.name}
                <ArrowUpRight className="size-3 text-muted-foreground group-hover:text-foreground" aria-hidden />
              </a>
            ) : (
              <span>{f.name}</span>
            )}
            {f.role && <span className="text-muted-foreground"> · {f.role}</span>}
            {f.background && <div className="text-black-alpha-56 dark:text-muted-foreground">{f.background}</div>}
          </li>
        ))}
      </ul>
      {via && founders.some((f) => f.linkedin_url) && (
        <p className="mt-1.5 text-muted-foreground">
          LinkedIn via Alexandria from{" "}
          <a href={via} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
            ycombinator.com
          </a>
        </p>
      )}
    </>
  );
}
