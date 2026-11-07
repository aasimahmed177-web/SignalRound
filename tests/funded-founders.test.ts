import { describe, expect, test } from "vitest";
import {
  contextWords,
  descriptorSentence,
  evidenceScore,
  fundingCandidates,
  fundingSignalUrl,
  leadInvestors,
  mentionsDomain,
  type NewsItem,
  parseFeed,
  postedContactsOnly,
  roundupRows,
  searchResultLinks,
  siteMentionsRound,
  tldFitsCountry,
} from "../lib/funded-founders";
import {
  amountAsWritten,
  classifyEmail,
  cleanCompanyName,
  companyFromHeadline,
  companyKey,
  countryFromText,
  domainGuesses,
  excludedDeal,
  foundersFromTeamPage,
  foundersFromText,
  linkedinFor,
  pageEmails,
  readStage,
  websiteMatches,
} from "../lib/funding-parse";

describe("stage filter", () => {
  test("keeps pre-seed to Series C as written", () => {
    expect(readStage("Quillfen AI raises $2.7 Mn in pre-seed round")).toEqual({ key: "pre_seed", asWritten: "Pre-Seed" });
    expect(readStage("Orbitrue Space raises $6 Mn in seed round")).toEqual({ key: "seed", asWritten: "Seed" });
    expect(readStage("Mintwhirl Robotics raises Rs 100 Cr in Pre-Series B")).toEqual({ key: "series_a", asWritten: "Pre-Series B" });
    expect(readStage("Chatterloop Group raises $80 Mn in Series C led by Hollowbill")).toEqual({ key: "series_c", asWritten: "Series C" });
    expect(readStage("GLIMMR raises Rs 3 Cr in angel round")).toEqual({ key: "pre_seed", asWritten: "Angel" });
  });

  test("excludes Series D and later, debt, acquisitions, IPOs, grants and fund launches", () => {
    expect(readStage("Harrowgate raises $240M Series D")).toEqual({ excluded: "series d" });
    expect(excludedDeal("Jewelo $100 million Series D fundraise")).toBe("series d");
    expect(excludedDeal("Acme raises $20M in venture debt")).toBe("debt");
    expect(excludedDeal("Tripmint acquires majority stake in Carpoolly")).toBe("acquisition");
    expect(excludedDeal("Paywhirl receives regulator approval for IPO")).toBe("ipo");
    expect(excludedDeal("Brightfold Growth Ventures raises Rs 125 Cr in first close of maiden consumer fund")).toBe("fund launch");
    expect(excludedDeal("Startup wins $50,000 grant from city")).toBe("grant");
    expect(excludedDeal("From JEWELO To Chatterloop Group — Indian Startups Raised $255 Mn This Week")).toBe("roundup");
    expect(excludedDeal("Orbitrue Space raises $6 Mn in seed round")).toBeNull();
  });

  test("a seed-stage investor or a broker called Angel One Ventureworks is not a round", () => {
    expect(readStage("Acme raises $5M from seed-stage fund Foo")).toBeNull();
    expect(readStage("Angel One Ventureworks overtakes Tradewise to become second-largest broker")).toBeNull();
    expect(excludedDeal("Evermoss Capital raises €15 million debut fund")).toBe("fund launch");
  });

  test("states the amount as written, not the valuation", () => {
    expect(amountAsWritten("The Waffle Folks raises Rs 14 Cr from Q9 Ventures at Rs 100 Cr valuation")).toBe("Rs 14 Cr");
    expect(amountAsWritten("Sorvik raises €1.9M seed round")).toBe("€1.9M");
    expect(amountAsWritten("Mintwhirl Robotics | $10.5 Mn*")).toBe("$10.5 Mn");
  });
});

