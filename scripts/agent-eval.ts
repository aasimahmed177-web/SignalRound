// How well an agent gets answers from the Fireround data pack, scored against the database:
//   pnpm agent-eval                                  every question against https://fireround.dev's public API (free)
//   pnpm agent-eval -- --via-alexandria              the same calls through Alexandria (5 credits each; FIRECRAWL_API_KEY)
//   pnpm agent-eval -- --routing                     also ask Alexandria's free tool search which capability each question routes to
//   pnpm agent-eval -- --only profile-supabase,top-90d --base https://preview.example --out ./agent-eval
//   pnpm agent-eval -- --baseline ./agent-eval.json  list the questions whose verdict changed since an earlier run
//   pnpm agent-eval -- --sha abc1234                 name the deployed commit when the deployment record is not readable
// Each question (scripts/agent-eval/questions.ts) names the capability and options an agent should
// call; its ground truth is read from the database (DATABASE_URL) as the question is asked, with
// SELECTs only. The scorecard is printed as markdown; --out writes it to <out>.md and the full
// results to <out>.json.

import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getDb } from "@fireround/core/db";
import type { SQL } from "drizzle-orm";
import { type Answer, type Judgement, judge, readAnswer, score, type Verdict } from "./agent-eval/judge.ts";
import { CAPABILITIES, type Capability, days, type Question, questions } from "./agent-eval/questions.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const base = (option("--base") ?? "https://fireround.dev").replace(/\/+$/, "");
const viaAlexandria = flag("--via-alexandria");
const routing = flag("--routing");
const maxCredits = Number(option("--max-credits") ?? 400);
const only = option("--only")?.split(",");
const out = option("--out");
const baseline = option("--baseline");
const firecrawl = (process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/+$/, "");
const CREDITS_PER_CALL = 5;
const CONCURRENCY = 4;

/** The public API behind each capability, and the page size Alexandria asks for when the agent names none. */
const ROUTES: Record<Capability, { path: string; pinned?: Record<string, string>; limit?: number }> = {
  "rounds/search": { path: "/api/v1/rounds", limit: 20 },
  "rounds/trending": { path: "/api/v1/rounds", pinned: { sort: "trending" }, limit: 20 },
  "companies/rounds": { path: "/api/v1/rounds", limit: 20 },
  "companies/search": { path: "/api/v1/companies", limit: 20 },
  "companies/profile": { path: "/api/v1/companies/{id}" },
  "investors/search": { path: "/api/v1/investors", limit: 20 },
  "investors/top": { path: "/api/v1/investors/top", limit: 10 },
  "investors/profile": { path: "/api/v1/investors/{id}" },
  "news/latest": { path: "/api/v1/news", limit: 20 },
};

interface Call {
  answer: Answer;
  ms: number;
  bytes: number;
  credits: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public API allows 60 calls a minute per address, so direct calls go out at most one a second. */
const API_GAP_MS = 1050;
let nextApiSlot = 0;
async function paced(): Promise<void> {
  const wait = nextApiSlot - Date.now();
  nextApiSlot = Math.max(Date.now(), nextApiSlot) + API_GAP_MS;
  if (wait > 0) await sleep(wait);
}

/** A 429 waits out the minute (or the Retry-After it names) and tries again, twice at most. */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt === 2) return res;
    await sleep(Number(res.headers.get("retry-after") ?? 60) * 1000);
  }
}

async function callApi(question: Question): Promise<Call> {
  const route = ROUTES[question.capability];
  const { id, ...rest } = question.params;
  const path = route.path.replace("{id}", encodeURIComponent(String(id ?? "")));
  const params = new URLSearchParams({
    ...(route.limit ? { limit: String(route.limit) } : {}),
    ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    ...route.pinned,
  });
  await paced();
  const started = performance.now();
  const res = await fetchRetrying(`${base}${path}${params.size ? `?${params}` : ""}`);
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = { error: body.slice(0, 200) };
  }
  return { answer: readAnswer(question.capability, res.status, json), ms: performance.now() - started, bytes: body.length, credits: 0 };
}

async function alexandria(provider: string, capability: string, options: Record<string, unknown>) {
  const res = await fetchRetrying(`${firecrawl}/v2/scrape`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ alexandria: [{ provider, capability, options }] }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { alexandria?: Array<{ data?: unknown; error?: { message?: string; status?: number } }>; creditsCost?: number };
    error?: string;
  } | null;
  return { status: res.status, item: body?.data?.alexandria?.[0], credits: body?.data?.creditsCost ?? 0, error: body?.error };
}

