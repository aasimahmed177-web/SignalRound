// Jev against the rules on labelled search results (scripts/jev-items.json: PlanetScale, Whoop,
// Clerk, tldraw, and Resend, with negatives). A result is a usable source when it states the company's
// round and is its own announcement or a journalist's article. Needs TYPESAFE_API_KEY; about 40 calls.
//   pnpm eval-jev [items.json]

import { readFileSync } from "node:fs";
import { isArticleUrl, isDirectoryTitle, isFundingAggregatorUrl, jevClassifier, MENTION_ONLY } from "@fireround/core";
import { jevKeeps } from "../lib/jev-shadow.ts";
import { leadsFromCandidate, NO_ROUND } from "../lib/request-research.ts";

interface Item {
  c: string;
  url: string;
  title: string;
  text: string;
  round: boolean;
  kind: "primary" | "news" | "aggregator" | "other";
}

const classify = jevClassifier({ timeoutMs: 10_000 });
if (!classify) {
  console.error("eval-jev: TYPESAFE_API_KEY is not set");
  process.exit(1);
}
const items = JSON.parse(readFileSync(process.argv[2] ?? "scripts/jev-items.json", "utf8")) as Item[];
const started = Date.now();
const verdicts = await classify(items.map((it) => ({ company: it.c, url: it.url, title: it.title, snippet: it.text })));
const seconds = (Date.now() - started) / 1000;

const want = (it: Item) => it.round && (it.kind === "primary" || it.kind === "news");
/** The rules alone: an article URL, no directory title, not a funding database, and a lead (the company named, a stage, a funding word). */
const rules = (it: Item) =>
  isArticleUrl(it.url) &&
  !isDirectoryTitle(it.title) &&
  !isFundingAggregatorUrl(it.url) &&
  leadsFromCandidate({ url: it.url, title: it.title, description: it.text, via: "search" }, { name: it.c, domain: null }).length > 0;

let read = 0;
const score = { rules: 0, jev: 0, both: 0, kind: 0, round: 0 };
const misses: string[] = [];
let droppedUsable = 0;
let lostLeads = 0;
items.forEach((it, i) => {
  const v = verdicts[i];
  if (!v) {
    misses.push(`  no verdict: ${it.title}`);
    return;
  }
  read++;
  const jev = jevKeeps(v);
  const shipped = jev && !isFundingAggregatorUrl(it.url);
  if (rules(it) === want(it)) score.rules++;
  if (jev === want(it)) score.jev++;
  if (shipped === want(it)) score.both++;
  if (v.kind === it.kind) score.kind++;
  if (v.isRound >= 0.5 === it.round) score.round++;
  if (want(it) && v.aboutRaise < MENTION_ONLY && v.kind !== "primary") droppedUsable++;
  if (it.round && v.isRound < NO_ROUND) lostLeads++;
  if (shipped !== want(it) || rules(it) !== want(it))
    misses.push(
      `  ${shipped === want(it) ? " " : "J"}${rules(it) === want(it) ? " " : "R"} want=${want(it)} about=${v.aboutRaise.toFixed(2)} round=${v.isRound.toFixed(2)} kind=${v.kind} | ${it.c} | ${it.title.slice(0, 70)}`,
    );
});

const n = items.length;
console.log(`usable source, ${read}/${n} classified in ${seconds.toFixed(1)}s`);
console.log(`  rules alone:                   ${score.rules}/${n}`);
console.log(`  Jev alone:                     ${score.jev}/${n}`);
console.log(`  Jev with the host and URL rule: ${score.both}/${n}`);
console.log(`is_round ${score.round}/${n}, kind ${score.kind}/${n}`);
console.log(`usable sources the MENTION_ONLY drop would lose: ${droppedUsable}; rounds the NO_ROUND lead rule would lose: ${lostLeads}`);
console.log("wrong (J: Jev with the rule, R: rules alone):");
for (const m of misses) console.log(m);
process.exit(0);