describe("company-name cleanup", () => {
  test.each([
    ["Spacetech startup Orbitrue Space raises $6 Mn in seed round", "Orbitrue Space"],
    ["Bio-tech startup Quillfen AI raises $2.7 Mn in pre-seed round", "Quillfen AI"],
    ["Specialty chemicals startup chemQ raises $10.3 Mn led by Rainfall Fund, Mesa Ventures", "chemQ"],
    ["Larkspur India Capital participates in Botlane’s Rs 40.6 Cr funding round", "Botlane"],
    ["Foxglove India leads pre-seed round in last-mile delivery startup Parcelrun Network", "Parcelrun Network"],
    ["Tom Exampleton’s adtech, Snipwise, adds $20m million Series A", "Snipwise"],
    ["Unified AI workspace DeskloopAI raises Rs 6 crore in pre-seed round", "DeskloopAI"],
    ["South Africa’s ZigZagr raises undisclosed Hoop Ventures investment", "ZigZagr"],
    ["Exclusive: Gripforge kicks off Rs 67 Cr seed round", "Gripforge"],
    ["The Waffle Folks raises Rs 14 Cr from Q9 Ventures", "The Waffle Folks"],
    ["Biotech Startup Quillfen AI Raises $2.7 Mn In Pre-Seed Round", "Quillfen AI"],
    ["Bengaluru-based Acme Robotics raises $3M seed round", "Acme Robotics"],
    ["Fjordly To Raise ₹100 Cr From Northstar Consumer Care Ventures", "Fjordly"],
  ])("%s", (title, name) => {
    expect(companyFromHeadline(title)).toBe(name);
  });

  test("rejects descriptors with no name left", () => {
    expect(companyFromHeadline("AI coworker startup raises $115 million")).toBeNull();
    expect(cleanCompanyName("the startup")).toBeNull();
    expect(cleanCompanyName("broker; Tradewise")).toBeNull();
    expect(cleanCompanyName("of Zany Content Agent")).toBe("Zany Content Agent");
  });

  test("one key for the same company spelled two ways", () => {
    expect(companyKey("Quillfen AI")).toBe(companyKey("Quillfen"));
    expect(companyKey("Wards On Cloud")).toBe("wardsoncloud");
  });

  test("groups a round covered by several outlets and drops non-rounds", () => {
    const item = (title: string, url: string): NewsItem => ({
      title,
      url,
      published: new Date("2026-11-05"),
      source: "test",
      country: null,
    });
    const { candidates, skipped } = fundingCandidates([
      item("Spacetech startup Orbitrue Space raises $6 Mn in seed round", "https://news.example/a"),
      item("Orbitrue Space Raises $6 Mn Seed Funding", "https://news2.example/b"),
      item("Three Point Q raises $10 million", "https://news3.example/c"),
      item("Clean energy platform Three Point Q Capital raises $10 Mn", "https://news.example/d"),
      item("Glowkart's profit jumps 3X to Rs 101 Cr in Q2 FY27", "https://news.example/e"),
      item("Tripmint acquires majority stake in Carpoolly", "https://news.example/f"),
    ]);
    expect(candidates.map((c) => [c.company, c.items.length])).toEqual([
      ["Orbitrue Space", 2],
      ["Three Point Q Capital", 2],
    ]);
    expect(skipped).toEqual({ "not a funding headline": 1, acquisition: 1 });
  });
});

describe("website matching", () => {
  test("accepts the company's own domain and rejects news sites", () => {
    expect(websiteMatches("Wards On Cloud", "https://wardsoncloud.com/")).toBe(true);
    expect(websiteMatches("Quillfen AI", "https://quillfen.ai/")).toBe(true);
    expect(websiteMatches("chemQ", "https://www.chemq.bio/")).toBe(true);
    expect(websiteMatches("Orbitrue Space", "https://news.example/snippets/orbitrue")).toBe(false);
    expect(websiteMatches("Press", "https://press.example/")).toBe(false);
    expect(websiteMatches("Acme", "https://www.linkedin.com/company/acme")).toBe(false);
  });

  test("a related domain needs the page to name the company", () => {
    expect(websiteMatches("LiftUp Money", "https://www.liftup.money/")).toBe(false);
    expect(websiteMatches("LiftUp Money", "https://www.liftup.money/", { title: "LiftUp Money | Wealth" })).toBe(true);
    expect(websiteMatches("Orbitrue", "https://getorbitrue.com/")).toBe(true);
    expect(websiteMatches("Parcelrun Network", "https://www.parcelrunnetwork.co/")).toBe(true);
    expect(websiteMatches("Larchwood", "https://larchwoodcapital.com/", { title: "Larchwood Capital" })).toBe(true);
    expect(websiteMatches("Chemicl", "https://chemics.org/")).toBe(false);
  });

  test("domain guesses try the stated TLD first", () => {
    expect(domainGuesses("Quillfen AI")[0]).toBe("quillfen.ai");
    expect(domainGuesses("Wards On Cloud")).toContain("wardsoncloud.com");
  });

  test("a namesake homepage does not echo the funding article", () => {
    const evidence = {
      title: contextWords("Spacetech startup Orbitrue Space raises $6 Mn in seed round", ["Orbitrue Space"], 5),
      body: contextWords("Orbitrue is building satellite servicing and space debris removal technology in orbit.", ["Orbitrue Space"]),
      surnames: ["vantablue"],
    };
    expect(evidenceScore("Orbitrue: a global consulting network for international business innovation", evidence)).toBeLessThan(4);
    expect(evidenceScore("Orbitrue Space — satellite servicing and debris removal in orbit", evidence)).toBeGreaterThanOrEqual(4);
    expect(evidenceScore("Founded by Kiran Vantablue", evidence)).toBe(10);
  });

  test("a country-code domain of another country is a namesake", () => {
    expect(tldFitsCountry("https://threepointq.co.uk/", "India")).toBe(false);
    expect(tldFitsCountry("https://fjordly.in/", "India")).toBe(true);
    expect(tldFitsCountry("https://quillfen.ai/", "India")).toBe(true);
  });

  test("country from the opening, ignoring where investors are based", () => {
    expect(countryFromText("Hyderabad-based Orbitrue raised $6 million from Japan-based Kitebridge Partners")).toBe("India");
    expect(countryFromText("Wards On Cloud raised $12.5 million from Dubai-based investors. The Pune startup", "India")).toBe("India");
    expect(countryFromText("Lagos-based Kudipoint raised")).toBe("Nigeria");
  });
});

