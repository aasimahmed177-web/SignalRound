"use client";

import { useState, useTransition } from "react";
import { analyzeFunnelUrlAction, runQuestionnaireReplayAction } from "@/app/(dashboard)/scraper/actions";

const starterPlan = JSON.stringify(
  {
    version: 1,
    mode: "interactive-dry-run",
    startUrl: "https://example.com/questionnaire?utm_source=meta&utm_campaign=example",
    allowedOrigins: ["https://example.com"],
    steps: [
      { id: "goal", action: "select", selector: "#goal", answerKey: "goal", by: "value" },
      { id: "continue", action: "click", selector: "button[data-next]", intent: "next" },
      { id: "score", action: "observe", selector: "[data-score]" },
    ],
    profiles: [
      { id: "baseline", label: "Baseline", answers: { goal: "starting" } },
      { id: "variant", label: "Matched variant", answers: { goal: "scaling" } },
    ],
    scoreSelectors: ["[data-score]"],
    scoring: {
      version: 1,
      baseScore: 0,
      questions: [{ id: "goal", weights: { starting: 0, scaling: 5 } }],
      routes: [
        { id: "standard", minScore: 0, maxScore: 4 },
        { id: "qualified", minScore: 5 },
      ],
    },
  },
  null,
  2,
);

const field =
  "w-full rounded-8 border border-border-faint bg-background px-3 py-3 text-body-small outline-none focus-visible:ring-2 focus-visible:ring-signal-blue disabled:opacity-60";

export function FunnelReplayWorkbench() {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [urlResult, setUrlResult] = useState("");
  const [plan, setPlan] = useState(starterPlan);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const download = () => {
    const objectUrl = URL.createObjectURL(new Blob([result], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "signalround-questionnaire-replay.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  return (
    <section className="overflow-hidden rounded-16 border border-signal-ink/10 bg-paper text-signal-ink dark:border-white/10 dark:bg-[#18212b] dark:text-white">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="p-5 sm:p-7">
          <p className="text-mono-x-small uppercase tracking-[0.18em] text-signal-blue">Questionnaire lab · dry run</p>
          <h2 className="mt-2 max-w-2xl text-title-h4 text-balance">Replay answers. Keep the write boundary locked.</h2>
          <p className="mt-3 max-w-3xl text-body-small text-black-alpha-64 dark:text-white/65">
            Run the same questionnaire plan against matched synthetic profiles. SignalRound fills fields, advances safe client-side steps,
            observes score and route evidence, and blocks non-GET/HEAD requests. No form submission or response is submitted.
          </p>
        </div>
        <div className="border-t border-signal-ink/10 bg-signal-blue/[0.06] p-5 lg:border-t-0 lg:border-l dark:border-white/10">
          <p className="text-label-small">Hard boundary</p>
          <ul className="mt-3 space-y-2 text-body-small text-black-alpha-64 dark:text-white/65">
            <li>POST / PUT / PATCH / DELETE blocked</li>
            <li>Submit controls blocked</li>
            <li>Purchases, messages and group joins refused</li>
            <li>Fresh browser context per profile</li>
          </ul>
        </div>
      </div>

      <div className="grid border-t border-signal-ink/10 dark:border-white/10 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4 p-5 sm:p-6 xl:border-r xl:border-signal-ink/10 dark:xl:border-white/10">
          <div>
            <p className="text-label-medium">Inspect an attributed URL</p>
            <p className="mt-1 text-body-small text-black-alpha-56 dark:text-white/55">
              Values stay hidden. The result lists UTM, click-ID, identity, experiment and session parameter names.
            </p>
          </div>
          <input
            aria-label="Attributed funnel URL"
            className={field}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/quiz?utm_source=meta"
            disabled={pending}
          />
          <button
            type="button"
            disabled={pending || !url.trim()}
            className="rounded-8 border border-signal-ink/15 px-4 py-2.5 text-label-small outline-none hover:bg-signal-ink/[0.04] focus-visible:ring-2 focus-visible:ring-signal-blue disabled:opacity-50 dark:border-white/15"
            onClick={() =>
              start(async () => {
                setError("");
                const response = await analyzeFunnelUrlAction(url);
                if (!response.ok) setError(response.error);
                else setUrlResult(JSON.stringify(response.value, null, 2));
              })
            }
          >
            Find attribution keys
          </button>
          {urlResult && (
            <pre className="max-h-72 overflow-auto rounded-8 bg-white/60 p-3 text-mono-small dark:bg-black/20">{urlResult}</pre>
          )}
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-label-medium">Declarative replay plan</p>
              <p className="mt-1 max-w-2xl text-body-small text-black-alpha-56 dark:text-white/55">
                Replace the example URL, selectors and synthetic answers. Profiles run independently; only parameter names and redacted
                evidence leave the runner.
              </p>
            </div>
            <span className="w-fit rounded-full border border-proof-green/25 bg-proof-green/10 px-2.5 py-1 text-label-x-small text-proof-green">
              No form writes
            </span>
          </div>
          <textarea
            aria-label="Questionnaire replay plan JSON"
            className={`${field} min-h-[28rem] resize-y font-mono leading-6`}
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            spellCheck={false}
            disabled={pending}
          />
          <details className="rounded-8 border border-signal-ink/10 p-3 text-body-small dark:border-white/10">
            <summary className="cursor-pointer text-label-small">Plan rules</summary>
            <p className="mt-2 text-black-alpha-56 dark:text-white/55">
              Actions: fill, select, check, click and observe. Click intent must be answer, continue or next. Every answer key must exist in
              every profile. Score rules are declared inputs; they are not inferred from a successful route.
            </p>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending || !plan.trim()}
              className="rounded-8 bg-signal-blue px-5 py-3 text-label-medium text-white outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-signal-blue focus-visible:ring-offset-2 disabled:opacity-55"
              onClick={() =>
                start(async () => {
                  setError("");
                  setResult("");
                  const response = await runQuestionnaireReplayAction(plan);
                  if (!response.ok) setError(response.error);
                  else setResult(JSON.stringify(response.value, null, 2));
                })
              }
            >
              {pending ? "Running isolated profiles…" : "Run dry replay"}
            </button>
            {result && (
              <button
                type="button"
                onClick={download}
                className="rounded-8 border border-signal-ink/15 px-4 py-2.5 text-label-small dark:border-white/15"
              >
                Download evidence
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-body-small text-crimson-ink">
              {error}
            </p>
          )}
          {result && <pre className="max-h-[42rem] overflow-auto rounded-8 bg-white/60 p-4 text-mono-small dark:bg-black/20">{result}</pre>}
        </div>
      </div>
    </section>
  );
}
