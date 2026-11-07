import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  angleSentence,
  answeringProof,
  articleAngles,
  articleMismatch,
  articleTopicWords,
  buildDrafts,
  CALL_ASK,
  clause,
  type Draft,
  draftFounder,
  draftJob,
  type FundedLead,
  fingerprint,
  fitProof,
  isDraft,
  isPitchable,
  type JobLead,
  leadAngles,
  leadArticleMismatch,
  lintDraft,
  listingRequirement,
  MAX_WORDS,
  matchProof,
  namedRecipient,
  onPolicyPage,
  PROOF_METRICS,
  type ProofKey,
  postedSubject,
  proofFor,
  roleKind,
  shortCompany,
  wordCount,
} from "../lib/outreach";

const HOME_ARTICLE = "https://news.example.org/2026/11/acme-health-raises-12m-to-bring-its-clinical-intake-into-the-home";
const SEO_ASK = "If you are an expert in search for education brands, email jobs@brightlearn.example";
const RESULTS_ASK = "Send your CV and two examples of paid campaigns you ran, with results, to jobs@brightlearn.example";

const funded = (over: Partial<FundedLead> = {}): FundedLead => ({
  company: "Acme Health",
  website: "https://acmehealth.example/",
  brief: "Acme Health is the clinical intake platform for small clinics.",
  industry: {
    label: "healthcare",
    confidence: 0.9,
    evidence_quote: "clinical intake platform for small clinics",
    source_url: "https://acmehealth.example/",
  },
  stage: "Series A",
  amount: "$12M",
  announced_on: "2026-11-05",
  funding_source_url: HOME_ARTICLE,
  founders: [],
  company_emails: [
    {
      email: "hello@acmehealth.example",
      source_url: "https://acmehealth.example/contact",
      quote: "Write to hello@acmehealth.example",
      inbox: "general",
    },
  ],
  ...over,
});

const job = (over: Partial<JobLead> = {}): JobLead => ({
  title: "Performance Marketing Manager",
  company: "Brightlearn",
  company_brief: "Brightlearn runs online courses for students preparing for exams.",
  posted_at: "2026-11-06T00:00:00.000Z",
  source: "indeed",
  source_url: "https://in.indeed.com/viewjob?jk=abc",
  apply_url: "https://in.indeed.com/viewjob?jk=abc",
  emails: ["jobs@brightlearn.example"],
  email_source_quote: RESULTS_ASK,
  ...over,
});

const asDraft = (result: ReturnType<typeof draftFounder>): Draft => {
  if (!isDraft(result)) throw new Error(`expected a draft, got skipped: ${result.reason}`);
  return result;
};

describe("style lint", () => {
  test("rejects banned openers, closers, em dashes, sign-offs and missing call ask", () => {
    const ok = `Hi,\n\nI'm writing because Acme raised a round.\n\n${CALL_ASK}`;
    expect(lintDraft(ok)).toEqual([]);
    for (const bad of [
      "Acme caught my eye last week.",
      "Congratulations on the raise.",
      "I hope this finds you well.",
      "I'd welcome a conversation.",
      "Would love to talk.",
      "Worth a call?",
      "Could we do a 20-minute call?",
      "Can I send a one-page plan?",
      "We grew fast — really fast.",
    ])
      expect(lintDraft(`Hi,\n\n${bad}\n\n${CALL_ASK}`).length, bad).toBeGreaterThan(0);
    expect(lintDraft(`Hi,\n\nText.\n\n${CALL_ASK}\n\nBest,\nAasim`).length).toBeGreaterThan(0);
    expect(lintDraft(`Hi,\n\nI'm Aasim.\n\n${CALL_ASK}`).length).toBeGreaterThan(0);
    // A posting can ask for the applicant's name in the subject; the body still never carries it.
    expect(lintDraft(`Hi,\n\nText.\n\n${CALL_ASK}`, "Marketing Specialist - Aasim")).toEqual([]);
    expect(lintDraft("Hi,\n\nText without the ask.")).toContain("must end with the call ask");
    expect(lintDraft(`${"word ".repeat(MAX_WORDS)}\n${CALL_ASK}`).some((p) => p.startsWith("too long"))).toBe(true);
  });
});

