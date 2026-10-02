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
