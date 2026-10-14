import { describe, expect, test } from "vitest";
import { companyNameFrom } from "./brand-name.ts";
import { preferredCompanyName } from "./keys.ts";

describe("companyNameFrom: a new company is named by its strongest name signal", () => {
  test("a subpage's title or a blog post's heading never names the company", () => {
    expect(companyNameFrom({ stated: "Coinbase", brand: "About" }, "coinbase.com")).toBe("Coinbase");
    expect(companyNameFrom({ brand: "About" }, "coinbase.com")).toBe("Coinbase");
    expect(companyNameFrom({ stated: "The Browser Company", brand: "Notes on Roadtrips" }, "thebrowser.company")).toBe(
      "The Browser Company",
    );
    expect(companyNameFrom({ brand: "Notes on Roadtrips" }, "thebrowser.company")).toBe("Thebrowser");
  });

  test("a homepage's tagline never names the company", () => {
    expect(companyNameFrom({ stated: "Meesho", brand: "Online Shopping Site for Fashion, Electronics, Home & More" }, "meesho.com")).toBe(
      "Meesho",
    );
    expect(companyNameFrom({ stated: "Flink", brand: "Groceries delivered in minutes" }, "goflink.com")).toBe("Flink");
    expect(companyNameFrom({ brand: "Groceries delivered in minutes" }, "goflink.com")).toBe("Goflink");
    expect(companyNameFrom({ siteName: "Pinecone", brand: "The trusted AI knowledge company" }, "pinecone.io")).toBe("Pinecone");
    expect(companyNameFrom({ siteName: "Weaviate", brand: "The AI database developers love" }, "weaviate.io")).toBe("Weaviate");
    expect(companyNameFrom({ stated: "fal", brand: "Gen Media AI Inference Platform & Serverless GPUs" }, "fal.ai")).toBe("fal");
    expect(companyNameFrom({ stated: "N26", brand: "Love your bank" }, "n26.com")).toBe("N26");
  });

  test("a strong signal outranks a brand read that spells the domain with a word too many", () => {
    expect(companyNameFrom({ stated: "Swiggy", brand: "Swiggy.com" }, "swiggy.com")).toBe("Swiggy");
    expect(companyNameFrom({ stated: "Airwallex", brand: "Airwallex US" }, "airwallex.com")).toBe("Airwallex");
    expect(companyNameFrom({ stated: "Hims & Hers", brand: "hims" }, "hims.com")).toBe("Hims & Hers");
    expect(companyNameFrom({ stated: "Bluesky" }, "bsky.social")).toBe("Bluesky");
  });

  test("a renamed company keeps its current name over a former one the reading recalls", () => {
    expect(companyNameFrom({ stated: "xAI", siteName: "SpaceXAI", brand: "xAI" }, "x.ai")).toBe("SpaceXAI");
    expect(companyNameFrom({ stated: "SpaceXAI", brand: "xAI" }, "x.ai")).toBe("SpaceXAI");
    expect(companyNameFrom({ siteName: "SpaceXAI", brand: "xAI", title: "Grok" }, "x.ai")).toBe("SpaceXAI");
  });

  test("a brand read or title that spells the domain still names a company with no stronger signal", () => {
    expect(companyNameFrom({ brand: "Resend · Email for developers" }, "resend.com")).toBe("Resend");
    expect(companyNameFrom({ brand: "Kalshi" }, "kalshi.com")).toBe("Kalshi");
    expect(companyNameFrom({ title: "Trade Republic | Invest, spend and bank" }, "traderepublic.com")).toBe("Trade Republic");
  });

  test("a stated name off the domain is kept; a page label or sentence is not a name", () => {
    expect(companyNameFrom({ stated: "Payward", brand: "Kraken" }, "kraken.com")).toBe("Kraken");
    expect(companyNameFrom({ stated: "Meta", brand: "Connect with friends" }, "facebook.com")).toBe("Meta");
    expect(companyNameFrom({ stated: "Home", siteName: "Blog" }, "acme.com")).toBe("Acme");
    expect(companyNameFrom({}, null)).toBeNull();
  });

  test("a name written as the domain's bare label gives way to the same name with its capitals", () => {
    expect(companyNameFrom({ stated: "glycoera", brand: "GlycoEra" }, "glycoera.com")).toBe("GlycoEra");
    expect(companyNameFrom({ stated: "newlimit", brand: "NewLimit" }, "newlimit.com")).toBe("NewLimit");
    expect(companyNameFrom({ stated: "xpanceo", brand: "XPANCEO" }, "xpanceo.com")).toBe("XPANCEO");
    expect(companyNameFrom({ stated: "dreamgames", brand: "Dream Games" }, "dreamgames.com")).toBe("Dream Games");
    expect(companyNameFrom({ stated: "ambiencehealthcare", brand: "Ambience Healthcare" }, "ambiencehealthcare.com")).toBe(
      "Ambience Healthcare",
    );
    expect(companyNameFrom({ stated: "beta", brand: "BETA Technologies" }, "beta.team")).toBe("BETA Technologies");
    expect(companyNameFrom({ stated: "beaconsoftware", brand: "Beacon" }, "beaconsoftware.com")).toBe("Beacon");
    expect(companyNameFrom({ stated: "Stord", siteName: "stord", brand: "stord" }, "stord.com")).toBe("Stord");
    expect(companyNameFrom({ stated: "Hub International", siteName: "hub-international" }, "hubinternational.com")).toBe(
      "Hub International",
    );
  });

  test("the domain written out gives way to the name without it", () => {
    expect(companyNameFrom({ stated: "ManyChat", siteName: "manychat.com", brand: "manychat.com" }, "manychat.com")).toBe("ManyChat");
    expect(companyNameFrom({ stated: "Thunes", siteName: "Thunes.com", brand: "Thunes.com" }, "thunes.com")).toBe("Thunes");
    expect(companyNameFrom({ siteName: "noon.com", brand: "noon.com" }, "noon.com")).toBe("noon");
    expect(companyNameFrom({ brand: "Cal.com" }, "cal.com")).toBe("Cal.com");
  });

  test("the name the reading was asked about is no signal of how the company writes it", () => {
    const asked = (domain: string) => domain.split(".")[0];
    expect(companyNameFrom({ stated: "sandboxaq", placeholder: asked("sandboxaq.com") }, "sandboxaq.com")).toBe("Sandboxaq");
    expect(companyNameFrom({ stated: "firstdue", brand: "Fire and EMS Software", placeholder: "firstdue" }, "firstdue.com")).toBe(
      "Firstdue",
    );
    expect(companyNameFrom({ stated: "porter", brand: "Reliable & Hassle", placeholder: "porter" }, "porter.in")).toBe("Porter");
    expect(companyNameFrom({ stated: "aspida", brand: "Aspida", placeholder: "aspida" }, "aspida.com")).toBe("Aspida");
    // A brand that writes itself in lowercase keeps it.
    expect(companyNameFrom({ brand: "bunq" }, "bunq.com")).toBe("bunq");
    expect(companyNameFrom({ stated: "fal", brand: "Gen Media AI Inference Platform & Serverless GPUs" }, "fal.ai")).toBe("fal");
  });
});