describe("proof matches industry", () => {
  test("maps industries to the right case study and falls back to Leadgentic", () => {
    expect(proofFor("edtech", 0.8)).toBe("newton_school");
    expect(proofFor("healthcare", 0.8)).toBe("healthcare");
    expect(proofFor("real_estate", 0.8)).toBe("living_expert");
    expect(proofFor("hiring_marketplace", 0.8)).toBe("hiring");
    expect(proofFor("consumer_app", 0.8)).toBe("workindia_app");
    expect(proofFor("b2b_saas", 0.8)).toBe("leadgentic");
    expect(proofFor("agency", 0.8)).toBe("leadgentic");
    expect(proofFor("climate", 0.9)).toBe("leadgentic");
    expect(proofFor("healthcare", 0.1)).toBe("leadgentic");
  });

  test("a healthcare founder gets Shraddha and an edtech job gets Newton School, with no other metrics", () => {
    const founder = asDraft(draftFounder(funded()));
    expect(founder.proof_used.key).toBe("healthcare");
    expect(founder.body).toContain("2.61x ROAS");
    expect(founder.body).not.toContain("Newton School");
    const role = asDraft(draftJob(job()));
    expect(role.proof_used.key).toBe("newton_school");
    expect(role.body).toContain("Newton School");
    expect(role.body).not.toContain("Shraddha");
  });

  test("every figure in a draft comes from the round or the matched proof", () => {
    const run = buildDrafts({
      funded: [funded(), funded({ company: "Gridco", industry: { label: "climate", confidence: 0.9 } })],
      jobs: [job()],
    });
    for (const draft of run.drafts) {
      const allowed = new Set<string>([...PROOF_METRICS[draft.proof_used.key as ProofKey], ...PROOF_METRICS.leadgentic, "$12M", "5"]);
      const figures = draft.body.match(/(?<![A-Za-z])\$?\d[\d.,]*(?:x|%|K\+?|M)?/g) ?? [];
      for (const raw of figures) {
        const figure = raw.replace(/[.,]+$/, "");
        expect(allowed.has(figure), `${draft.id}: ${figure}`).toBe(true);
      }
    }
  });
});

