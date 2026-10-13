# Round certainty in the read API

Each round in `GET /api/v1/rounds` has a `certainty` field in JSON and JSONL, and a `certainty` column in CSV. The same field is in the compact round returned by the MCP tools `list_rounds`, `search_rounds`, `get_company`, and `list_trending`.

| Value | Meaning |
|---|---|
| `announced` | The round closed on the record. |
| `reported` | A publisher reports that it closed, citing unnamed sources. |
| `expected` | The financing is proposed or in progress and has not closed. |
| `unconfirmed` | Its status is not established. |

This describes whether the financing closed, not whether the page was checked. Use `verification`, `confidence`, and `disposition` for the separate evidence and publication checks. Rows stored before certainty existed read as `announced`.

Pass one exact value as `certainty` to filter `/api/v1/rounds`, for example `GET /api/v1/rounds?certainty=reported&limit=50`. An invalid value, an empty value, or a comma-separated list returns HTTP 400. The filter applies before cursor pagination, including `sort=trending` and full CSV exports. Omit it to read announced, reported, and expected rounds; unconfirmed rows appear only with `certainty=unconfirmed`. The `/api/v1/openapi.json` contract specifies both the field and the filter.

`sort=amount` lists the published rounds announced on the record first, then every other round: flagged ones, and expected, reported, and unconfirmed ones. Each part runs largest first, with unknown amounts last, so a list of the biggest rounds opens with announced money. Every row still carries its own `certainty` and `disposition`. The feed's amount order, Biggest rounds on the Overview, and CSV exports use the same order. A `next_cursor` under `sort=amount` records which part the page ended in (`amt:N|id` or `amtp:N|id`), so paging crosses from one part to the next without repeating or skipping a row.

MCP accepts the same optional `certainty` value on `list_rounds`, `search_rounds`, and `list_trending`. For example, call `list_rounds` with `{ "certainty": "expected", "limit": 25 }`. `get_company` returns each round's certainty but does not narrow the company's record.

The public feed includes announced, reported, and expected rounds by default; use its early-reports control to see announced rounds alone, or explicitly include unconfirmed rounds. Expected rounds are excluded from capital totals. Delivery targets, public Slack subscriptions, and feed tokens exclude expected rounds unless that specific destination opts in; unconfirmed rounds are never sent. A later on-record announcement updates the same round, retains its first-seen and earlier reporting history, and can be delivered again when the existing news, visibility, hold, and verification checks allow it.

# A round's record: sources, the official announcement, earlier rounds, and valuation

Every round in `GET /api/v1/rounds` (and the MCP tools' compact round) carries these alongside its facts:

- **`sources`** in reading order: the company's own announcement first (a page on its domain or a domain it is known by), then a newswire's release of it (Business Wire, PR Newswire, GlobeNewswire, pr.com and the like), then established outlets, then everything else; within each, the earlier page first. Every surface that lists a round's pages (the API, MCP, feeds, the company page, Slack) uses the same order.
- **`primary_source`**: `{ url, kind }`, the company's own page (`kind: "company"`) or else its wire release (`kind: "wire"`); null when the sources hold neither. When present it is always the first of `sources`.
- **`previous_rounds`**: the company's other visible rounds announced before this one, newest first, at most 10, each with `stage`, `stage_as_written`, `amount`, `announced_on`, `lead_investors`, and `url` (its official announcement when it has one). Earlier rounds verified against their own announcement (history rounds) are included. `company=<domain>` lists every round in full.
- **`valuation_disclosed`**: `true` when a valuation is stated (`valuation_as_written`); `false` when a source says outright that it was not disclosed ("The round's valuation was not disclosed"); `null` when no source says either way. A null valuation with `valuation_disclosed: false` is a known non-disclosure, not a gap. A withholding sentence counts only when it names the company or sits on a page about this round; a roundup's sentence about another deal, or one that names only another of the company's rounds, never does.

A history round's `previous_rounds` entry is how the earlier-rounds pipeline surfaces: an `earlier_rounds` reading on a page queues the prior round on the history ledger, the history lane verifies it against its own announcement, and once visible it appears in every later round's `previous_rounds`.

# Sectors and sector groups

Each company has one sector from a fixed list. The sectors sit in a few groups, and a `sector` filter on a group matches every sector under it. A group named after a sector (`ai`, `fintech`, `climate`, `hardware`, `consumer`) is that sector plus the narrower ones beside it, so `sector=ai` includes `ai infrastructure` and a narrower sector (`sector=ai-infrastructure`) matches itself alone.

| Group | Sectors |
|---|---|
| `ai` | ai, ai infrastructure |
| `software` | enterprise software, developer tools, data and analytics, cybersecurity, hr tech, legal tech, edtech |
| `fintech` | fintech, payments, insurtech, crypto |
| `health` | healthtech, biotech, medtech |
| `climate` | climate, energy |
| `hardware` | hardware, semiconductors, quantum, robotics |
| `aerospace and defense` | space, defense |
| `mobility` | mobility, logistics |
| `consumer` | consumer, ecommerce, marketplace, media and gaming |
| `industrials` | manufacturing, proptech, agtech and food |
| `other` | other |

The same reading applies to `/api/v1/rounds`, `/api/v1/companies`, `/api/v1/investors/top`, `/api/v1/news`, MCP's `list_rounds`, and the feed's sector menu, which lists each group with its sectors inset under it. Case, spaces, and dashes don't matter, and common other names map on (`healthcare` is `health`, `saas` is `software`, `dev tools` is `developer tools`). An unknown word is a 400 that lists the sectors and groups. The groups live in `packages/core/src/records/sectors.ts` (`SECTOR_GROUPS`), and a test holds every sector to exactly one group.

# SEC Form D filings

Rounds read from SEC Form D filings (`preset_slug: "form-d"`) rarely state an amount, a lead, or what the company does, so default lists leave them out. These are `GET /api/v1/rounds`, MCP's `list_rounds`, the feed, Biggest rounds and RSS. Ask for them with `preset=form-d`, for example `GET /api/v1/rounds?preset=form-d`. A company's own record still lists its filings: `company=<domain>`, `get_company` and the company page.

# Dates and windows

`since` on `/api/v1/rounds`, `/api/v1/companies`, `/api/v1/news` and MCP's `list_rounds`, `list_companies` and `list_news` takes the day to count from in any of these forms. Days are UTC.

| Form | Example | Counts from |
|---|---|---|
| A date | `2026-10-04` | that day |
| A month | `2026-10` | the month's first day |
| `today`, `yesterday` | `today` | today, or the day before |
| Days back | `7d` | the day that many days before today |

Anything else is a 400 that lists these forms. `window` on `/api/v1/investors/top` and MCP's `top_investors` is `7d`, `30d` or `90d`, and `week`, `month` and `quarter` read as the same three.