describe("founders", () => {
  const article = [
    "Hyderabad-based Orbitrue Space has raised $6 million in a seed funding round.",
    "Founded last year by Kiran Vantablue, Orbitrue is developing a proprietary architecture.",
    "“We are thrilled,” said Jane Doe, co-founder and CEO of Orbitrue.",
    "Omar Quillby, partner at Emberline Ventures, said the team is great.",
    "Emberline Ventures co-founder Tessa Brightwater did not comment.",
    "The startup's co-founders Rohan Zephyr, Anika Moonstone, and Meera Quarry said it will hire.",
  ].join(" ");

  test("reads founders and their roles from a funding article, not investors", () => {
    expect(foundersFromText(article, "Orbitrue Space").map((f) => [f.name, f.role])).toEqual([
      ["Kiran Vantablue", "Founder"],
      ["Jane Doe", "Co-founder and CEO"],
      ["Rohan Zephyr", "Co-founder"],
      ["Anika Moonstone", "Co-founder"],
      ["Meera Quarry", "Co-founder"],
    ]);
  });

  test("a multi-company article only counts sentences naming the company", () => {
    const text = "Founded in 2023 by Dev Example and Ravi Sample, Skyquill Aero builds drones. Parcelrun Network raised $500K.";
    expect(foundersFromText(text, "Parcelrun Network", { strict: true })).toEqual([]);
  });

  test("team pages: bare titles only, never testimonials", () => {
    const html = `<html><body><div><h3>Harsh Quillman</h3><p>Co-Founder &amp; COO</p></div>
      <div><h3>Clara Testberg</h3><p>CEO, BRAINO Magazine</p></div>
      <div><p>Tom Hartfield — CEO, Restaurant Group</p></div>
      <div><h3>Ajay Underwood</h3><p>Founder’s office</p></div>
      <div>Joe JanskiCo-Founder &amp; CTO</div></body></html>`;
    expect(foundersFromTeamPage(html, "GridCap").map((f) => [f.name, f.role])).toEqual([["Harsh Quillman", "Co-founder & COO"]]);
  });

  test("LinkedIn only when a page links the founder's own profile", () => {
    const links = [
      { href: "https://www.linkedin.com/in/ronaldexample/", text: "" },
      { href: "https://www.linkedin.com/company/mintwhirl", text: "Ronald Example" },
    ];
    expect(linkedinFor("Ronald Example", links)).toBe("https://www.linkedin.com/in/ronaldexample");
    expect(linkedinFor("Jane Doe", links)).toBeNull();
  });
});

