// Websites, logos, and profiles for every investor on a visible round (lib/investor-backfill.ts).
// Dry run by default: reads the store, calls NativeWebClient, writes nothing to the store, and saves the
// plan and a report to --out. --apply writes a saved plan without another call.
//   pnpm resolve-investors                                   # plan every visible investor into ./investor-backfill
//   pnpm resolve-investors -- --out ../fireround-devdata/investors --limit 300
//   pnpm resolve-investors -- --ids "d1,kensho"              # only these (ids are /investors/<id>)
//   pnpm resolve-investors -- --no-reverify                  # leave stored domains unread
//   pnpm resolve-investors -- --resume ../fireround-devdata/investors/plan.jsonl   # skip what a cut-off run already planned
//   pnpm resolve-investors -- --merge full/plan.json,replan/plan.json --out merged   # no call: later plans win by id
//   pnpm resolve-investors -- --apply --plan ../fireround-devdata/investors/plan.json
// The plan costs about one search and one homepage verdict (7 credits) per investor without a
// domain, more for the hard ones, and one verdict (5 credits) per stored domain re-verified.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb } from "@fireround/core/db";
import { openStore } from "../lib/db.ts";
import { applyInvestorBackfill, type BackfillEntry, planInvestorBackfill, visibleInvestors } from "../lib/investor-backfill.ts";
import { invalidateScriptEntityPages } from "../lib/script-cache-invalidation.ts";
import { getWebClient } from "../lib/web-client.ts";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apply = process.argv.includes("--apply");
const planFile = arg("--plan", "");
const out = path.resolve(arg("--out", "investor-backfill"));
const limit = Number(arg("--limit", "0"));
const concurrency = Number(arg("--concurrency", "8"));
const ids = arg("--ids", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const resume = arg("--resume", "");
const reverify = !process.argv.includes("--no-reverify");

if (apply && !planFile) throw new Error("--apply requires --plan; planning never writes to the store");

if (apply && planFile) {
  const handle = await openStore();
  const entries = JSON.parse(readFileSync(planFile, "utf8")) as BackfillEntry[];
  console.log(`APPLY: writing ${entries.length} planned investors from ${planFile}; no NativeWebClient call.`);
  const done = await applyInvestorBackfill(handle, entries);
  console.log(
    `set ${done.set} · confirmed ${done.confirm} · cleared ${done.clear} · people ${done.person} · checked ${done.none} · kept ${done.keep}`,
  );
  console.log("Rows whose domain moved since the plan was made were skipped; re-plan those ids to pick them up.");
  await invalidateScriptEntityPages();
  await closeDb();
  process.exit(0);
}

// Merge saved plans without a call: a later plan's entries replace an earlier one's by id (a re-plan
// of some ids over the full run), and the report is written for the merged set.
const mergeFiles = arg("--merge", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (mergeFiles.length > 0) {
  const byId = new Map<string, BackfillEntry>();
  for (const f of mergeFiles) for (const e of JSON.parse(readFileSync(f, "utf8")) as BackfillEntry[]) byId.set(e.id, e);
  mkdirSync(out, { recursive: true });
  const merged = [...byId.values()];
  writeFileSync(path.join(out, "plan.json"), JSON.stringify(merged, null, 1));
  writeReport(merged, 0);
  process.exit(0);
}

const handle = await openStore();
const all = await visibleInvestors(handle, ids.length > 0 ? ids : undefined);
const seen = new Set<string>();
const prior: BackfillEntry[] = [];
if (resume && existsSync(resume)) {
  for (const line of readFileSync(resume, "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as BackfillEntry;
    if (!seen.has(e.id)) prior.push(e);
    seen.add(e.id);
  }
}
const list = all.filter((i) => !seen.has(i.id)).slice(0, limit > 0 ? limit : undefined);
mkdirSync(out, { recursive: true });
const jsonl = path.join(out, "plan.jsonl");
if (!resume) writeFileSync(jsonl, "");
console.log(
  `${apply ? "APPLY" : "DRY RUN"}: ${all.length} visible investors, ${all.filter((i) => i.domain).length} with a domain; ` +
    `planning ${list.length}${prior.length ? ` (${prior.length} carried from ${resume})` : ""} into ${out}`,
);

let n = 0;
const { entries, pressCredits } = await planInvestorBackfill(handle, getWebClient(), list, {
  concurrency,
  reverify,
  onEntry: (e) => {
    appendFileSync(jsonl, `${JSON.stringify(e)}\n`);
    n++;
    if (n % 25 === 0 || n === list.length) console.log(`${n}/${list.length} planned`);
  },
});
const plan = [...prior, ...entries];
writeFileSync(path.join(out, "plan.json"), JSON.stringify(plan, null, 1));

writeReport(plan, pressCredits);

if (apply) {
  const done = await applyInvestorBackfill(handle, entries);
  console.log(
    `APPLIED: set ${done.set} · confirmed ${done.confirm} · cleared ${done.clear} · people ${done.person} · checked ${done.none}`,
  );
}
await invalidateScriptEntityPages();
await closeDb();
process.exit(0);

/** The report for a plan: coverage before and after, the plan by action, and a sample to check by hand. */
function writeReport(plan: BackfillEntry[], pressCredits: number): void {
  const count = (f: (e: BackfillEntry) => boolean) => plan.filter(f).length;
  const pct = (x: number, of: number) => `${of ? Math.round((x / of) * 1000) / 10 : 0}%`;
  const total = plan.length;
  const before = count((e) => !!e.before.domain);
  const logosBefore = count((e) => !!e.before.logo_url);
  const after = count((e) => (e.action === "set" || e.action === "confirm" || e.action === "keep" ? !!e.domain : false));
  const logosAfter = count((e) =>
    e.action === "clear"
      ? false
      : e.action === "set"
        ? !!e.logo_url
        : !!(e.before.logo_url ?? (e.action === "confirm" ? e.logo_url : null)),
  );
  const unresolved = plan.filter((e) => e.action === "none");
  const credits = plan.reduce((s, e) => s + e.credits, 0) + pressCredits;
  const byType = new Map<string, number>();
  for (const e of plan) if (e.type) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const sample = plan
    .filter((e) => e.action === "set")
    .map((e) => ({ e, k: Math.sin(e.id.length * 7919 + e.id.charCodeAt(0) * 104729 + e.rounds) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 40)
    .map((x) => x.e);
  const lines = [
    "# Investor websites: backfill plan",
    "",
    `Visible investors planned: ${total}. Credits represented by the saved entries: about ${Math.round(credits)} (not total spend across superseded runs).`,
    "",
    "## Coverage",
    "",
    "| | before | projected after apply |",
    "|---|---|---|",
    `| with a website | ${before} (${pct(before, total)}) | ${after} (${pct(after, total)}) |`,
    `| with a logo | ${logosBefore} (${pct(logosBefore, total)}) | ${logosAfter} (${pct(logosAfter, total)}) |`,
    `| recorded as a person | 0 | ${count((e) => e.action === "person" || (e.action === "clear" && e.type === "person"))} |`,
    "",
    "## The plan",
    "",
    `- resolved, new website: ${count((e) => e.action === "set" && !e.before.domain)} (verified on the homepage ${count((e) => e.action === "set" && !e.before.domain && e.confidence === "verified")}, snippet only ${count((e) => e.action === "set" && !e.before.domain && e.confidence === "snippet")})`,
    `- stored website confirmed: ${count((e) => e.action === "confirm")}`,
    `- stored website replaced by a verified one: ${count((e) => e.action === "set" && !!e.before.domain)}`,
    `- stored website refuted and cleared: ${count((e) => e.action === "clear")}`,
    `- stored website kept unverified (unreadable, or only a label bar): ${count((e) => e.action === "keep")}`,
    `- people (no website by design): ${count((e) => e.action === "person")}`,
    `- refused (candidates read, none verified): ${unresolved.filter((e) => e.refused.length > 0).length}`,
    `- unresolved (no candidate spelled the name): ${unresolved.filter((e) => e.refused.length === 0 && !/placeholder|no firm/.test(e.reason)).length}`,
    `- skipped (placeholder, or a person named by a role or affiliation): ${unresolved.filter((e) => /placeholder|no firm/.test(e.reason)).length}`,
    "",
    "## Kinds",
    "",
    ...[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `- ${t}: ${c}`),
    "",
    "## Cleared (review before applying)",
    "",
    ...plan.filter((e) => e.action === "clear").map((e) => `- ${e.name} (${e.id}): ${e.before.domain} -> none. ${e.reason}`),
    "",
    "## Replaced (review before applying)",
    "",
    ...plan
      .filter((e) => e.action === "set" && e.before.domain)
      .map((e) => `- ${e.name} (${e.id}): ${e.before.domain} -> ${e.domain}. ${e.reason}`),
    "",
    "## Automatic sample of 40 new resolutions (not hand-verified)",
    "",
    "| investor | rounds | website | kind | how |",
    "|---|---|---|---|---|",
    ...sample.map((e) => `| ${e.name} | ${e.rounds} | ${e.domain} | ${e.type ?? ""} | ${e.confidence}, ${e.origin} |`),
    "",
  ];
  writeFileSync(path.join(out, "report.md"), lines.join("\n"));
  writeFileSync(
    path.join(out, "plan.csv"),
    [
      "id,name,rounds,action,before,domain,confidence,type,origin,headquarters,reason",
      ...plan.map((e) =>
        [
          e.id,
          e.name,
          e.rounds,
          e.action,
          e.before.domain ?? "",
          e.domain ?? "",
          e.confidence ?? "",
          e.type ?? "",
          e.origin ?? "",
          e.headquarters ?? "",
          e.reason,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n"),
  );
  console.log(lines.slice(0, 26).join("\n"));
  console.log(`\nplan: ${path.join(out, "plan.json")}\nreport: ${path.join(out, "report.md")}`);
}
