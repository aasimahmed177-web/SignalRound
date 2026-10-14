// A company asked for by its name as people write it (spaces, mixed case, punctuation, a trailing AI,
// Inc. or Labs) reads that company through /api/v1/companies/{id} and the MCP company tools. Namesakes
// are never picked between silently, and a miss is a 404 that names companies to retry with.
process.env.PGLITE_DIR = "memory://";
process.env.DATABASE_URL = "";

import { normalizeCompanyKey } from "@fireround/core";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as mcpPost } from "../app/api/mcp/route";
import { GET as companyGet } from "../app/api/v1/companies/[id]/route";
import { db } from "../lib/db";
import { persistRecords, setDisposition } from "../lib/persist";
import { record } from "./helpers";

const COMPANIES: Array<[name: string, domain: string | null, disposition?: "review"]> = [
  ["TypeSafe AI", null],
  ["Harmonic Security", "harmonic.security"],
  ["Thinking Machines Lab", "thinkingmachines.ai"],
  ["Safe Superintelligence", "ssi.inc"],
  ["Black Forest Labs", "bfl.ai"],
  ["Scale AI", "scale.com"],
  ["Scale", "scale.dev"],
  ["Hugging Face", "huggingface.co"],
  ["Alice & Bob", "alice-bob.com"],
  ["Alice", "alice.io"],
  ["1Password", "1password.com"],
  ["Character.AI", "character.ai"],
  ["Ghost", "ghost.org"],
  ["Ghost", "ghost.build"],
  ["Odyssey", "odyssey.world"],
  ["Odyssey", "odyssey.energy", "review"],
];

beforeAll(async () => {
  const handle = await db();
  for (const [i, [name, domain, disposition]] of COMPANIES.entries()) {
    const day = `2026-0${1 + (i % 9)}-${String(10 + i).padStart(2, "0")}`;
    const host = (domain ?? `${normalizeCompanyKey(name).replace(/ /g, "")}.example`).replace(/[^a-z0-9.]/g, "");
    const r = record({
      company_name: name,
      company_key: normalizeCompanyKey(name),
      company_domain: domain,
      announced_date: day,
      evidence_quotes: [`${name} raised $20M.`],
      sources: [{ url: `https://news.example/${host}-${i}`, host: "news.example", title: `${name} raises $20M` }],
    });
    const summary = await persistRecords(handle, [r], "series-a-b", `run-${i}`);
    await setDisposition(handle, summary.persistedIds[0] as string, disposition ?? "publish");
  }
  // TypeSafe AI's id is its name, and its site came later, as on the live feed.
  await handle.update(schema.companies).set({ domain: "typesafe.ai" }).where(eq(schema.companies.id, "typesafe"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function company(asked: string) {
  const id = encodeURIComponent(asked);
  const res = await companyGet(new Request(`http://app.test/api/v1/companies/${id}`), { params: Promise.resolve({ id }) } as never);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & { did_you_mean?: Array<{ id: string; name: string }> },
  };
}

async function tool(name: string, args: Record<string, unknown>) {
  const res = await mcpPost(
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  const { result } = JSON.parse(data ? data.slice(6) : body) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: result.isError ?? false, body: JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown> };
}

const NAMES: Array<[asked: string, id: string]> = [
  ["TypeSafe AI", "typesafe"],
  ["typesafe ai", "typesafe"],
  ["Typesafe", "typesafe"],
  ["typesafe.ai", "typesafe"],
  ["Harmonic Security", "harmonic.security"],
  ["Thinking Machines Lab", "thinkingmachines.ai"],
  ["Thinking Machines", "thinkingmachines.ai"],
  ["Safe Superintelligence", "ssi.inc"],
  ["Safe Superintelligence Inc.", "ssi.inc"],
  ["Black Forest Labs", "bfl.ai"],
  ["black forest", "bfl.ai"],
  ["Scale AI", "scale.com"],
  ["Scale", "scale.dev"],
  ["Hugging Face", "huggingface.co"],
  ["HUGGING FACE, Inc.", "huggingface.co"],
  ["hugging-face", "huggingface.co"],
  ["Alice & Bob", "alice-bob.com"],
  ["Alice and Bob", "alice-bob.com"],
  ["Alice", "alice.io"],
  ["1Password", "1password.com"],
  ["Character.AI", "character.ai"],
  ["Character AI", "character.ai"],
  ["Odyssey", "odyssey.world"],
];

describe("a company by its name", () => {
  test.each(NAMES)("%s reads %s through the API and both MCP tools", async (asked, id) => {
    const api = await company(asked);
    expect(api.status).toBe(200);
    expect(api.body.id).toBe(id);
    expect(api.body).not.toHaveProperty("matched_from");
    const profile = await tool("get_company_profile", { id: asked });
    expect(profile.isError).toBe(false);
    expect(profile.body).toEqual(api.body);
    const rounds = await tool("get_company", { company: asked });
    expect(rounds.isError).toBe(false);
    expect(rounds.body.id).toBe(id);
    expect((rounds.body.rounds as unknown[]).length).toBe(1);
  });

  test("a typo one edit away still reads the company, and says so", async () => {
    const { status, body } = await company("Typsafe AI");
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "typesafe", matched_from: "typsafe ai" });
  });

  test("namesakes are listed to choose from, never one picked", async () => {
    const { status, body } = await company("Ghost");
    expect(status).toBe(404);
    expect(body.error).toMatch(/^More than one company goes by "ghost"\. Did you mean Ghost \(id ghost\.\w+\), Ghost \(id ghost\.\w+\)\?$/);
    expect(body.did_you_mean?.map((c) => c.id).sort()).toEqual(["ghost.build", "ghost.org"]);
    vi.stubEnv("PUBLIC_DEMO", "1");
    const rounds = await tool("get_company", { company: "Ghost" });
    expect(rounds).toEqual({ isError: true, body: { company: "Ghost", rounds: [], ...body } });
    // Each namesake still reads by its own id.
    expect((await company("ghost.build")).body.name).toBe("Ghost");
  });

  test("a site is never read as a company whose name only resembles it", async () => {
    const { status, body } = await company("scale.ai");
    expect(status).toBe(404);
    expect(body.error).toMatch(/^No company matches "scale\.ai" by id, domain or name/);
  });

  test("a miss is a 404 that says no company matches the name and names up to five to retry with", async () => {
    const partial = await company("Hugging");
    expect(partial.status).toBe(404);
    expect(partial.body.error).toMatch(
      /^No company matches "hugging" by id, domain or name; .* Did you mean Hugging Face \(id huggingface\.co\)\?$/,
    );
    expect(partial.body.did_you_mean).toEqual([{ id: "huggingface.co", name: "Hugging Face" }]);
    const broad = await company("a");
    expect(broad.status).toBe(404);
    expect(broad.body.did_you_mean?.length).toBe(5);
    const none = await company("Nobody Anywhere Inc.");
    expect(none).toEqual({ status: 404, body: { error: expect.stringMatching(/^No company matches/), did_you_mean: [] } });
    vi.stubEnv("PUBLIC_DEMO", "1");
    const mcp = await tool("get_company", { company: "Nobody Anywhere Inc." });
    expect(mcp).toEqual({ isError: true, body: { company: "Nobody Anywhere Inc.", rounds: [], ...none.body } });
  });
});
