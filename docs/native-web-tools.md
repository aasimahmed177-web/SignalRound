# Native Web tools

Open `/scraper` in the dashboard. Choose Scrape page, Map website, Crawl website,
or Search web, enter a public URL or query, and select Run. Results can be
downloaded as JSON. This screen uses NativeWebClient, not the Firecrawl service.
No Firecrawl API key or credits are required.

## Adaptive reads and Agent Reach

Two additional operations are available:

- **Adaptive read:** public GitHub repository root URLs return structured repository
  metadata from the unauthenticated GitHub API. RSS/Atom URLs return up to 100
  normalized entries with source links, descriptions and publication strings.
  Other URLs use the existing direct HTML reader. No model is used.
- **Agent Reach Reader:** explicitly uses Agent Reach's upstream web backend,
  `https://r.jina.ai/`. This sends the public target URL to Jina; it is not local
  browser rendering. Query strings and credential-bearing/private destinations
  are rejected before the provider request. No cookies or API keys are forwarded.
  Jina manages its own target fetches/redirects and can rate-limit or block reads.
  Challenge pages, empty bodies and unrecognized responses are errors, not evidence.

Each scrape includes provider provenance and a retrieval timestamp. Reader mode
is opt-in and is never a silent fallback for direct reads or crawls. The UI's limit
applies to crawl/map/search; adaptive feeds have their own 100-entry safety cap.
GitHub's unauthenticated API has its own rate limit.

This integrates the upstream web-reader route documented by
[Agent Reach](https://github.com/Panniantong/agent-reach), rather than executing a
fictional `agent-reach scrape` command. GitHub and feed parsing use native adapters;
they do not require installing Agent Reach's Python CLI. The existing Exa search
bridge still requires a separately configured mcporter executable. Social-network
logins, YouTube transcription, and automatic tool installation are not included.

Live verification on 2026-10-22 succeeded for the public Agent-Reach GitHub repository,
Hacker News RSS (20 entries), and example.com through Jina. The focused suite now
includes 37 passing tests. This expands this app's coverage; it is not evidence of
overall superiority to Firecrawl.

## Current scope

- Scrape: direct HTML reads with Markdown, links and page metadata.
- Map: homepage and sitemap discovery.
- Crawl: bounded, serial, same-origin link discovery, at most 25 attempts and two
  link levels through this screen. Failed requests count toward the limit.
  Partial results include errors and remaining discovered URLs.
- Search: the app's configured native/Agent Reach search path. Provider access,
  configuration and rate limits still apply; this is not an independent web index.

The existing transport validates public network destinations and redirects.
Dashboard authorization protects the action, and public-demo visitors cannot use
this page. Raw HTML is displayed as text, never executed in the results panel.

This is an initial implementation, not full Firecrawl parity. The separate
Rendered page + frames operation executes JavaScript with restricted networking;
ordinary scrape/crawl do not. It does not solve CAPTCHAs, provide screenshots or parse PDFs. The new crawl loop
does not yet enforce robots.txt; use it only on sites you are permitted to crawl.
Redirects are validated by the transport; off-origin crawl results are excluded
after fetching. Large background jobs and robots-aware scheduling remain future
work. Local compute, bandwidth and any separately configured search/model service
can still have costs. These four UI operations do not require an extraction model.

## REA investigation

REA `rea-agents@6.7.0` analyzed the public Firecrawl JavaScript SDK `src/index.ts`
on 2026-10-22. Evidence ID:
`ev_3fd6283fc1c9d4190c0f03cc625153b3972805e6936c2b075301ff328fec6e0e`.
It identified the wrapper/client exports but reported unresolved imports because
only the entry point was supplied. This is not an analysis of the hosted backend.
REA is an analysis tool, not the app's scraping engine. No Firecrawl hosted API
was called for this investigation or the live scraping checks.

## Verification

- 29 tests passed across crawl, native client and transport suites.
- Application TypeScript check passed.
- Direct native crawl of `https://example.com` returned a real page and zero credits.
- Playwright submitted Scrape page from `/scraper` and received live Markdown,
  HTML and metadata for `https://example.com`.

Repeat tests with a supported Node runtime:

```sh
npx vitest run packages/core/src/web/crawl.test.ts packages/core/src/web/client.test.ts packages/core/src/web/transport.test.ts
npx tsc --noEmit
```
