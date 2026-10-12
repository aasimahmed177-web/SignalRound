// Jev, TypeSafe AI's System One classifier, as a reader of search results: for a page's URL, title,
// and snippet, how likely it is about a round the company raised, whether it states one, and what
// kind of page it is. It returns calibrated probabilities in about 200 ms for a few hundredths of a
// cent, so it can look at every result before a page is paid for. Optional: without
// TYPESAFE_API_KEY, or on any error, every caller keeps the rules it had (a null verdict).
// https://api.typesafe.ai/openapi.json

import { mapLimit } from "../firecrawl/credits.ts";
import { ISSUER_TYPES, type IssuerType, MONEY_KINDS, type MoneyKind } from "../records/money-kind.ts";

/** What a page is: the company's or an investor's own announcement, a journalist's article, a database or profile, or anything else. */
export type SourceKind = "primary" | "news" | "aggregator" | "other";

/** Jev's reading of one page. */
export interface PageVerdict {
  /** The page's headline subject is a round the company raised; a passing mention of an earlier raise is not. */
  aboutRaise: number;
  /** The page states that the company raised a particular round (a database can). */
  isRound: number;
  kind: SourceKind;
  kindConfidence: number;
  model: string;
}

/** A page as a search offered it. */
export interface PageToClassify {
  company: string;
  url: string;
  title?: string | null;
  snippet?: string | null;
}

/** One verdict per page, in order; null for a page it could not read. Never throws. */
export type PageClassifier = (pages: PageToClassify[]) => Promise<Array<PageVerdict | null>>;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KINDS: readonly SourceKind[] = ["primary", "news", "aggregator", "other"];

/** The questions, as evaluated on real results from PlanetScale, Whoop, Clerk, tldraw, and Resend (pnpm eval-jev). */
function questions(company: string) {
  return {
    about_raise: {
      type: "noul",
      instructions: `Is the main subject of this page, as its headline shows, a funding round that ${company} raised? A page about something else that mentions an earlier raise in passing is not.`,
    },
    is_round: {
      type: "noul",
      instructions: `Does this search result report that ${company} itself raised or closed a specific funding round (its own announcement, an investor's announcement, or news coverage of the raise)?`,
      criteria: {
        true: `States that ${company} raised a particular round: an amount, a stage, or named investors in that raise`,
        false: `A database or directory profile, a company profile, a funding total across rounds, talks or rumours of a raise, another company's round, or a page not about ${company}'s funding`,
      },
    },
    kind: {
      type: "choice",
      instructions: "What kind of page is this?",
      criteria: {
        primary: "The company's own blog or press release, or an investor's own announcement of the round",
        news: "A news publication's article written by a journalist",
        aggregator: "A database, directory, company profile, job site, data aggregator, or auto-generated funding summary site",
        other: "Anything else: product docs, app pages, forums, unrelated news",
      },
    },
  };
}

interface JevResponse {
  model?: string;
  answers?: {
    about_raise?: { noul?: number };
    is_round?: { noul?: number };
    kind?: { choice?: string; confidence?: number };
  };
}

function verdictOf(body: JevResponse): PageVerdict | null {
  const a = body.answers;
  const kind = a?.kind?.choice as SourceKind | undefined;
  if (typeof a?.about_raise?.noul !== "number" || typeof a?.is_round?.noul !== "number" || !kind || !KINDS.includes(kind)) return null;
  return {
    aboutRaise: a.about_raise.noul,
    isRound: a.is_round.noul,
    kind,
    kindConfidence: a.kind?.confidence ?? 0,
    model: body.model ?? "jev",
  };
}

