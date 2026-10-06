// The X announcements lane's rules without the network: a funding post read into a lead, the
// search for its article, the match against the article's record, the backoff, and the narrow rule
// under which a post lands on its own. The fixtures are search results as Firecrawl returned them on
// September 24, 2026.

import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { resolveRounds } from "../records/resolve.ts";
import { STAGE_BANDS } from "../records/routing.ts";
import {
  type AnnouncementLead,
  bioFromProfile,
  bioLinksCompany,
  CORROBORATION_SCHEDULE_HOURS,
  companyFromFounderBio,
  companyFromHandle,
  companyInText,
  confirmsLead,
  domainInText,
  leadArticleQuery,
  leadAsItem,
  leadMatches,
  looksLikeCompanyAccount,
  nextAttemptAt,
  pickCorroboration,
  readAnnouncement,
  selfPublishable,
  X_ANNOUNCEMENT_QUERIES,
  xOnlyRecord,
} from "./announcements.ts";
import { isAnnouncementOutlet, OUTLET_HANDLES } from "./outlets.ts";
import { parseXResult } from "./signals.ts";
import { searchAnnouncements, X_ANNOUNCEMENT_TBS } from "./x.ts";

const NOW = new Date("2026-09-24T20:30:00Z");

/** Seth Rosenberg's post quoting Carl Schoeller's launch of Parallax, an hour old. */
const PARALLAX = {
  url: "https://x.com/sethgrosenberg/status/2103195007822000000",
  title: "Seth Rosenberg on X",
  description:
    "1 hour ago · @CarlSchoeller. Carl Schoeller · @CarlSchoeller · Now. Today we're launching Parallax, the AI energy company with a $117m fundraise led by Founders Fund, Eclipse, Lux, Diffusion, Greylock and General Catalyst.",
};

function lead(result: { url: string; title: string; description: string }, now = NOW): AnnouncementLead {
  const x = parseXResult(result, now);
  if (!x) throw new Error("not an X result");
  const r = readAnnouncement(x, result.title, now);
  if (typeof r === "string") throw new Error(`not a lead: ${r}`);
  return r;
}

function reject(result: { url: string; title: string; description: string }, now = NOW): string {
  const x = parseXResult(result, now);
  if (!x) return "not an X result";
  const r = readAnnouncement(x, result.title, now);
  return typeof r === "string" ? r : "lead";
}

