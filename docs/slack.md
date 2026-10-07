# Slack

Three ways to get funding rounds into a Slack channel, from one click to no setup at all. All three live in Settings → Delivery. A public demo (`PUBLIC_DEMO=1`, like fireround.dev) adds a fourth for its visitors: [Public Add to Slack](#public-add-to-slack). Back to the [README](../README.md).

| Path | Setup | What the channel gets |
| --- | --- | --- |
| Add to Slack | A Slack app, once (two minutes, below) | Block Kit messages per round, through a delivery target |
| Slack's `/feed` | None | Slack's RSS app posts each new item from a private feed |
| Paste a webhook URL | An incoming webhook you made yourself | Block Kit messages, same as Add to Slack |

## What a round looks like

Add to Slack and a pasted webhook post the same message, built by `slackBlocks` in `lib/delivery.ts`: the headline ("Firecrawl raised a $75M Series B"), the company's one-line description and site, a grid of amount, stage, lead, date, sector, and other investors (a field the record lacks is left out), the verdict with up to three source links ("Verified against 5 sources"), and two buttons, **Open round** (the company page on `APP_ORIGIN`) and **Read the source**. Link unfurls are off, so the sources stay one line. The landing page draws this message from a live round.

![A new round posted to Slack: the headline, the field grid, the verdict with its sources, and the two buttons](screenshots/slack.png)

### What is never posted as new

Every Slack path (targets, subscriptions, and the daily digest), like webhooks and the email digest, asks one rule before it queues a round and again at the moment it sends (`newsBlocks` in `lib/deliverable.ts`). A round goes only when it is visible (published or flagged), not history, not held as a late re-report (a dossier, a ledger lead, or a stored round reports the same round well before the row's day), not a merged-away copy, and announced no more than 14 days before the moment of sending. A row that fails at send time is dead-lettered with the reason, so the outbox shows why nothing went. An undated round never reaches a channel on its own: it starts in review. On 2026-09-25 Assort Health's June 24 Series C was posted as new from a September profile; under this rule it is 93 days old and never leaves the outbox.

Slack shows the app's own icon beside the message. The manifest cannot set one; upload a square PNG of at least 512 pixels under the app's **Basic Information → Display Information** (the flame's geometry is in `app/icon.svg`).

## Add to Slack

With `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_WEBHOOK_KEY` set, Delivery shows an Add to Slack button. Press it, pick a channel on Slack's screen, and you land back on Settings with the new target highlighted. It is named after the channel and workspace (`#deals · Acme`), receives every preset, and takes verified and checked rounds, the same default as the manual form; change or delete it like any other target. Nothing posts until a round arrives or you press Send a test.

Under the hood it is Slack's OAuth v2 flow with one scope, `incoming-webhook`:

1. `GET /api/slack/install` sets a random state in an httpOnly, SameSite=Lax cookie (Secure in production, ten minutes, path `/api/slack`) and redirects to `https://slack.com/oauth/v2/authorize`.
2. Slack redirects to `GET /api/slack/oauth/callback`. The route checks the state against the cookie and clears it, exchanges the code at `oauth.v2.access`, and keeps the channel's webhook URL, channel and workspace metadata, and the bot and installing-user IDs used to match revocations. The bot token Slack also returns is discarded.
3. The webhook URL is encrypted with AES-256-GCM under `SLACK_WEBHOOK_KEY` before it is stored as a delivery target, using the same format as public subscriptions. After that it is shown masked (`hooks.slack.com/…wxyz`): anyone holding the original URL can post to the channel. Manually pasted Slack webhooks are encrypted too.

Before upgrading an existing Slack deployment, set `SLACK_WEBHOOK_KEY` to a random secret of at least 32 characters (`openssl rand -base64 48`). The deployment and embedded-database startup migrate existing plaintext Slack targets in place; repeated migration leaves encrypted values unchanged. Migration refuses to run without a valid key when plaintext targets exist. Keep the key stable and back it up securely: changing it makes existing credentials unreadable and invalidates public manage links.

Both routes are admin actions. They sit behind `DASHBOARD_PASSWORD` like the rest of the dashboard, stay behind it in `PUBLIC_DEMO` mode (like `/settings`), and check the password themselves as well.

### Creating the Slack app

With the variables unset, Delivery shows a "Connect Slack in two minutes" card instead of the button:

1. **Create the Slack app** opens `https://api.slack.com/apps?new_app=1&manifest_json=…`, Slack's create-from-manifest page, prefilled with: the name Fireround, a description, the `incoming-webhook` bot scope, incoming webhooks turned on, and this instance's redirect URL (`<origin>/api/slack/oauth/callback`). Pick a workspace and press Create. The manifest follows [Slack's manifest reference](https://docs.slack.dev/reference/app-manifest) (`_metadata.major_version` 2); it declares a bot user because Slack issues a bot token with every OAuth v2 install, but that bot never posts.
2. On the app's **Basic Information** page, under **App Credentials**, copy the Client ID, Client Secret, and Signing Secret into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`. Set `SLACK_WEBHOOK_KEY` to a stable random secret of at least 32 characters. On Vercel the card links to the project's Environment Variables page; elsewhere use `.env` or your host's settings.
3. Redeploy (or restart the server). Under **Event Subscriptions**, enable events, set the Request URL to `<origin>/api/webhooks/slack`, and subscribe to the bot events `app_uninstalled` and `tokens_revoked`. The generated manifest includes this configuration. If Slack asks to verify the URL before the app exists, deploy with its signing secret and save Event Subscriptions afterwards. Reinstall the app when Slack requests it.

The origin comes from `APP_ORIGIN` when set, else the host the request arrived on. Set `APP_ORIGIN` to your production URL before creating the app, so the redirect URL in the manifest and the one the install sends agree; if you later move domains, add the new callback under the app's **OAuth & Permissions → Redirect URLs**.

An app that is not distributed publicly installs only into the workspace that created it, which is all a self-hosted instance needs.

### Localhost

Slack's OAuth docs require the redirect URL to use https, and Slack's servers cannot fetch a feed from your laptop, so the card warns when the origin is localhost. To try Add to Slack or `/feed` locally, run a tunnel (ngrok, cloudflared), set `APP_ORIGIN` to its https URL, and create the app from there. Pasting a webhook URL works from localhost, since delivery is an outbound request.

## Public Add to Slack

On a public demo any visitor can add Fireround to a channel of their own, with no password and no account. The landing page's Delivery section and the feed's Subscribe line carry an Add to Slack button with two pickers (which rounds: a preset or all of them; how often: each round, or a daily digest), and `/slack` is the same button on a page of its own, with the welcome and a digest drawn from the live feed. The `/feed` command stays under the button as the way that needs no app. Without the three variables below only the `/feed` command and the raw feeds show.

### What a channel gets

- **The welcome**, right after the install: "Fireround is connected to #channel", which rounds and how often, today's top three Trending rounds as compact cards (the newest three on a day nothing trends), and a **Manage this channel** button.
- **Each round** (`instant`): each new visible round we find under the preset, history rows excluded, as the card above. A sweep that finds many at once posts the five largest as cards and one "And N more new rounds on Fireround" note.
- **Daily digest** (`daily`): one message at 07:00 UTC with the count of rounds newly found in the last day (found, not announced; a round announced more than 14 days before the digest is left out, as every channel leaves it out) and their total, the five largest rounds by amount, then up to three Trending rounds it has not listed. A quiet day posts nothing.
- Every message ends with **Fireround · Manage · Unsubscribe · Privacy**. At most 50 posts reach one channel per UTC day (cards, notes, digests, tests, and the welcome together); past that, rows wait for the next day.

### The manage page

Manage opens `/slack/manage/<token>`: the workspace and channel names, the preset and cadence to change, Send a test (once per 30 seconds), Pause and Resume, and Unsubscribe behind a confirmation (the message's Unsubscribe link opens the page with that question already asked). The token is an HMAC of the subscription's id under a key derived from `SLACK_WEBHOOK_KEY`, so it is never stored (the table keeps its SHA-256) and a reinstall into the same channel keeps the same link. The page is `noindex`, sends no referrer, and is disallowed in `robots.txt`. Anyone holding the link can manage that one channel and nothing else.

### How it works

1. `GET /api/slack/connect?preset=<slug>&cadence=<instant|daily>` checks the install is on, rate-limits the address (ten starts per ten minutes), refuses early when the instance is full, and sets `fireround_slack_connect` (a random state plus the picks; httpOnly, SameSite=Lax, Secure in production, ten minutes, path `/api/slack/connected`) before redirecting to Slack's consent screen with the one scope, `incoming-webhook`.
2. Slack returns to `GET /api/slack/connected`. The route checks the state against the cookie and clears it on every way out, exchanges the code at `oauth.v2.access`, and keeps the webhook URL, channel and workspace IDs and names, and the bot and installing-user IDs used to match revocations. The bot token is discarded.
3. The subscription is created, or updated when that (workspace, channel) already has one: one row per pair, so a reinstall replaces the webhook, applies the new picks, and reactivates it. The webhook is encrypted at rest with AES-256-GCM under a key derived from `SLACK_WEBHOOK_KEY`, decrypted only at the moment of sending, and never rendered, logged, or put in a URL.
4. The welcome posts, and the visitor lands on the manage page.

Delivery shares the outbox with the delivery targets (rows keyed `sub:<id>`), so a round is queued once in the sweep's deliver step and retried like any other. A Slack answer of 404 or 410, or `channel_not_found`, `invalid_token`, `no_service`, `no_team`, `team_disabled`, or `channel_is_archived`, ends the subscription and forgets its webhook; a 429 or a 5xx backs off on the outbox schedule. The digest runs from `/api/cron/slack-digest` at 07:00 UTC (one more Vercel Cron, four in `vercel.json`, well inside the Pro plan's limits), and the six-hourly deliveries cron sends any digest that failed.

With Event Subscriptions configured, Slack's `app_uninstalled` event removes stored webhook credentials for that workspace, and `tokens_revoked` removes credentials associated with the revoked install. The receiver verifies Slack's signature over the raw request body and rejects timestamps outside a five-minute window. It clears admin targets and public subscriptions without waiting for the next post. Failed-post cleanup remains a fallback for removed webhooks, archived channels, and missed events.

### Abuse and privacy

The connect route is rate-limited per address by the shared limiter (`lib/rate-limit.ts`, counted in the store so it holds across serverless instances; only a hash of the address is kept, for a day); the walls are the caps: 500 live channels in total (`SLACK_SUBSCRIPTION_CAP`) and 20 per workspace. The install keeps Slack's bot and installing-user IDs to match token revocations, alongside the workspace and channel metadata and encrypted webhook. It does not keep a personal name, email, or raw IP address. The pickers disclose the stored install IDs. The admin install (`/api/slack/install`, `/api/slack/oauth/callback`) stays admin-only in demo mode; the public routes, `/slack`, and the manage pages are the only Slack paths open to visitors, and they write nothing but the visitor's own subscription. Outside demo mode the public routes answer 404. Admins see counts only (active, each round, daily, paused, ended, workspaces, queued) in Settings → Delivery, never a workspace, a channel, or a webhook.

### Setting it up

For fireround.dev (any demo: replace the origin in both redirect URLs):

1. [Create the Slack app from this manifest](https://api.slack.com/apps?new_app=1&manifest_json=%7B%22_metadata%22%3A%7B%22major_version%22%3A2%2C%22minor_version%22%3A1%7D%2C%22display_information%22%3A%7B%22name%22%3A%22Fireround%22%2C%22description%22%3A%22New%20funding%20rounds%20from%20the%20open%20web%2C%20verified%20and%20posted%20to%20a%20channel.%22%2C%22background_color%22%3A%22%23fa5d19%22%7D%2C%22features%22%3A%7B%22bot_user%22%3A%7B%22display_name%22%3A%22Fireround%22%2C%22always_online%22%3Afalse%7D%7D%2C%22oauth_config%22%3A%7B%22redirect_urls%22%3A%5B%22https%3A%2F%2Ffireround.dev%2Fapi%2Fslack%2Foauth%2Fcallback%22%2C%22https%3A%2F%2Ffireround.dev%2Fapi%2Fslack%2Fconnected%22%5D%2C%22scopes%22%3A%7B%22bot%22%3A%5B%22incoming-webhook%22%5D%7D%7D%2C%22settings%22%3A%7B%22event_subscriptions%22%3A%7B%22request_url%22%3A%22https%3A%2F%2Ffireround.dev%2Fapi%2Fwebhooks%2Fslack%22%2C%22bot_events%22%3A%5B%22app_uninstalled%22%2C%22tokens_revoked%22%5D%7D%2C%22incoming_webhooks%22%3A%7B%22incoming_webhooks_enabled%22%3Atrue%7D%2C%22org_deploy_enabled%22%3Afalse%2C%22socket_mode_enabled%22%3Afalse%2C%22token_rotation_enabled%22%3Afalse%7D%7D). It is the one in [Creating the Slack app](#creating-the-slack-app) with both redirect URLs, `https://fireround.dev/api/slack/oauth/callback` (the admin install) and `https://fireround.dev/api/slack/connected` (the public one), the `incoming-webhook` bot scope, and incoming webhooks on. Pick a workspace and press Create.
2. Under **Basic Information → Display Information**, upload the icon (a square PNG of at least 512 pixels; the flame's geometry is in `app/icon.svg`).
3. Under **Manage Distribution**, tick the checklist (the redirect URLs are https, no hard-coded tokens) and press **Activate Public Distribution**. Until then only the workspace that created the app can install it.
4. On Vercel, under the project's **Settings → Environment Variables** (Production), set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` from **Basic Information → App Credentials**, and `SLACK_WEBHOOK_KEY` to a random secret of at least 32 characters (`openssl rand -base64 48`). Check `APP_ORIGIN` is `https://fireround.dev` and `CRON_SECRET` is set. Optionally set `SLACK_SUBSCRIPTION_CAP`.
5. Redeploy, then enable **Event Subscriptions** at `https://fireround.dev/api/webhooks/slack` with `app_uninstalled` and `tokens_revoked` bot events. Migrations run in the build. The landing page and the feed now show Add to Slack; Settings → Environment reads "Public Slack: on".

Keep `SLACK_WEBHOOK_KEY` for good. Changing it makes every stored webhook unreadable and retires every manage link; channels then need to be added again.

## Slack's /feed

No app needed. Pick a preset and press **Copy /feed command**: Fireround mints a private feed token for that preset (the same path as Feed URLs) and copies `/feed subscribe <rss-url>` to your clipboard. Paste it in the channel and send it; Slack's RSS app then posts each new round. The token appears in Feed URLs, where it can be revoked. Slack polls the feed on its own schedule, so rounds arrive later than through a delivery target, and without the Block Kit layout.

## Paste a webhook URL

Under **Paste a webhook URL instead**: make an incoming webhook yourself (api.slack.com/apps → your app → Incoming Webhooks), paste its URL, and choose the preset and what it receives. This is the path Fireround had before Add to Slack, and it still works everywhere.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SLACK_CLIENT_ID` | The Slack app's Client ID. With the secret, turns on Add to Slack. |
| `SLACK_CLIENT_SECRET` | The Slack app's Client Secret. Server-side only; used once per install to exchange the code. |
| `SLACK_WEBHOOK_KEY` | Public Add to Slack only. At least 32 characters; encrypts each visitor's webhook and signs the manage links. Unset (or short), the public install is off. |
| `SLACK_SUBSCRIPTION_CAP` | Public Add to Slack only. Live channels the instance accepts in total; default 500. |
| `APP_ORIGIN` | This instance's public URL. Sets the Slack redirect URL and the feed URLs; falls back to the request's host. |

Settings → Environment shows whether the Slack app and the public install are configured.