async function callAlexandria(question: Question): Promise<Call> {
  const started = performance.now();
  const { status, item, credits, error } = await alexandria("fireround", question.capability, question.params);
  const ms = performance.now() - started;
  if (!item) return { answer: readAnswer(question.capability, status || 502, { error: error ?? "no result" }), ms, bytes: 0, credits };
  if (item.error) {
    const answer = readAnswer(question.capability, item.error.status ?? 400, { error: item.error.message ?? "error" });
    return { answer, ms, bytes: 0, credits };
  }
  return { answer: readAnswer(question.capability, 200, item.data), ms, bytes: JSON.stringify(item.data).length, credits };
}

/**
 * Where Alexandria's free tool search ranks the expected capability for the question as asked (1 is
 * first, null when it is not in the top 5), and the tool it puts first.
 */
async function route(question: Question): Promise<{ rank: number | null; first: string | null }> {
  const query = question.ask.replace(/\s*\(.*\)\s*$/, "");
  const { item } = await alexandria("firecrawl", "find-tools", { query, limit: 5 });
  const items = (item?.data as { items?: Array<{ id?: string }> } | undefined)?.items ?? [];
  const at = items.findIndex((t) => t.id === `fireround/${question.capability}`);
  return { rank: at >= 0 ? at + 1 : null, first: items[0]?.id ?? null };
}

/** The commit production runs: --sha as given, else the latest production deployment when its record is readable. */
async function productionSha(): Promise<string | null> {
  if (option("--sha")) return option("--sha") ?? null;
  if (base !== "https://fireround.dev") return null;
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch("https://api.github.com/repos/firecrawl/fireround/deployments?environment=Production&per_page=1", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  const [latest] = res?.ok ? ((await res.json()) as Array<{ sha?: string }>) : [];
  return latest?.sha?.slice(0, 7) ?? null;
}

interface Result extends Judgement {
  id: string;
  ask: string;
  capability: Capability;
  params: Question["params"];
  tags: string[];
  status: number;
  returned: number;
  expected: number | null;
  ms: number;
  bytes: number;
  route_rank?: number | null;
  routed_first?: string | null;
}

async function pool<T, R>(items: T[], n: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await run(items[i] as T);
      }
    }),
  );
  return results;
}

const now = new Date();
const set = questions(days(now)).filter((q) => !only || only.includes(q.id));
if (set.length === 0) throw new Error(`no question matches --only ${only?.join(",")}`);
if ((viaAlexandria || routing) && !process.env.FIRECRAWL_API_KEY) throw new Error("--via-alexandria and --routing need FIRECRAWL_API_KEY");
if (viaAlexandria && set.length * CREDITS_PER_CALL > maxCredits) {
  throw new Error(
    `${set.length} questions through Alexandria cost ${set.length * CREDITS_PER_CALL} credits, over --max-credits ${maxCredits}; narrow with --only`,
  );
}

const handle = await getDb();
const query = async <T>(q: SQL): Promise<T[]> => (await handle.execute(q)).rows as T[];
const results = await pool(set, CONCURRENCY, async (question): Promise<Result & { credits: number }> => {
  const [call, expect, routed] = await Promise.all([
    viaAlexandria ? callAlexandria(question) : callApi(question),
    question.truth(query),
    routing ? route(question) : Promise.resolve(undefined),
  ]);
  const expected =
    expect.kind === "rows"
      ? expect.keys.length
      : expect.kind === "top"
        ? Math.min(expect.n, expect.ranked.length)
        : expect.kind === "none"
          ? 0
          : 1;
  return {
    id: question.id,
    ask: question.ask,
    capability: question.capability,
    params: question.params,
    tags: question.tags ?? [],
    ...judge(expect, call.answer),
    status: call.answer.status,
    returned: call.answer.entity ? 1 : call.answer.keys.length,
    expected,
    ms: Math.round(call.ms),
    bytes: call.bytes,
    credits: call.credits,
    ...(routed ? { route_rank: routed.rank, routed_first: routed.first } : {}),
  };
});
await closeDb();

