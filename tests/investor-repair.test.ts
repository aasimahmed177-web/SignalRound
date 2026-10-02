// The investor directory brought under today's name hygiene (P1-12).
import { schema } from "@fireround/core/db";
import { describe, expect, test } from "vitest";
import { applyInvestorRepair, type InvestorDecision, planInvestorRepair } from "../lib/investor-repair";
import { persistRecords } from "../lib/persist";
import { record, testDb } from "./helpers";

describe("repair-investors", () => {
  test("drops descriptions, folds spellings into their firm, holds a namesake, and removes orphans", async () => {
    const db = await testDb();
    const round = record({ company_name: "Acme", lead_investors: ["Fund One"] });
    await persistRecords(db, [round], "series-a-b", "run-1");
    const { investors, roundInvestors } = schema;
    // Rows the way the store held them before the rules: old keys, old names.
    await db.insert(investors).values([
      { id: "executives from openai", name: "executives from OpenAI" },
      { id: "andreessen horowitz s speedrun accelerator", name: "a16z’s Speedrun accelerator" },
      { id: "andreessen horowitz speedrun", name: "a16z speedrun" },
      { id: "wells fargo and", name: "Wells Fargo & Co" },
      { id: "sovereign s", name: "Sovereign’s Capital" },
      { id: "sovereign", name: "Sovereign AI" },
      { id: "toyota s woven", name: "Toyota’s Woven Capital" },
      { id: "woven", name: "Woven Capital" },
      { id: "nobody links me", name: "Nobody Links Me" },
    ]);
    await db.insert(roundInvestors).values([
      { roundId: round.id, investorId: "executives from openai", role: "participant" },
      { roundId: round.id, investorId: "andreessen horowitz s speedrun accelerator", role: "lead" },
      { roundId: round.id, investorId: "andreessen horowitz speedrun", role: "participant" },
      { roundId: round.id, investorId: "wells fargo and", role: "participant" },
      { roundId: round.id, investorId: "sovereign s", role: "participant" },
      { roundId: round.id, investorId: "sovereign", role: "participant" },
      { roundId: round.id, investorId: "toyota s woven", role: "participant" },
      { roundId: round.id, investorId: "woven", role: "participant" },
    ]);
    const plan = await planInvestorRepair(db);
    expect(plan.drop.map((d) => d.id)).toEqual(["executives from openai"]);
    // "Sovereign AI" keeps its "AI" in today's key, which frees "sovereign" for Sovereign's Capital.
    expect(plan.merge.map((m) => [m.id, m.into]).sort()).toEqual([
      ["andreessen horowitz s speedrun accelerator", "andreessen horowitz speedrun"],
      ["sovereign s", "sovereign"],
      ["sovereign", "sovereign ai"],
      ["toyota s woven", "woven"],
      ["wells fargo and", "wells fargo"],
    ]);
    expect(plan.merge.findIndex((m) => m.id === "sovereign")).toBeLessThan(plan.merge.findIndex((m) => m.id === "sovereign s"));
    expect(plan.conflicts).toEqual([]);
    expect(plan.orphans).toEqual(["nobody links me"]);

    await applyInvestorRepair(db, plan);
    const links = await db.select().from(roundInvestors);
    const role = (id: string) => links.find((l) => l.investorId === id)?.role;
    // The speedrun link keeps the lead the accelerator spelling carried.
    expect(role("andreessen horowitz speedrun")).toBe("lead");
    expect(role("wells fargo")).toBe("participant");
    expect(role("executives from openai")).toBeUndefined();
    expect(role("sovereign s")).toBeUndefined();
    const names = new Map((await db.select().from(investors)).map((r) => [r.id, r.name]));
    expect(names.get("sovereign")).toBe("Sovereign’s Capital");
    expect(names.get("sovereign ai")).toBe("Sovereign AI");
    const ids = [...names.keys()];
    expect(ids).not.toContain("nobody links me");
    expect(ids).not.toContain("wells fargo and");
    // Safe to run again: nothing left to do.
    const again = await planInvestorRepair(db);
    expect([again.drop.length, again.merge.length, again.orphans.length, again.conflicts.length]).toEqual([0, 0, 0, 0]);
  });

  test("display hygiene renames in place; a person's decisions rename with a site or force a merge, and a stale one is skipped", async () => {
    const db = await testDb();
    const round = record({ company_name: "Acme", lead_investors: ["Fund One"] });
    await persistRecords(db, [round], "series-a-b", "run-1");
    const { investors, roundInvestors } = schema;
    await db.insert(investors).values([
      { id: "eli lilly", name: "Eli Lilly (NYSE: LLY)" },
      { id: "arm", name: "Arm Holdings Inc", domain: "arm.com" },
      { id: "sovereign", name: "Sovereign AI" },
      { id: "the d e shaw", name: "the D. E. Shaw group" },
      { id: "d e shaw", name: "D. E. Shaw Ventures", domain: "deshaw.com" },
    ]);
    await db.insert(roundInvestors).values(
      ["eli lilly", "arm", "sovereign", "the d e shaw", "d e shaw"].map((investorId) => ({
        roundId: round.id,
        investorId,
        role: "participant" as const,
      })),
    );
    const decisions: InvestorDecision[] = [
      {
        kind: "rename",
        id: "sovereign",
        from: "Sovereign AI",
        to: "Sovereign’s Capital",
        domain: "sovereignscapital.com",
        reason: "r",
        evidence: "e",
      },
      { kind: "merge", id: "the d e shaw", from: "the D. E. Shaw group", into: "d e shaw", reason: "r", evidence: "e" },
      { kind: "rename", id: "gone", from: "Gone Capital", to: "Gone", reason: "r", evidence: "e" },
    ];
    const plan = await planInvestorRepair(db, decisions);
    expect(plan.rename.map((r) => [r.id, r.to]).sort()).toEqual([
      ["arm", "Arm Holdings"],
      ["eli lilly", "Eli Lilly"],
      ["sovereign", "Sovereign’s Capital"],
    ]);
    expect(plan.merge.map((m) => [m.id, m.into])).toEqual([["the d e shaw", "d e shaw"]]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.stale).toEqual([{ id: "gone", expected: "Gone Capital", found: null }]);

    await applyInvestorRepair(db, plan);
    const rows = new Map((await db.select().from(investors)).map((r) => [r.id, r]));
    expect(rows.get("eli lilly")?.name).toBe("Eli Lilly");
    expect(rows.get("arm")).toMatchObject({ name: "Arm Holdings", domain: "arm.com" });
    expect(rows.get("sovereign")).toMatchObject({ name: "Sovereign’s Capital", domain: "sovereignscapital.com", logoUrl: null });
    expect(rows.has("the d e shaw")).toBe(false);
    const links = await db.select().from(roundInvestors);
    expect(links.filter((l) => l.investorId === "d e shaw")).toHaveLength(1);
  });
});
