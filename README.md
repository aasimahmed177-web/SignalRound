# SignalRound

SignalRound is evidence-first funding intelligence. It discovers possible funding events across the open web and social sources, keeps those unverified observations in a separate signal inbox, then uses FireRound's research pipeline to turn corroborated claims into structured, deduplicated funding records.

The core rule is simple: **rumors may enter the inbox; only evidence reaches the feed.**

## What works today

- A source-neutral Signal Inbox for observations from Agent Reach, monitors, filings, social networks, or custom collectors.
- Authenticated single and batch ingestion at `POST /api/v1/signals`.
- Idempotent ingestion by channel + URL, repeat-sighting counts, source metadata, tags, and discovery confidence.
- Analyst workflow for moving signals between New, Researching, Matched, and Dismissed without contaminating verified records.
- FireRound's complete funding product underneath: web discovery, extraction, corroboration, deduplication, review, company and investor pages, JSON/CSV/JSONL API, feeds, Slack delivery, MCP, and scheduled runs.

```text
Agent Reach / Firecrawl / SEC / RSS / custom workers
                         │
                         ▼
                 Signal Inbox (unverified)
                         │
             corroborate + resolve + dedupe
                         │
                         ▼
                  Funding feed (verified)
```

## Quick start

Requires Node 24+ and pnpm.

```bash
git clone https://github.com/aasimahmed177-web/SignalRound.git
cd SignalRound
corepack enable
pnpm install
cp .env.example .env
pnpm demo-data
pnpm dev
```

Open [http://localhost:3000/signals](http://localhost:3000/signals). Demo mode seeds ten fictional rounds and three fictional discovery signals; it uses no Firecrawl credits.

Without `DATABASE_URL`, SignalRound uses embedded Postgres through PGlite at `./data/signalround`. Set `DATABASE_URL` to use Postgres 15+.

## Ingest a signal

Set a dedicated secret in `.env`:

```bash
SIGNAL_INGEST_KEY=replace-with-a-long-random-value
```

Then send one observation:

```bash
curl -X POST http://localhost:3000/api/v1/signals \
  -H 'Authorization: Bearer replace-with-a-long-random-value' \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "x",
    "url": "https://x.com/example/status/123",
    "title": "Founder hints at a recently closed round",
    "summary": "The post names an investor but gives no amount or stage.",
    "company": "Example",
    "confidence": 0.68,
    "tags": ["founder-post"],
    "metadata": { "adapter": "agent-reach" }
  }'
```

For batches, send either a JSON array or `{ "data": [...] }`, up to 100 observations. Required fields are `channel`, `url`, and either `title` or `summary`. `confidence` is a lead score from 0 to 1; it is explicitly not verification confidence.

Agent Reach should run as a separate discovery worker and normalize each upstream result into this contract. Credentials and cookies stay with the worker; SignalRound receives only the observation and source-specific metadata.

## FireRound capabilities

Set `FIRECRAWL_API_KEY` to run live discovery and research. Optional model keys add cross-source read-back and company deep dives. The inherited operational guides remain in `docs/`:

- [How the research pipeline works](docs/how-it-works.md)
- [Data quality and verification](docs/data-quality.md)
- [Configuration](docs/configuration.md)
- [Deployment](docs/deploy.md)
- [API](docs/api.md)

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The stack is Next.js 16, React 19, TypeScript, Tailwind 4, Drizzle, PGlite/Postgres, the Vercel Workflow SDK, Firecrawl, and the AI SDK.

## Roadmap

1. Agent Reach worker adapters and per-source health/cost telemetry.
2. Automatic corroboration queues that search for primary and reputable secondary sources.
3. Entity resolution from signal companies to canonical company records.
4. A human-assisted match flow from an observation to a verified round.
5. Personalized watchlists, alerts, and source-quality calibration.

## Upstream and license

[SignalRound](https://github.com/aasimahmed177-web/SignalRound) is built from [FireRound](https://github.com/firecrawl/fireround), an MIT-licensed Firecrawl project. The FireRound repository is retained as the `upstream` remote so improvements can be followed and merged. SignalRound is also MIT licensed; see [LICENSE](LICENSE).
