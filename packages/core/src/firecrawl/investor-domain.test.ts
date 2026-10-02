// An investor's domain is taken only from its own site: the host's label spells the firm, the
// result is not a directory or press page, and a bare-brand label must also read as an investor.
// A person resolves only through an investing vehicle in parentheses. Misses are null, never a guess.

import { describe, expect, test } from "vitest";
import { isLikelyPerson } from "../records/investors.ts";
import {
  anchorCandidates,
  INVESTOR_DOMAINS_PER_RUN,
  type InvestorCandidate,
  type InvestorHomepage,
  investorCandidates,
  investorDomainCap,
  investorDomainCredits,
  investorHomepageCredits,
  investorQueries,
  investorQuery,
  investorSearchTarget,
  judgeInvestorHomepage,
  pickInvestorDomain,
  readsAsPerson,
  storedCandidate,
} from "./investor-domain.ts";

const hit = (url: string, title: string, description?: string) => ({ url, title, description });

/** What a search for a firm returns around its site: databases, a wiki, the press. */
const NOISE = [
  hit("https://www.crunchbase.com/organization/acme-ventures", "Acme Ventures - Crunchbase Investor Profile"),
  hit("https://www.linkedin.com/company/acme-ventures", "Acme Ventures | LinkedIn"),
  hit("https://pitchbook.com/profiles/investor/12345-67", "Acme Ventures Investor Profile: Portfolio & Exits"),
  hit("https://en.wikipedia.org/wiki/Acme_Ventures", "Acme Ventures - Wikipedia", "Acme Ventures is a venture capital firm."),
  hit("https://techcrunch.com/2026/09/01/acme-ventures-fund-iv/", "Acme Ventures closes $400M Fund IV"),
  hit("https://signal.nfx.com/firms/acme-ventures", "Acme Ventures | Signal"),
  hit("https://x.com/acmevc", "Acme Ventures (@acmevc) / X"),
];

