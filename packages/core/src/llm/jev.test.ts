// The Jev client against a scripted fetch: no network, no key needed.

import { describe, expect, test } from "vitest";
import { jevCertaintyClassifier, jevClassifier, jevIssuerClassifier, jevMoneyClassifier } from "./jev.ts";

const answer = {
  model: "jev-1.13.0",
  answers: {
    about_raise: { type: "noul", noul: 0.97 },
    is_round: { type: "noul", noul: 0.98 },
    kind: { type: "choice", choice: "news", confidence: 1, probabilities: { news: 1 } },
  },
};
const page = {
  company: "PlanetScale",
  url: "https://techcrunch.com/x",
  title: "PlanetScale raises $30M Series B",
  snippet: "led by Insight Partners",
};

function scripted(...replies: Array<Response | Error>) {
  const bodies: Array<Record<string, unknown>> = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no reply");
    return next;
  }) as unknown as typeof fetch;
  return { f, bodies };
}

describe("jevClassifier", () => {
  test("without a key there is no classifier, so every caller keeps its rules", () => {
    expect(jevClassifier({ apiKey: null })).toBeNull();
    expect(jevClassifier({ apiKey: "" })).toBeNull();
  });

  test("a page's verdict: the probabilities and the kind, asked about the company by name", async () => {
    const { f, bodies } = scripted(Response.json(answer));
    const classify = jevClassifier({ apiKey: "k", fetch: f });
    expect(await classify?.([page])).toEqual([{ aboutRaise: 0.97, isRound: 0.98, kind: "news", kindConfidence: 1, model: "jev-1.13.0" }]);
    expect(bodies[0]).toMatchObject({ model: "jev-latest", state: { company: "PlanetScale", title: page.title, snippet: page.snippet } });
    expect(JSON.stringify(bodies[0].questions)).toContain("a funding round that PlanetScale raised");
  });

  test("a 429 or 529 is tried once more; a second refusal, an error, or a malformed answer is no verdict", async () => {
    const retried = scripted(new Response("busy", { status: 429 }), Response.json(answer));
    expect((await jevClassifier({ apiKey: "k", fetch: retried.f })?.([page]))?.[0]?.kind).toBe("news");
    expect(retried.bodies).toHaveLength(2);
    const refused = scripted(new Response("busy", { status: 529 }), new Response("busy", { status: 529 }));
    expect(await jevClassifier({ apiKey: "k", fetch: refused.f })?.([page])).toEqual([null]);
    const thrown = scripted(new Error("timeout"));
    expect(await jevClassifier({ apiKey: "k", fetch: thrown.f })?.([page])).toEqual([null]);
    const odd = scripted(Response.json({ answers: { kind: { choice: "blog" } } }));
    expect(await jevClassifier({ apiKey: "k", fetch: odd.f })?.([page])).toEqual([null]);
  });
});

describe("jevMoneyClassifier", () => {
  test("asks a typed choice about the quoted figure and abstains without a key or on failure", async () => {
    expect(jevMoneyClassifier({ apiKey: null })).toBeNull();
    const { f, bodies } = scripted(Response.json({ answers: { money_kind: { choice: "cumulative", confidence: 0.94 } } }));
    const check = jevMoneyClassifier({ apiKey: "k", fetch: f });
    expect(await check?.("Parallax has raised $117m to date.", "$117m")).toBe("cumulative");
    expect(bodies[0]).toMatchObject({ state: { figure: "$117m", sentence: "Parallax has raised $117m to date." } });
    expect((bodies[0].questions as Record<string, { type: string }>).money_kind.type).toBe("choice");
    const malformed = scripted(Response.json({ answers: { money_kind: { choice: "guess", confidence: 1 } } }));
    expect(await jevMoneyClassifier({ apiKey: "k", fetch: malformed.f })?.("Acme raised $5m.", "$5m")).toBeNull();
  });
});

describe("jevCertaintyClassifier", () => {
  test("asks for the sentence's certainty and abstains without a key or with low confidence", async () => {
    expect(jevCertaintyClassifier({ apiKey: null })).toBeNull();
    const { f, bodies } = scripted(Response.json({ answers: { certainty: { choice: "expected", confidence: 0.91 } } }));
    expect(await jevCertaintyClassifier({ apiKey: "k", fetch: f })?.("Modal Labs is nearing a $750 million funding round.")).toBe(
      "expected",
    );
    expect(bodies[0]).toMatchObject({ state: { sentence: "Modal Labs is nearing a $750 million funding round." } });
    const weak = scripted(Response.json({ answers: { certainty: { choice: "announced", confidence: 0.4 } } }));
    expect(await jevCertaintyClassifier({ apiKey: "k", fetch: weak.f })?.("Acme raised $5 million.")).toBeNull();
  });
});

describe("jevIssuerClassifier", () => {
  test("checks the recipient against the evidence and company line, abstaining on low confidence or error", async () => {
    expect(jevIssuerClassifier({ apiKey: null })).toBeNull();
    const { f, bodies } = scripted(Response.json({ answers: { issuer_type: { choice: "fund", confidence: 0.92 } } }));
    const classify = jevIssuerClassifier({ apiKey: "k", fetch: f });
    expect(
      await classify?.("Unicorn Frontier Fund-I", "an IIT Madras-backed venture fund", "The fund reached its first close of ₹450 crore."),
    ).toBe("fund");
    expect(bodies[0]).toMatchObject({
      state: {
        company: "Unicorn Frontier Fund-I",
        company_line: "an IIT Madras-backed venture fund",
        evidence: "The fund reached its first close of ₹450 crore.",
      },
    });
    expect((bodies[0].questions as Record<string, { type: string }>).issuer_type.type).toBe("choice");
    const weak = scripted(Response.json({ answers: { issuer_type: { choice: "listed_company", confidence: 0.6 } } }));
    expect(await jevIssuerClassifier({ apiKey: "k", fetch: weak.f })?.("Wheels India", null, "QIP")).toBeNull();
    const failed = scripted(new Error("unavailable"));
    expect(await jevIssuerClassifier({ apiKey: "k", fetch: failed.f })?.("Wheels India", null, "QIP")).toBeNull();
  });
});
