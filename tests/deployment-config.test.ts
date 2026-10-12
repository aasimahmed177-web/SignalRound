import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEPLOY_URL } from "../lib/landing";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploy = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8");

test("the one-click deployment asks only for what a first deploy needs, and the landing page's button is the README's", () => {
  const link = readme.match(/https:\/\/vercel\.com\/new\/clone\?[^)]+/)?.[0] ?? "";
  expect(link).not.toBe("");
  // MCP_API_KEY is added later: a password-protected deployment refuses MCP until it is set, and nothing else needs it.
  expect(new URL(link).searchParams.get("env")?.split(",")).toEqual(["FIRECRAWL_API_KEY", "DASHBOARD_PASSWORD", "CRON_SECRET"]);
  expect(DEPLOY_URL).toBe(link);
});

test("sub-daily Vercel crons have a Pro warning next to Deploy and an authenticated Hobby alternative", () => {
  const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons as Array<{ schedule: string }>;
  expect(crons.some(({ schedule }) => schedule.split(" ")[1].includes("*"))).toBe(true);
  expect(readme.slice(readme.indexOf("Deploy with Vercel"), readme.indexOf("![Fireround:"))).toContain("Vercel Pro");
  expect(deploy).toContain("### Vercel Hobby");
  expect(deploy).toContain('"schedule": "0 0 * * *"');
  expect(deploy).toContain(`\${{ secrets.CRON_SECRET }}`);
  expect(deploy).toContain("Authorization: Bearer $CRON_SECRET");
});

test("deployment documentation makes the webhook signature mandatory and the pool default explicit", () => {
  expect(deploy).toContain("never a replacement for the signature");
  expect(deploy).toContain("defaults to three connections per process");
  expect(readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8")).toContain("pg pool (default 3)");
});

test("Slack privacy copy discloses install identifiers used for credential revocation", () => {
  const controls = readFileSync(new URL("../components/slack/install-controls.tsx", import.meta.url), "utf8");
  const slack = readFileSync(new URL("../docs/slack.md", import.meta.url), "utf8");
  expect(controls).toContain("Slack install IDs");
  expect(controls).not.toContain("Nothing else");
  expect(slack).toContain("installing-user IDs to match token revocations");
  expect(slack).not.toContain("no user id");
});