describe("a funding post as a lead", () => {
  test("Parallax: the quoted founder is the author, the company and the figure come from the words", () => {
    const l = lead(PARALLAX);
    expect(l.handle).toBe("carlschoeller");
    expect(l.authorName).toBe("Carl Schoeller");
    expect(l.via).toBe("sethgrosenberg");
    expect(l.company).toBe("Parallax");
    expect(l.amountAsWritten).toBe("$117m");
    expect(l.usdMillions).toBe(117);
    expect(l.label).toBe("fundraise");
    expect(l.leadInvestors).toEqual(["Founders Fund", "Eclipse", "Lux", "Diffusion", "Greylock", "General Catalyst"]);
  });

  test("the company a post names: its handle, a name before raised, the name after launching", () => {
    expect(companyInText("Excited to announce that @naturalpay has raised a $30M Series A led by @ForerunnerVC")).toEqual({
      name: "naturalpay",
      handle: "naturalpay",
    });
    expect(companyInText("Today we're launching @pitdotcom, with $16M funding led by @a16z.").handle).toBe("pitdotcom");
    expect(companyInText("We are thrilled to announce that Limble has raised $58M in Series B funding").name).toBe("Limble");
    expect(companyInText("Fortytwo is thrilled to announce a $2.3M Pre-Seed funding round").name).toBe("Fortytwo");
    expect(companyInText("Introducing Alexandria. We raised a $75M Series B led by Smash Capital").name).toBe("Alexandria");
    expect(companyInText("We've raised $76M in initial funding from Caffeinated Capital, Founders Fund, Lux Capital").name).toBeNull();
  });

  test("a company's own account names itself; a person or a firm does not", () => {
    expect(looksLikeCompanyAccount("seltz_ai", "Seltz")).toBe(true);
    expect(looksLikeCompanyAccount("officialmagicco", "MagicCo")).toBe(true);
    expect(looksLikeCompanyAccount("bkroberts", "Brian Roberts")).toBe(false);
    expect(looksLikeCompanyAccount("sequoia", "Sequoia Capital")).toBe(false);
    expect(looksLikeCompanyAccount("benyuls", "ben.")).toBe(false);
  });

  test("not leads: a charity drive, a fund close, any profile page, a news desk, no figure", () => {
    expect(
      reject({
        url: "https://x.com/RepKatCammack/status/2103195009642090664",
        title: "Congresswoman Kat Cammack on X",
        description: "2 hours ago · Together, we've raised more than $5.8 MILLION for YSC and their work in this fight.",
      }),
    ).toBe("no announcement");
    expect(
      reject({
        url: "https://x.com/sam_mielke",
        title: "Sam Mielke (@sam_mielke) / X",
        description:
          "3 hours ago · Today, our team is very happy to share that we've raised Haystack VIII, an $85M early stage fund and Needles III, a select fund for high conviction",
      }),
    ).toBe("profile");
    expect(
      reject({
        url: "https://x.com/acmevc/status/2103176387544518950",
        title: "Acme on X",
        description:
          "2 hours ago · Excited to announce we've closed Acme Fund II, a $150M seed fund, with investors including three endowments.",
      }),
    ).toBe("not a round");
    expect(
      reject({
        url: "https://x.com/jhwindmueller",
        title: "Jordan Windmueller (@jhwindmueller) / X",
        description: "3 hours ago · 2025 г. We've raised $100M from Kleiner Perkins, Index Ventures, Lightspeed, and NVIDIA.",
      }),
    ).toBe("profile");
    expect(
      reject({
        url: "https://x.com/menlotimes/status/2103176387544518957",
        title: "Menlo Times on X",
        description: "2 hours ago · Numeral has raised a $100 million Series C led by Insight Partners.",
      }),
    ).toBe("outlet");
    expect(
      reject({
        url: "https://x.com/acmehq/status/2103176387544518958",
        title: "Acme on X",
        description: "2 hours ago · We've raised our seed round led by Accel.",
      }),
    ).toBe("no amount");
    // A status id older than the lookback is not this hour's news, whatever the search engine dated it.
    expect(reject(PARALLAX, new Date("2026-09-26T20:30:00Z"))).toBe("old");
  });
});

describe("the article search", () => {
  test("company and figure two ways, over the past week", () => {
    expect(leadArticleQuery(lead(PARALLAX))).toEqual({
      q: '"Parallax" ("$117M" OR "$117 million") (raises OR raised OR funding OR fundraise)',
      tbs: "qdr:w",
    });
  });

  test("the pages read: news pages naming the company; X, LinkedIn, and pages about something else are not", () => {
    const picks = pickCorroboration(
      [
        { url: "https://x.com/victoralazarte/status/2103197394511020423", title: "victor lazarte on X", description: "Parallax $117m" },
        {
          url: "https://www.wsj.com/business/energy-oil/is-3-d-printing-the-answer-to-ais-gas-turbine-crunch-865ae5d0",
          title: "Is 3-D Printing the Answer to AI's Gas Turbine Crunch?",
          description: "Parallax, a startup, has raised $117 million.",
        },
        { url: "https://www.linkedin.com/posts/parallax-117m", title: "Parallax raises $117m" },
        { url: "https://news.example/2026/09/24/other-startup-raises", title: "Other startup raises $117 million" },
        {
          url: "https://finance.yahoo.com/technology/articles/3-d-printing-answer-ai-110000268.html",
          title: "Is 3-D Printing the Answer to AI's Gas Turbine Crunch?",
          description: "Parallax has raised $117 million from Founders Fund",
        },
      ],
      lead(PARALLAX),
    );
    expect(picks.map((p) => p.url)).toEqual([
      "https://www.wsj.com/business/energy-oil/is-3-d-printing-the-answer-to-ais-gas-turbine-crunch-865ae5d0",
      "https://finance.yahoo.com/technology/articles/3-d-printing-answer-ai-110000268.html",
    ]);
  });

  test("the article's record is the lead's round: same company, figure within 15 percent", () => {
    const l = lead(PARALLAX);
    const rec = (name: string, usd: number | null) => ({
      company_name: name,
      amount: { value: usd, currency: usd === null ? null : "USD", usd_millions: usd },
      lead_investors: [],
    });
    expect(leadMatches(rec("Parallax", 117), l)).toBe(true);
    expect(leadMatches(rec("Parallax Inc.", 120), l)).toBe(true);
    expect(leadMatches(rec("Parallax", 40), l)).toBe(false);
    expect(leadMatches(rec("Solcoa Industries", 117), l)).toBe(false);
    // A lead naming only its author needs the figure and a name the post also carries.
    const byAuthor = {
      ...l,
      company: null,
      companyHandle: null,
      text: "We raised $117m led by Founders Fund",
      leadInvestors: ["Founders Fund"],
    };
    expect(leadMatches({ ...rec("Parallax", 117), lead_investors: ["Founders Fund"] }, byAuthor)).toBe(true);
    expect(leadMatches(rec("Parallax", 117), byAuthor)).toBe(false);
  });
});

