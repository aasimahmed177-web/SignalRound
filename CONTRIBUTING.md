# Contributing to Fireround

Thanks for helping. Fireround is small enough that one person can hold it in their head; keep it that way.

## Setup

```bash
git clone https://github.com/firecrawl/fireround.git && cd fireround
pnpm install
cp .env.example .env   # a Firecrawl key is only needed to run sweeps; the tests need none
```

## The stack and where things live

Next.js 16, React 19, and TypeScript 7; Tailwind 4 and shadcn/ui; Drizzle over PGlite or Postgres (Neon); the Vercel Workflow SDK for durable runs; the AI SDK for the reconcile step; Vitest and Biome.

```
app/             dashboard routes, the landing page, /api/v1, /api/mcp, /api/webhooks/firecrawl, /api/cron, /feeds
components/      shadcn-owned ui/, plus shell/, feed/, overview/, search/, presets/, review/, runs/, settings/, company/, slack/, seo/, marketing/, brand/
lib/             db handle, persistence, stats, delivery, repair passes
packages/core/   the pipeline as a library (records/, firecrawl/, llm/, edgar/, presets/, db/), tests, migrations
workflows/       Workflow SDK definitions: sweep, ingest-candidate, watch-sites, announcements, form-d, corroborate, enrich, dossiers, history, trending, accuracy
presets/         series-a-b.json, seed.json, growth.json; add a file, or add a preset from the UI
rules/           aliases.json (the investor aliases a fresh clone starts with; ones added from Review live in the database) and publisher-tiers.json
evals/           hand-labeled rounds and page excerpts the reconcile and pipeline benchmarks score against
scripts/         sweep, backfill, feed-token, migrate, investor-domains, bench-reconcile; maintenance/ holds the one-off repair, prune, merge, and reset passes
tests/           persistence, delivery, presets, routes, and page tests on an in-memory Postgres
```

Every script, one line each: [docs/scripts.md](docs/scripts.md). The house look and the brand rule: [docs/design.md](docs/design.md).

## The three gates

Every change passes all three before it is opened as a pull request. CI runs the same three, then a build.

```bash
pnpm typecheck
pnpm lint          # biome; `pnpm format` fixes what it can
pnpm test          # the suite on an in-memory Postgres, no network
```

## Adding a preset

A preset is a JSON file in `presets/` (copy `presets/series-a-b.json`: a slug, a name, a description, the stages, the goal, eight queries, `xAccounts`, `watchSites`), or "New preset" in the UI, which stores the same shape in the database. A file preset ships with the repo; a UI preset stays with the instance.

## Adding a data-quality rule

A rule is a pure function in `packages/core/src/records/` with a test beside it (`investors.ts` and `investors.test.ts` are the shape). Wire it where the round meets it (resolve, persist, or the read-back), then add one line to [docs/data-quality.md](docs/data-quality.md) in the order a round meets it. A rule with no test does not land.

## Commit messages

One line under 72 characters that says what changed and why, in the present tense ("Drop rounds whose only sources are directory pages"). A body when the why needs more than the line. No prefixes, no ticket numbers.

## House rules for prose

No em dashes or en dashes anywhere: not in docs, not in code comments, not in commit messages. Use a colon, a comma, a period, or parentheses. Headings in sentence case with no trailing period. Every markdown file starts with an H1. Short declaratives, second person where it reads naturally, no marketing filler.
