// The read-back clears an amount no page states only when what it read states some figure or says the
// terms were not disclosed. Cases from the launch-day feed audit: Form D rounds cited their filing's
// index page, which lists documents and file sizes but no amount, and the read-back cleared every one.

import { describe, expect, test } from "vitest";
import { textsStateMoney } from "../records/correction.ts";
import type { FeedRecord } from "../records/schema.ts";
import { applyReconciliation, type Reconciliation, type SourceText } from "./reconcile.ts";

const INDEX_URL = "https://www.sec.gov/Archives/edgar/data/2078406/000143774926032509/0001437749-26-032509-index.htm";

/** The Axelyf, Inc. filing index as the reader returned it. */
const AXELYF_INDEX =
  "EDGAR Filing Documents for 0001437749-26-032509 Form D - Notice of Exempt Offering of Securities: SEC Accession No. 0001437749-26-032509 Filing Date 2026-10-13 Accepted 2026-10-13 09:19:12 Documents 1 Effectiveness Date 2026-10-13 Items Item 06b: Document Format Files | Seq | Description | Document | Type | Size | | --- | --- | --- | --- | --- | | 1 | | primary_doc.html | D | | | 1 | | primary_doc.xml | D | 6364 | | | Complete submission text file | 0001437749-26-032509.txt | | 7490 | Mailing Address 33 GLENLAND ROAD UNIT 2 CHESTNUT HILL MA 02467 Business Address 33 GLENLAND ROAD UNIT 2 CHESTNUT HILL MA 02467 1-508-494-0155 Axelyf, Inc. (Filer) CIK: 0002078406 (see all company filings) EIN.: 333955972 | State of Incorp.: DE | Fiscal Year End: 1231 Type: D | Act: 33 | File No.: 021-600844 | Film No.: 261455124";

function formDRecord(): FeedRecord {
  return {
    id: "axelyf:other:2026-10-07",
    company_key: "axelyf",
    company_name: "Axelyf, Inc.",
    company_domain: null,
    company_website: null,
    company_description: null,
    stage: "other",
    stage_as_written: "Form D (equity)",
    is_extension: false,
    amount: { value: 2.631439, currency: "USD", as_written: "$2,631,439", usd_millions: 2.631439, fx_rate: 1, fx_date: "2026-10-13" },
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: "2026-10-07",
    date_precision: "day",
    date_basis: "stated",
    headquarters: null,
    sector: null,
    evidence_quotes: [
      "Axelyf, Inc. reported in a Form D filed 2026-10-13 that it sold $2,631,439 of equity securities under Regulation D of a $2,700,000 offering (first sale 2026-10-07; 8 investors; Biotechnology).",
    ],
    sources: [{ url: INDEX_URL, host: "sec.gov", title: "Form D: Axelyf, Inc.", published: "2026-10-13", query: "formd" }],
    confidence: 0.8,
    status: "new",
    undated: false,
  };
}

const NOTHING = { stated: false, value: null, source: null, quote: null };

/** The verdict the read-back gave on the index page: a filing, nothing stated. */
const SILENT: Reconciliation = {
  is_announcement: "yes",
  company_matches: true,
  stage: NOTHING,
  amount: NOTHING,
  valuation: NOTHING,
  financing_total: NOTHING,
  announced_date: { ...NOTHING, precision: "day" },
  lead_investors: [],
  other_investors: [],
  not_this_round: [],
  headquarters: NOTHING,
  notes:
    "The SEC index identifies a Form D filing but does not state a round label, amount, valuation, announcement date, headquarters, or investors.",
};

const OPTS = { rates: null, verifier: "gateway:openai/gpt-5.6-luna", sourcesSeen: 1 };

function page(markdown: string, url = INDEX_URL): SourceText {
  return { url, host: new URL(url).hostname, title: "Form D: Axelyf, Inc.", markdown };
}

describe("an amount no page states", () => {
  test("stays when the page read states no figure at all: a Form D's index page (Axelyf, $2,631,439)", () => {
    const r = applyReconciliation(formDRecord(), SILENT, { ...OPTS, pages: [page(AXELYF_INDEX)] });
    expect(r.amount.as_written).toBe("$2,631,439");
    expect(r.amount.usd_millions).toBe(2.631439);
    expect(r.verification?.notes.some((n) => /not stated for this round/.test(n))).toBe(false);
  });

  test("stays when the page is a cookie wall (Cloover's $114 million)", () => {
    const cookie = "We use cookies to improve your experience. Accept all | Reject all | Manage preferences. Privacy policy.";
    const r = applyReconciliation(formDRecord(), SILENT, { ...OPTS, pages: [page(cookie, "https://example.com/cloover")] });
    expect(r.amount.as_written).toBe("$2,631,439");
  });

  test("goes when the page states a figure that is not the round's: a total raised (Arcee's $5.5 million)", () => {
    const total = "Arcee has raised $5.5 million in total funding to date from Wndrco and Long Journey Ventures.";
    const r = applyReconciliation(formDRecord(), SILENT, { ...OPTS, pages: [page(total, "https://arcee.ai/blog")] });
    expect(r.amount.as_written).toBeNull();
    expect(r.verification?.notes).toContain("amount $2,631,439 not stated for this round");
  });

  test("goes when the page says the terms were not disclosed (Darwinbox's release)", () => {
    const release = "Darwinbox announced a new investment led by Teachers' Venture Growth. Financial terms were not disclosed.";
    const r = applyReconciliation(formDRecord(), SILENT, { ...OPTS, pages: [page(release, "https://darwinbox.com/press")] });
    expect(r.amount.as_written).toBeNull();
  });

  test("goes as before when the caller has no page text", () => {
    const r = applyReconciliation(formDRecord(), SILENT, OPTS);
    expect(r.amount.as_written).toBeNull();
  });
});

describe("textsStateMoney", () => {
  test("a filing index, with its sizes and file numbers, states no figure", () => {
    expect(textsStateMoney([AXELYF_INDEX])).toBe(false);
  });

  test("figures in the forms the feed's pages write them", () => {
    expect(textsStateMoney(["Wavena has secured seed funding of 200 million won"])).toBe(true);
    expect(textsStateMoney(["GreenCell Mobility Secures ₹330 Crore from Impact Fund Denmark"])).toBe(true);
    expect(textsStateMoney(["Archa raises AUD 11 million"])).toBe(true);
    expect(textsStateMoney(["Mosi Intelligence completed a Pre-Series A financing of over 1 billion yuan"])).toBe(true);
    expect(textsStateMoney(["Stenon raised an undisclosed amount in a second closing of its Series B"])).toBe(true);
  });
});