describe("pickInvestorDomain", () => {
  test("the firm's own site behind the directories: brand plus an investing suffix", () => {
    const pick = pickInvestorDomain("Acme Ventures", [...NOISE, hit("https://www.acmevc.com/", "Acme Ventures")]);
    expect(pick?.domain).toBe("acmevc.com");
    expect(
      pickInvestorDomain("Sequoia Capital", [hit("https://sequoiacap.com/our-companies/", "Our Companies | Sequoia Capital")])?.domain,
    ).toBe("sequoiacap.com");
    expect(pickInvestorDomain("Lux Capital", [hit("https://www.luxcapital.com", "Lux Capital")])?.domain).toBe("luxcapital.com");
    expect(
      pickInvestorDomain("HV Capital", [hit("https://www.hv.capital/", "HV Capital", "Venture capital for founders in Europe")])?.domain,
    ).toBe("hv.capital");
  });

  test("aggregators, press, and social pages never resolve, whatever their title says", () => {
    expect(pickInvestorDomain("Acme Ventures", NOISE)).toBeNull();
    // A label that spells the brand on a press domain is still the press.
    expect(
      pickInvestorDomain("Bloomberg", [hit("https://www.bloomberg.com/profile/company/X", "Bloomberg venture investments")]),
    ).toBeNull();
    // NFX's own site is NFX's; its investor database on the same domain is not anyone's site.
    expect(pickInvestorDomain("NFX", [hit("https://www.nfx.com/", "NFX", "NFX is a seed-stage venture firm")])?.domain).toBe("nfx.com");
  });

  test("a bare-brand label must name the firm and read as an investor: a reseller owns the plain word", () => {
    expect(
      pickInvestorDomain("Insight Partners", [
        hit("https://www.insight.com/", "Insight: Solutions Integrator", "Insight helps organizations modernize their IT."),
        hit("https://www.insightglobal.com/", "Insight Global | Staffing and Services"),
      ]),
    ).toBeNull();
    expect(
      pickInvestorDomain("Insight Partners", [
        hit("https://www.insight.com/", "Insight: Solutions Integrator"),
        hit("https://www.insightpartners.com/", "Insight Partners", "A global software investor"),
      ])?.domain,
    ).toBe("insightpartners.com");
    expect(
      pickInvestorDomain("Accel", [hit("https://www.accel.com/", "Accel", "Accel is an early and growth-stage venture capital firm.")])
        ?.domain,
    ).toBe("accel.com");
    // A public company's investor-relations page is not the corporate VC reading as an investor.
    expect(pickInvestorDomain("Nvidia", [hit("https://investor.nvidia.com/", "NVIDIA Investor Relations")])).toBeNull();
  });

  test("a firm named like a person resolves only when its site names it and reads as a firm", () => {
    expect(
      pickInvestorDomain("Kleiner Perkins", [
        hit("https://www.kleinerperkins.com/", "Kleiner Perkins | Make History", "Kleiner Perkins is a venture capital firm."),
      ])?.domain,
    ).toBe("kleinerperkins.com");
    expect(
      pickInvestorDomain("Y Combinator", [
        hit("https://www.ycombinator.com/", "Y Combinator", "Y Combinator created a new model for funding early stage startups."),
      ])?.domain,
    ).toBe("ycombinator.com");
    // A namesake's personal site: the name, no firm.
    expect(
      pickInvestorDomain("Jane Doe", [hit("https://janedoe.com/", "Jane Doe Photography", "Weddings and portraits in Lyon")]),
    ).toBeNull();
  });

  test("short forms: the curated ones and the one a name gives itself", () => {
    expect(
      pickInvestorDomain("Andreessen Horowitz", [
        hit("https://en.wikipedia.org/wiki/Andreessen_Horowitz", "Andreessen Horowitz - Wikipedia"),
        hit("https://a16z.com/", "Andreessen Horowitz", "a16z is a venture capital firm that backs bold entrepreneurs"),
      ])?.domain,
    ).toBe("a16z.com");
    expect(pickInvestorDomain("Lightspeed", [hit("https://lsvp.com/", "Lightspeed Venture Partners")])?.domain).toBe("lsvp.com");
    expect(
      pickInvestorDomain("Qatar Investment Authority (QIA)", [
        hit("https://www.qia.qa/en/Pages/default.aspx", "Qatar Investment Authority"),
      ])?.domain,
    ).toBe("qia.qa");
  });

  test("people: null unless the firm in parentheses clearly matches a site", () => {
    // A vehicle in parentheses is searched and matched as the firm.
    expect(
      pickInvestorDomain("Julien Jean (JJCapinvest)", [
        hit("https://www.linkedin.com/in/julienjean", "Julien Jean - JJCapinvest | LinkedIn"),
        hit("https://jjcapinvest.com/", "JJCapinvest - Home"),
      ])?.domain,
    ).toBe("jjcapinvest.com");
    // No site of the vehicle in the results: the person's namesake does not stand in for it.
    expect(
      pickInvestorDomain("Julien Jean (JJCapinvest)", [
        hit("https://www.linkedin.com/in/julienjean", "Julien Jean - JJCapinvest | LinkedIn"),
        hit("https://julienjean.com/", "Julien Jean, music producer"),
      ]),
    ).toBeNull();
    // An affiliation in parentheses (the company he founded) is not his fund: nothing to search for.
    expect(investorSearchTarget("Sylvestre Blavet (Freelance.com)")).toBeNull();
    expect(pickInvestorDomain("Sylvestre Blavet (Freelance.com)", [hit("https://www.freelance.com/", "Freelance.com")])).toBeNull();
  });

  test("a suffix naming a different kind of firm than the name's needs the full name written (live: HSR Ventures)", () => {
    // The live false positive: HSR Ventures took hsr-capital.com on "the name plus a suffix".
    expect(
      pickInvestorDomain("HSR Ventures", [
        hit("https://www.hsr-capital.com/", "HSR Capital | Real Estate Investment", "HSR Capital invests in private equity real estate."),
      ]),
    ).toBeNull();
    // The same host resolves when the result writes the name the record does.
    expect(
      pickInvestorDomain("HSR Ventures", [hit("https://www.hsr-capital.com/", "HSR Ventures", "HSR Ventures backs early-stage founders.")])
        ?.domain,
    ).toBe("hsr-capital.com");
    // A suffix of the same kind needs nothing more: "cap" is capital, "vc" is venture capital.
    expect(pickInvestorDomain("Smash Capital", [hit("https://www.smashcap.com/", "Smash Capital")])?.domain).toBe("smashcap.com");
    expect(pickInvestorDomain("Acme Ventures", [hit("https://acmevc.com/", "Acme Ventures")])?.domain).toBe("acmevc.com");
  });

  test("a one-word name takes only a venture firm's suffix, named as an investor (live: Archetype)", () => {
    // The live false positive: Archetype, the crypto fund at archetype.fund, took archetypeinvestments.com.
    const investments = hit(
      "https://www.archetypeinvestments.com/",
      "Archetype Investments | Wealth Management",
      "Archetype Investments offers portfolio management and venture investing for families.",
    );
    expect(pickInvestorDomain("Archetype", [investments])).toBeNull();
    expect(
      pickInvestorDomain("Archetype", [investments, hit("https://www.archetype.fund/", "Archetype", "Archetype is a crypto venture firm.")])
        ?.domain,
    ).toBe("archetype.fund");
    // A venture suffix still needs the name and an investing word, not just one of them.
    expect(pickInvestorDomain("Nexus", [hit("https://nexusvp.com/", "Nexus Home")])).toBeNull();
  });

  test("regressions from the live run: the good resolutions keep passing", () => {
    const cases: Array<[string, ReturnType<typeof hit>, string]> = [
      [
        "Altos Ventures",
        hit("https://altos.vc/", "Altos Ventures", "Altos Ventures is a venture capital firm investing in early-stage companies."),
        "altos.vc",
      ],
      ["Freestyle", hit("https://freestyle.vc/", "Freestyle - Seed Stage VC"), "freestyle.vc"],
      [
        "Nexus",
        hit("https://nexusvp.com/", "Nexus Venture Partners", "Nexus Venture Partners is a venture capital firm in India and the US."),
        "nexusvp.com",
      ],
      ["Offline Ventures", hit("https://offline.vc/", "Offline Ventures"), "offline.vc"],
      ["Smash Capital", hit("https://www.smashcap.com/", "Smash Capital"), "smashcap.com"],
      [
        "Y Combinator",
        hit("https://www.ycombinator.com/", "Y Combinator", "Y Combinator created a new model for funding early stage startups."),
        "ycombinator.com",
      ],
      [
        "ALL STAR SAAS FUND",
        hit("https://allstarsaas.com/", "All Star SaaS Fund | Pre-seed and seed investing in SaaS"),
        "allstarsaas.com",
      ],
      ["Blue Heron Ventures", hit("https://www.blueheronventures.com/", "Blue Heron Ventures"), "blueheronventures.com"],
      ["Delight Ventures", hit("https://www.delight-ventures.com/", "Delight Ventures | Early-stage VC"), "delight-ventures.com"],
      ["Happiness Capital", hit("https://www.happinesscapital.com/", "Happiness Capital"), "happinesscapital.com"],
      ["BAM Ventures", hit("https://bam.vc/", "BAM Ventures"), "bam.vc"],
      ["BFG Partners", hit("https://www.bfgpartners.com/", "BFG Partners | Growth equity for consumer brands"), "bfgpartners.com"],
      [
        "Founder Collective",
        hit("https://www.foundercollective.com/", "Founder Collective | Seed-stage venture capital fund"),
        "foundercollective.com",
      ],
      ["Thrive Capital", hit("https://thrivecap.com/", "Thrive Capital"), "thrivecap.com"],
      ["CDP Venture Capital", hit("https://www.cdpventurecapital.it/", "CDP Venture Capital SGR"), "cdpventurecapital.it"],
    ];
    for (const [name, result, domain] of cases) expect([name, pickInvestorDomain(name, [result])?.domain]).toEqual([name, domain]);
  });

  test("a label that is only the brand left once the type word came off needs the whole name in the result (review: Founders Fund)", () => {
    // The review's namesake: "founders" is Founders Fund minus "Fund", and a founders' community owns it.
    expect(pickInvestorDomain("Founders Fund", [hit("https://founders.org/", "Founders | Community for startup founders")])).toBeNull();
    // Generic words alone ("founders", "startups", "portfolio", "backs") no longer read as an investor.
    expect(
      pickInvestorDomain("Founders", [
        hit("https://founders.org/", "Founders", "A community that backs startup founders; see our portfolio."),
      ]),
    ).toBeNull();
    expect(
      pickInvestorDomain("Founders Fund", [
        hit("https://founders.org/", "Founders | Community for startup founders"),
        hit("https://foundersfund.com/", "Founders Fund", "Founders Fund is a San Francisco based venture capital firm."),
      ])?.domain,
    ).toBe("foundersfund.com");
    // The brand-only label passes when the result says the rest of the name.
    expect(pickInvestorDomain("Offline Ventures", [hit("https://offline.vc/", "Offline Ventures")])?.domain).toBe("offline.vc");
    expect(pickInvestorDomain("Offline Ventures", [hit("https://offline.vc/", "Offline | Early-stage VC")])).toBeNull();
  });

  test("a short form in parentheses makes a person-shaped name a firm; a person's company stays an affiliation (review: a16z)", () => {
    expect(investorSearchTarget("Andreessen Horowitz (a16z)")).toEqual({ firm: "Andreessen Horowitz", person: false, individual: false });
    expect(
      pickInvestorDomain("Andreessen Horowitz (a16z)", [hit("https://a16z.com/", "Andreessen Horowitz", "a16z is a venture capital firm.")])
        ?.domain,
    ).toBe("a16z.com");
    expect(investorSearchTarget("Alexandre Prot (Qonto)")).toBeNull();
  });

  test("a parked or for-sale domain is refused even when it spells the name", () => {
    expect(pickInvestorDomain("Acme Ventures", [hit("https://acmeventures.com/", "acmeventures.com is for sale")])).toBeNull();
  });

  test("the first passing result in search order wins", () => {
    const pick = pickInvestorDomain("Spark Capital", [
      hit("https://www.sparkcapital.com/", "Spark Capital"),
      hit("https://sparkcap.com/", "Spark Capital"),
    ]);
    expect(pick).toMatchObject({ domain: "sparkcapital.com", url: "https://www.sparkcapital.com/" });
    expect(pick?.reason).toContain("sparkcapital.com");
  });
});

