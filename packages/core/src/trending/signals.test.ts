// The Trending rules on fixtures shaped like real X search results from the spike (2026-09-23).

import { describe, expect, test } from "vitest";
import {
  aboutRound,
  amountInCurrency,
  amountTokens,
  chooseHandle,
  classifyX,
  cleanSnippet,
  decay,
  displayNameFromTitle,
  frequentAccounts,
  fundingContext,
  handleMatchesName,
  handlesFromLinks,
  hnStoryMatches,
  identityHit,
  isOneWordName,
  isOutletAccount,
  labelRounds,
  nameAliases,
  parseXPost,
  parseXResult,
  type RoundSubject,
  type StalePost,
  type StaleSubject,
  snowflakeTime,
  staleCheck,
  staleReadings,
  trendingScore,
  trendingSummary,
  xQueries,
  xTbs,
} from "./signals.ts";

const SEARCHED = new Date("2026-09-23T20:40:00Z");
const firecrawl: RoundSubject = {
  name: "Firecrawl",
  aliases: [],
  handle: "firecrawl",
  amounts: ["$75M", "$75 million", "75M"],
  announced: "2026-09-22",
};

describe("snowflakeTime", () => {
  test("a status id is its own clock: the top bits are milliseconds since X's epoch", () => {
    // The X scrape reported this post as posted 2026-09-16T19:09:59Z.
    expect(snowflakeTime("2100301185949270219")?.toISOString()).toBe("2026-09-16T19:09:59.096Z");
    expect(snowflakeTime("2102426246235775068")?.toISOString().slice(0, 10)).toBe("2026-09-22");
    expect(snowflakeTime("not-an-id")).toBeNull();
    expect(snowflakeTime("12")).toBeNull();
  });
});

describe("parseXResult", () => {
  test("a post URL gives the status id, the handle, the display name, and the status-id time", () => {
    const r = parseXResult(
      {
        url: "https://x.com/SiliconANGLE/status/2102532815824867513",
        title: 'SiliconANGLE on X: "Web scraping startup Firecrawl closes $75M ...',
        description: "22 hours ago · Web scraping startup Firecrawl closes $75M investment https://t.co/CH3f8x3abu.",
      },
      SEARCHED,
    );
    expect(r).toMatchObject({ kind: "post", statusId: "2102532815824867513", handle: "siliconangle", name: "SiliconANGLE" });
    expect(r?.postedAt?.toISOString().slice(0, 10)).toBe("2026-09-22");
    expect(r?.snippet).toBe("Web scraping startup Firecrawl closes $75M investment https://t.co/CH3f8x3abu.");
  });

  test("a photo suffix is still the post; twitter.com and mobile hosts are X; other hosts are not", () => {
    expect(parseXResult({ url: "https://x.com/rdominguezibar/status/2102676815743521161/photo/1" }, SEARCHED)?.statusId).toBe(
      "2102676815743521161",
    );
    expect(parseXResult({ url: "https://mobile.twitter.com/acme/status/2102676815743521161" }, SEARCHED)?.handle).toBe("acme");
    expect(parseXResult({ url: "https://techcrunch.com/2026/09/22/firecrawl" }, SEARCHED)).toBeNull();
  });

  test("a profile page counts as its account, dated from 'N hours ago' when the snippet says", () => {
    const r = parseXResult(
      {
        url: "https://x.com/ericciarla",
        title: "Eric Ciarla (hiring) (@ericciarla) / X",
        description: "3 hours ago · We raised a $75M Series B",
      },
      SEARCHED,
    );
    expect(r).toMatchObject({ kind: "profile", handle: "ericciarla", name: "Eric Ciarla (hiring)" });
    expect(r?.postedAt?.toISOString()).toBe("2026-09-23T17:40:00.000Z");
    expect(parseXResult({ url: "https://x.com/search?q=firecrawl" }, SEARCHED)).toBeNull();
  });

  test("display names come from every title shape search returns, never from a sentence fragment", () => {
    expect(displayNameFromTitle("Y Combinator (@ycombinator) on X")).toBe("Y Combinator");
    expect(displayNameFromTitle("Nexus on X")).toBe("Nexus");
    expect(displayNameFromTitle("Ruben - @rdominguezibar")).toBe("Ruben");
    expect(displayNameFromTitle("Firecrawl")).toBe("Firecrawl");
    expect(displayNameFromTitle("Firecrawl", 'Firecrawl on X: "Introducing Alexandria.')).toBe("Firecrawl");
    expect(displayNameFromTitle("housing, jobs, research, code, pricing, sits out ...")).toBeNull();
  });

  test("snippets drop the age, the repost chrome, and the 'Name on X:' lead", () => {
    expect(cleanSnippet(null, "1 day ago · @firecrawl · Firecrawl · @firecrawl · Now. Introducing Alexandria.")).toBe(
      "Introducing Alexandria.",
    );
    expect(cleanSnippet(null, "@creem_io · 15h. Building a product went from months to a weekend")).toBe(
      "Building a product went from months to a weekend",
    );
    expect(cleanSnippet(null, 'Firecrawl on X: "Introducing Alexandria. We raised a $75M Series B')).toBe(
      "Introducing Alexandria. We raised a $75M Series B",
    );
    expect(cleanSnippet('Acme on X: "We raised $5M"', "")).toBe("We raised $5M");
    // A description that is an X scrape's markdown.
    expect(cleanSnippet(null, "# Post by @oneabhishek ## Post Proud to double down in this round")).toBe(
      "Proud to double down in this round",
    );
    expect(cleanSnippet(null, "# Firecrawl (@firecrawl) 🔥 ## Latest Posts ### 2. Post We raised a $75M Series B")).toBe(
      "We raised a $75M Series B",
    );
    expect(cleanSnippet(null, "x".repeat(400)).length).toBe(280);
  });
});