describe("proof is gated on fit", () => {
  const ROVANTA =
    "Rovanta builds self-driving delivery robots for campus and last-mile runs across healthcare, industrial and parcel settings";

  test("Leadgentic only for B2B buyers; consumer buyers get a consumer case study or nothing", () => {
    expect(fitProof("b2b_saas", 0.9, "Payments for your business.", "b2b")).toMatchObject({ key: "leadgentic", withLeadgentic: true });
    expect(fitProof("other", 0.9, "Master franchising of F&B brands.", "visit")).toBeNull();
    expect(fitProof("climate", 0.9, "An electric bike for urban riders.", "test_ride")).toBeNull();
    expect(fitProof("ecommerce", 0.9, "Skincare infused makeup.", "order")).toBeNull();
    expect(fitProof("other", 0.9, "Download our app.", "install")).toMatchObject({ key: "workindia_app", withLeadgentic: false });
    expect(fitProof("other", 0.9, "Physiotherapy for back pain at home.", "order")).toMatchObject({
      key: "healthcare",
      withLeadgentic: false,
    });
    expect(fitProof("edtech", 0.9, "Courses for students.", "signup")).toMatchObject({ key: "newton_school", withLeadgentic: false });
  });

  test("healthcare proof needs a health term in the brief, not just the word healthcare in a list of sectors", () => {
    expect(fitProof("healthcare", 0.5, ROVANTA, "b2b")?.key).toBe("leadgentic");
    const draft = asDraft(
      draftFounder(
        funded({
          company: "Rovanta",
          website: "https://rovanta.example/",
          brief: ROVANTA,
          industry: { label: "healthcare", confidence: 0.5, evidence_quote: ROVANTA, source_url: "https://rovanta.example/" },
          funding_source_url: "https://news.example.org/rovanta-raises-5m-to-expand-autonomous-delivery-robots-across-us-hospitals",
        }),
      ),
    );
    expect(draft.proof_used.key).toBe("leadgentic");
    expect(draft.body).not.toContain("142");
    expect(draft.body).not.toContain("Shraddha");
  });

  test("consumer and local leads never get the B2B Leadgentic line", () => {
    const role = asDraft(draftJob(job()));
    expect(role.body).not.toContain("Leadgentic");
    const fnb = draftFounder(
      funded({
        company: "Tandoor Lane Foods",
        brief: "Tandoor Lane Foods Limited runs master franchises for well-known F&B brands such as Crumbly and Spoonful.",
        industry: { label: "other", confidence: 0.9 },
      }),
    );
    expect(isDraft(fnb)).toBe(false);
    if (!isDraft(fnb)) expect(fnb.reason).toContain("no matching proof");
    const bakery = draftJob(
      job({ company: "Crumbwell Bakery", company_brief: "Crumbwell Bakery makes fresh bread and cakes in Perth each morning." }),
    );
    expect(isDraft(bakery)).toBe(false);
  });

  test("a funding article about a different company of the same name is skipped", () => {
    const rangelineUrl =
      "https://markets.example.com/article/bizwire-2026-11-4-rangeline-raises-5-million-in-seed-funding-to-help-developers-own-control-and-monetize-ai";
    expect(articleTopicWords(rangelineUrl, "Rangeline")).toEqual(["developers", "control", "monetize", "ai"]);
    const brief = "Rangeline makes a connected electric bike built for city riders who want to skip the traffic.";
    expect(articleMismatch(rangelineUrl, "Rangeline", brief)).toBe(true);
    const rangeline = draftFounder(
      funded({
        company: "Rangeline",
        website: "https://rangeline.example/",
        brief,
        industry: { label: "consumer_app", confidence: 0.9 },
        funding_source_url: rangelineUrl,
      }),
    );
    expect(isDraft(rangeline)).toBe(false);
    if (!isDraft(rangeline)) expect(rangeline.reason).toContain("different company");
    // Same company: shared words, investor clauses and too-short slugs do not trigger the check.
    expect(
      articleMismatch(
        "https://news.example.net/article/edinburgh-s-flexora-raises-2-95-million-series-a-extension-for-soft-robotic-stroke-rehabilitation",
        "Flexora",
        "Wearable devices that help stroke survivors with neurological rehabilitation at home.",
      ),
    ).toBe(false);
    expect(
      articleMismatch(
        "https://news.example.net/article/930560/kinetra-raises-10-million-in-seed-funding-led-by-larkfield-capital-with-us-venture-partners-participating/",
        "Kinetra",
        "Kinetra builds synthetic training data for physical AI.",
      ),
    ).toBe(false);
    expect(
      articleMismatch(
        "https://news.example.net/2026/11/stockholms-grid-harbor-raises-e13-5-million-to-operate-and-trade-battery-storage-across-european-power-markets-using-ai/",
        "Grid Harbor",
        "GridHarbor uses AI to run, trade and protect battery storage and renewable energy assets.",
      ),
    ).toBe(false);
  });
});