describe("public emails", () => {
  const html = `<html><body><footer><p>Write to us at: contact@acme.example</p>
    <a href="mailto:Founders@acme.example?subject=Hi">Talk to the founders</a>
    <p>Jane Doe (CEO) — jane@acme.example</p><img src="logo@2x.png"><p>noreply@acme.example</p></footer></body></html>`;

  test("every email comes with the text that shows it", () => {
    expect(pageEmails(html, "https://acme.example/contact")).toEqual([
      { email: "contact@acme.example", source_url: "https://acme.example/contact", quote: "Write to us at: contact@acme.example" },
      { email: "jane@acme.example", source_url: "https://acme.example/contact", quote: "Jane Doe (CEO) — jane@acme.example" },
      {
        email: "founders@acme.example",
        source_url: "https://acme.example/contact",
        // Visible words only, never the page's raw HTML.
        quote: "Talk to the founders (mailto:founders@acme.example)",
      },
    ]);
  });

  test("labels a founder's own address apart from company inboxes", () => {
    const founders = [{ name: "Jane Doe" }];
    expect(classifyEmail("jane@acme.example", founders)).toEqual({ founder: "Jane Doe", inbox: "person" });
    expect(classifyEmail("jdoe@acme.example", founders)).toEqual({ founder: "Jane Doe", inbox: "person" });
    expect(classifyEmail("founders@acme.example", founders)).toEqual({ inbox: "founders" });
    expect(classifyEmail("hello@acme.example", founders)).toEqual({ inbox: "general" });
    expect(classifyEmail("press@acme.example", founders)).toEqual({ inbox: "press" });
  });

  test("a piece of a name is not a founder's address; the full first name, first+last or a printed name is", () => {
    expect(classifyEmail("marketing@acme.example", [{ name: "Mark Example" }])).toEqual({ inbox: "other" });
    expect(classifyEmail("janet@acme.example", [{ name: "Jane Doe" }]).founder).toBeUndefined();
    expect(classifyEmail("doe@acme.example", [{ name: "Jane Doe" }]).founder).toBeUndefined();
    expect(classifyEmail("dev@acme.example", [{ name: "Dev Testwala" }]).founder).toBeUndefined();
    expect(classifyEmail("sales@acme.example", [{ name: "Sales Example" }]).founder).toBeUndefined();
    expect(classifyEmail("jane.doe@acme.example", [{ name: "Jane Doe" }]).founder).toBe("Jane Doe");
    expect(classifyEmail("janed@acme.example", [{ name: "Jane Doe" }]).founder).toBe("Jane Doe");
    // The page prints the address with the founder's full name: theirs, unless it is a desk or spells someone else.
    expect(classifyEmail("jd2024@acme.example", [{ name: "Jane Doe" }], "Jane Doe · CEO · jd2024@acme.example").founder).toBe("Jane Doe");
    expect(classifyEmail("press@acme.example", [{ name: "Jane Doe" }], "Jane Doe · press@acme.example").founder).toBeUndefined();
    expect(classifyEmail("omar.lee@acme.example", [{ name: "Jane Doe" }], "Jane Doe and omar.lee@acme.example").founder).toBeUndefined();
  });
});

describe("feeds", () => {
  test("unwraps Bing news links and reads RSS items", () => {
    const xml = `<rss><channel><item><title>Sorvik Raises €1.9M Seed Round</title>
      <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fnews.example%2fsorvik&amp;c=1</link>
      <pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate><description>Sorvik raised</description></item></channel></rss>`;
    const [item] = parseFeed(xml, "Bing News", null);
    expect(item?.url).toBe("https://news.example/sorvik");
    expect(item?.source).toBe("Bing News (news.example)");
  });

  test("reads every deal row of Inc42's weekly table", () => {
    const html = `<table><tr><td>Date</td><td>Name</td></tr>
      <tr><td>3 Nov 2026</td><td>Wards On Cloud</td><td>Health Tech</td><td>Devices</td><td>B2B</td><td>$12.5 Mn</td><td>Series A</td><td>Fund42</td></tr>
      <tr><td>3 Nov 2026</td><td>JEWELO</td><td>Ecommerce</td><td>D2C</td><td>B2C</td><td>$103 Mn*</td><td>–</td><td>Manifold</td></tr></table>`;
    const rows = roundupRows({
      title: "Indian Startups Raised $255 Mn This Week",
      url: "https://news.example/w",
      published: new Date(),
      source: "Inc42",
      country: "India",
      html,
    });
    expect(rows.map((row) => row.row)).toEqual([
      { company: "Wards On Cloud", stage: "Series A", amount: "$12.5 Mn" },
      { company: "JEWELO", stage: "–", amount: "$103 Mn" },
    ]);
  });
});

