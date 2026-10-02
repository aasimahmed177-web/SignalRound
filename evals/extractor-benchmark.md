# Extraction reader benchmark, September 27, 2026

The same 82 Firecrawl markdown snapshots were read by the production JSON extractor and three structured gateway readers. The cohort is 42 earlier audited cases plus 40 additional recent pages checked against their funding, date, money, lead, and participant sentences. It includes tranches, extensions, valuations beside totals, non-USD funding, roundups, credit financing, grant splits, re-reporting, and sibling-domain publications. The initial and quote-required JSON captures have identical markdown for all 82 URLs. `pipeline-captures.json` preserves the former schema's output; `pipeline-quoted-captures.json` preserves the latter. Both are real Firecrawl outputs, not authored responses. The committed captures are excerpts, not whole articles: each keeps the lines its extractions quote and the benchmark reads (the headline area, the funding sentences, and the few lines the resolver needs to decide the same way), the title, URL, and publication-date metadata, and the Firecrawl JSON. Other article text, email addresses, and scrape metadata were removed on 2026-09-29, and `pnpm bench-pipeline` gives the same per-case results on the excerpts as on the full pages, with and without `--legacy`. The model columns below were measured on the full pages, so a model rerun on the excerpts is not directly comparable. A fresh `scripts/capture-pipeline.ts` run writes whole pages; reduce them the same way before committing, since the articles belong to their publishers.

Each cell below is **precision / recall / abstentions**. An incorrect nonempty answer counts as both a false positive and a false negative. A field is compared as a whole, including the complete investor list. Money has a 1 percent numeric tolerance and must have the correct currency. Dates use the round's date or the same publisher metadata available to both readers. Only the 40 new cases label the full participant list; the first 42 label leads but not participants. Valuation basis has only one explicitly labelled positive, so its perfect score is not informative. A rejected model output is an abstention on its fields.

| Field | Firecrawl JSON before quotes | Firecrawl JSON with quotes | GPT-5.6 Luna | GPT-5.6 Sol | GPT-6 Sol |
|---|---:|---:|---:|---:|---:|
| Company | .96 / .89 / 6 | .96 / .88 / 7 | .97 / .83 / 12 | .96 / .83 / 11 | .97 / .85 / 10 |
| Stage | .93 / .88 / 6 | .95 / .88 / 7 | .96 / .82 / 12 | .96 / .84 / 11 | .96 / .85 / 10 |
| New money | .89 / .89 / 6 | .88 / .87 / 7 | .91 / .84 / 11 | .90 / .84 / 10 | .92 / .87 / 8 |
| Financing total | .64 / .67 / 7 | .71 / .73 / 8 | .72 / .70 / 11 | .88 / .84 / 10 | .91 / .86 / 10 |
| Valuation | 1.00 / .83 / 2 | 1.00 / .83 / 2 | 1.00 / .67 / 4 | 1.00 / .67 / 4 | 1.00 / .83 / 2 |
| Valuation basis | 1.00 / 1.00 / 0 | 1.00 / 1.00 / 0 | n/a / .00 / 1 | 1.00 / 1.00 / 0 | 1.00 / 1.00 / 0 |
| Date | .83 / .78 / 9 | .85 / .81 / 8 | .95 / .78 / 16 | .95 / .79 / 15 | .94 / .79 / 15 |
| Leads | .86 / .90 / 6 | .95 / .85 / 9 | 1.00 / .85 / 10 | 1.00 / .85 / 10 | 1.00 / .87 / 9 |
| Other investors, 40 cases | .73 / .59 / 8 | .75 / .56 / 9 | .85 / .72 / 6 | .85 / .72 / 6 | .89 / .75 / 6 |

| Reader | Grounded pages | Mean measured latency | Gateway model cost per page | Firecrawl usage |
|---|---:|---:|---:|---:|
| Firecrawl JSON before quotes | 82/82 | 4.9 s, scrape and JSON | none | 5 credits |
| Firecrawl JSON with quotes | 82/82 | 4.5 s, scrape and JSON | none | 5 credits |
| GPT-5.6 Luna | 76/82 | 10.7 s, model only | $0.0027 | 1 scrape credit |
| GPT-5.6 Sol | 77/82 | 12.5 s, model only | $0.0445 | 1 scrape credit |
| GPT-6 Sol | 79/82 | 11.9 s, model only | $0.0220 | 1 scrape credit |

The model calls set the gateway's `zeroDataRetention` provider option. Costs use the gateway catalog's per-token prices and actual input and output token usage. The model timings exclude the Firecrawl markdown scrape because every model read the same captured text, whereas JSON timings include its live scrape. A JSON extraction is 5 Firecrawl credits and a markdown-only scrape is 1; credit cost did not decide the recommendation.