describe("drafts", () => {
  test("founder drafts use the round, address a named founder by first name, and pass lint", () => {
    const draft = asDraft(
      draftFounder(
        funded({
          founders: [
            {
              name: "Priya Raman",
              role: "CEO",
              source_url: "https://news.example.org/acme-raises",
              emails: [
                { email: "priya@acmehealth.example", source_url: "https://acmehealth.example/team", quote: "priya@acmehealth.example" },
              ],
            },
          ],
        }),
      ),
    );
    expect(draft.to.email).toBe("priya@acmehealth.example");
    expect(draft.body.startsWith("Hi Priya,")).toBe(true);
    expect(draft.body).toContain("$12M Series A round");
    expect(draft.body).toContain("November 5");
    expect(draft.body).toContain("news.example.org reports the round is to bring your clinical intake into the home.");
    expect(draft.body).toContain("from clinics and clinical teams to patients and families at home");
    expect(draft.body).toContain("Is that the plan?");
    expect(draft.body).not.toContain("clinical intake platform for small clinics");
    expect(draft.body.trim().endsWith(CALL_ASK)).toBe(true);
    expect(lintDraft(draft.body, draft.subject)).toEqual([]);
    expect(wordCount(draft.body)).toBeLessThanOrEqual(MAX_WORDS);
    expect(draft.facts_used.every((fact) => fact.source_url.startsWith("https://"))).toBe(true);
  });

  test("company inbox drafts carry no name", () => {
    const draft = asDraft(draftFounder(funded()));
    expect(draft.to).toMatchObject({ email: "hello@acmehealth.example", name: null, source_url: "https://acmehealth.example/contact" });
    expect(draft.body.startsWith("Hi,\n")).toBe(true);
  });

  test("job drafts name the exact role and where it was posted, and say a CV is attached", () => {
    const draft = asDraft(draftJob(job({ title: "Growth Marketer — Paid Social", source: "linkedin-post" })));
    expect(draft.body).toContain("Growth Marketer - Paid Social role at Brightlearn");
    expect(draft.body).toContain("LinkedIn post");
    expect(draft.body).toContain("My CV is attached.");
    expect(draft.body).toContain('The listing asks for "two examples of paid campaigns you ran, with results". Here is one.');
    expect(draft.body).not.toContain("Brightlearn runs online courses");
    expect(draft.attachments).toEqual(["CV"]);
    expect(lintDraft(draft.body, draft.subject)).toEqual([]);
  });

  test("no draft without a posted, pitchable email", () => {
    expect(isDraft(draftFounder(funded({ company_emails: [] })))).toBe(false);
    // Not on the quoted page: never used.
    expect(
      isDraft(
        draftFounder(
          funded({
            company_emails: [{ email: "hello@acmehealth.example", source_url: "https://acmehealth.example/", quote: "Contact us" }],
          }),
        ),
      ),
    ).toBe(false);
    for (const local of [
      "privacy",
      "legal",
      "security",
      "dpo",
      "accessibility",
      "support",
      "noreply",
      "no-reply",
      "spam",
      "press",
      "media",
      "pr",
    ]) {
      expect(isPitchable(`${local}@acmehealth.example`), local).toBe(false);
      const only = funded({
        company_emails: [
          { email: `${local}@acmehealth.example`, source_url: "https://acmehealth.example/", quote: `${local}@acmehealth.example` },
        ],
      });
      expect(isDraft(draftFounder(only)), local).toBe(false);
    }
    expect(isDraft(draftJob(job({ email_source_quote: "Apply on our site" })))).toBe(false);
    expect(isDraft(draftJob(job({ emails: ["privacy@brightlearn.example"], email_source_quote: "privacy@brightlearn.example" })))).toBe(
      false,
    );
  });

  test("buildDrafts keeps one draft per lead and every draft passes lint", () => {
    const run = buildDrafts({
      funded: [funded(), funded({ company_emails: [] })],
      ranked: [job()],
      jobs: [job(), job({ title: "SEO Lead", email_source_quote: SEO_ASK })],
    });
    expect(run.stats.founder_drafts).toBe(1);
    expect(run.stats.job_drafts).toBe(2);
    expect(run.skipped).toHaveLength(1);
    for (const draft of run.drafts) {
      expect(lintDraft(draft.body, draft.subject)).toEqual([]);
      expect(draft.body).not.toMatch(/aasim|regards|best,/i);
    }
  });

  test("clause keeps a whole leading phrase and rejects headlines, stubs and non-English", () => {
    expect(clause("Kinetra builds synthetic training data for physical AI.")).toBe(
      "Kinetra builds synthetic training data for physical AI",
    );
    expect(clause("Your ideas finally have a voice.")).toBe("Your ideas finally have a voice");
    expect(clause("Gestiona la contabilidad de tu despacho con Contalo.")).toBeNull();
    expect(clause("Industry: Hospitals and Health Care")).toBeNull();
    expect(clause("Acme raises $5M to grow")).toBeNull();
    expect(
      clause("Skillnest offers Data Science, Machine Learning, Business Analytics, Full Stack Development, Cloud Training and more", 10),
    ).toBeNull();
  });
});