describe("the relevance rule", () => {
  const post = (url: string, title: string, description: string) => parseXResult({ url, title, description }, SEARCHED);

  test("the name as a whole word, a funding word or the amount, and a status-id time inside the window", () => {
    const hit = post(
      "https://x.com/nexusvp/status/2102442824801399082",
      "Nexus on X",
      "Congratulations to Firecrawl on their $75M Series B",
    );
    expect(hit && classifyX(hit, firecrawl)).toMatchObject({ nameHit: true, amountHit: true, fund: true, inWindow: true, relevant: true });
    // The company's handle stands in for the name.
    const byHandle = post("https://x.com/mariabrw/status/2102445605528162425", "Maria Palma on X", "Congrats to @firecrawl on the raise");
    expect(byHandle && classifyX(byHandle, firecrawl).relevant).toBe(true);
  });

  test("a post from before the window, a name inside another word, or no funding word is not relevant", () => {
    // 2026-09-16: six days before the announcement.
    const old = post("https://x.com/tradedvc/status/2100301185949270219", "Traded on X", "Firecrawl raised $75M");
    expect(old && classifyX(old, firecrawl)).toMatchObject({ inWindow: false, relevant: false });
    const ema: RoundSubject = { name: "Ema", aliases: [], handle: null, amounts: ["$77M"], announced: "2026-09-22" };
    const email = post("https://x.com/someone/status/2102442824801399082", "Someone on X", "Our email funding round update");
    expect(email && classifyX(email, ema).nameHit).toBe(false);
    const chatter = post("https://x.com/someone/status/2102442824801399082", "Someone on X", "Tinkering with Firecrawl this morning");
    expect(chatter && classifyX(chatter, firecrawl).relevant).toBe(false);
  });

  test("a common-word name needs the round where it is named, not a shared word (Millie, pre-launch audit)", () => {
    const millie: RoundSubject = {
      name: "Millie",
      aliases: [],
      handle: null,
      amounts: ["$12M", "$12 million", "12M"],
      announced: "2026-09-22",
      domain: null,
      leadInvestors: ["TMV", "Foreground"],
      description: "a maternity care clinic and virtual care provider",
    };
    const at = "https://x.com/someone/status/2102442824801399082";
    const judged = (title: string, description: string) => {
      const p = post(at, title, description);
      return p ? classifyX(p, millie).relevant : null;
    };
    // The post the audit found: a pet, a lymph node, and the word "raised".
    expect(
      judged(
        "Pixie on X",
        "#OTLFP My Bestie Millie's mum discovered a raised lymph node on Millie's neck and took her to the vet to get it checked out",
      ),
    ).toBe(false);
    expect(judged("Millie on X", "I'm Millie, raised a Padres fan, married an Angels fan, now unhinged about the Mariners.")).toBe(false);
    // The figure far from the name, or a namesake beside it.
    expect(
      judged(
        "True Parity on X",
        "Millie Bobby Brown skipped the Hollywood mansion for a chaotic Georgia farm ... $12M Bondi Beach penthouse",
      ),
    ).toBe(false);
    expect(
      judged(
        "BBG Ventures on X",
        "Congrats to @GetToplinePro for closing a $12M Series A to ... Built by moms & providers who've been there, Millie is the new standard in maternity care.",
      ),
    ).toBe(false);
    expect(judged("Millie Meeta on X", "Just in; @axisrobotics just closed a $12M seed round led by Hack VC")).toBe(false);
    // The round itself, named where the company is.
    expect(judged("SyS Creations on X", "Big news in maternity care! Millie just secured $12M in Series A")).toBe(true);
    expect(judged("TMV on X", "Proud to co-lead Millie's Series A with Foreground")).toBe(true);
  });

  test("fundingContext: the figure, a funding phrase, or a raise verb where the name is", () => {
    const acme: RoundSubject = { name: "Acme Robotics", aliases: ["Acme"], handle: "acmebots", amounts: ["$20M"], announced: "2026-09-22" };
    expect(fundingContext("Acme Robotics raises $20M to build arms", acme)).toBe(true);
    expect(fundingContext("Congrats to the Acme team on the Series B", acme)).toBe(true);
    expect(fundingContext("Congrats to @acmebots on the raise", acme)).toBe(true);
    expect(
      fundingContext("Acme Robotics hired a new CFO. Unrelated: another startup raised a Series B at a $2B valuation this week", acme),
    ).toBe(false);
    expect(fundingContext("Nothing about the company here", acme)).toBe(false);
    expect(
      fundingContext("Acme Robotics, a maker of warehouse arms that tend night shifts across the Midwest, has raised a Series A", acme),
    ).toBe(true);
    expect(fundingContext("Why we invested in Acme Robotics", acme)).toBe(true);
  });

  test("the company's own account is marked self", () => {
    const own = post(
      "https://x.com/firecrawl/status/2102426246235775068",
      "Firecrawl",
      "Introducing Alexandria. We raised a $75M Series B",
    );
    expect(own && classifyX(own, firecrawl)).toMatchObject({ self: true, relevant: true });
  });

  test("aliases drop a generic tail only when five letters or more remain", () => {
    expect(nameAliases("Snorkel AI")).toEqual(["Snorkel"]);
    expect(nameAliases("Heidi Health")).toEqual(["Heidi"]);
    expect(nameAliases("Comp AI")).toEqual([]);
    expect(nameAliases("Crusoe")).toEqual([]);
  });

  test("amounts read the way posts write them, the query token first", () => {
    expect(amountTokens({ asWritten: "$75 million", value: 75, currency: "USD", usdMillions: 75 })).toEqual(["$75M", "$75 million", "75M"]);
    expect(amountTokens({ asWritten: "$3.9 billion", value: 3900, currency: "USD", usdMillions: 3900 }).slice(0, 2)).toEqual([
      "$3.9B",
      "$3.9 billion",
    ]);
    expect(amountTokens({ asWritten: "€5 million", value: 5, currency: "EUR", usdMillions: 5.7 })).toEqual([
      "€5M",
      "€5 million",
      "5M",
      "$5.7M",
      "$5.7 million",
      "5.7M",
    ]);
    expect(amountTokens({ asWritten: null, value: null, currency: null, usdMillions: null })).toEqual([]);
  });

  test("the queries: name with funding words, name with the amount, handle when verified; tbs spans a day before to four after", () => {
    expect(xTbs("2026-09-22")).toBe("cdr:1,cd_min:9/21/2026,cd_max:9/25/2026");
    expect(xQueries(firecrawl).map((q) => q.q)).toEqual([
      'site:x.com "Firecrawl" (raises OR raised OR funding OR round)',
      'site:x.com "Firecrawl" "$75M"',
      'site:x.com "@firecrawl" (raises OR raised OR funding OR round)',
    ]);
    expect(xQueries({ ...firecrawl, handle: null, amounts: [] }).map((q) => q.key)).toEqual(["name_fund"]);
  });
});

