# Pipeline evidence and benchmark

The extraction scrape stores its complete main-content markdown by SHA-256 in `page_snapshots`. `page_snapshot_reads` ties a URL and hash to the raw Firecrawl JSON from that read; the read-back and history readers also save their markdown. Identical text shares one row, while changed text gets another hash. A page over 128 KiB is skipped rather than truncated, since a partial page cannot faithfully replay an extraction. Failed writes are ignored after the scrape; they never discard a round. The daily accuracy workflow prunes URL readings after 90 days and unreferenced snapshots older than 90 days. `pnpm prune-page-snapshots` runs the same policy manually; `SNAPSHOT_RETENTION_DAYS` overrides it for the manual command. Old snapshots may remain when a more recent URL reading still points to them.

## Run

```sh
pnpm bench-pipeline
pnpm bench-pipeline -- --assert
pnpm bench-pipeline -- --stored
pnpm bench-pipeline -- --model openai/gpt-6-luna
pnpm bench-pipeline -- --stored --model openai/gpt-6-luna
pnpm bench-pipeline -- --case axya-split --model openai/gpt-6-luna
```

The default and `--assert` need no key or database, and CI only runs `--assert`. The latter requires the current deterministic true-positive floors, zero duplicate events, and zero false-new candidates. `--case <id>` selects one case for a manual run, and cannot be combined with `--assert`. `--stored` requires the migrated store to have a snapshot and raw extraction for **every selected** case URL; it fails rather than silently substituting fixture JSON. Combining `--stored --model` feeds the model the exact snapshot whose captured Firecrawl JSON `--stored` scores, so the two extractors have identical text. `--model` needs `AI_GATEWAY_API_KEY`, or another provider key chosen by `RECONCILE_PROVIDER`. Its model id is passed to the existing AI gateway client in `packages/core/src/llm/model.ts`. It extracts structured rounds from the chosen markdown and requires a grounded quote for every stated field. The resulting records go through the ordinary page settle, price, and resolver, then the existing model read-back over that same text. These modes are manual, since network models and the store are absent from CI. The captured default mode reads `evals/pipeline-quoted-captures.json` (`--legacy` reads `evals/pipeline-captures.json`); both hold excerpts of each page, not whole articles, as [extractor-benchmark.md](../evals/extractor-benchmark.md) explains.

The default runs authored JSON extraction through the real `extractRounds` grounding and settle logic, then `resolveRounds` for date, price, and merge. It checks the evidence again without calling a model. It is **not** a measured Firecrawl extraction baseline or a model verification baseline. The legacy `sources.raw_extraction` column has no writer in the current code; new reads capture JSON with their markdown in `page_snapshot_reads`. The replay dates each round in its own announcement window to score old rounds' fields, and runs a second fixed evaluation window, September 20 through 27, 2026, for publication safety. Before model verification, the publication tally is a high-confidence candidate tally, not a claim that the feed actually delivered anything. The model run uses the read-back's verification status for the publication tally. Duplicate input is replayed for every event, with an additional two-source Axya merge check. A history or previously announced round from a history pass must not be delivered or enter Latest, Trending, or the digest; this benchmark tests the resolver's fixed-week boundary, not the downstream delivery jobs.

`evals/pipeline-cases.json` has 42 hand-labeled cases, including 30 recent source pages beyond the nine initial incidents, a separate Corgi derivative report, a down round whose primary versus secondary split is undisclosed, and a multi-company roundup. The markdown is a source excerpt, not a whole archived article; typographic long dashes are normalized to ASCII hyphens in the fixture. The original Forbes page returned only a teaser through the available web reader, so its fixture proves the $5B mention but cannot prove or score the $64M figure. The separate RuntimeWire excerpt states the $64M extension and the May $1.3B valuation, and is marked background, so it cannot silently become an independently verified new event. Replace the Forbes excerpt with a lawful complete scrape and a captured extraction before making an extraction-accuracy claim about that figure. The `pipeline-labels.json` rows preserve the 30 added pages' manually checked expected fields and the text fragment used to select each sourced evidence line. They are provenance metadata, not model predictions.

The field scorer counts a correct stated value as TP, an unsupported value as FP, a missed stated value as FN, and a correct omission as TN. A wrong non-null value counts both FP and FN. Recall is TP divided by TP plus FN; precision is TP divided by TP plus FP; abstentions are the FN subset where the pipeline returned no value. `new_money` compares currency as well as amount. A missing round total on an extension is an abstention because the current record only stores the newly raised figure. Exact date, normalized company and stage, and an order-independent lead set are scored independently. The false-new tally counts extra events and high-confidence current-week candidates on pages labeled not new.

Fixture baseline on 2026-09-27, with authored extraction inputs and deterministic stages only:

| Field | Precision | Recall | Abstentions | TP / FP / FN / TN |
|---|---:|---:|---:|---|
| Company | 1.00 | 0.93 | 3 | 39 / 0 / 3 / 0 |
| Stage | 0.95 | 0.90 | 2 | 37 / 2 / 4 / 1 |
| New money | 0.83 | 0.81 | 4 | 30 / 6 / 7 / 2 |
| Round total | 0.85 | 0.91 | 2 | 29 / 5 / 3 / 6 |
| Valuation | 1.00 | 0.82 | 2 | 9 / 0 / 2 / 31 |
| Date | 0.97 | 1.00 | 0 | 38 / 1 / 0 / 3 |
| Lead | 0.97 | 0.92 | 2 | 33 / 1 / 3 / 6 |

The duplicate-event check produced zero extra rows, including the two-source Axya event. There were zero false-new high-confidence candidates, but only 2 of 14 expected recent cases crossed the pre-verification confidence bar. That is not a publication recall score: actual publishing requires a verified read-back, which this free fixture mode does not perform. Grounding passed on 39 of 39 retained records; the three missing records were blocked as background or rumor. The roundup's issue date was incorrectly carried as a precise round date, which the date false positive exposes.

## Add a case

Read the source itself and write a new object in `evals/pipeline-cases.json` with a unique `id`, canonical article `url`, a copied markdown excerpt with its date and funding sentence, a clearly authored `extract` input, and independent `expected` fields. Include the company, stage, new money in millions, ISO currency for non-USD money, round total when it is stated, valuation in millions, announcement date or null, actual lead investors, and `publish` for the current-week check. Do not infer an old announcement date from a later roundup or a derivative story; historical mentions need an explicit background extraction and `publish: false`. An extraction field's `evidence_quote` must be on the excerpt, including the amount when one is claimed. Run the default benchmark and check each case's printed result; adjust the `--assert` floors only after reviewing a real behavior change. When adding captured production data, check the snapshot and JSON are from the same read and do not copy secret pages into the repository.
