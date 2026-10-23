# Funnel research replacement: observed requirements and actual coverage

Reviewed on 2026-10-22: the chat **Dubai real estate lead qualification system**,
its `funnel-audit-log.md`, `funnel-forensic-audit.md`, and source inspection of the
Sagar funnel. The earlier workflow combined Firecrawl reads/search/extraction with
separate interactive browser tools. Replacing the reads alone does not reproduce
the full experiment.

## Available now

In `/scraper`, select **Funnel evidence audit**, paste up to ten canonical URLs on
separate lines and run. The page limit limits explicit seeds, not automatic link
traversal. Export JSON to retain the evidence bundle.

- Full-page text, headings and CTAs.
- Form action/method, field names/types/options, without prefilled field values.
- Links represented as observed edges, not inferred user journeys.
- Iframe, video, source and caption-track URLs (discovery only).
- Script references and bounded source snippets for tracking, attribution,
  browser storage, experiments, routing and scoring.
- Up to two same-origin JS assets per page, ten total; scripts never execute.
- Requested/final URLs, timestamps and SHA-256 source hashes.
- Partial failures and an explicit unknowns list; 60-second request deadline.

The report is not automatically published or persisted. Exported source snippets
and URLs can still contain information embedded by the source site; review the
bundle before sharing it. Supplied query strings are rejected, but this is not a
general-purpose PII-redaction system.

## Requirements not yet met

| Prior exercise | Status / next acceptance test |
|---|---|
| JavaScript-rendered registration modal and Tally questionnaire | Local guided browser supports manual interaction and frame capture; approved live registration/questionnaire reached thank-you. No autonomous UI replay |
| Matched high/low/country/source tests | Missing experiment runner; hold session/variant state fixed and record each step |
| Actual browser events/network requests | Guided runner records bounded request summaries; no response bodies, event semantics, or backend delivery proof |
| VSL transcripts/variant comparisons | Embed/track discovery only; need published caption collection or separately configured transcription |
| Deep competitor research with structured schemas | Core research/extraction exists, but requires a configured model and search backend; not validated here |
| Reddit, Instagram, LinkedIn, X logged-in content | Not configured; explicit account/session setup required, not unlocked by Jina |
| Long-running durable research batches | Current audit is bounded and synchronous, not a background job system |

Do not describe this as full parity. The guided runner has local browser fixture tests.
Authorization from a different
chat's old test must not be reused to create new CRM registrations. Purchases,
messages, joining groups, and form submissions require an explicit scoped decision.

## Forum research

**Forum discussion (Hacker News)** uses the official public API, returning the root
and up to the selected number of attempted comment reads with parent IDs and source
links. The result explicitly marks incomplete samples. It does not establish the
truth of commenters' claims. Public HTML/forum feeds can also use existing reads.
Agent Reach's current Reddit adapter documents an authenticated-session requirement:
https://github.com/Panniantong/agent-reach/blob/main/agent_reach/channels/reddit.py

## Live verification

- `https://event.monetise.com/lp`: 38,627 characters of extracted text, five script references.
- `https://event.monetise.com/survey`: 1,519 characters, one iframe, five script references.
- `https://sagar.click/workshop-wp`: redirected to a WhatsApp invitation page; no join occurred.
- HN item `8863`: root plus three comments, marked partial.
- 42 web-module tests passed; TypeScript check passed.

Zero Firecrawl API calls. These observations are one-time reads, not guarantees of
future availability, completeness, or unchanged site content.

## Follow-up: isolated browser renderer

The **Rendered page + frames** operation now uses local Playwright/Chrome, not a
hosted scraping service. Install Chrome on the host; `NATIVE_BROWSER_CHANNEL`
can select another installed Playwright channel. This is a local Node deployment
feature, not an Edge/serverless browser service.

