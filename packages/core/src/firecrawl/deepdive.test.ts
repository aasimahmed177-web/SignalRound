// The deep-dive prompt names the company, its site, and what is already known, asks the agent to
// leave unstated fields null rather than guess, and keeps customers and backers apart. The durable
// pair (start, then poll in bounded steps) hands back a finished run or one still processing.

import type { Firecrawl } from "firecrawl";
import { describe, expect, test } from "vitest";
import { awaitDeepDive, DEEP_DIVE_EFFORT, DEEP_DIVE_MAX_CREDITS, deepDivePrompt, startDeepDive } from "./deepdive.ts";

describe("deepDivePrompt", () => {
  test("names the company, its site, and what is known, and asks for null where unstated", () => {
    const p = deepDivePrompt({ company_name: "Acme", website: null, domain: "acme.com", description: "Acme builds widgets." });
    expect(p).toContain("Build a dossier on the company Acme.");
    expect(p).toContain("Its website is https://acme.com.");
    expect(p).toContain("What we know so far: Acme builds widgets.");
    expect(p).toContain("Leave a field null or empty when no page states it");
    expect(p).toContain("an investor, accelerator, or grant program is a backer, never a customer");
  });
});

const dossier = {
  one_liner: "Acme builds widgets.",
  founded_year: 2021,
  founders: [],
  headcount_estimate: "Not stated",
  total_raised_as_written: null,
  prior_rounds: [],
  customers: ["Globex", "Globex", ""],
  investors_and_backers: [],
  competitors: [],
  business_model: null,
  why_it_matters: "It matters.",
  sources: ["https://acme.com", "not a url"],
};

describe("startDeepDive and awaitDeepDive", () => {
  test("starts at effort high under the 2,500 cap, then polls until the run finishes, cleaning what it returns", async () => {
    const started: unknown[] = [];
    const statuses = [{ status: "processing" }, { status: "completed", data: dossier, creditsUsed: 140 }];
    const client = {
      async startAgent(args: unknown) {
        started.push(args);
        return { success: true, id: "job-1" };
      },
      async getAgentStatus() {
        return statuses.shift();
      },
    } as unknown as Firecrawl;
    const id = await startDeepDive(client, { company_name: "Acme", website: "https://acme.com", domain: "acme.com", description: null });
    expect(id).toBe("job-1");
    expect(started[0]).toMatchObject({ model: "spark-2", maxCredits: DEEP_DIVE_MAX_CREDITS, effort: DEEP_DIVE_EFFORT });
    expect(DEEP_DIVE_MAX_CREDITS).toBe(2500);
    expect(DEEP_DIVE_EFFORT).toBe("high");
    const result = await awaitDeepDive(client, id, Date.now(), { sleep: async () => undefined });
    expect(result.status).toBe("completed");
    expect(result.creditsUsed).toBe(140);
    expect(result.dossier?.headcount_estimate).toBeNull();
    expect(result.dossier?.customers).toEqual(["Globex"]);
    expect(result.dossier?.sources).toEqual(["https://acme.com"]);
  });

  test("hands back a run still processing when the step's budget runs out", async () => {
    const client = { getAgentStatus: async () => ({ status: "processing" }) } as unknown as Firecrawl;
    const result = await awaitDeepDive(client, "job-2", Date.now(), { budgetSeconds: 0, sleep: async () => undefined });
    expect(result).toMatchObject({ status: "processing", dossier: null });
  });

  test("a job that does not start throws", async () => {
    const client = { startAgent: async () => ({ success: false, error: "insufficient credits" }) } as unknown as Firecrawl;
    await expect(startDeepDive(client, { company_name: "Acme", website: null, domain: null, description: null })).rejects.toThrow(
      "insufficient credits",
    );
  });
});