describe("the outlet filter", () => {
  test("news desks and aggregators by handle or name; frequent accounts; a round's own investor never", () => {
    const none = new Set<string>();
    expect(isOutletAccount("siliconangle", "SiliconANGLE", none)).toBe(true);
    expect(isOutletAccount("reuterslegal", "Reuters Legal", none)).toBe(true);
    expect(isOutletAccount("tldrnewsletter", "TLDR Newsletter", none)).toBe(true);
    expect(isOutletAccount("tfnbreakingnews", "Tech Funding News", none)).toBe(true);
    expect(isOutletAccount("ericciarla", "Eric Ciarla (hiring)", none)).toBe(false);
    expect(isOutletAccount("dealbot", "Deal Bot", new Set(["dealbot"]))).toBe(true);
    // A venture firm's handle reads as an outlet, but not on a round it invested in.
    expect(isOutletAccount("radicalventures", "Radical Ventures", none)).toBe(true);
    expect(isOutletAccount("radicalventures", "Radical Ventures", none, ["Radical Ventures"])).toBe(false);
  });

  test("an account is an aggregator on 5 percent of recent rounds, and never fewer than three", () => {
    const seen = new Map([
      ["techmeme", 6],
      ["friend", 2],
      ["regular", 3],
    ]);
    expect(frequentAccounts(seen, 20)).toEqual(new Set(["techmeme", "regular"]));
    expect(frequentAccounts(seen, 100)).toEqual(new Set(["techmeme"]));
  });
});