describe("wrong-company websites", () => {
  test("a domain counts as mentioned only when the page names that exact domain", () => {
    const article = `<p>Learn more at <a href="https://www.journo.example.io/">journo.example.io</a>.</p>`;
    expect(mentionsDomain(article, "journo.example.io")).toBe(true);
    expect(mentionsDomain(article, "journo.example.ai")).toBe(false);
    expect(mentionsDomain("<p>notjourno.example.io</p>", "journo.example.io")).toBe(false);
  });

  test("a site names the round by a founder, a lead investor or the amount in a funding sentence", () => {
    const round = { founders: ["Kiran Vantablue"], investors: ["Hollowbill Capital"], amount: "$5 million" };
    expect(siteMentionsRound("Our team: Kiran Vantablue, CEO", round)).toBe(true);
    expect(siteMentionsRound("Backed by Hollowbill Capital and friends.", round)).toBe(true);
    expect(siteMentionsRound("We raised $5M in seed funding to build agent tools.", round)).toBe(true);
    // A namesake e-bike maker: the same word, none of the round's facts.
    expect(siteMentionsRound("Ride the new e-bike. 5 million kilometres ridden by our community.", round)).toBe(false);
    expect(siteMentionsRound("We raised $15M in 2021.", round)).toBe(false);
  });

  test("lead investors and the article's own descriptor sentence", () => {
    expect(leadInvestors("The round was led by Hollowbill Capital and Emberline Ventures, with participation from angels.")).toEqual([
      "Hollowbill Capital",
      "Emberline Ventures",
    ]);
    const article =
      "Rodeo Labs has raised $5 million in seed funding. Rodeo Labs is a marketplace where developers sell AI agents. The round was led by Hollowbill Capital.";
    expect(descriptorSentence(article, "Rodeo Labs")).toBe("Rodeo Labs is a marketplace where developers sell AI agents.");
    expect(descriptorSentence("Nothing about it here.", "Rodeo Labs")).toBeNull();
  });

  test("search result links unwrap the results page's redirects", () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjourno.example.io%2F&amp;rut=x">Journo</a>
      <a href="https://duckduckgo.com/settings">Settings</a>`;
    expect(searchResultLinks(html)).toEqual(["https://journo.example.io/"]);
  });
});

describe("storing signals", () => {
  test("companies from one roundup article get distinct signal URLs", () => {
    const a = fundingSignalUrl({ company: "Wards On Cloud", funding_source_url: "https://news.example/w" });
    const b = fundingSignalUrl({ company: "JEWELO", funding_source_url: "https://news.example/w" });
    expect(a).not.toBe(b);
    expect(a).toBe("https://news.example/w#company=wardsoncloud");
    expect(new URL(b).origin + new URL(b).pathname).toBe("https://news.example/w");
  });
});

describe("postedContactsOnly", () => {
  const company = (founders: unknown[], company_emails: unknown[]) =>
    ({ company: "Acme", website: "https://acme.example/", founders, company_emails }) as never;
  const founder = (name: string, emails: unknown[]) => ({ name, role: "CEO", source_url: "u", quote: "q", linkedin_url: null, emails });

  test("keeps only founders and inboxes whose email is posted on a kept page", () => {
    const [kept] = postedContactsOnly([
      company(
        [
          founder("Ana", [
            {
              email: "ana@acme.example",
              kind: "founder_personal",
              source_url: "https://acme.example/team",
              quote: "Write to ana@acme.example",
            },
          ]),
          founder("Bo", []),
        ],
        [
          {
            email: "hello@acme.example",
            kind: "company_inbox",
            inbox: "general",
            source_url: "https://acme.example/contact",
            quote: "hello@acme.example",
          },
          { email: "x@acme.example", kind: "company_inbox", inbox: "general", source_url: "", quote: "x@acme.example" },
        ],
      ),
    ]);
    expect(kept?.founders.map((f) => f.name)).toEqual(["Ana"]);
    expect(kept?.company_emails.map((e) => e.email)).toEqual(["hello@acme.example"]);
  });

  test("drops a company with no posted email", () => {
    expect(postedContactsOnly([company([founder("Bo", [])], [])])).toEqual([]);
  });

  test("drops privacy, DPO, legal, security, accessibility, abuse and compliance desks", () => {
    const inbox = (email: string) => ({
      email,
      kind: "company_inbox",
      inbox: "support",
      source_url: "https://acme.example/p",
      quote: email,
    });
    const desks = ["privacy", "dpo", "legal", "security", "accessibility", "abuse", "compliance"].map((local) =>
      inbox(`${local}@acme.example`),
    );
    expect(postedContactsOnly([company([], desks)])).toEqual([]);
    const [kept] = postedContactsOnly([company([], [...desks, inbox("hello@acme.example"), inbox("legalteam@acme.example")])]);
    expect(kept?.company_emails.map((e) => e.email)).toEqual(["hello@acme.example", "legalteam@acme.example"]);
  });
});