**Decision:** Keep Firecrawl JSON as the production reader. GPT-6 Sol clearly wins financing-total accuracy, and improves precision for leads and participants, but its lower company, stage, and new-money recall and three failed or rejected pages do not clearly win the whole extraction decision. Required field quotes on Firecrawl's schema and prompt, checked against its markdown, improve financing-total, date, and lead precision. An unsupported optional claim abstains; a page's sound rounds survive another round's bad quote. A single-page amount that loses a quote can still use its existing grounded evidence sentence, preserving the earlier trust gate. The downstream blind read-back remains responsible for cross-source arbitration. No `EXTRACTOR` switch or new model default is needed.

The blind read-back comparison used 20 money and date stress cases, 17 of which produced an initial record. All four models saw the same captured source and used the gateway's ZDR route. The three unresolved inputs were excluded from every row, not counted as model failures.

| Blind read-back model | New money correct | Date correct | Mean model latency | Mean model cost |
|---|---:|---:|---:|---:|
| GPT-5.6 Luna | 12/17 | 12/17 | 10.4 s | $0.0023 |
| GPT-5.6 Sol | 12/17 | 11/17 | 12.2 s | $0.0427 |
| GPT-6 Luna | 12/17 | 12/17 | 7.8 s | $0.0011 |
| GPT-6 Sol | 12/17 | 11/17 | 9.5 s | $0.0192 |

Keep the existing `openai/gpt-6-luna` read-back default. It tied the best money and date accuracy, was the fastest and cheapest, and completed through a ZDR provider. A team requiring ZDR must enforce that routing in its gateway settings; the benchmark's per-call ZDR option does not change production's routing configuration.

The sanitized production copy was restored to local PostgreSQL 18, with 1,315 funding rows and 4,138 sources. All 82 captures were loaded into its page-snapshot tables and replayed through `pnpm bench-pipeline -- --stored`. The quote-required replay produced zero duplicate event rows and zero labelled false-new publish candidates. It produced two pre-verification publish candidates against 14 expected-new labels; the other 12 misses are not evidence that the trust gates should be relaxed. Ten additional rounds on roundup or multi-story pages lack labels in this benchmark and are reported separately, not counted as false new. The post-resolver valuation recall is 6/12 despite raw extraction reaching 10/12, because the per-round valuation provenance gate rejects unsupported placement. That is a useful follow-up for source-specific auditing, not a reason to weaken the gate.

Reproduce with `pnpm bench-pipeline` for quote-required captured pages, `pnpm bench-pipeline -- --legacy` for the earlier JSON, and `pnpm bench-pipeline -- --assert` for the deterministic fixture guard. The comparison scripts are `node scripts/bench-extractors.ts --score-only --quoted openai/gpt-5.6-luna openai/gpt-5.6-sol openai/gpt-6-sol` and `node scripts/bench-readback.ts openai/gpt-5.6-luna openai/gpt-5.6-sol` with the configured gateway key. `node scripts/capture-pipeline.ts` refreshes missing quote-schema captures with the configured Firecrawl key.

## Replay and provenance follow-up

The initial replay's 2/14 publish-candidate count included records that the production verification gate intentionally keeps flagged. The captured pages carry publisher metadata, but that replay omitted it and simulated extraction at each case's announcement noon. Replaying the actual metadata with a September 27 capture clock resolves all 14 labelled new cases. Twelve still score 0.61 or 0.69 and require confirmation before publication; the two raw candidates score 0.75. All 14 are eligible for verification, with zero labelled false-new candidates and zero duplicate Axya events. This is not a claim that all 14 were discovered by the live sweep or delivered.

The sanitized store has confirmed or corrected `disposition=publish` rows for all 13 distinct companies. Axya's two source cases resolve to one round, and IPID is stored under its legal name, International Payments Identity Pte. Ltd., and domain `ipid.tech`. This store inventory does not itself prove delivery. Cyera's row has a hold for an older January $400 million Series F report and cannot be delivered without a person resolving it. Ema's stored row still says Series A despite the benchmark's Series B evidence; a new guard keeps unjudged readings from overwriting a verified stage, and the scheduled verifier now rereads sources added since its last verdict before marking the ledger done. The local restored row was not manually repaired. The verification ledger had no rows in the restored copy; running the actual `seedRoundVerification` function created pending entries for eligible stored rows. The delivery path still checks the 14-day news window, history, holds, disposition, date precision and merge tombstones at send time.

The captured replay's valuation score moves from 6/12 before the follow-up to 9/12, with no false positives. Supplying publisher metadata restores Cyera's dated valuation; an on-page fallback recovers Snorkel's $3.5 billion from the current round sentence when the extracted valuation quote instead cites its earlier $1.3 billion; and Heidi's $100 million equity plus a separately grounded $240 million growth financing explains its $340 million headline while retaining the $900 million valuation. The three remaining positive labels abstain correctly on these captures: Corgi Forbes is a background story, and the Angle and Enveda page snapshots are browser challenges that do not contain their extracted valuation quotes. Their claims need new grounded source captures, not a weaker provenance check.