describe("investorSearchTarget", () => {
  test("a firm is searched by its name without the descriptor; placeholders and roles are not searched", () => {
    expect(investorSearchTarget("M12 – Microsoft's Venture Fund")).toEqual({ firm: "M12", person: false, individual: false });
    expect(investorSearchTarget("Kleiner Perkins")).toEqual({ firm: "Kleiner Perkins", person: true, individual: false });
    expect(investorSearchTarget("Julien Jean (JJCapinvest)")).toEqual({ firm: "JJCapinvest", person: false, individual: false });
    // Investing words and an acronym in parentheses make a firm of a person-shaped name.
    expect(investorSearchTarget("Gandel Invest")).toEqual({ firm: "Gandel Invest", person: false, individual: false });
    expect(investorSearchTarget("German Aerospace Center (DLR)")).toEqual({
      firm: "German Aerospace Center",
      person: false,
      individual: false,
    });
    expect(investorSearchTarget("undisclosed investors")).toBeNull();
    expect(investorSearchTarget("Stripe co-founder John Collison")).toBeNull();
    expect(investorSearchTarget("  ")).toBeNull();
  });

  test("the query steers toward the firm's own site", () => {
    expect(investorQuery({ firm: "Lux Capital", person: false, individual: false })).toBe("Lux Capital investor official website");
  });
});

