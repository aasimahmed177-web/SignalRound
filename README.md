# SignalRound

SignalRound is a self-hosted startup-funding and public-contact collector. Its native path reads RSS/Atom feeds and public webpages directly, resolves the startup's first-party website, and looks for published role inboxes such as `hello@company.com`. It does not call Firecrawl or spend Firecrawl credits.

The core rule is simple: **store the source, never invent a lead.**

## What works today

- Direct RSS/Atom discovery from funding-news and press-release feeds.
- Direct HTTP reads of the source article and startup website, with bounded responses and timeouts.
- Funding-only headline filtering, company/amount/stage extraction, and first-party website resolution.
- Public role-email discovery from the company's own homepage and contact/about pages.
- A Signal Inbox containing the article, company, funding facts, public email, source URL, and collection method.
- Dry-run by default; idempotent storage with `--apply`.
- Live searches from the Signals page, using native DuckDuckGo Lite search, a configured SearXNG instance, or Agent Reach's mcporter/Exa channel.
- Native structured page extraction and bounded research jobs reuse the existing evidence checks. A model key is required for these—not a scraping-service key.
- Database-backed local monitors, run by the app's cron schedule. No remote webhook subscription is needed.

```text
RSS / Atom / Agent Reach sources
              │
              ▼
     direct article inspection
              │
              ▼
 first-party website + public email
              │
              ▼
       Signal Inbox (real data)
```

## Quick start

Requires Node 24+ and pnpm.

```bash
git clone https://github.com/aasimahmed177-web/SignalRound.git
cd SignalRound
corepack enable
pnpm install
cp .env.example .env
pnpm collect:native -- --limit 10 --days 30 --apply --no-jina
pnpm dev
```

Open [http://localhost:3000/signals](http://localhost:3000/signals). The collector stores only live observations fetched during that run. No API key is required.

Without `DATABASE_URL`, SignalRound uses embedded Postgres through PGlite at `./data/signalround`. Set `DATABASE_URL` to use Postgres 15+.

### Collector options

```bash
# Preview without writing
pnpm collect:native -- --limit 10 --days 7 --no-jina

# Store direct-web results
pnpm collect:native -- --limit 25 --days 30 --apply --no-jina

# Add another RSS or Atom source (repeat --feed as needed)
pnpm collect:native -- --feed https://example.com/funding.xml --apply --no-jina
```

All reads are direct; the old `--no-jina` flag is accepted for compatibility but no hosted-reader fallback runs. Private IPs, unsafe redirects, and oversized responses are rejected. A collection has a 90-second budget and can return partial results.

### Search and verification setup

Open **Signals → Find startups**. Enter a funding query, a public website URL, or leave it blank to collect recent funding feeds. Results are unverified observations, with public-email source pages—not guessed addresses or deliverability claims.

Search engines can block or rate-limit automated requests. On a web-search failure, the UI explicitly falls back to searching the configured funding feeds; coverage is narrower. For another search provider set `NATIVE_SEARCH_PROVIDER=searxng` with `SEARXNG_URL`, or `NATIVE_SEARCH_PROVIDER=agent-reach` with `AGENT_REACH_MCPORTER` pointing to an installed mcporter executable with Exa configured. Agent Reach routes upstream tools; Exa is an external search service and has its own limits. No cookies are imported automatically.

Funding extraction, company research, dossiers and verification require one of `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY`. These model calls may cost money. With no model configured, discovery and public-email collection still work; observations are not promoted to verified funding records.

Delete and recreate old hosted monitors in Presets. Native monitors run through `/api/cron/native-monitors`; self-hosted production scheduling requires `CRON_SECRET`. Run only one process against an embedded PGlite store—use the UI while the app is running, not a second `--apply` collector process.

## Ingest from another Agent Reach channel

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

Agent Reach is a tool installer and router rather than a scraping proxy, so its upstream tools run directly. A worker can normalize any additional channel into this contract; credentials and cookies stay with that worker.

## Migration status

SignalRound began as a fork of FireRound. Runtime code uses the repository-owned native web client; the Firecrawl SDK and API-key requirement have been removed. Historical fixture data and some internal module names retain upstream terminology. Existing evidence, deduplication and publication safeguards remain in place.

Native collection is not feature-equivalent to a commercial scraping fleet: blocked or JavaScript-only pages may be unreadable, search coverage varies by provider, and X discovery uses publicly indexed posts rather than a private live index. Authenticated social workers can submit observations through the intake API. Failures remain visible; missing evidence is never filled with sample data.

The inherited pipeline guides remain in `docs/`; use this README's native setup instead of historical vendor-specific billing or webhook instructions:

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

The native stack is Next.js 16, React 19, TypeScript, Tailwind 4, Drizzle, PGlite/Postgres, Cheerio, and fast-xml-parser.

## Roadmap

1. Add more Agent Reach channels and source health telemetry.
2. Add an isolated browser-rendering worker for JavaScript-heavy pages.
3. Expand provider health telemetry and evidence replay tests.
4. Add watchlists and additional source-specific adapters.

## Upstream and license

[SignalRound](https://github.com/aasimahmed177-web/SignalRound) is built from [FireRound](https://github.com/firecrawl/fireround), an MIT-licensed Firecrawl project. The FireRound repository is retained as the `upstream` remote so improvements can be followed and merged. SignalRound is also MIT licensed; see [LICENSE](LICENSE).
