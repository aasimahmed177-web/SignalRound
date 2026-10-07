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

MCP accepts the same optional `certainty` value on `list_rounds`, `search_rounds`, and `list_trending`. For example, call `list_rounds` with `{ "certainty": "expected", "limit": 25 }`. `get_company` returns each round's certainty but does not narrow the company's record.

The public feed includes announced, reported, and expected rounds by default; use its early-reports control to see announced rounds alone, or explicitly include unconfirmed rounds. Expected rounds are excluded from capital totals. Delivery targets, public Slack subscriptions, and feed tokens exclude expected rounds unless that specific destination opts in; unconfirmed rounds are never sent. A later on-record announcement updates the same round, retains its first-seen and earlier reporting history, and can be delivered again when the existing news, visibility, hold, and verification checks allow it.

# A round's record: sources, the official announcement, earlier rounds, and valuation

Every round in `GET /api/v1/rounds` (and the MCP tools' compact round) carries these alongside its facts:

- **`sources`** in reading order: the company's own announcement first (a page on its domain or a domain it is known by), then a newswire's release of it (Business Wire, PR Newswire, GlobeNewswire, pr.com and the like), then established outlets, then everything else; within each, the earlier page first. Every surface that lists a round's pages (the API, MCP, feeds, the company page, Slack) uses the same order.
- **`primary_source`**: `{ url, kind }`, the company's own page (`kind: "company"`) or else its wire release (`kind: "wire"`); null when the sources hold neither. When present it is always the first of `sources`.
- **`previous_rounds`**: the company's other visible rounds announced before this one, newest first, at most 10, each with `stage`, `stage_as_written`, `amount`, `announced_on`, `lead_investors`, and `url` (its official announcement when it has one). Earlier rounds verified against their own announcement (history rounds) are included. `company=<domain>` lists every round in full.
- **`valuation_disclosed`**: `true` when a valuation is stated (`valuation_as_written`); `false` when a source says outright that it was not disclosed ("The round's valuation was not disclosed"); `null` when no source says either way. A null valuation with `valuation_disclosed: false` is a known non-disclosure, not a gap. A withholding sentence counts only when it names the company or sits on a page about this round; a roundup's sentence about another deal, or one that names only another of the company's rounds, never does.

A history round's `previous_rounds` entry is how the earlier-rounds pipeline surfaces: an `earlier_rounds` reading on a page queues the prior round on the history ledger, the history lane verifies it against its own announcement, and once visible it appears in every later round's `previous_rounds`.
