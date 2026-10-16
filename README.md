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
- Optional Agent Reach/Jina reader fallback for sites that reject direct reads. `--no-jina` keeps the run strictly direct-web.

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

Omit `--no-jina` to allow the reader fallback used by Agent Reach when a site blocks a normal request. Firecrawl is disabled in both modes.

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

SignalRound began as a fork of FireRound. The native collector, contact discovery, storage path, and Signal Inbox do not import or call Firecrawl. Some inherited FireRound modules and their `firecrawl` package dependency remain in the repository while the older sweep, monitor, and enrichment routes are replaced; do not run those legacy commands if you want a zero-Firecrawl deployment.

The inherited operational guides remain in `docs/` while that migration continues:

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
2. Replace the remaining inherited Firecrawl research routes with Playwright/direct-web workers.
3. Add automatic primary/secondary-source corroboration and entity resolution.
4. Add scheduled native collection, deduplication, watchlists, and alerts.
5. Remove the legacy `firecrawl` dependency once the last inherited route is replaced.

## Upstream and license

[SignalRound](https://github.com/aasimahmed177-web/SignalRound) is built from [FireRound](https://github.com/firecrawl/fireround), an MIT-licensed Firecrawl project. The FireRound repository is retained as the `upstream` remote so improvements can be followed and merged. SignalRound is also MIT licensed; see [LICENSE](LICENSE).
