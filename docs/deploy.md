# Deploy

Everything past the quick start: hosting on Vercel or anywhere else, running a public instance, and who can reach what. Every variable named here is in [configuration.md](configuration.md). Back to the [README](../README.md).

## Vercel

Press the Deploy button in the README, or import the repo and add `FIRECRAWL_API_KEY` plus a Neon database from the Vercel Marketplace. Migrations apply at build.

Set `CRON_SECRET` too (any random string of 16+ characters): Vercel sends it as the bearer on every cron call, and without it the scheduled sweep answers 401. `vercel.ts` sets the Vercel Cron schedule when the project builds, from `FIREROUND_SCHEDULE`. Unset, every route runs once a day (UTC): `/api/cron/accuracy` at 05:00, `/api/cron/sweep`, `/api/cron/company-newsrooms`, and `/api/cron/announcements` at 06:00, `/api/cron/slack-digest` at 07:00, `/api/cron/trending` at 08:00, `/api/cron/deliveries` at 09:00, `/api/cron/verify-rounds` at 10:00, `/api/cron/publication-audit` at 11:00, and `/api/cron/health` at 12:00. With `FIREROUND_SCHEDULE=frequent` (Vercel Pro), the sweep, Trending, and deliveries ([posting to X](#posting-to-x)) run hourly, announcements and verification every 15 minutes, the publication audit every 5, and the health check every 10 ([production alerts](#production-alerts)); accuracy, newsrooms, and the Slack digest keep their daily hours. The hourly tick is a clock, and the coverage rung decides which hours sweep. A change to `FIREROUND_SCHEDULE` takes effect at the next deployment.

Set `AI_GATEWAY_API_KEY` to read every record back against its sources with a model. A deployed function does not see Vercel's OIDC token in its environment, so the key is needed on Vercel too; without one, the judge reads the primary page with Firecrawl alone.

Research runs inline in a server action for up to five minutes (`maxDuration = 300`). That is also the Hobby plan's function maximum, so a host with a shorter limit cuts that button off early. Deep dive starts a durable workflow and returns; the agent is polled in steps of up to eight minutes and the dossier check runs in its own step, so dossiers want the Pro plan's longer step limit.

Vercel Web Analytics and Speed Insights (cookieless) report once you enable them in the project's Analytics and Speed Insights tabs; their scripts load only on a Vercel production build, so a clone hosted anywhere else makes no analytics calls.

### Vercel Hobby

The default schedule deploys on Hobby as it is: Hobby accepts only crons that run at most once a day (each at some minute of its hour), and with `FIREROUND_SCHEDULE` unset every route is daily. That covers the default Lite coverage, whose sweep runs Mondays at 06:00 UTC. Do not set `FIREROUND_SCHEDULE=frequent` on Hobby: Vercel refuses a deployment with sub-daily crons, and the refusal may not show in the dashboard.

On a daily schedule, verification and the publication audit work through their backlog once a day, so new rounds can take a day longer to publish, and a rung above Lite sweeps at most once a day. For a faster cadence on Hobby, call the routes from an external scheduler. Send `Authorization: Bearer <CRON_SECRET>` on each request. GitHub Actions is one option: save `FIREROUND_ORIGIN` as a repository variable and `CRON_SECRET` as an Actions secret, then add a workflow such as:

```yaml
name: Fireround hourly lanes
on:
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:
permissions: {}
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - name: Call authenticated routes
        env:
          ORIGIN: ${{ vars.FIREROUND_ORIGIN }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: |
          for route in sweep trending announcements; do
            curl --fail --silent --show-error --max-time 120 \
              -H "Authorization: Bearer $CRON_SECRET" "$ORIGIN/api/cron/$route"
          done
```

This example covers the three hourly lanes only. Schedule the other paths at the frequent cadences in `vercel.ts`, including deliveries, verification, newsroom refreshes, and the daily Slack digest. Workflow-starting routes deduplicate calls within a UTC minute; a later minute is a new tick. GitHub Actions schedules can run late and are disabled after 60 days of repository inactivity in public repositories, so they are not a punctuality guarantee. External scheduling does not raise Hobby's function-duration limits; long workflow steps may still need Pro.

## Anywhere else

Set `DATABASE_URL` to any Postgres 15+ and `CRON_SECRET` to any random string of 16+ characters (`openssl rand -hex 24`), then `pnpm db:migrate && pnpm build && pnpm start`. A local Postgres without TLS takes a plain URL such as `postgres://postgres:postgres@localhost:5432/postgres`; adding `?sslmode=require` to it makes the migration fail with "The server does not support SSL connections". The README has a copy-paste version on a throwaway Docker Postgres.

`pnpm start` ticks the schedule itself every hour, and `/api/cron/verify-rounds` and `/api/cron/announcements` every quarter hour, by calling its own cron routes with `CRON_SECRET` as the bearer (`SCHEDULE=0` turns it off, `SCHEDULE=1` turns it on under `pnpm dev`). Without the secret the routes refuse every tick in production, and the server says so when it starts. The tick is a clock: on the default Lite rung the sweep itself runs on Mondays at 06:00 UTC, so press Run the first sweep (or call `/api/cron/sweep?force=1` with the bearer) to fill a new store. The in-process schedule leaves out `/api/cron/health`; point any scheduler at it every 10 minutes with the cron bearer to get [production alerts](#production-alerts).

## Production settings

Set `APP_ORIGIN` to your production URL so webhooks, Slack links, share cards, canonical tags, and the sitemap point at it, and `EDGAR_USER_AGENT` to `your-app/version (you@example.com)`, because EDGAR asks every caller to identify itself.

Set `FIRECRAWL_WEBHOOK_SECRET` before creating a monitor. It is the secret in your Firecrawl dashboard (Advanced settings) that signs monitor webhooks. In production the route requires both a configured secret and a valid `x-firecrawl-signature` HMAC. `WEBHOOK_BEARER_TOKEN`, when configured, is an additional requirement, never a replacement for the signature.

The Postgres socket pool defaults to three connections per process. Increase `DATABASE_POOL_MAX` only within your database's connection budget, accounting for concurrent serverless instances. Neon's HTTP driver does not use this socket pool.

For an existing Slack install, set `SLACK_WEBHOOK_KEY` to a stable random secret of at least 32 characters **before deploying this version**. The migration encrypts existing admin delivery targets in place and refuses to leave them in plaintext if the key is missing. New targets and public subscriptions use the same AES-256-GCM encryption. Set `SLACK_SIGNING_SECRET` from Slack's App Credentials and enable `app_uninstalled` and `tokens_revoked` at `<APP_ORIGIN>/api/webhooks/slack`; see [Slack setup](slack.md#creating-the-slack-app). Failed-post cleanup remains a fallback.

## Back up and restore the database

The steps below are for Neon, the database the Deploy button provisions. fireround.dev runs on PlanetScale Postgres; its differences are in [PlanetScale](#planetscale) after the Neon runbook. The dump script and its checks are the same on both.

Two layers. Neon's instant restore (point-in-time, within the project's history window) is the first answer to a bad write: it rewinds the branch in seconds and keeps the old state as a backup branch. A logical dump is the copy that outlives the window, the Neon project, and the account.

Two rules for every dump and restore. Use Neon's direct host, never the one with `-pooler` in its name: the pooler hands pg_dump's session settings on to the app's connections (on fireround.dev that was a four-minute outage). And use a client whose major matches the server's: pg_dump refuses a newer server. On a Mac, `brew install postgresql@18` is keg-only and leaves an older `pg_dump` on `PATH` alone; point `PG_BIN` at it.

```bash
export PG_BIN=/opt/homebrew/opt/postgresql@18/bin
# DATABASE_URL: the direct host (drop "-pooler" from the hostname); the script refuses the pooler
pnpm backup-db -- --dir ~/fireround-backups --label prod --keep 14
```

It writes `fireround-prod-<UTC time>.dump` and a manifest beside it (`.json`, every table's row count in the dump's own snapshot), reads nothing but what pg_dump reads, and prunes the label's dumps past the newest 14. Prove a dump restores before you need it, into a throwaway Postgres of the same major:

```bash
docker run --rm -d --name fireround-restore -p 55418:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18
$PG_BIN/createdb -h localhost -p 55418 -U postgres restore
pnpm backup-db -- --verify ~/fireround-backups/fireround-prod-<time>.dump --into postgres://postgres@localhost:55418/restore
docker stop fireround-restore
```

No Docker: `$PG_BIN/initdb` a scratch cluster and start it on the same port with `$PG_BIN/pg_ctl`.

`--verify` restores only into a database on this machine and exits 1 when any table's rows differ from the manifest.

### Restore runbook

1. **Stop the writers.** Pause the schedule so nothing writes while you restore: disable the crons (Vercel project, Settings, Cron Jobs) and hold any running backfill.
2. **Within the history window, use instant restore.** In the Neon console, Backup & Restore on the production branch: pick a time just before the bad write, preview it (Time Travel queries or the Tables view), and restore. Neon keeps the pre-restore state as `<branch>_old_<time>`. The app's `DATABASE_URL` is unchanged, so nothing redeploys. Only a root branch restores in place; for anything else, create a branch from that point in time and switch to it as in step 4.
3. **Past the window, restore a dump into a new database, never over the live one.** Create a branch or database in Neon (an empty one, not a copy of production), then, on its direct host:

   ```bash
   pnpm backup-db -- --verify <file.dump> --into postgres://postgres@localhost:55418/restore   # the archive is sound
   $PG_BIN/psql "<the branch's direct URL>" -c "create database fireround_restore"
   $PG_BIN/pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
     --dbname="<the same URL, with /fireround_restore for the database>" <file.dump>
   ```

   `--single-transaction` makes the restore all or nothing. Compare a few tables' counts (`funding_rounds`, `companies`, `round_sources`) with the dump's manifest.
4. **Switch the app.** Set `DATABASE_URL` in Vercel to the restored database (the app itself may use the pooler URL) and redeploy. The migrations table came with the dump, so the build's migrate step has nothing to apply.
5. **Resume.** Turn the crons back on, check Runs for the next tick, and keep the old branch or database until the restored one has run a day.

### PlanetScale

The same two layers. PlanetScale backs up every production branch every 12 hours and archives the write-ahead log between backups, so point-in-time recovery reaches any moment from the oldest retained backup to about five minutes ago. The included schedule keeps backups for two days; for a longer window add a schedule under the database's Backups page (Add new schedule, with its own retention), which PlanetScale bills beyond the included backup storage. A logical dump is still the copy that outlives the retention window, the database, and the account.

Dump over the direct endpoint: the database's host on port 5432 with the plain username. The app's URL may point at PgBouncer (port 6432, or a username ending in `|bouncer`), which is right for the app and wrong for pg_dump for the reason given above; `pnpm backup-db` refuses port 6432 and a `|bouncer` user, and the migrate script switches to the direct endpoint on its own.

```bash
export PG_BIN=/opt/homebrew/opt/postgresql@18/bin
# DATABASE_URL: postgres://<user>:<password>@<host>.psdb.cloud:5432/<database>?sslmode=require (not 6432, no "|bouncer")
pnpm backup-db -- --dir ~/fireround-backups --label prod --keep 14
```

Prove the dump with `--verify` exactly as above. Restoring:

1. **Stop the writers**, as in the Neon runbook.
2. **Within the retention window, restore to a new branch.** On the database's Backups page, pick the backup before the bad write and choose Restore to new branch, or restore to a point in time for a moment between backups. The restore never touches the live branch: it creates an independent branch with the data as of that point. PlanetScale does not restore extensions; Fireround's migrations create none, so there is nothing to reinstall.
3. **Past the window, restore a dump into a new branch or database**, never over the live one: create it empty, then run the `pg_restore` command from the Neon runbook's step 3 against its direct endpoint (port 5432), and compare a few tables' counts with the dump's manifest.
4. **Switch the app.** Promote the restored branch to production, or set `DATABASE_URL` in Vercel to its URL (the PgBouncer port is fine for the app) and redeploy. The migrations table came with the data, so the build's migrate step has nothing to apply.
5. **Resume**, as in the Neon runbook, and keep the old branch until the restored one has run a day.

## Production alerts

`/api/cron/health` runs every 10 minutes on Vercel Cron and tells you when production breaks, before a visitor does. Turn it on with one variable: create a Slack incoming webhook for a private channel (api.slack.com/apps, Create New App, Incoming Webhooks, Add New Webhook to Workspace, pick the channel) and set its URL as `ALERT_SLACK_WEBHOOK_URL`. Unset, the check still runs and writes each message to the function log instead. After a deploy, send one test line to the channel:

```bash
curl -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/health?test=1"
# What fails right now, read only: no state written, nothing sent
curl -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/health?dry=1"
```

Each check looks at:

- **The database**: a read of `funding_rounds` by its unqualified name, so a connection whose `search_path` was emptied fails it even though `select 1` would pass (the message says so when `public.funding_rounds` still answers). With the database failing, the checks below are skipped.
- **Public pages**: `/`, `/feed`, and `/api/v1/rounds?limit=1` fetched from `APP_ORIGIN` must answer 2xx within 15 seconds (with `DASHBOARD_PASSWORD` sent when set; production behind Vercel Deployment Protection answers 401 here).
- **Each scheduled lane's cadence**: every preset's sweep, watch sites, Form D, X announcements, and Trending must have started a run since the last tick the coverage plan made due at least two hours ago, computed with the same clocks the cron routes use. On Max that is every hour, so one missed tick is covered by the next and two in a row alert; a daily or weekly lane alerts two hours after the tick it missed. A lane the rung has off owes nothing, nor does a tick before the rung last changed. Monitor webhooks are owed within the monitor schedule plus a day per stored monitor, since Firecrawl posts only when a check finds pages.
- **Run errors**: half or more of a scheduled lane's last 8 finished runs (in the last day, at least 4) erroring. One bad sweep tick across three presets stays under that. Deep dives are left out: they record a rejected dossier as an error. A scheduled lane's run with no end two hours after it started (a workflow that died mid-run; the longest real one has taken about half an hour) is closed as failed with "never finished" and counts here like any other failure, so Runs stops showing it as running.
- **Deliveries**: a target with rows dead-lettered after the whole retry schedule (in the last week, with no successful send to it since) or retrying after 3 failed sends. Dead letters by policy (a round no longer news, a revoked subscription) never count.
- **Freshness**: no new visible round for longer than the sweep's interval under the plan plus 12 hours: 13 hours on Max, a week and a half-day on Lite.
- **Credits**: the Firecrawl credits every run recorded in the last 24 hours (measured, else estimated; Runs shows each) past twice the busiest 24 hours of the eight days before, so a looping lane or a forgotten backfill is caught within the day. Busiest, not average, so a weekly sweep day compares with last week's; with under three days of history nothing is owed. `CREDIT_ALERT_PER_DAY` sets a fixed ceiling instead, which also applies from the first day.

A message goes out only when something changes: a condition must fail on two checks in a row to open an incident, the incident sends one message (not one per check), and a single "recovered" follows after two passing checks. Conditions confirmed on the same check share one message, and at most 5 messages open incidents per UTC day; past that they wait for the next day, while recoveries still go out. Each message names what fails, since when, the likely cause, and one link; it never mentions `@channel`. The incident state lives in the `settings` table under the `health` key. If the database itself is down, the state cannot be saved: the check confirms the failure a second time 20 seconds later within the same run, alerts, and remembers it in the function's memory, so a cold instance may repeat that one alert or miss its recovery.

## Posting to X

Fireround can post significant rounds to an X account. It is off until `X_POSTING` says otherwise, and runs inside the hourly `/api/cron/deliveries` call.

A round qualifies when every one of these holds: the news rule every channel shares lets it through (`lib/deliverable.ts`: not history, not held, not merged away, not old news), it is announced (not reported or expected), published (not flagged or in review) with a confirmed or corrected read-back, it was announced today or in the two days before, it names a lead investor or an amount, its company page has a clean URL (no `:identity:` id and no spaces; such rounds are skipped with `x: skipped (unclean company url)` in the log), and it is either at least `X_MIN_USD_MILLIONS` (50) or in Trending's top `X_TRENDING_TOP` (5). Each run posts at most one round, the best first (Trending's top rounds by rank, then the largest), no sooner than 24 hours divided by `X_MAX_POSTS_PER_DAY` (6, so four hours) after the last, and never more than that many in 24 hours.

A post is one short sentence and the company page, whose share card X renders:

```
Spiko raised a $90M Series B led by New Enterprise Associates.
https://fireround.dev/companies/spiko
```

The company's trailing legal form is dropped ("NexBank Capital, Inc." reads "NexBank Capital", "AnaCardio AB" reads "AnaCardio"). Two leads are named at most, then "and others", and a lead's descriptive clause is cut so one investor never reads as two ("Kembara, Mundi Ventures' European scale-up fund" reads "Kembara"). The company's own line follows the sentence only when it is short, makes no claim ("leading", "first"), and the company's homepage passed the identity check. `@`, `#`, and `$TICKER` never reach X, so no investor is tagged. A post never runs past 280 characters.

Every round gets one row in the deliveries outbox on channel `x`, so it is posted at most once, and a merge carries the row to the surviving round. The row keeps the post's id and the company, stage, and figure it stated. When a posted round is later rejected, corrected on any of those three, or merged into a round that was posted too, the next run deletes the post and marks the row `retracted` with the reason. A 429 waits for X's own reset time; a 403 or any other failure retries on the outbox's backoff and then dead-letters, and the lane posts nothing while a failure is backing off.

To turn it on:

1. In the X developer portal, give the account's app **Read and write** permission and generate its OAuth 1.0a keys. Set `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_TOKEN_SECRET`.
2. Set `APP_ORIGIN` to the public origin, since posts link to it.
3. Set `X_POSTING=dry_run` and redeploy. Each run writes `x: would post ...` with the exact text to the function log and stores it on the row as `previewed`. To review in Slack too, set `X_REVIEW_SLACK_TARGET` to a Slack delivery target's label as Settings, Delivery shows it (`#x-review · Acme`), or its id; a disabled target works, so a review channel can take the previews and nothing else. Nothing is sent to X.
4. Once the dry runs read right, set `X_POSTING=live`. A round a dry run previewed can still be posted live; going back to `off` stops everything at once.

The cron response carries what the run did under `x`.

## Slack

Settings, Delivery has a "Create the Slack app" button that opens Slack with the app prefilled for your origin. Paste its Client ID and Client Secret into `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, redeploy, and Add to Slack connects a channel in one click. No app at all: copy the `/feed subscribe` command Settings writes for you. The three paths in full: [slack.md](slack.md).

## Investor websites for an existing store

New investors get a site, a logo, and a profile on every enrichment pass, and every pass also works a slice of the backlog, so a store catches up on its own. To do the whole directory at once, `pnpm resolve-investors -- --out investor-backfill` plans it without writing (it reads the store and calls Firecrawl, about 7 credits an investor), `investor-backfill/report.md` says what it would change, and `pnpm resolve-investors -- --apply --plan investor-backfill/plan.json` writes the reviewed plan with no further call. Run `pnpm repair-investors -- --apply` first, so the plan's ids are the directory's. The options: [scripts.md](scripts.md).

## Dossiers for every company

Every dossier is checked against its sources before it is saved ([how-it-works.md](how-it-works.md#dossiers-are-checked-before-they-are-saved)), so the check needs a model key (`AI_GATEWAY_API_KEY`). It uses `DOSSIER_VERIFY_MODEL` when set, else `RECONCILE_MODEL`, else `openai/gpt-6-sol`; a gateway team that enforces Zero Data Retention should set `DOSSIER_VERIFY_MODEL` to a model with a ZDR provider. One route gives every visible company a checked dossier. It is not in `vercel.ts`: an operator starts it with the cron bearer, and it answers with the pass's run id.

```bash
# Check the dossiers written before the check; no agent runs
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/backfill-dossiers?reverifyOnly=1"
# A pilot: check five and dive five
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/backfill-dossiers?limit=5"
# Progress: dossier coverage and the latest passes with their counts
curl -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/backfill-dossiers"
# Everything, twenty at a time, no new dive past 250,000 credits
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/backfill-dossiers"
```

A dive costs what the agent reports (effort high, capped at 2,500; a run that hits the cap is not billed) plus the check's reads, about 7 to 17 credits. The pass runs twelve companies per workflow run and hands the rest to a fresh run, so a pass over hundreds of companies takes hours; Runs shows it as one Dossiers row. On Max, each sweep tick also dives two companies still without a checked dossier, so the store converges without the route, only slower.

## History rounds for every checked dossier

Each checked dossier lists the company's earlier rounds (and a company's timeline search queues the rounds its results state that the store lacks); each is promoted to a verified round marked history only when its own announcement is found and read back like any record ([how-it-works.md](how-it-works.md#history-rounds-a-companys-earlier-rounds-each-verified-on-its-own)). New dossiers queue theirs on their own; this route does the ones already on the store. It is not in `vercel.ts`: an operator starts it with the cron bearer, and it answers with the pass's run id and its workflow run id. It is idempotent, so running it again only picks up rounds not yet looked for and failures whose backoff is over.

```bash
# A pilot: ten dossiers
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/history-rounds?limit=10"
# Progress: where the prior rounds stand, the latest passes with their counts, the newest history rows
curl -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/history-rounds?workflow=<workflowRunId>"
# Everything, three companies at a time, no new company past 25,000 credits
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/history-rounds"
```

A prior round costs a site map, one search, one to five page reads, and the read-back: about 11 to 21 credits when it is found and about 30 when no page states it. The read-back uses the reconcile model when a key is set (`AI_GATEWAY_API_KEY`) and the judge otherwise. Runs shows the pass as one History row and each company as its own.

## The daily accuracy check

`/api/cron/accuracy` is on the schedule (05:00 UTC), and the same route runs it by hand with the cron bearer. Each run reads the companies that matter most, records the flags admins see in Review under Accuracy, clears the ones that no longer hold, starts the capped remedies (a profile refresh, a deep dive, a history lead), and writes one Accuracy row on Runs with its counts: companies read, flags new, open, dismissed, reopened, and cleared, and the remedies started or skipped ([data-quality.md](data-quality.md#the-daily-accuracy-check)). The checks are database reads; a profile refresh costs what an enrichment read costs (a search and up to three homepage reads), a dive and a history pass what their lanes cost, and both record their own rows.

```bash
# What it would flag now, written nowhere
curl -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/accuracy?dry=1"
# Record the flags, start no remedy
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/accuracy?remedies=0"
# A run with other caps: ten profile refreshes, no dives, three history passes
curl -X POST -H "authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/accuracy?profile=10&dossier=0&history=3"
```

The params (query string, or a JSON body on POST): `topN` (100 per ranking), `remedies` (0 for flags only), `profile` (5), `dossier` (2), `history` (3). Without `FIRECRAWL_API_KEY` no remedy starts, and without a model key no dive does; the flags are recorded either way. `pnpm accuracy-check` prints the same report as the dry run from the command line and only reads, so it is safe against production.

## Host a public instance

`PUBLIC_DEMO=1` makes the instance a read-only demo: `/` is the feed, and anyone can browse the feed, news, runs, companies, and investors, call the read API (`/api/v1`, `/api/mcp`, `/api/v1/openapi.json`), and subscribe at `/feeds/public/{preset-or-all}.{rss,atom,json}`. A visitor spends nothing: Deep dive and the dossier's Refresh are hidden and their action is refused like every other write, so the dossiers a visitor reads are the ones the coverage rung builds on its own (every new company on Max, above $10M on Deep; [coverage.md](coverage.md)). Without `MCP_API_KEY` the MCP server drops its one write (`mark_seen`) and, like `/api/v1`, lists only the rounds the feed publishes. A visitor reads no operator detail anywhere: `/api/v1`, the MCP tools, the feeds, the CSV and JSON exports, and the browser's own rows leave out which model read a round back (`verification.verifier`), the search query that found each source (`sources[].query`), why a profile was refused, every credits field and credit or budget counter on `/api/v1/runs`, and, over MCP, a preset's queries and accounts (`lib/public-view.ts`). A failure says one sentence: an MCP tool, a Slack manage action, and a run's stored error never forward a driver error (which quotes its query and parameters) or a stack. The demo's `/api/v1/openapi.json` describes the visitor's API, without `include_review`, the credit fields, or Basic auth. The admin, and every caller on a private instance, still read the full rows. Add `LANDING=1` and `/` serves the landing page instead, with the dashboard at `/feed`.

Presets, Review, Settings, and every other write then depend on `DASHBOARD_PASSWORD`:

- **Unset**: the demo has no admin tier at all. There is no sign-in link, the admin paths answer 404, and every write is refused. Change coverage and presets from a private instance on the same database, such as a Vercel preview deployment with `PUBLIC_DEMO` unset, behind Vercel's own login.
- **Set**: the admin paths ask for it. Sign in once from the sidebar's "Sign in" link and the browser sends the credentials origin-wide.

A public instance should also cap what one client can pull. On Vercel, add Firewall rate-limit rules per IP over a 60-second window, answering 429 past the limit, on five kinds of path. Reasonable starting points: `/api/v1` and `/api/mcp` at 60 requests each, `/feeds/` at 30, paths containing `opengraph-image` or `twitter-image` at 120, and server function POSTs (a `next-action` header) at 120. Add them under the project's Firewall tab or with `vercel firewall rules add`; blocked requests are not billed.

The app counts too, so a clone without firewall rules is not open-ended. On a public demo every visitor-reachable door that costs something per call has a per-address budget in `lib/rate-limit.ts`, counted in the store (the `rate_limits` table, so it holds across serverless instances; only a hash of the address is kept, and rows older than a day are pruned as it runs): `/api/v1` pages 60 a minute, a CSV with no `limit` (the whole filtered set, up to 10,000 rows) 10 per ten minutes, `/api/mcp` 60 a minute, the command palette's search 120 a minute, `/api/slack/connect` 10 per ten minutes, and `/api/logo` 600 a minute. Past a budget the answer is a 429 with `Retry-After` (the palette just shows no hits). An admin and a private instance's callers are never counted, and a store that cannot count lets the call through. The logo route also refuses any query but its own `kind` and `ui`, so a junk parameter cannot bust the CDN's cache.

A public instance serves its visitors from cache: the prerendered shells and the read API (`s-maxage=60`) from Vercel's CDN, and every page's live data from the shared runtime cache, refreshed at most once a minute per page and filter ([how-it-works.md](how-it-works.md#screens)). What still reaches the database is a page's first view in a minute (a crawler's long tail, a new search) and the admin's reads. For a launch spike, point `DATABASE_URL` at the pooler: Neon's pooled URL (the `-pooler` host; the Marketplace integration sets it so), with the compute given room to autoscale (a 0.25 CU compute allows about 100 connections, 1 CU about 400), or PlanetScale's PgBouncer on port 6432.

A clone without `PUBLIC_DEMO` behaves exactly as the README describes.

## Alexandria

An instance can serve as a funding data source for [Firecrawl's Alexandria](https://docs.firecrawl.dev/features/alexandria), answering agents' funding-round searches, trending rounds, and company lookups from `GET /api/v1/rounds`. Every agent's call reaches the API from a handful of addresses, so set `ALEXANDRIA_API_KEY` to a random secret of 32+ characters, and give Alexandria the same value to send as `Authorization: Bearer <key>`. A request with it skips the per-address budgets in `lib/rate-limit.ts`; it is not an admin and reads exactly the public rows a visitor reads. The Vercel Firewall's `/api/v1` rule counts by IP before the app sees the request, so give it an exception for requests whose `authorization` header equals `Bearer <key>` (a Bypass rule above the rate limit), or Alexandria meets the firewall's 429s instead.

## Who can reach what

Without `PUBLIC_DEMO` and without `DASHBOARD_PASSWORD`, everything is open: every button that spends Firecrawl credits (Run sweep, Create monitor, Research, Deep dive), the coverage rung, feed tokens, and delivery targets are reachable by anyone who can reach the URL. That is the laptop case.

Set `DASHBOARD_PASSWORD` and the dashboard and `/api/v1` sit behind HTTP Basic auth (any username); API clients send `-u fireround:$DASHBOARD_PASSWORD`. The alternative is a private URL behind [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection).

The routes outside the dashboard keep their own secrets: the feeds carry a per-token path, the MCP server takes `MCP_API_KEY` as a bearer, the cron routes take `CRON_SECRET` (in production they refuse every call without one), and the webhook verifies `FIRECRAWL_WEBHOOK_SECRET`. On a private deployment with `DASHBOARD_PASSWORD`, MCP refuses all calls until `MCP_API_KEY` is set and presented; Basic dashboard credentials do not authorize MCP. A keyless `PUBLIC_DEMO=1` instance keeps its public read-only MCP tools, while a private instance without a dashboard password remains deliberately open.