describe("cost", () => {
  test("one ten-result search is the minimum search charge; a homepage verdict is a page plus JSON; a run is capped", () => {
    expect(investorDomainCredits(1)).toBe(2);
    expect(investorDomainCredits(INVESTOR_DOMAINS_PER_RUN)).toBe(120);
    expect(investorHomepageCredits(1)).toBe(5);
  });

  test("a pass's cap is proportional to its scope: one ingested round resolves at most 20, never above 60", () => {
    expect(investorDomainCap(0)).toBe(0);
    expect(investorDomainCap(1)).toBe(20);
    expect(investorDomainCap(2)).toBe(40);
    expect(investorDomainCap(40)).toBe(INVESTOR_DOMAINS_PER_RUN);
  });
});

describe("investorCandidates", () => {
  test("every host whose label spells the name, in search order, snippet or not; directories only as hints", () => {
    const got = investorCandidates("Bloomberg Beta", [
      hit("https://www.bloomberg.com/company/values/tech-at-bloomberg/bloomberg-beta/", "Bloomberg Beta | Bloomberg LP"),
      hit("https://www.linkedin.com/company/bloombergbeta", "Bloomberg Beta - LinkedIn"),
      hit("https://www.bloombergbeta.com/", "Bloomberg Beta"),
    ]);
    // The snippet alone never passed ("Bloomberg Beta" says nothing of investing); the homepage decides.
    expect(got).toEqual([
      {
        domain: "bloombergbeta.com",
        homepage: "https://www.bloombergbeta.com",
        origin: "search",
        spelled: "name",
        snippet: null,
        armPage: true,
      },
    ]);
    const hinted = investorCandidates("Kensho VC", [
      hit(
        "https://startupintros.com/orgs/kensho-vc",
        "Kensho VC: Funding, Team & Investors",
        "Website: kensho.vc. Munich-based deep-tech fund.",
      ),
    ]);
    expect(hinted.map((c) => [c.domain, c.origin])).toEqual([["kensho.vc", "hint"]]);
  });

  test("a label with its connective spells a name like M&G; an investing TLD counts only when it writes the exact name", () => {
    expect(investorCandidates("M&G Investments", [hit("https://www.mandg.com/investments/", "M&G Investments")])[0]?.domain).toBe(
      "mandg.com",
    );
    expect(investorCandidates("Kensho VC", [hit("https://www.kensho.vc/", "Kensho Ventures")])[0]?.spelled).toBe("name");
    // "offline.vc" does not write "Offline Ventures": the label is only the brand.
    expect(pickInvestorDomain("Offline Ventures", [hit("https://offline.vc/", "Offline | Early-stage VC")])).toBeNull();
  });

  test("the second query quotes the name as an investor", () => {
    const target = investorSearchTarget("BREEGA");
    expect(target && investorQueries(target)).toEqual(["BREEGA investor official website", '"BREEGA" venture capital']);
  });
});

