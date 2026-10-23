"use server";

import { auditFunnel, NativeWebClient, readDiscussion } from "@fireround/core/web";
import { attempt } from "@/lib/action-result";
import { auditRenderedPage } from "@/lib/browser-audit";
import { requireDashboard } from "@/lib/dashboard-auth.server";

export async function runWebTool(mode: string, input: string, limit: number) {
  return attempt(async () => {
    await requireDashboard();
    if (typeof input !== "string" || !input.trim() || input.length > 2000)
      throw new Error("Enter a URL or search query under 2000 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Choose a limit from 1 to 25.");
    const client = new NativeWebClient();
    const query = input.trim();
    switch (mode) {
      case "browser":
        return { mode, result: await auditRenderedPage(query) };
      case "discussion":
        return { mode, result: await readDiscussion(query, limit) };
      case "audit":
        return { mode, result: await auditFunnel(query.split(/\s+/), limit) };
      case "adaptive":
        return { mode, result: await client.scrape(query, { adaptive: true }) };
      case "reader":
        return { mode, result: await client.scrape(query, { reader: "agent-reach", timeout: 30_000 }) };
      case "scrape":
        return { mode, result: await client.scrape(query, { formats: ["markdown", "links"] }) };
      case "map":
        return { mode, result: await client.map(query, { limit }) };
      case "crawl":
        return { mode, result: await client.crawl(query, { limit, maxDepth: 2 }) };
      case "search":
        return { mode, result: await client.search(query, { limit }) };
      default:
        throw new Error("Choose a supported web operation.");
    }
  });
}