describe("one sentence only this recipient could get", () => {
  test("founders that are not paid-acquisition buyers, or have no brief or named customer, are skipped", () => {
    for (const over of [
      { industry: { label: "deeptech", confidence: 0.9 }, brief: "Orbita builds satellites for low orbit." },
      { industry: { label: "climate", confidence: 0.9 }, brief: "Acme Health makes fluorochemicals without HF." },
      { brief: null, industry: null },
      { brief: "Your ideas finally have a voice.", industry: { label: "b2b_saas", confidence: 0.2 } },
    ] as Array<Partial<FundedLead>>) {
      const result = draftFounder(funded(over));
      expect(isDraft(result), JSON.stringify(over)).toBe(false);
    }
  });

  test("job drafts skip without a company brief to match the record against", () => {
    expect(roleKind("Senior SEO Executive")).toBe("seo");
    expect(roleKind("Social Media Manager")).toBe("social");
    expect(isDraft(draftJob(job({ company_brief: null })))).toBe(false);
    expect(isDraft(draftJob(job({ company_brief: "Industry: Education And Schools" })))).toBe(false);
    expect(shortCompany("Orbitfold Technologies PVT. LTD.")).toBe("Orbitfold Technologies");
  });

  test("job drafts honour the posting's subject line and portfolio request", () => {
    const quote =
      'Send your CV, portfolio and two examples of paid campaigns with results to jobs@brightlearn.example with the subject line "Application – Performance Marketer".';
    const draft = asDraft(draftJob(job({ email_source_quote: quote })));
    expect(draft.subject).toBe("Application - Performance Marketer");
    expect(draft.body).toContain("portfolio");
    expect(draft.attachments).toContain("portfolio of campaign results");
    expect(postedSubject("Send your CV to a@b.example using the Job Position as the subject of the email.", "SEO Lead")).toEqual({
      subject: "SEO Lead",
      rule: "title",
    });
    expect(postedSubject("Email a@b.example with the subject line Marketing Intern – Fizzbee.", "x")?.subject).toBe(
      "Marketing Intern - Fizzbee",
    );
    expect(postedSubject('Email a@b.example with the subject line "Marketing Specialist – [Your Name]".', "x")?.subject).toBe(
      "Marketing Specialist - Aasim",
    );
    expect(postedSubject("Email a@b.example with the subject line:", "x")).toEqual({ subject: null, rule: "missing" });
    expect(postedSubject("Email your CV to a@b.example", "x")).toBeNull();
    const missing = asDraft(
      draftJob(
        job({
          email_source_quote: "Send two examples of paid campaigns with results. Email jobs@brightlearn.example with the subject line:",
        }),
      ),
    );
    expect(missing.check_before_sending.length).toBe(1);
  });

  test("buildDrafts drops a draft whose body matches another once names are stripped", () => {
    const run = buildDrafts({
      funded: [],
      jobs: [
        job({ company: "Alpha Prep", title: "SEO Lead", company_brief: "Online courses for students preparing for exams." }),
        job({
          company: "Beta Prep",
          title: "SEO Lead",
          company_brief: "Online courses for students preparing for exams.",
          emails: ["hr@betaprep.example"],
          email_source_quote: "Send your CV and two examples of paid campaigns you ran, with results, to hr@betaprep.example",
        }),
      ],
    });
    expect(run.drafts).toHaveLength(1);
    expect(run.skipped.some((s) => s.reason.includes("same as"))).toBe(true);
  });

  const runFile = "evals/runs/outreach-drafts.json";
  test.skipIf(!existsSync(runFile))("no two drafts in the last run share a body once company, role and board are stripped", () => {
    const run = JSON.parse(readFileSync(runFile, "utf8")) as { drafts: Draft[] };
    const seen = new Map<string, string>();
    for (const draft of run.drafts) {
      const print = fingerprint(draft);
      expect(seen.get(print), `${draft.id} duplicates ${seen.get(print)}`).toBeUndefined();
      seen.set(print, draft.id);
      expect(lintDraft(draft.body, draft.subject), draft.id).toEqual([]);
    }
  });
});

