# Funnel forensics: delivery status

Updated 2026-10-23. The supplied Iman Gadzhi audit is a requirements baseline,
not a newly reproduced live result. Its estimated 45–55% parity is not a measured
score for this working tree. No new live registrations were made for this milestone.

## Available now

The `/scraper` screen supports direct page reads, bounded mapping/crawling,
restricted rendered page/frame inspection, public GitHub conversations and feeds,
and optional local Scrapling CSS extraction. These paths do not use Firecrawl.
External reader/search services remain separately configured and require explicit
per-run sharing consent in the UI and server action.

The renderer now skips known advertising/analytics hosts before spending its read
or byte budget. Aggregate outcomes survive the detailed network-log cap. A real
Chromium fixture with 100 advertising scripts and an embedded questionnaire
hydrates two fields using three transport reads. This is a controlled fixture,
not proof that the live Tally questionnaire fully hydrates. POST, fetch/XHR,
WebSockets and media remain blocked. Classification is a narrow known-host list,
not a general priority scheduler.

The questionnaire lab on `/scraper` accepts a declarative plan and replays up to
eight matched synthetic profiles in fresh browser contexts. It can fill, select,
check, advance safe client-side controls and observe score selectors. GET/HEAD
hydration is pinned to approved origins; non-GET/HEAD requests, submit controls,
WebSockets, downloads and consequential destinations remain blocked. GET cannot
be proven side-effect-free, so targets must still be authorized. Computed scores come
only from rules supplied in the plan. The lab is usable before the transmission
boundary, but it is not yet an authorized live-submission executor.

URL analysis reports attribution, click-ID, identity, experiment and session key
names while redacting values. Passive audits now identify declared Meta, Google,
TikTok and dataLayer events, sanitized source snippets, snippet hashes and visible
parameter names. These are `declared-in-source` observations, not proof of runtime
invocation, transmission, platform acknowledgement or backend persistence.

## Foundation modules, not live execution permissions

- `packages/core/src/browser/policy.ts`: strict authorization manifests, exact
  write endpoint/payload checks, expiration, submission limits and prohibitions.
  Pure preflight only; not connected to a live submission runner. A future runner
  must establish human approval, reserve budgets atomically and pin public DNS on
  every request/redirect. GET heuristics cannot prove absence of side effects.
- `packages/core/src/browser/redaction.ts`: bounded JSON redaction, seeded values,
  per-report pseudonyms and residual-pattern checks. Not universal PII detection,
  screenshot redaction or a complete export-review system.
- `packages/core/src/browser/evidence.ts`: canonical hashes of redacted evidence
  and explicit observation levels. A request attempt or HTTP response never
  establishes platform acceptance or backend persistence. Producers must supply
  truthful levels; this module does not observe browser events itself.
- `pnpm bench:funnel`: deterministic offline checks of these foundations. Fixtures
  do not send requests or create records. No production identity data is needed.

## Remaining milestones

| Milestone | Still required |
| --- | --- |
| Phase 0: safety and evidence | Wire policy into a trusted executor, atomic budgets, complete fixture suite, artifact/export review |
| Phase 1: discovery | Advertiser/ad collection, destination clustering and deduplication |
| Phase 2: questionnaires | Import discovered fields/options into the plan editor and map conditional branches automatically |
| Phase 3: replay | Dry replay and fresh-profile isolation exist; live synthetic transmission still needs exact request/body approval and atomic budgets |
| Phase 4: events | Runtime instrumentation, vendor payload decoding, step-linked evidence without overstating delivery |
| Phase 5: experiments | Matched profiles, frozen experiment state, causal diffs and validated scoring rules |
| Phase 6: reporting | Authorized media/transcripts, variant comparison and evidence-linked reports |

Do not enable purchases, paid OTOs, group joins, messages or new registrations as
a side effect of these milestones. The earlier free-webinar approval is not blanket
authorization for new experiments. Keep third-party query/URL sharing opt-in.

Agent Reach helps route supported public sources; it is not a universal scraping
API. Scrapling is currently parser-only behind the existing pinned transport.
Patchright and Crawl4AI were evaluated but are not installed or enabled as engines.
No claim of overall Firecrawl superiority or complete funnel parity is made.

## Verification on 2026-10-23

- Nine real-Chromium audit tests passed, including the advertising-budget fixture.
- Policy/evidence tests and eight offline benchmark checks passed. Redaction review
  added correlation/idempotence and URL-fragment regression tests.
- Four offline Python parser tests passed; Playwright verified local extraction,
  direct reads, public GitHub reads, consent gates and mobile layout in the UI.
- Typecheck and lint passed (lint retains 11 existing warnings and six infos).
  Production build passed before the final foundation/asset-policy additions;
  the subsequent TypeScript check includes those additions.
- Final full test run: 2,749 passed, six skipped, one snapshot-retention timeout
  at five seconds. A concurrent single-file retry also timed out on a different
  snapshot test. After the full run ended, all four snapshot tests passed in
  isolation in 4.80 seconds total, without changed assertions or timeout settings.
  This is evidence of load-sensitive timing, not a fully green full-suite run.
- Local `/scraper` returned HTTP 200. These results do not validate the unbuilt
  replay, experiment, event-decoding or transcription milestones above.
