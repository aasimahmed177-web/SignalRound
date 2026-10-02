import type { ExtractedItem, HistoryCandidate } from "@fireround/core";
import { hostOf } from "@fireround/core";
import { round } from "./history-fixtures";

export const CORGI_FETCHED_ON = "2026-09-27";
export const CORGI_A =
  "https://www.prnewswire.com/news-releases/corgi-insurance-raises-108-million-receives-regulatory-approval-to-launch-the-first-full-stack-insurance-carrier-for-startups-302657727.html";
export const CORGI_B = "https://www.corgi.insure/press-releases/series-b";
export const CORGI_B1 = "https://techcrunch.com/2026/05/28/corgi-announces-106m-raise-at-2-6b-valuation-three-weeks-after-160m-series-b/";
export const CORGI_JULY =
  "https://techcrunch.com/2026/07/23/insurance-startup-corgi-reportedly-raised-more-money-at-4b-its-third-round-in-eight-weeks/";
export const CORGI_FILING = "https://coverager.com/corgi-discloses-20-million-offering/";
export const CORGI_FORM_D = "https://aum13f.com/fund/corgi-insurance-services-inc";
export const CORGI_SEPTEMBER = "https://www.forbes.com/sites/richardnieva/2026/09/26/corgi-5-billion-valuation/";

export const corgiAnnouncements = [
  {
    url: CORGI_A,
    title:
      "Corgi Insurance Raises $108 Million, Receives Regulatory Approval to Launch the First Full-Stack Insurance Carrier for Startups",
    published: "2026-01-09",
    excerpt:
      "Corgi announced today that it has raised $108 million in funding. The funding encompasses a recent Series A round and a previous seed round.",
    round: round({
      company_name: "Corgi",
      company_website: "https://corgi.insure",
      round_type_as_written: "Series A",
      amount_as_written: "$108 million",
      amount_kind: "total_funding",
      announced_date: "2026-01-09",
      lead_investors: [],
      evidence_quote: "The funding encompasses a recent Series A round and a previous seed round.",
    }),
  },
  {
    url: CORGI_B,
    title: "Corgi Raises $160M Series B at $1.3B Valuation",
    published: "2026-05-07",
    excerpt:
      "Corgi announced today it has raised $160 million in Series B funding at a $1.3 billion valuation. This financing builds on Corgi's previously announced $108 million across its seed and Series A rounds.",
    round: round({
      company_name: "Corgi",
      company_website: "https://corgi.insure",
      round_type_as_written: "Series B",
      amount_as_written: "$160 million",
      valuation_as_written: "$1.3 billion",
      announced_date: "2026-05-07",
      lead_investors: ["TCV"],
      evidence_quote: "Corgi announced today it has raised $160 million in Series B funding at a $1.3 billion valuation.",
    }),
  },
  {
    url: CORGI_B1,
    title: "Corgi announces $106M raise at $2.6B valuation",
    published: "2026-05-28",
    excerpt:
      "Insurance tech Corgi on Thursday announced a $106 million Series B1 raise, valuing the company at $2.6 billion, just three weeks after announcing a $160 million Series B at a $1.3 billion valuation and four months after its $108 million Series A.",
    round: round({
      company_name: "Corgi",
      company_website: "https://corgi.insure",
      round_type_as_written: "Series B1",
      amount_as_written: "$106 million",
      valuation_as_written: "$2.6 billion",
      announced_date: "2026-05-28",
      lead_investors: [],
      evidence_quote: "Insurance tech Corgi on Thursday announced a $106 million Series B1 raise, valuing the company at $2.6 billion",
    }),
  },
  {
    url: CORGI_JULY,
    title: "Insurance startup Corgi reportedly raised more money at $4B",
    published: "2026-07-23",
    excerpt:
      "The round is said to be a second extension of its Series B round and has already closed. Corgi announced its last round, the B1 round of $106 million at a $2.6 billion valuation at the end of May, about eight weeks ago. Forbes did not report the amount of money that Corgi raised, though, and the company declined to comment on the potential funding.",
    round: round({
      company_name: "Corgi",
      company_website: "https://corgi.insure",
      round_type_as_written: "Series B extension",
      amount_as_written: null,
      valuation_as_written: "$4 billion",
      announced_date: "2026-07-23",
      lead_investors: [],
      is_rumor: true,
      evidence_quote: "The round is said to be a second extension of its Series B round and has already closed.",
    }),
  },
] as const;

export const corgiCandidates: HistoryCandidate[] = corgiAnnouncements.map((a) => ({
  url: a.url,
  title: a.title,
  description: a.excerpt,
  published: a.published,
  via: "search",
}));
export const corgiPages: Record<string, ExtractedItem[]> = Object.fromEntries(
  corgiAnnouncements.map((a) => [
    a.url,
    [
      {
        round: a.round,
        source: { url: a.url, host: hostOf(a.url), title: a.title, published: a.published },
        page_kind: "article",
        grounded: true,
      },
    ],
  ]),
);
