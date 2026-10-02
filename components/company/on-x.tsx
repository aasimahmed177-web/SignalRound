import { ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import { FoundWithFirecrawl } from "@/components/found-with-firecrawl";
import { Dot } from "@/components/ui/dot";
import { Panel } from "@/components/ui/stat";
import { Tag } from "@/components/ui/tag";
import { XLogo } from "@/components/x-logo";
import { countParts } from "@/lib/buzz";
import { relativeTime } from "@/lib/format";
import { groupDigits } from "@/lib/text";
import type { RoundOnX } from "@/lib/trending";

/** "13 people on X · 6 outlets · 40 HN points", with X's logomark where its name was. */
function Counts({ x }: { x: RoundOnX }) {
  const parts = countParts(x);
  if (parts.length === 0) return null;
  return (
    <p className="text-body-small text-muted-foreground">
      {parts.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <Dot />}
          <span className="whitespace-nowrap">
            <span className="text-mono-small text-foreground">{groupDigits(p.n)}</span> {p.words}
            {p.key === "x" && (
              <>
                {" "}
                <XLogo />
              </>
            )}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/** Likes and reposts, only when the X scrape has read them; a count we do not have is left out, not shown as zero. */
function Engagement({ likes, reposts }: { likes: number | null; reposts: number | null }) {
  if (likes === null && reposts === null) return null;
  return (
    <span className="text-mono-x-small normal-case text-muted-foreground">
      {likes !== null && `${groupDigits(likes)} ${likes === 1 ? "like" : "likes"}`}
      {likes !== null && reposts !== null && " · "}
      {reposts !== null && `${groupDigits(reposts)} ${reposts === 1 ? "repost" : "reposts"}`}
    </span>
  );
}

/**
 * The company page's "On X" block: up to three posts per round (the company's own first), who
 * posted, what they said, when, and the likes once read, each linking to the post; the counts
 * behind the Trending rank; and one quiet line saying the posts were found with Firecrawl. `labels` names
 * each round when the company has more than one with posts. An admin also sees why a round was
 * kept out of Trending when its date looks late.
 */
export function OnX({ rounds, labels, admin }: { rounds: RoundOnX[]; labels: Map<string, string>; admin: boolean }) {
  const shown = rounds.filter((x) => x.posts.length > 0 || (admin && x.stale_reason));
  if (shown.length === 0) return null;
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          On <XLogo />
        </span>
      }
    >
      <div className="space-y-5">
        {shown.map((x) => (
          <div key={x.round_id} className="space-y-3">
            {(shown.length > 1 || x.label) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {shown.length > 1 && <span className="text-label-small">{labels.get(x.round_id) ?? "Round"}</span>}
                {x.label && <Tag tone="forest">TRENDING</Tag>}
              </div>
            )}
            <Counts x={x} />
            {admin && x.stale_reason && (
              <p className="rounded-8 border border-border-faint px-3 py-2 text-body-small text-muted-foreground">
                Kept out of Trending and flagged for re-dating: {x.stale_reason}
              </p>
            )}
            {x.posts.length > 0 && (
              <ul className="divide-y divide-border-faint border-y border-border-faint">
                {x.posts.map((p) => (
                  <li key={p.url}>
                    <a href={p.url} target="_blank" rel="noreferrer" className="group block space-y-1 py-3 outline-none">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="truncate text-label-small group-hover:underline group-focus-visible:underline">
                          {p.author ?? (p.handle ? `@${p.handle}` : "Post on X")}
                        </span>
                        {p.handle && <span className="truncate text-body-small text-muted-foreground">@{p.handle}</span>}
                        {p.posted_at && (
                          <span className="whitespace-nowrap text-mono-x-small normal-case text-muted-foreground">
                            {relativeTime(p.posted_at)}
                          </span>
                        )}
                        <ArrowUpRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
                      </span>
                      <span className="block text-body-small text-black-alpha-72 dark:text-muted-foreground">{p.snippet}</span>
                      <Engagement likes={p.likes} reposts={p.reposts} />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <FoundWithFirecrawl />
      </div>
    </Panel>
  );
}