The renderer creates a fresh nonpersistent context, without the user's cookies.
It routes document/script/stylesheet GETs through the existing DNS-pinned public
transport. Other request types/methods, service workers, WebSockets, downloads
and form submissions are blocked. An unusable proxy fails closed for normal
browser traffic not handled by the bridge. Limits: 60 read attempts, 12 MB aggregate
text, 2 MB per resource, eight captured frames, and a browser-close watchdog.
Only one browser audit per server process runs at a time.

The browser executes public JavaScript but blocks fetch/XHR, media and images;
response headers/cookies are not replayed. These restrictions deliberately change
page behavior, so the result is not evidence of a normal user's complete journey.
Use network outcomes to diagnose missing content. Network-log query values are
redacted, but page content itself is not comprehensively PII-redacted.

Live survey read on 2026-10-22 captured the main page plus a Tally iframe with one
form and an additional service iframe. The static read had zero forms. Coverage
was partial, with blocked requests and one TLS failure. No registration was sent.

The requested fresh Firecrawl comparison was attempted but refused for insufficient
credits, so no new Firecrawl baseline exists. Do not claim a successful A/B comparison.

Validation: 45 tests passed with `RUN_BROWSER_TESTS=1`, including actual Chromium
execution against deterministic in-memory HTML. It verified JS-generated controls,
iframe extraction and blocking of a POST without transmitting it. TypeScript passed.

```sh
RUN_BROWSER_TESTS=1 pnpm exec vitest run tests/browser-audit.test.ts packages/core/src/web/
```

## Guided interactive journey (local only)

From the repository with Node 24+, dependencies and Google Chrome installed:

```sh
pnpm audit:guided https://event.monetise.com/lp --allow-live
```

A fresh Chrome window opens. Interact with it manually; return to the terminal
and press Enter after each step to capture page copy, visible field labels/options,
iframes and request metadata. Type `q` to finish and save the report under
`data/guided-audits/session-*/report.json` (Git-ignored). Limits: 20 captures/15 minutes.
No Firecrawl key or credits are used. This is separate from the dashboard's
read-only renderer: it allows normal site requests and submissions, is not a
network sandbox, and does not automatically block purchases. Follow the authorized
scope. Report redaction is best-effort; review before sharing.

For animated native buttons, keyboard activation avoids Playwright's endless
stable-bounds wait: focus the observed button and press Enter, then explicitly
wait for the newly mounted field. Do not treat an immediate empty DOM scan as
evidence that the modal failed.

## Approved live free-path result — 2026-10-22

An agent-operated Playwright session, using the explicitly approved synthetic
identity, observed this route sequence on `event.monetise.com`:

`/lp` → `/survey` → `/vip/vip0-ftk2` → `/ftk/vip0-ftk2-no` → `/thank-you`.

Registration and questionnaire submission advanced successfully. Both paid
offers were declined via their explicit free/skip links. No checkout, purchase,
WhatsApp join, or outbound message was performed. The thank-you page still asks
for WhatsApp participation and email confirmation; neither was completed, so this
is not proof of confirmed attendance, email delivery, or CRM persistence.

Questionnaire answers: age 20; no previous online business; high school graduate;
free AI tools only; no job; no income source; savings USD 100; following Iman less
than one month; no purchased online course. Monthly income was conditionally
skipped. The phone selector was United States +1, while the route retained
`country=IN`; these are distinct observed values, not proof of country-based scoring.
One run does not establish how experiments or qualification scores choose routes.

This live test used Playwright CLI, not an autonomous SignalRound dashboard replay.
The repository's guided runner is the reusable manual capture mode. The isolated
renderer intentionally remains read-only. Firecrawl comparison could not run
because its account lacked credits; no successful comparison is claimed.

Final focused validation: 52 tests passed across eight web/browser/guided suites,
including an animated-button regression and delayed modal. TypeScript and focused
Biome checks passed. The dashboard exposes guided-mode instructions; the CLI
`--help` entry point was verified.
