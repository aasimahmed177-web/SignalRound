import { describe, expect, test } from "vitest";
import { companyNameFrom } from "./brand-name.ts";

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
});
