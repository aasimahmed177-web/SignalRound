import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "data/india-funding-leads.json";
const leads = JSON.parse(readFileSync(file, "utf8")) as unknown[];
if (!process.env.CONVEX_DEPLOY_KEY) throw new Error("CONVEX_DEPLOY_KEY is required");

for (const lead of leads) {
  execFileSync("pnpm", ["exec", "convex", "run", "leads:upsert", JSON.stringify(lead), "--prod"], {
    env: process.env,
    stdio: "inherit",
  });
}

execFileSync("pnpm", ["exec", "convex", "run", "leads:stats", "{}", "--prod"], {
  env: process.env,
  stdio: "inherit",
});