describe("anchorCandidates", () => {
  const release = [
    "Acme raised $20M led by [Acme Ventures](https://www.acmevc.com/) and [Beta Capital](https://betafirm.io/about).",
    "The round follows [Acme's seed](https://news.example/acme-seed) and a post on [LinkedIn](https://www.linkedin.com/company/acme-ventures).",
    "Acme Ventures portfolio company [Acme Robotics](https://acmerobotics.com/) also joined.",
    "[Read more about Acme Ventures](https://www.acmevc.com/news/2026/09/acme-raise).",
  ].join("\n");

  test("a link whose text is the firm's name, to a site's front page or one level down", () => {
    expect(anchorCandidates("Beta Capital", release, "https://news.example/acme").map((c) => [c.domain, c.spelled])).toEqual([
      ["betafirm.io", "anchor"],
    ]);
    expect(anchorCandidates("Acme Ventures", release, "https://news.example/acme").map((c) => c.domain)).toEqual(["acmevc.com"]);
  });

  test("never the publisher, a social page, a portfolio company the text names, or a deep article", () => {
    const got = anchorCandidates("Acme Ventures", release, "https://news.example/acme").map((c) => c.domain);
    expect(got).not.toContain("news.example");
    expect(got).not.toContain("linkedin.com");
    expect(got).not.toContain("acmerobotics.com");
  });
});