describe("the backoff", () => {
  test("a status post: at once, then 2, 6, 12, 24, and 48 hours after first seen; then nothing", () => {
    const first = new Date("2026-09-24T20:00:00Z");
    const hours = CORROBORATION_SCHEDULE_HOURS.map((_, i) => ((nextAttemptAt(first, i)?.getTime() ?? 0) - first.getTime()) / 3_600_000);
    expect(hours).toEqual([0, 2, 6, 12, 24, 48]);
    expect(nextAttemptAt(first, CORROBORATION_SCHEDULE_HOURS.length)).toBeNull();
    // A profile page's snippet may be an older post: three searches.
    expect(nextAttemptAt(first, 1, "profile")?.toISOString()).toBe("2026-09-25T08:00:00.000Z");
    expect(nextAttemptAt(first, 3, "profile")).toBeNull();
  });
});

describe("a post on its own", () => {
  test("only a status post naming its company, from an account the company's homepage links", () => {
    const l = { ...lead(PARALLAX), handle: "parallaxenergy" };
    expect(selfPublishable(l, ["parallaxenergy"])).toBe(true);
    expect(selfPublishable(l, [])).toBe(false);
    expect(selfPublishable({ ...l, kind: "profile" }, ["parallaxenergy"])).toBe(false);
    expect(selfPublishable({ ...l, company: null }, ["parallaxenergy"])).toBe(false);
    // Carl Schoeller's account: parallax.ai linked no X account when read (September 24, 2026), so Parallax waits for its article.
    expect(selfPublishable(lead(PARALLAX), [])).toBe(false);
    expect(domainInText("Try it at parallax.ai today")).toBe("parallax.ai");
    expect(domainInText("see x.com/acme")).toBeNull();
  });

  test("the post reads as a record the resolver keeps: the post is the source, its day the date", () => {
    const l = { ...lead(PARALLAX), handle: "parallaxenergy" };
    const r = resolveRounds([leadAsItem(l, "https://parallax.ai")], {
      stages: ["series_a", "series_b", "seed", "pre_seed", "series_c", "series_d_plus", "growth"],
      stagelessBands: STAGE_BANDS,
      windowStart: new Date("2026-09-17T00:00:00Z"),
      now: NOW,
    });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]).toMatchObject({
      company_name: "Parallax",
      stage: "other",
      stage_as_written: "fundraise",
      announced_date: "2026-09-24",
    });
    expect(r.kept[0].amount.usd_millions).toBe(117);
    expect(r.kept[0].sources[0].url).toBe(PARALLAX.url);
  });
});