export interface JevOptions {
  apiKey?: string | null;
  model?: string;
  concurrency?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The classifier over TypeSafe's API, or null without a key. One call per page, `concurrency` at
 * once, each cut off after `timeoutMs`; a 429 or 529 is tried once more after a short pause.
 */
export function jevClassifier(opts: JevOptions = {}): PageClassifier | null {
  const apiKey = opts.apiKey === undefined ? process.env.TYPESAFE_API_KEY : opts.apiKey;
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? "jev-latest";
  const timeoutMs = opts.timeoutMs ?? 3000;
  const one = async (page: PageToClassify): Promise<PageVerdict | null> => {
    const body = JSON.stringify({
      model,
      state: { company: page.company, url: page.url, title: page.title ?? "", snippet: page.snippet ?? "" },
      questions: questions(page.company),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if ((res.status === 429 || res.status === 529) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (!res.ok) return null;
        return verdictOf((await res.json()) as JevResponse);
      } catch {
        return null;
      }
    }
    return null;
  };
  return (pages) => mapLimit(pages, opts.concurrency ?? 8, (page) => one(page));
}

/** A verdict as a ledger or a run keeps it: rounded, so an audit reads it at a glance. */
export function verdictSummary(v: PageVerdict): { kind: SourceKind; about: number; round: number } {
  return { kind: v.kind, about: Math.round(v.aboutRaise * 100) / 100, round: Math.round(v.isRound * 100) / 100 };
}

/** An independent, typed read of the figure's evidence sentence. */
export function jevCertaintyClassifier(
  opts: JevOptions = {},
): ((sentence: string) => Promise<"announced" | "reported" | "expected" | null>) | null {
  const apiKey = opts.apiKey === undefined ? process.env.TYPESAFE_API_KEY : opts.apiKey;
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? fetch;
  return async (sentence) => {
    try {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? "jev-latest",
          state: { sentence },
          questions: {
            certainty: {
              type: "choice",
              instructions:
                "Does this sentence state a completed funding round, a completed round attributed only to unnamed sources, or a round that has not closed? Read this sentence only.",
              criteria: {
                announced: "Completed financing announced on the record or reported as closed without anonymous attribution",
                reported: "Financing reported as completed, attributed to unnamed sources or people familiar",
                expected: "Not completed: in talks, nearing, closing in on, raising, seeking, or term sheet",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { answers?: { certainty?: { choice?: string; confidence?: number } } };
      const answer = body.answers?.certainty;
      return answer?.choice && ["announced", "reported", "expected"].includes(answer.choice) && (answer.confidence ?? 1) >= 0.7
        ? (answer.choice as "announced" | "reported" | "expected")
        : null;
    } catch {
      return null;
    }
  };
}

/** An independent, typed read of the figure's evidence sentence. */
export function jevMoneyClassifier(opts: JevOptions = {}): ((sentence: string, figure: string) => Promise<MoneyKind | null>) | null {
  const apiKey = opts.apiKey === undefined ? process.env.TYPESAFE_API_KEY : opts.apiKey;
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? fetch;
  return async (sentence, figure) => {
    try {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? "jev-latest",
          state: { sentence, figure },
          questions: {
            money_kind: {
              type: "choice",
              instructions:
                "What does this particular money figure in this evidence sentence represent? Classify the figure, not another number in the sentence.",
              criteria: {
                primary: "New primary equity, SAFE, or convertible money raised in one round now",
                tranche: "New primary closing or extension of a previously announced round",
                combined: "Aggregate across two distinct rounds announced together, with no amount specific to this one",
                mixed: "Total financing combining primary new money with grants or secondary sales, without an isolated primary amount",
                cumulative: "Lifetime funding or a series' cumulative proceeds including earlier closings",
                future_commitment: "Future or conditional investment, not closed money",
                secondary: "Existing shares sold by shareholders, not money entering the company",
                ipo_allocation: "IPO anchor book or other public market share allocation",
                debt: "Loan, credit facility, or debt financing only",
                grant: "Grant, subsidy, or award",
                internal_spending: "Company's own planned spending or internal investment",
                project_cost: "Cost of a plant, facility, or project the company is building, however it is financed",
                unknown: "The sentence does not establish what this money represents",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { answers?: { money_kind?: { choice?: string; confidence?: number } } };
      const answer = body.answers?.money_kind;
      return answer?.choice && MONEY_KINDS.includes(answer.choice as MoneyKind) && (answer.confidence ?? 1) >= 0.7
        ? (answer.choice as MoneyKind)
        : null;
    } catch {
      return null;
    }
  };
}

/** Independent issuer check on the funding evidence and the page's company line. */
export function jevIssuerClassifier(
  opts: JevOptions = {},
): ((company: string, companyLine: string | null, evidence: string) => Promise<IssuerType | null>) | null {
  const apiKey = opts.apiKey === undefined ? process.env.TYPESAFE_API_KEY : opts.apiKey;
  if (!apiKey) return null;
  const doFetch = opts.fetch ?? fetch;
  return async (company, companyLine, evidence) => {
    try {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? "jev-latest",
          state: { company, company_line: companyLine ?? "", evidence },
          questions: {
            issuer_type: {
              type: "choice",
              instructions: `What is ${company}, the issuer receiving this financing, according to the company line and evidence? Classify the recipient, not its investor.`,
              criteria: {
                operating_company: "A privately held operating company raising money for its business, including a startup",
                fund: "An investment fund or investment manager raising commitments from limited partners, including a first or final fund close",
                listed_company: "An already listed/public company issuing shares or conducting a QIP, FPO, rights issue or IPO",
                government_program: "A government programme, scheme or public body distributing or announcing funding",
                unknown: "The evidence does not establish the issuer type",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { answers?: { issuer_type?: { choice?: string; confidence?: number } } };
      const answer = body.answers?.issuer_type;
      return answer?.choice && ISSUER_TYPES.includes(answer.choice as IssuerType) && (answer.confidence ?? 0) >= 0.7
        ? (answer.choice as IssuerType)
        : null;
    } catch {
      return null;
    }
  };
}