describe("round 1 fixes", () => {
  test("Leadgentic needs a positive B2B signal; no signal or a consumer business gets no proof", () => {
    expect(fitProof("other", 0.9, "Handmade candles, poured in Leeds.", null)).toBeNull();
    expect(matchProof("other", 0.9, "Handmade candles, poured in Leeds.", null).why).toContain("no B2B signal");
    expect(fitProof("b2b_saas", 0.9, "CRM platform for home service businesses.", null)?.key).toBe("leadgentic");
    for (const consumer of [
      "Puffin Point is Devon's favourite family adventure park.",
      "Durian Delight is the place to go for fresh durian cakes.",
      "Silkstrand hair extensions give your clients fuller hair without harming their own.",
      "Since 1985, our award-winning travel team has planned trips to dream destinations.",
      "Criminal defense and personal injury attorneys with decades of shared experience.",
      "Warmhaven is one of the fastest-growing heating and home cover brands in Wales, chosen by thousands of homeowners.",
    ])
      expect(fitProof("agency", 0.9, consumer, null), consumer).toBeNull();
    expect(fitProof("other", 0.9, "HARTWELL GROUP OF COMPANIES OVERVIEW", null)).toBeNull();
    expect(fitProof("other", 0.9, "Fenland Air Ambulance Charity brings urgent care to patients across the region.", null)).toBeNull();
  });

  test("healthcare proof only for patients, clinics or care; NEET coaching is edtech; a drama app gets app proof", () => {
    expect(fitProof("healthcare", 0.9, "Experienced doctors and NEET mentors run our NEET preparation classes.", null)?.key).toBe(
      "newton_school",
    );
    expect(fitProof("healthcare", 0.3, "Computer vision to identify injury risk for professional sport.", "b2b")?.key).toBe("leadgentic");
    expect(fitProof("other", 0.9, "Peakform Fitness is a gym with wellness programmes for every fitness level.", null)).toBeNull();
    expect(fitProof("healthcare", 0.9, "Clearsound: a trusted Indian clinic for hearing, speech and vertigo care.", "b2b")?.key).toBe(
      "healthcare",
    );
    expect(fitProof("other", 0.9, "Meet StoryReel, an Indian short drama app built for quick binge sessions.", null)?.key).toBe(
      "workindia_app",
    );
  });

  test("never writes to spam, press or a privacy-page-only address", () => {
    expect(onPolicyPage("https://acmehealth.example/privacy-policy")).toBe(true);
    expect(onPolicyPage("https://acmehealth.example/contact")).toBe(false);
    const policyOnly = funded({
      company_emails: [
        {
          email: "hello@acmehealth.example",
          source_url: "https://acmehealth.example/privacy-policy",
          quote: "Questions: hello@acmehealth.example",
        },
        {
          email: "press@acmehealth.example",
          source_url: "https://acmehealth.example/press",
          quote: "press@acmehealth.example",
          inbox: "press",
        },
      ],
    });
    expect(isDraft(draftFounder(policyOnly))).toBe(false);
    const spam = draftJob(
      job({
        emails: ["spam@brightlearn.example"],
        email_source_quote: "Please forward such requests to spam@brightlearn.example for us to investigate.",
      }),
    );
    expect(isDraft(spam)).toBe(false);
    const fraud = draftJob(job({ email_source_quote: "Report recruitment fraud to jobs@brightlearn.example" }));
    expect(isDraft(fraud)).toBe(false);
  });

  test("addresses the person the posting names, never a name guessed from the address", () => {
    expect(namedRecipient("theo.marsh@xexample.com", "please email Theo Marsh at theo.marsh@xexample.com with your CV")).toBe("Theo");
    expect(namedRecipient("digital@kitefieldexample.agency", "digital@kitefieldexample.agency (Attn: Petra)")).toBe("Petra");
    expect(namedRecipient("leratod@xexample.co.za", "Send your CV to Lerato Dube at leratod@xexample.co.za.")).toBe("Lerato");
    expect(namedRecipient("nadia.frost@xexample.group", "Send us your CV to the HR Manager at nadia.frost@xexample.group")).toBeNull();
    expect(namedRecipient("Marisol@xexample.co.uk", "Please send your CV to Marisol@xexample.co.uk.")).toBeNull();
    const draft = asDraft(
      draftJob(
        job({
          emails: ["theo.marsh@brightlearn.example"],
          email_source_quote: "Send two examples of paid campaigns with results. Email Theo Marsh at theo.marsh@brightlearn.example",
        }),
      ),
    );
    expect(draft.body.startsWith("Hi Theo,\n")).toBe(true);
    expect(draft.to.name).toBe("Theo");
  });

  test("a lead whose round articles all describe something else is skipped", () => {
    const lead = {
      company: "Rangeline",
      funding_source_url:
        "https://news.example.net/rangeline-raises-5-million-in-seed-funding-to-help-developers-own-control-and-monetize-ai",
      other_sources: ["https://wire.example.net/rangeline-bags-5m-for-developer-ai-monetization-tools"],
    };
    expect(leadArticleMismatch(lead, "Rangeline makes a connected electric bike for city riders.")).toBe("developers control monetize ai");
    // One article in the homepage's words is enough to call it the same company.
    expect(
      leadArticleMismatch(
        { ...lead, other_sources: ["https://wire.example.net/rangeline-raises-5m-for-connected-electric-bike-riders"] },
        "Rangeline makes a connected electric bike for city riders.",
      ),
    ).toBeNull();
  });
});