describe("the lane's September 25 fixes", () => {
  test("every search asks for the past day sorted by date, and a profile result is counted as a profile", async () => {
    const seen: Array<{ q: string; tbs?: string }> = [];
    const client = {
      search: async (q: string, opts: { tbs?: string }) => {
        seen.push({ q, tbs: opts.tbs });
        return {
          web: [
            { url: "https://x.com/bryanonel86", title: "Bryan Onel (@bryanonel86) / X", description: "10 hours ago · We've raised $33M." },
          ],
        };
      },
    } as unknown as Firecrawl;
    const r = await searchAnnouncements(client, NOW);
    expect(X_ANNOUNCEMENT_TBS).toBe("sbd:1,qdr:d");
    expect(seen).toHaveLength(X_ANNOUNCEMENT_QUERIES.length);
    expect(new Set(seen.map((s) => s.tbs))).toEqual(new Set(["sbd:1,qdr:d"]));
    expect(r.leads).toEqual([]);
    expect(r.rejected.profile).toBe(X_ANNOUNCEMENT_QUERIES.length);
  });

  test("X's own index through Alexandria reads a post whole, minutes old, the same way a search result is read", async () => {
    const calls: unknown[] = [];
    const client = {
      search: async () => ({ web: [] }),
      scrape: async (req: { alexandria: { options: { query: string; from_date: string } } }) => {
        calls.push(req.alexandria);
        return {
          alexandria: [
            {
              creditsCost: 30,
              data: {
                data: [
                  {
                    id: "2107163635810472259",
                    username: "StartupAndrew",
                    name: "Andrew Lee",
                    text: "Today, I'm excited to share we've raised an additional $12.8M at a $500M valuation. @TaskletAI is built for teams.",
                    created_at: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
                  },
                ],
              },
            },
          ],
        };
      },
    } as unknown as Firecrawl;
    const r = await searchAnnouncements(client, NOW, { queries: [{ key: "weve_raised", q: `site:x.com "we've raised" led by` }] });
    expect(calls).toEqual([
      {
        provider: "x-com",
        capability: "posts/search",
        options: { query: `"we've raised" led by`, limit: 10, from_date: expect.any(String) },
      },
    ]);
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0]).toMatchObject({
      key: "2107163635810472259",
      handle: "startupandrew",
      amountAsWritten: "$12.8M",
      url: "https://x.com/startupandrew/status/2107163635810472259",
    });
    expect(r.calls.find((c) => c.key === "weve_raised:live")).toMatchObject({ results: 1, leads: 1, credits: 30 });
  });

  test("a profile page is never a lead: every one measured was an older post under the page's newest time", () => {
    // Oneleet's Series A from October 2025, returned on Sep 24, 2026 as a profile page "10 hours ago".
    expect(
      reject({
        url: "https://x.com/bryanonel86",
        title: "Bryan Onel (@bryanonel86) / X",
        description: "10 hours ago · Oct 2, 2025. Today, we're announcing our $33M Series A led by Dawn Capital.",
      }),
    ).toBe("profile");
  });

  test("a company account's first-person post names the company from its handle when its display name is a tagline", () => {
    const hifi = lead({
      url: "https://x.com/hifihq/status/2103195007822000010",
      title: "Money is becoming software. HIFI is the infrastructure it runs on. We ... on X",
      description: "1 hour ago · We've raised a $37 million Series A led by @leftlanecap. Thank you to the customers who run on HIFI.",
    });
    expect(hifi.company).toBe("HIFI");
    expect(companyFromHandle("hifihq", "the customers who run on HIFI")).toBe("HIFI");
    expect(companyFromHandle("bkroberts", "We've raised $76M")).toBeNull();
    // A person's first name at the front of a longer handle is not a company account.
    expect(looksLikeCompanyAccount("karankendre", "Karan")).toBe(false);
    expect(looksLikeCompanyAccount("seltz_ai", "Seltz")).toBe(true);
    expect(looksLikeCompanyAccount("getacme", "Acme")).toBe(true);
  });

  test("a camel-cased name is read whole, and a descriptor in front of a name is dropped", () => {
    expect(companyInText("functionSPACE has raised $1.7M in pre-seed funding").name).toBe("functionSPACE");
    expect(companyInText("Israeli-founded Island has raised $400 million in a Series F").name).toBe("Island");
  });

  test("the outlet list: venture firms and companies with tech, venture, or capital in the handle are not outlets", () => {
    expect(OUTLET_HANDLES.has("thesaasnews")).toBe(true);
    for (const h of ["khoslaventures", "indexventures", "radicalventures", "acmetech", "startupfundingco", "bainscapital"])
      expect(isAnnouncementOutlet(h, null), h).toBe(false);
    for (const h of ["menlotimes", "techmeme", "tfnbreakingnews", "entrackr", "eu_startups", "prnewswire"])
      expect(isAnnouncementOutlet(h, null), h).toBe(true);
    expect(isAnnouncementOutlet("someone", "Daily Deal News")).toBe(true);
    expect(isAnnouncementOutlet("benyuls", "Ben Yuls")).toBe(false);
    // A firm's own post is a lead now, not an outlet's.
    const firm = lead({
      url: "https://x.com/khoslaventures/status/2103195007822000011",
      title: "Khosla Ventures on X",
      description: "1 hour ago · Proud to lead @novamed's $12M Series A. Nova is rebuilding clinical trials.",
    });
    expect(firm).toMatchObject({ company: "novamed", companyHandle: "novamed", amountValue: 12, leadInvestors: ["Khosla Ventures"] });
  });

  test("investor phrasings: proud to lead, we led, our investment in; and their searches", () => {
    const keys = X_ANNOUNCEMENT_QUERIES.map((q) => q.key);
    expect(keys).toEqual(expect.arrayContaining(["proud_to_lead", "we_led", "our_investment", "weve_closed"]));
    expect(X_ANNOUNCEMENT_QUERIES).toHaveLength(12);
    const led = lead({
      url: "https://x.com/jane_vc/status/2103195007822000012",
      title: "Jane Park on X",
      description: "2 hours ago · We led the $8M seed round in @betaco, which turns warehouse video into inventory counts.",
    });
    expect(led).toMatchObject({ company: "betaco", amountValue: 8, leadInvestors: ["Jane Park"] });
    const invested = lead({
      url: "https://x.com/jane_vc/status/2103195007822000013",
      title: "Jane Park on X",
      description:
        "2 hours ago · Thrilled to back Gamma's $20M Series A alongside Sequoia. Our investment in Gamma is our third in robotics.",
    });
    expect(invested.company).toBe("Gamma");
  });

  test("a second account confirms a lead: same company and figure, a different author, within twelve hours", () => {
    const base = lead(PARALLAX);
    const other = { ...base, handle: "victoralazarte", postedAt: new Date(base.postedAt!.getTime() + 3 * 3_600_000) };
    expect(confirmsLead(base, other)).toBe(true);
    expect(confirmsLead(base, { ...other, handle: "carlschoeller" })).toBe(false);
    expect(confirmsLead(base, { ...other, postedAt: new Date(base.postedAt!.getTime() + 13 * 3_600_000) })).toBe(false);
    expect(confirmsLead(base, { ...other, usdMillions: 40, amountValue: 40 })).toBe(false);
    expect(confirmsLead(base, { ...other, company: "Parallel", companyHandle: null })).toBe(false);
    expect(confirmsLead(base, { ...other, kind: "profile" })).toBe(false);
  });

  test("a founder's bio links the company by domain, by the company's handle, or by name beside a role", () => {
    const md = [
      "# Carl Schoeller (@CarlSchoeller)",
      "",
      "CEO @ Parallax",
      "",
      "- Followers: 1,417",
      "- Verified: yes",
      "",
      "## Latest Posts",
      "Today we're launching Parallax",
    ].join("\n");
    const bio = bioFromProfile(md);
    expect(bio).toBe("CEO @ Parallax");
    const parallax = { name: "Parallax", domain: "parallax.ai", handles: ["parallaxenergy"] };
    expect(bioLinksCompany(bio, parallax)).toBe(true);
    expect(bioLinksCompany("building things. parallax.ai", { ...parallax, name: null })).toBe(true);
    expect(bioLinksCompany("Energy nerd. Views mine. @parallaxenergy", { ...parallax, name: null })).toBe(true);
    // Named in passing, with no role: not a link.
    expect(bioLinksCompany("Big fan of Parallax and good coffee", parallax)).toBe(false);
    expect(bioLinksCompany("CEO @ Parallel Systems", parallax)).toBe(false);
  });

  test("a founder's bio names the company the post names when no raise phrase does", () => {
    const post =
      "Today, I’m excited to share we’ve raised an additional $12.8M at a $500M valuation. ... @TaskletAI is built with collaboration, automation, security, and control at its core. Investors in the round include @usv, @359Capital, @patrickc and others.";
    const bio = "Founder &amp; CEO of @TaskletAI &amp; @Shortwave. Previously founded @Firebase.";
    expect(companyFromFounderBio(bio, post)).toEqual({ name: "Tasklet", handle: "TaskletAI" });
    // No founder's role, no account the post names, or two of them: no company.
    expect(companyFromFounderBio("Partner @usv. Views mine.", post)).toBeNull();
    expect(companyFromFounderBio("Founder of @Shortwave", post)).toBeNull();
    expect(companyFromFounderBio(bio, `${post} Thanks @Shortwave team too.`)).toBeNull();
    expect(companyFromFounderBio("CEO @hifihq", "we raised $5M to run on HIFI, says @hifihq")).toEqual({ name: "HIFI", handle: "hifihq" });
  });

  test("a post-only record is dated by the page, so the late re-report hold can still set it aside", () => {
    const r = xOnlyRecord({ date_basis: "stated", verification: undefined }, "a note", "https://x.com/a/status/1");
    expect(r).toEqual({ date_basis: "page", verification: { status: "unverified", notes: ["a note"], url: "https://x.com/a/status/1" } });
  });
});