const vc = (
  domain: string,
  spelled: InvestorCandidate["spelled"] = "name",
  origin: InvestorCandidate["origin"] = "search",
): InvestorCandidate => ({
  domain,
  homepage: `https://${domain}`,
  origin,
  spelled,
  snippet: null,
});

function page(
  siteName: string,
  extra: Partial<NonNullable<InvestorHomepage["site"]>> = {},
  meta: Partial<InvestorHomepage> = {},
): InvestorHomepage {
  return {
    status: 200,
    title: siteName,
    site: {
      site_name: siteName,
      kind: "venture capital firm",
      identity_reason: `${siteName}'s own site.`,
      is_named_investor: true,
      is_parent_of_named_investor: false,
      business_is_investing: true,
      description: "",
      headquarters: "",
      ...extra,
    },
    ...meta,
  };
}

describe("judgeInvestorHomepage", () => {
  test("the firm's own site verifies, with what it says about itself", () => {
    const v = judgeInvestorHomepage(
      "Bloomberg Beta",
      vc("bloombergbeta.com"),
      page("Bloomberg Beta", { description: "We invest at early stages.", headquarters: "San Francisco, USA" }),
    );
    expect(v).toMatchObject({
      ok: true,
      domain: "bloombergbeta.com",
      type: "venture_capital",
      investing: true,
      headquarters: "San Francisco, USA",
    });
  });

  test("a person's own site, a startup, and a directory are refused whatever the name", () => {
    expect(
      judgeInvestorHomepage("Reid Hoffman", vc("reidhoffman.org"), page("Reid Hoffman", { kind: "personal website of an individual" })),
    ).toMatchObject({
      ok: false,
      unreadable: false,
    });
    expect(
      judgeInvestorHomepage(
        "Acme Ventures",
        vc("acmeventures.io"),
        page("Acme Ventures Robotics", { kind: "startup or other company", is_named_investor: false }),
      ),
    ).toMatchObject({ ok: false });
    expect(judgeInvestorHomepage("Acme Ventures", vc("acmevc.com"), page("Acme Ventures", { is_named_investor: false }))).toMatchObject({
      ok: false,
    });
  });

  test("a rebrand's redirect is refused: Sequoia India's old host landing on Peak XV is not Sequoia India's site", () => {
    const v = judgeInvestorHomepage(
      "Sequoia India",
      vc("sequoiaindia.com"),
      page("Peak XV Partners", {}, { finalUrl: "https://www.peakxv.com/" }),
    );
    expect(v).toMatchObject({ ok: false, reason: "redirects to peakxv.com" });
    // A redirect to another host that also spells the name moves the domain there.
    expect(
      judgeInvestorHomepage("Acme Ventures", vc("acmevc.com"), page("Acme Ventures", {}, { finalUrl: "https://acme.ventures/" })),
    ).toMatchObject({
      ok: true,
      domain: "acme.ventures",
    });
  });

  test("namesakes that share the brand: the site must write the name's own type word", () => {
    // Picus Capital is a real investor, but the record names Picus Ventures.
    expect(judgeInvestorHomepage("Picus Ventures", vc("picuscap.com", "suffix"), page("PICUS CAPITAL"))).toMatchObject({ ok: false });
    // Alliance VC on a bare "alliance" host must write the whole name.
    expect(
      judgeInvestorHomepage(
        "Alliance VC",
        vc("alliance.com"),
        page("Alliance Logistics", { kind: "corporation", business_is_investing: false }),
      ),
    ).toMatchObject({
      ok: false,
    });
    expect(
      judgeInvestorHomepage("Founders Fund", vc("founders.org"), page("Founders", { kind: "angel network or syndicate" })),
    ).toMatchObject({ ok: false });
    // Both words written apart name another firm that shares them.
    expect(
      judgeInvestorHomepage(
        "Ithaka Partners",
        vc("ithaka.com"),
        page("Ithaka Infrastructure Partners", { kind: "private equity or growth investor" }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      judgeInvestorHomepage(
        "Ithaka Partners LLC",
        vc("ithaka.com"),
        page("Ithaka Partners LLC", {}, { title: "Ithaka Infrastructure Partners" }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      judgeInvestorHomepage("Nuri Capital", vc("nuri.vc"), page("Nuri Ventures", {}, { title: "Nuri Venture Partners" })),
    ).toMatchObject({ ok: false });
    expect(
      judgeInvestorHomepage("Perennial", vc("perennial.net.au"), page("Perennial", {}, { title: "Perennial Partners" })),
    ).toMatchObject({
      ok: false,
    });
    // An investor's own .vc host, or a firm that calls itself by the brand alone, is the firm.
    expect(judgeInvestorHomepage("Liquid2 Ventures", vc("liquid2.vc"), page("Liquid 2"))).toMatchObject({ ok: true });
    expect(judgeInvestorHomepage("TPG Capital", vc("tpg.com"), page("TPG", { kind: "private equity or growth investor" }))).toMatchObject({
      ok: true,
    });
    expect(
      judgeInvestorHomepage(
        "Alliance VC",
        vc("alliance.vc"),
        page("Alliance Logistics", { kind: "corporation", is_named_investor: false, business_is_investing: false }),
      ),
    ).toMatchObject({ ok: false });
  });

  test("a one-word name on a suffixed host needs the round itself to write the suffixed name", () => {
    const huma = page("Huma Capital", { headquarters: "São Paulo, Brazil" });
    expect(
      judgeInvestorHomepage("Huma", vc("humacapital.com.br", "suffix"), huma, "led by SPRIND and Huma, with private investors"),
    ).toMatchObject({ ok: false });
    expect(judgeInvestorHomepage("Huma", vc("humacapital.com.br", "suffix"), huma, "led by Huma Capital")).toMatchObject({ ok: true });
  });

  test("the page's own name must name the firm, even when the verdict says yes", () => {
    expect(judgeInvestorHomepage("Beta Capital", vc("betafirm.io", "anchor", "source"), page("Gamma Holdings"))).toMatchObject({
      ok: false,
    });
    expect(judgeInvestorHomepage("Beta Capital", vc("betafirm.io", "anchor", "source"), page("Beta Capital"))).toMatchObject({
      ok: true,
    });
  });

  test("an operating company passes only on a host that spells its name; a fund manager called a corporation is an investment firm", () => {
    expect(
      judgeInvestorHomepage("Nestle", vc("nestle.com"), page("Nestlé", { kind: "corporation", business_is_investing: false })),
    ).toMatchObject({
      ok: true,
      type: "corporate",
      investing: false,
    });
    expect(
      judgeInvestorHomepage(
        "Beta Capital",
        vc("betafirm.io", "anchor", "source"),
        page("Beta Capital", { kind: "corporation", business_is_investing: false }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      judgeInvestorHomepage("BlackRock", vc("blackrock.com"), page("BlackRock", { kind: "corporation", business_is_investing: true })),
    ).toMatchObject({
      ok: true,
      type: "asset_manager",
      investing: true,
    });
  });

  test("a company's own venture arm takes its parent's site; a namesake that only shares the word does not", () => {
    const coinbase = page("Coinbase", {
      kind: "corporation",
      is_named_investor: false,
      is_parent_of_named_investor: true,
      business_is_investing: false,
    });
    expect(judgeInvestorHomepage("Coinbase Ventures", vc("coinbase.com"), coinbase)).toMatchObject({
      ok: true,
      type: "corporate_venture",
      domain: "coinbase.com",
    });
    const unsure = page("Coinbase", { kind: "corporation", is_named_investor: false, business_is_investing: false });
    expect(judgeInvestorHomepage("Coinbase Ventures", vc("coinbase.com"), unsure)).toMatchObject({ ok: false });
    expect(judgeInvestorHomepage("Coinbase Ventures", { ...vc("coinbase.com"), armPage: true }, unsure)).toMatchObject({
      ok: true,
      type: "corporate_venture",
    });
    expect(
      judgeInvestorHomepage(
        "Nuri Capital",
        { ...vc("nuri.vc"), armPage: true },
        page("Nuri Ventures", { kind: "corporation", is_named_investor: false }, { title: "Nuri Venture Partners" }),
      ),
    ).toMatchObject({ ok: false });
    const [amd] = investorCandidates("AMD Ventures", [
      hit("https://www.amd.com/en/corporate/amd-ventures.html", "AMD Ventures", "AMD Ventures invests in startups"),
      hit("https://www.amd.com/", "AMD | together we advance"),
    ]);
    expect(amd).toMatchObject({ domain: "amd.com", armPage: true });
    // Alliance Ventures is not the Alliance a logistics company's site belongs to.
    const alliance = page("Alliance", {
      kind: "corporation",
      is_named_investor: false,
      is_parent_of_named_investor: false,
      business_is_investing: false,
    });
    expect(judgeInvestorHomepage("Alliance Ventures", vc("alliance.com"), alliance)).toMatchObject({ ok: false });
    // The arm's name must be the brand plus venture words only, on a host that spells the brand.
    expect(judgeInvestorHomepage("Coinbase Asia Ventures", vc("coinbase.com"), coinbase)).toMatchObject({ ok: false });
  });

  test("a page that could not be judged is unknown, not refused; a parked one is refused", () => {
    expect(judgeInvestorHomepage("Acme Ventures", vc("acmevc.com"), { status: 503, site: null })).toMatchObject({
      ok: false,
      unreadable: true,
    });
    expect(judgeInvestorHomepage("Acme Ventures", vc("acmevc.com"), { status: 200, site: null })).toMatchObject({
      ok: false,
      unreadable: true,
    });
    expect(
      judgeInvestorHomepage("BC Growth Equity", vc("bcgrowthequity.com"), page("bcgrowthequity.com", { kind: "parked or unavailable" })),
    ).toMatchObject({
      ok: false,
      unreadable: false,
    });
  });

  test("a stored domain is re-judged as its label spells the name", () => {
    expect(storedCandidate("Lightspeed", "lsvp.com")).toMatchObject({ spelled: "short", origin: "stored" });
    expect(storedCandidate("Sequoia India", "peakxv.com")).toMatchObject({ spelled: "anchor" });
  });
});

describe("people", () => {
  test("a given name, an honorific, or a couple reads as a person; a firm named like one does not", () => {
    for (const name of ["Jeff Hammerbacher", "Dr Michael Boyer", "Terri and John Penshorn", "Jane Q. Doe", "Matthieu du Rausas"])
      expect(isLikelyPerson(name), name).toBe(true);
    for (const name of ["Kleiner Perkins", "Baillie Gifford", "Sequoia Capital", "Andreessen Horowitz", "Lerer Hippeau", "Y Combinator"])
      expect(isLikelyPerson(name), name).toBe(false);
    expect(investorSearchTarget("Jeff Hammerbacher")).toEqual({ firm: "Jeff Hammerbacher", person: true, individual: true });
  });

  test("recorded as a person only when the search reads as one, and never when it names a company", () => {
    expect(
      readsAsPerson("Jeff Hammerbacher", [
        hit("https://www.linkedin.com/in/hammerbacher", "Jeff Hammerbacher - Founder - Related Sciences | LinkedIn"),
      ]),
    ).toBe(true);
    // Eli Lilly has a given name first and is a company.
    expect(
      readsAsPerson("Eli Lilly", [
        hit("https://www.lilly.com/", "Eli Lilly and Company", "Lilly unites caring with discovery"),
        hit("https://en.wikipedia.org/wiki/Eli_Lilly", "Eli Lilly - Wikipedia", "Eli Lilly was an American pharmacist, his company"),
      ]),
    ).toBe(false);
    // No profile and no biography: the kind stays unknown rather than guessed.
    expect(readsAsPerson("Morgan Stanley", [hit("https://www.morganstanley.com/", "Morgan Stanley")])).toBe(false);
    expect(readsAsPerson("Kleiner Perkins", [hit("https://www.linkedin.com/in/kleiner", "Kleiner Perkins | LinkedIn")])).toBe(false);
  });
});