describe("preferredCompanyName: a company read again keeps its brand over its legal name", () => {
  test("a legal name never replaces the stored brand (the 2026-10-14 sweep's cases)", () => {
    expect(preferredCompanyName("Kalshi", "Kalshi Inc.")).toBe("Kalshi");
    expect(preferredCompanyName("Upgrade", "Upgrade, Inc.")).toBe("Upgrade");
    expect(preferredCompanyName("ICON", "Icon Technology Inc.")).toBe("ICON");
    expect(preferredCompanyName("Precision Neuroscience", "Precision Neuroscience Corporation")).toBe("Precision Neuroscience");
    expect(preferredCompanyName("Helical Fusion", "Helical Fusion Co., Ltd.")).toBe("Helical Fusion");
    expect(preferredCompanyName("Dialybrid", "Dialybrid S.r.l.")).toBe("Dialybrid");
    expect(preferredCompanyName("Finches", "Finches GmbH")).toBe("Finches");
  });

  test("the brand replaces a stored legal name, whichever came first", () => {
    expect(preferredCompanyName("Kalshi Inc.", "Kalshi")).toBe("Kalshi");
    expect(preferredCompanyName("Upwind Security Inc.", "Upwind Security")).toBe("Upwind Security");
    expect(preferredCompanyName("Icon Technology Inc.", "ICON")).toBe("ICON");
  });

  test("without a legal form the fuller name still wins, and a brand ending in '& Co' is no legal name", () => {
    expect(preferredCompanyName("Scale", "Scale AI")).toBe("Scale AI");
    expect(preferredCompanyName("Scale AI", "Scale")).toBe("Scale AI");
    expect(preferredCompanyName("Sober", "Sober & Co")).toBe("Sober & Co");
  });

  test("names under different keys are not a brand and its legal name: the longer one wins as before", () => {
    expect(preferredCompanyName("Ramp", "Ramp Business Corporation")).toBe("Ramp Business Corporation");
  });
});