const VERDICTS: Verdict[] = ["correct", "partial", "wrong", "empty"];
const credits = results.reduce((n, r) => n + r.credits, 0);
const sha = await productionSha();
const tally = (rs: Result[]) => ({
  questions: rs.length,
  ...Object.fromEntries(VERDICTS.map((v) => [v, rs.filter((r) => r.verdict === v).length])),
  score: score(rs.map((r) => r.verdict)),
  ...(routing
    ? {
        routed_first: rs.filter((r) => r.route_rank === 1).length,
        routed_top3: rs.filter((r) => r.route_rank != null && r.route_rank <= 3).length,
        routed_to_pack: rs.filter((r) => r.routed_first?.startsWith("fireround/")).length,
      }
    : {}),
});
const byCapability = Object.fromEntries(
  CAPABILITIES.map((c) => [c, tally(results.filter((r) => r.capability === c))]).filter(
    ([, t]) => (t as { questions: number }).questions > 0,
  ),
);
const tags = [...new Set(results.flatMap((r) => r.tags))];
const byTag = Object.fromEntries([
  ["plain", tally(results.filter((r) => r.tags.length === 0))],
  ...tags.map((t) => [t, tally(results.filter((r) => r.tags.includes(t)))]),
]);
const summary = tally(results);
const report = {
  run: {
    at: now.toISOString(),
    base,
    deployed_sha: sha,
    via: viaAlexandria ? "alexandria" : "api",
    routing,
    credits,
  },
  summary,
  by_capability: byCapability,
  by_tag: byTag,
  results,
};

const previous = baseline ? (JSON.parse(readFileSync(baseline, "utf8")) as typeof report) : null;
const changed = previous
  ? results.flatMap((r) => {
      const before = previous.results.find((p) => p.id === r.id);
      return before && before.verdict !== r.verdict ? [{ id: r.id, before: before.verdict, after: r.verdict, reason: r.reason }] : [];
    })
  : [];

const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;
const tableOf = (title: string, groups: Record<string, ReturnType<typeof tally>>) => [
  row([title, "Questions", ...VERDICTS, "Score", ...(routing ? ["Routed 1st", "Routed top 3", "Fireround 1st"] : [])]),
  row(["---", ...Array(6 + (routing ? 3 : 0)).fill("---")]),
  ...Object.entries(groups).map(([name, t]) => {
    const counts = t as Record<string, number>;
    return row([
      name,
      t.questions,
      ...VERDICTS.map((v) => counts[v] ?? 0),
      `${t.score}%`,
      ...(routing ? [counts.routed_first ?? 0, counts.routed_top3 ?? 0, counts.routed_to_pack ?? 0] : []),
    ]);
  }),
];
const misses = results.filter((r) => r.verdict !== "correct");
const markdown = [
  `# Agent eval, ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  "",
  `${base}${sha ? ` (production ${sha})` : ""}, ${viaAlexandria ? `through Alexandria, ${credits} credits` : "public API"}${routing ? ", with routing" : ""}.`,
  "",
  `**Score ${summary.score}%**: ${VERDICTS.map((v) => `${(summary as Record<string, number>)[v]} ${v}`).join(", ")} of ${summary.questions}${previous ? ` (was ${previous.summary.score}%)` : ""}.`,
  "",
  ...tableOf("Capability", byCapability),
  "",
  ...tableOf("Kind", byTag),
  ...(changed.length
    ? [
        "",
        "## Changed since the baseline",
        "",
        row(["Question", "Before", "After", "Why"]),
        row(["---", "---", "---", "---"]),
        ...changed.map((c) => row([c.id, c.before, c.after, c.reason])),
      ]
    : []),
  "",
  "## Not correct",
  "",
  row(["Question", "Capability", "Options", "Verdict", "Why"]),
  row(["---", "---", "---", "---", "---"]),
  ...misses.map((r) =>
    row([`${r.id}: ${r.ask}`, r.capability, `\`${JSON.stringify(r.params)}\``, r.verdict, r.reason.replace(/\|/g, "/")]),
  ),
  ...(routing
    ? [
        "",
        "## Not routed first",
        "",
        row(["Question", "Expected", "Its rank", "Routed first"]),
        row(["---", "---", "---", "---"]),
        ...results
          .filter((r) => r.route_rank !== 1)
          .map((r) => row([`${r.id}: ${r.ask}`, r.capability, r.route_rank ?? "not in top 5", r.routed_first ?? "nothing"])),
      ]
    : []),
  "",
].join("\n");

console.log(markdown);
if (out) {
  writeFileSync(`${out}.md`, markdown);
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
process.exit(0);