describe("decay and the score", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);

  test("each item halves every 24 hours from its own time; the future weighs one", () => {
    expect(decay(ago(0), now)).toBe(1);
    expect(decay(ago(24), now)).toBeCloseTo(0.5);
    expect(decay(ago(48), now)).toBeCloseTo(0.25);
    expect(decay(new Date(now.getTime() + 3_600_000), now)).toBe(1);
  });

  test("ln(1 + people) + 0.75 ln(1 + outlets) + 0.5 ln(1 + HN points), each decayed", () => {
    const s = trendingScore({ people: [ago(0), ago(24)], outlets: [ago(0)], hn: [{ points: 4, at: ago(24) }] }, now);
    expect(s.x).toBeCloseTo(1.5);
    expect(s.press).toBeCloseTo(1);
    expect(s.hn).toBeCloseTo(2);
    expect(s.score).toBeCloseTo(Math.log1p(1.5) + 0.75 * Math.log1p(1) + 0.5 * Math.log1p(2));
    expect(trendingScore({ people: [], outlets: [], hn: [] }, now).score).toBe(0);
  });

  test("the same voices a day later score lower: the last 24 hours lead", () => {
    const fresh = trendingScore({ people: Array(10).fill(ago(2)), outlets: [], hn: [] }, now).score;
    const stale = trendingScore({ people: Array(10).fill(ago(30)), outlets: [], hn: [] }, now).score;
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("the stale check", () => {
  const at = (day: string) => ({ nameHit: true, amountHit: true, postedAt: new Date(`${day}T10:00:00Z`) });

  test("most amount-matching posts more than three days before the day on record: stale, with the reason", () => {
    const v = staleCheck([at("2026-08-24"), at("2026-08-24"), at("2026-08-25"), at("2026-09-23")], "2026-09-23");
    expect(v.stale).toBe(true);
    expect(v.reason).toContain("3 of 4 X posts");
    expect(v.reason).toContain("earliest 2026-08-24");
  });

  test("half or fewer, fewer than three posts, or posts without the amount: not stale", () => {
    expect(staleCheck([at("2026-08-24"), at("2026-09-23"), at("2026-09-23"), at("2026-08-24")], "2026-09-23").stale).toBe(false);
    expect(staleCheck([at("2026-08-24"), at("2026-08-24")], "2026-09-23").stale).toBe(false);
    const noAmount = [at("2026-08-24"), at("2026-08-24"), at("2026-08-24")].map((p) => ({ ...p, amountHit: false }));
    expect(staleCheck(noAmount, "2026-09-23").stale).toBe(false);
    // Two days early is the press running a day ahead of the release, not a stale date.
    expect(staleCheck([at("2026-09-21"), at("2026-09-21"), at("2026-09-21")], "2026-09-23").stale).toBe(false);
  });
});

// Shaped like the eight rounds the check flagged on 2026-09-23 (snippets as stored), five of them
// same-name noise and three real, plus Xpeng Robotics, whose flag found a round dated a month late.
describe("the stale check's reading of a post", () => {
  const post = (day: string, snippet: string, extra: Partial<StalePost> = {}): StalePost => ({
    nameHit: true,
    postedAt: new Date(`${day}T10:00:00Z`),
    handle: "someone",
    authorName: "Someone",
    snippet,
    ...extra,
  });
  const subject = (s: Partial<StaleSubject> & Pick<StaleSubject, "name" | "amount">): StaleSubject => ({
    handle: null,
    domain: null,
    leadInvestors: [],
    description: null,
    ...s,
  });
  const verdict = (posts: StalePost[], s: StaleSubject, announced: string) => staleCheck(staleReadings(posts, s), announced);

  test("the amount counts only as a whole figure in the round's own currency", () => {
    const usd4 = { value: 4, currency: "USD" };
    expect(amountInCurrency("raised $4M led by Slow Ventures", usd4)).toBe(true);
    expect(amountInCurrency("a $4 million seed", usd4)).toBe(true);
    expect(amountInCurrency("US$4m round", usd4)).toBe(true);
    for (const t of ["raised $14M", "raised $4.5M", "raised 4M", "a €4M fee", "$4Mbps"]) expect(amountInCurrency(t, usd4)).toBe(false);
    const eur6 = { value: 6, currency: "EUR" };
    expect(amountInCurrency("mika AI has closed a €6 million round", eur6)).toBe(true);
    expect(amountInCurrency("raised 6M euros", eur6)).toBe(true);
    // A converted figure is not the round's own.
    expect(amountInCurrency("raised $6.9 million", eur6)).toBe(false);
    expect(amountInCurrency("Nopan bags €7.2M", { value: 7.2, currency: "EUR" })).toBe(true);
    expect(amountInCurrency("raised $1.2B", { value: 1200, currency: "USD" })).toBe(true);
    expect(amountInCurrency("raised $1.2M", { value: 1200, currency: "USD" })).toBe(false);
    expect(amountInCurrency("$15M調達を発表した", { value: 15, currency: "USD" })).toBe(true);
    expect(amountInCurrency("raised $4M", { value: null, currency: "USD" })).toBe(false);
  });

  test("a one-word name needs a second sign; a longer name stands on its own", () => {
    for (const n of ["Mind", "snag", "Treble", "ReFresh", "Adaptive", "mika", "Vals AI", "Heidi Health"])
      expect(isOneWordName(n)).toBe(true);
    for (const n of ["Andromeda Surgical", "Xpeng Robotics", "Mind Robotics"]) expect(isOneWordName(n)).toBe(false);
    const vals = subject({
      name: "Vals",
      handle: "valsai",
      domain: "vals.ai",
      leadInvestors: ["Andreessen Horowitz"],
      amount: { value: 40, currency: "USD" },
    });
    // The handle squashed out of the brand, the handle itself, the lead's short name, a raise verb after the name.
    expect(
      identityHit(post("2026-08-13", "Today we're announcing our $40M Series A", { authorName: "Vals AI - Rayan Krishnan" }), vals),
    ).toBe(true);
    expect(identityHit(post("2026-08-13", "Congrats @valsai on the round"), vals)).toBe(true);
    expect(identityHit(post("2026-08-13", "led by @a16z with 8VC"), vals)).toBe(true);
    const adaptive = subject({ name: "Adaptive", description: "Agentic construction accounting", amount: { value: 30, currency: "USD" } });
    expect(identityHit(post("2026-09-21", "Adaptive raised $30 million led by Tidemark"), adaptive)).toBe(true);
    expect(identityHit(post("2026-09-21", "an AI accounting platform for construction companies"), adaptive)).toBe(true);
    // A comma after the name, a sentence break, or no verb: no sign.
    expect(identityHit(post("2026-04-25", "Adaptive Analysis · @AdaptiveIO. Crypto by the Numbers 1/ $30M outflows"), adaptive)).toBe(
      false,
    );
    expect(identityHit(post("2026-06-10", "$30M in tax credits to this adaptive reuse & conversion"), adaptive)).toBe(false);
  });

  test("same-name noise does not flag a round: football for Treble and mika, words for MIND, snag, ReFresh, Adaptive", () => {
    const treble = subject({
      name: "Treble",
      domain: "treble.tech",
      leadInvestors: ["Paladin Capital Group", "Amazon"],
      description: "a sound simulation and synthetic acoustic data company",
      amount: { value: 15, currency: "EUR" },
    });
    const football = [
      post("2023-07-03", "#ManCity want to sign Atletico Madrid winger Rodrigo Riquelme (23), offering €15M. ... Have we just won treble"),
      post("2025-09-28", "€15M for a treble-winning, versatile defender still in his prime? Inter are getting a bargain for Akanji"),
      post("2026-06-30", "We bought Akanji for €15M, won the treble and completed prem 4x in a row, then sold him out for same €15M."),
      post("2026-08-25", "... €15M (£8.6M–£13M). Breaking news, transfers & analysis on the Treble winners."),
    ];
    const real = post("2026-09-17", "Treble raises €15 million to bring sound and voice to physical AI, led by Paladin Capital Group");
    expect(verdict([...football, real], treble, "2026-09-17").stale).toBe(false);

    const mika = subject({
      name: "mika",
      domain: "getmika.de",
      leadInvestors: ["Smedvig Ventures"],
      description: "AI-powered tax advisory platform",
      amount: { value: 6, currency: "EUR" },
    });
    const transfers = [
      post("2025-01-19", "Mika Biereth (21,CF) - From Sturm Graz ... Mathias Løvik (21,LB) - From Molde FK to Parma for €6M."),
      post("2025-02-05", "... Mika Biereth, €13M to Monaco Juma Bah, €6M to Manchester City Finn Jeltsch"),
      post("2026-08-27", "... Mika Godts — €45M Lucas Digne — €7M ... €6M Kaan Kairinen — €4M"),
    ];
    const tfn = post("2026-09-23", "mika AI has closed a €6 million round, led by @smedvigventures.");
    expect(verdict([...transfers, tfn], mika, "2026-09-23").stale).toBe(false);

    const mind = subject({
      name: "MIND",
      domain: "mind.io",
      leadInvestors: ["Crosspoint Capital Partners"],
      description: "an AI-native data loss prevention (DLP) platform",
      amount: { value: 72, currency: "USD" },
    });
    const words = [
      post(
        "2025-10-13",
        "... $72M deal, but IU also committed $11M / year to his assistants. There's no doubt in my mind programs will throw big $$$",
      ),
      post("2026-02-10", "... $72M ebitda. The deal consolidates Refresco as a ... mind: - The Campbell's Company's $286M"),
      post("2026-08-18", "Keep in mind that $212M was just Rhode's 2025 revenue. They actually did $390M in 2026. $72M in profit."),
    ];
    const ynet = post(
      "2026-09-18",
      "Israeli cybersecurity startup MIND raises $72 million as AI fuels data-security drive Crosspoint Capital led the Series B",
    );
    expect(verdict([...words, ynet], mind, "2026-09-17").stale).toBe(false);

    const snag = subject({
      name: "snag",
      domain: "snagsublets.com",
      leadInvestors: ["Slow Ventures"],
      description: "a housing marketplace that connects renters with verified sublets and lease takeovers",
      amount: { value: 4, currency: "USD" },
    });
    const verbs = [
      post(
        "2023-08-29",
        "... $4M market cap. Could this be the next 200x like $RLB? Oh, and if you use my referral link, you'll snag a ...",
      ),
      post("2026-05-19", "Hold up we clowning fighters for almost doing a $4M ... Snag · @Snvggur · 19 May. These ..."),
      post("2026-06-13", "The @OHLBattalion snag Spencer Greenhalgh in the sixth round! $4M"),
    ];
    expect(verdict(verbs, snag, "2026-09-22").stale).toBe(false);

    const refresh = subject({
      name: "ReFresh",
      leadInvestors: ["Black Nova Venture Capital"],
      description: "a workplace psychosocial operating platform",
      amount: { value: 2.5, currency: "USD" },
    });
    const miami = [
      post(
        "2026-01-14",
        "Refresh Miami (@refreshmiami). 144 views. Miami PropTech @Titl raises $2.5M to automate property title verification",
      ),
      post(
        "2026-04-28",
        "#MiamiTech #AI #HealthTech Details on Refresh Miami. Miami Startup Raises $2.5M For AI Life Coach That Takes Action",
      ),
      post("2026-05-10", "Miami-based Dishio just raised $2.5M to fix the part most tech skips ... Refresh Miami · @refreshmiami."),
    ];
    const daily = post("2026-09-17", "ReFresh grabs $2.5m to make psychosocial safety more than limp surveys.");
    expect(verdict([...miami, daily], refresh, "2026-09-17").stale).toBe(false);

    const adaptive = subject({
      name: "Adaptive",
      handle: "adaptivebuilds",
      domain: "adaptive.build",
      leadInvestors: ["Tidemark"],
      description: "Agentic construction accounting",
      amount: { value: 30, currency: "USD" },
    });
    const others = [
      post("2023-04-25", "Adaptive Analysis · @AdaptiveIO. Crypto by the Numbers 1/ $30M ➡️ Digital asset investment outflows last week"),
      post("2026-01-15", "... $30M in just a few months during 2025. ➤ Robust & Adaptive: The model is robust to ..."),
      post(
        "2026-05-08",
        "Daily Hard Tech Headlines: - @Firestorm_Labs secured a $30M ... Adaptive Strike competition in collaboration with BEI Corp.",
      ),
    ];
    expect(verdict(others, adaptive, "2026-09-17").stale).toBe(false);
  });

  test("the real conversation about an earlier announcement still flags: Xpeng Robotics, Andromeda Surgical, Vals, Nopan", () => {
    const xpeng = subject({ name: "Xpeng Robotics", amount: { value: 900, currency: "USD" } });
    const august = [
      post("2026-08-24", "Xpeng Robotics raises over $900 million in its first funding round, valuing the unit at $6.3 billion"),
      post("2026-08-24", "BREAKING: Xpeng Robotics closes US$900M Series A"),
      post("2026-08-25", "Xpeng Robotics' $900M round is the largest humanoid raise in China this year"),
    ];
    const late = post("2026-09-23", "Jumbo Series A rounds keep getting bigger: Xpeng Robotics $900M");
    const v = verdict([...august, late], xpeng, "2026-09-22");
    expect(v.stale).toBe(true);
    expect(v.reason).toContain("3 of 4 X posts");
    expect(v.reason).toContain("earliest 2026-08-24");

    const andromeda = subject({ name: "Andromeda Surgical", amount: { value: 15, currency: "USD" } });
    const yc = [
      post("2026-08-04", "AIとロボットを活用した自律型・補助型手術プラットフォームを開発しているAndromeda Surgicalが$15M調達を発表した。"),
      post(
        "2026-08-10",
        "Andromeda Surgical recently announced their $15M Series A led by @Standard_Cap, bringing their total funding to $30M",
      ),
      post("2026-08-10", "Aug 10. Andromeda Surgical recently announced their $15M Series A led by @Standard_Cap"),
    ];
    expect(verdict(yc, andromeda, "2026-09-16").stale).toBe(true);

    const vals = subject({
      name: "Vals",
      handle: "valsai",
      domain: "vals.ai",
      leadInvestors: ["Andreessen Horowitz"],
      amount: { value: 40, currency: "USD" },
    });
    const valsPosts = [
      post("2026-08-13", "Today we're announcing our $40M Series A at a $400M valuation, led by @a16z", {
        authorName: "Vals AI - Rayan Krishnan",
      }),
      post("2026-08-13", "Vals AI just raised a $40M Series A at a $400M valuation. Here's what you need to know."),
      post(
        "2026-08-15",
        "SF-based Vals, which develops evaluations and benchmarks to test AI models on real-world tasks, raised a $40M Series A led by a16z",
      ),
      post(
        "2026-09-23",
        "A San Francisco startup built to decide whether that's actually true raised $40 million last month. The company is Vals AI",
      ),
    ];
    expect(verdict(valsPosts, vals, "2026-09-22").stale).toBe(true);

    // A coined one-word name with no description and one lead still counts through its headlines.
    const nopan = subject({ name: "Nopan", leadInvestors: ["Newion"], amount: { value: 7.2, currency: "EUR" } });
    const july = [
      post("2026-07-14", "Nopan bags €7.2M: The ex-Netflix duo on a mission to close the reliability gap in Europe's bank and..."),
      post("2026-07-14", "-> Nopan has raised €7.2M to build the performance platform for account & wallet payments."),
      post("2026-07-15", "Nopan Raises €7.2M in Funding #DigitalPayments #PaymentPerformance #OpenBanking"),
    ];
    expect(verdict(july, nopan, "2026-09-23").stale).toBe(true);
  });
});

describe("the label rule", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const row = (id: string, score: number, over: Partial<Parameters<typeof labelRounds>[0][number]> = {}) => ({
    roundId: id,
    score,
    stale: false,
    firstSeenAt: new Date("2026-09-23T00:00:00Z"),
    people: 12,
    outlets: 4,
    ...over,
  });

  test("top five, not stale, under 72 hours, 10+ people, 3+ outlets", () => {
    const { rank, labelled } = labelRounds(
      [
        row("a", 9),
        row("b", 8, { people: 9 }),
        row("c", 7, { outlets: 2 }),
        row("d", 6, { firstSeenAt: new Date("2026-09-20T11:00:00Z") }),
        row("e", 5, { stale: true }),
        row("f", 4),
        row("g", 3),
        row("h", 2),
      ],
      now,
    );
    expect([...labelled].sort()).toEqual(["a", "f"]);
    // The stale round has no rank, so "g" is fifth by score and labelled only if it clears the bar: it does not make the top five.
    expect(rank.get("e")).toBeUndefined();
    expect(rank.get("f")).toBe(5);
    expect(rank.get("g")).toBe(6);
    expect(labelled.has("g")).toBe(false);
  });

  test("a zero score earns no rank", () => {
    expect(labelRounds([row("a", 0)], now).rank.size).toBe(0);
  });

  test("the summary counts accounts and outlets, never likes", () => {
    expect(trendingSummary({ people: 14, outlets: 6, hnPoints: 3 })).toBe("14 people on X · 6 outlets · HN 3 pts");
    expect(trendingSummary({ people: 1, outlets: 0, hnPoints: 1 })).toBe("1 person on X · HN 1 pt");
  });
});

describe("the company's handle", () => {
  test("a handle spells the name, bare or wrapped in a common prefix or suffix", () => {
    expect(handleMatchesName("firecrawl", "Firecrawl")).toBe(true);
    expect(handleMatchesName("tryheidi", "Heidi Health")).toBe(true);
    expect(handleMatchesName("arcee_ai", "Arcee AI")).toBe(true);
    expect(handleMatchesName("temporalio", "Temporal")).toBe(true);
    expect(handleMatchesName("UltravioletteEV", "Ultraviolette")).toBe(true);
    expect(handleMatchesName("fearnlegal", "Fearn")).toBe(false);
    expect(handleMatchesName("paulg", "Firecrawl")).toBe(false);
  });

  test("homepage links: status links are testimonials, share and intent links are not accounts", () => {
    expect(
      handlesFromLinks([
        "https://x.com/firecrawl",
        "https://twitter.com/Firecrawl/",
        "https://x.com/paulg/status/123",
        "https://twitter.com/intent/tweet?text=hi",
        "https://x.com/share?url=a",
        "https://example.com/firecrawl",
      ]),
    ).toEqual(["firecrawl"]);
  });

  test("a homepage testimonial fails both tests; the account named like the company is adopted from the results", () => {
    const results = [
      { handle: "paulg", name: "Paul Graham" },
      { handle: "fearn_ai", name: "Fearn" },
    ];
    expect(chooseHandle(["paulg"], "Fearn", results)).toEqual({ handle: "fearn_ai", source: "search" });
    // A homepage handle that does not spell the name still verifies when a result by it carries the name.
    expect(chooseHandle(["fearnlegal"], "Fearn", [{ handle: "fearnlegal", name: "Fearn" }])).toEqual({
      handle: "fearnlegal",
      source: "homepage",
    });
    expect(chooseHandle(["firecrawl"], "Firecrawl", [])).toEqual({ handle: "firecrawl", source: "homepage" });
    expect(chooseHandle([], "Ema", [{ handle: "emma", name: "Emma" }])).toBeNull();
  });
});

describe("Hacker News and the X post read", () => {
  test("a story counts when its title names the company and reads as funding news", () => {
    const s = { name: "Firecrawl", aliases: [] };
    expect(hnStoryMatches({ title: "Firecrawl raises $75M Series B", url: null }, s, "firecrawl.dev")).toBe(true);
    expect(hnStoryMatches({ title: "Show HN: a Firecrawl clone", url: null }, s, "firecrawl.dev")).toBe(false);
    expect(hnStoryMatches({ title: "Our Series B", url: "https://www.firecrawl.dev/blog/series-b" }, s, "firecrawl.dev")).toBe(true);
  });

  test("the X scrape's markdown gives likes, reposts, the time, and the post", () => {
    const md = [
      "# Post by @TradedVC",
      "",
      "Author: Traded: Venture Capital @TradedVC",
      "Posted: 2026\\-09\\-16T19:09:59\\.000Z",
      "Likes: 1,204 | Retweets: 38",
      "",
      "## Post",
      "",
      "Arcee AI raised $150 million in Series B funding.",
      "",
      "## Top Comments",
    ].join("\n");
    expect(parseXPost(md)).toEqual({
      author: "Traded: Venture Capital @TradedVC",
      postedAt: new Date("2026-09-16T19:09:59.000Z"),
      likes: 1204,
      reposts: 38,
      isRetweet: false,
      text: "Arcee AI raised $150 million in Series B funding.",
    });
    expect(parseXPost("## Post\n\nRT @acme: we raised").isRetweet).toBe(true);
    expect(parseXPost("## Post\n\nData sets &amp; providers").text).toBe("Data sets & providers");
  });

  test("a post's own words are about the round only when they name it and say funding; a quote post's comment is not", () => {
    expect(aboutRound("Introducing Alexandria. We raised a $75M Series B", firecrawl)).toBe(false);
    expect(aboutRound("Congrats @firecrawl on the $75M Series B", firecrawl)).toBe(true);
    expect(aboutRound("Firecrawl raised a new round", firecrawl)).toBe(true);
    expect(aboutRound("Its SI, not AI @realDonaldTrump", firecrawl)).toBe(false);
  });
});