describe("round 2: a sentence from a source other than the homepage, answered by the proof", () => {
  const FLEXORA = funded({
    company: "Flexora",
    website: "https://www.flexora.example/",
    brief: "Wearable stroke rehabilitation devices that keep patients practising between sessions and give clinicians more therapy time.",
    stage: "Series A",
    amount: "€2.95 Million",
    funding_source_url:
      "https://www.dealbook.example/article/edinburgh-s-flexora-raises-2-95-million-series-a-extension-for-soft-robotic-stroke-rehabilitation",
    other_sources: [
      "https://www.startupwire.example/2026/11/flexora-raises-e2-95-million-to-bring-its-ai-powered-rehabilitation-technology-into-the-home/",
    ],
  });

  test("reads use of funds, customer, market, product and city from the article headline", () => {
    const angles = leadAngles(FLEXORA);
    expect(angles[0]).toMatchObject({ kind: "home", phrase: "bring your AI-powered rehabilitation technology into the home" });
    expect(angles.map((a) => a.kind)).toEqual(["home", "product", "hq"]);
    expect(angles.find((a) => a.kind === "product")?.phrase).toBe("soft robotic stroke rehabilitation");
    expect(angles.find((a) => a.kind === "hq")?.place).toBe("Edinburgh");
    expect(
      articleAngles(
        "https://startupnews.example/topic/funding/perth-logistics-analysis-startup-haulwise-moves-on-750000-pre-seed/",
        "Haulwise",
      ),
    ).toMatchObject([{ kind: "hq", place: "Perth", descriptor: "Perth logistics analysis startup" }]);
    expect(
      articleAngles(
        "https://startupwire.example/2026/11/london-based-ledgerwise-raises-e4-million-to-bring-ai-powered-research-and-review-to-tax-firms/",
        "Ledgerwise",
      )[0],
    ).toMatchObject({ kind: "customer", customer: "tax firms", phrase: "bring AI-powered research and review to tax firms" });
    // A run-together list keeps only its first item; "b2b" is not a figure; "us" is the US.
    expect(
      articleAngles(
        "https://news.example.net/leipzig-based-molara-raises-e818k-to-help-people-reduce-jaw-pain-bruxism-and-tmj-related-tension/",
        "Molara",
      )[0]?.phrase,
    ).toBe("help people reduce jaw pain");
    expect(
      articleAngles("https://news.example.net/paywell-raises-80m-series-c-to-expand-ai-powered-b2b-payments-platform/", "Paywell")[0],
    ).toMatchObject({
      kind: "purpose",
      phrase: "expand your AI-powered B2B payments platform",
    });
    expect(
      articleAngles("https://news.example.net/afterly-secures-5-6m-series-a-to-expand-aftersales-ai-and-us-operations/", "Afterly")[0],
    ).toMatchObject({
      kind: "market",
      market: "the US",
    });
    // A headline that only names the round gives nothing.
    expect(articleAngles("https://news.example.net/tracksy-secures-12m-series-a-amid-5x-growth/", "Tracksy")).toEqual([]);
  });

  test("the article sentence names a buyer and channel, asks a question, and the proof line answers it", () => {
    const draft = asDraft(draftFounder(FLEXORA));
    const [, opening, proof] = draft.body.split("\n\n");
    expect(opening).toContain("startupwire.example reports the round is to bring your AI-powered rehabilitation technology into the home.");
    expect(opening).toContain("patients and families at home");
    expect(opening).toMatch(/\?$/);
    expect(opening).not.toContain("Wearable stroke");
    expect(proof).toContain("142 patients");
    expect(proof).not.toContain("Leadgentic");
    expect(draft.facts_used.some((fact) => fact.source_url.includes("startupwire.example") && fact.fact.includes("into the home"))).toBe(
      true,
    );
    const b2bFit = { key: "leadgentic" as const, withLeadgentic: true, why: "" };
    expect(answeringProof(b2bFit, "consumer")).toBeNull();
    expect(answeringProof(b2bFit, "b2b")).toContain("B2B client acquisition");
    const ledgerwise = angleSentence(
      articleAngles(
        "https://startupwire.example/london-based-ledgerwise-raises-e4-million-to-bring-ai-powered-research-and-review-to-tax-firms",
        "Ledgerwise",
      )[0]!,
      "Ledgerwise",
      { audience: "accountants and tax advisers", buyer: "b2b" },
    );
    expect(ledgerwise).toMatchObject({ buyer: "b2b" });
    expect(ledgerwise?.text).toContain("Are tax firms the first market?");
  });

  test("a founder draft is skipped when the articles give nothing to build on, and a city only counts for an early round", () => {
    const bare = draftFounder(funded({ funding_source_url: "https://news.example.org/acme-health-raises-12m-series-a" }));
    expect(isDraft(bare)).toBe(false);
    if (!isDraft(bare)) expect(bare.reason).toContain("say nothing beyond the round");
    const cityOnly = { funding_source_url: "https://news.example.org/berlin-s-acme-health-raises-12m-series-a" };
    expect(isDraft(draftFounder(funded({ ...cityOnly, stage: "Series C" })))).toBe(false);
    const seed = asDraft(draftFounder(funded({ ...cityOnly, stage: "Seed" })));
    expect(seed.body).toContain("news.example.org places Acme Health in Berlin.");
    expect(seed.body).toContain("Leadgentic");
  });

  test("job drafts quote one requirement from the listing and answer it with the one matching proof line", () => {
    expect(listingRequirement(RESULTS_ASK, "newton_school")).toMatchObject({
      text: "two examples of paid campaigns you ran, with results",
      answer: "results",
    });
    expect(
      listingRequirement(
        "Email your CV, a brief cover note and two or three examples of campaigns you've run, with their results (pipeline, leads or ROI), to Lerato Dube at leratod@capeexample.co.za.",
        "leadgentic",
      )?.text,
    ).toBe("two or three examples of campaigns you've run, with their results (pipeline, leads or ROI)");
    expect(
      listingRequirement(
        "If you're an SEO specialist who cares about healthcare and skin health, share your CV at hr@dermaexample.in or call +91 00000 12345.",
        "healthcare",
      ),
    ).toMatchObject({ text: "an SEO specialist who cares about healthcare and skin health", answer: "sector" });
    // Work the record does not cover is not answered with an unrelated number.
    expect(
      listingRequirement(
        "Send your CV plus 2-3 samples of your SEO work (rankings or sites you have grown) to a@bexample.pk.",
        "leadgentic",
      ),
    ).toBeNull();
    expect(
      listingRequirement(
        "Submit your CV with details of your email marketing experience and the platforms you have used to mkg@xexample.ae",
        "leadgentic",
      ),
    ).toBeNull();
    expect(listingRequirement("Send your CV to jobs@brightlearn.example", "newton_school")).toBeNull();
    const skipped = draftJob(job({ email_source_quote: "Send your CV to jobs@brightlearn.example" }));
    expect(isDraft(skipped)).toBe(false);
    if (!isDraft(skipped)) expect(skipped.reason).toContain("no requirement or responsibility");
    const draft = asDraft(draftJob(job()));
    expect(draft.proof_used.lines).toHaveLength(1);
    expect(draft.body).toContain(`Here is one. ${draft.proof_used.lines[0]}`);
  });

  test("no draft uses the old homepage openers or spend-to-leads glue", () => {
    const run = buildDrafts({ funded: [FLEXORA, funded()], jobs: [job(), job({ title: "SEO Lead", email_source_quote: SEO_ASK })] });
    expect(run.drafts.length).toBe(4);
    for (const draft of run.drafts) {
      expect(draft.body).not.toMatch(
        /Your (?:page|site|homepage) (?:says|leads with)|From your site|I read "|You describe the business as|clear line from spend|I'd (?:market|build|put|turn|grow|bring|write|make|keep)\b/,
      );
      expect(lintDraft(draft.body, draft.subject)).toEqual([]);
    }
  });
});
