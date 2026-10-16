import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEPLOY_URL } from "../lib/landing";
import { config, cronsFor } from "../vercel";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploy = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8");

test("the landing deploy clones SignalRound and requests its ingestion credential", () => {
  const link = new URL(DEPLOY_URL);
  expect(link.searchParams.get("repository-url")).toBe("https://github.com/aasimahmed177-web/SignalRound");
  // Native collection needs no scraping-vendor key. MCP_API_KEY is added later: a password-protected
  // deployment refuses MCP until it is set, and nothing else needs it.
  expect(link.searchParams.get("env")?.split(",")).toEqual(["DASHBOARD_PASSWORD", "CRON_SECRET", "SIGNAL_INGEST_KEY"]);
  expect(readme).toContain("retained as the `upstream` remote");
});

test("a clone deploys on Vercel Hobby by default, and FIREROUND_SCHEDULE=frequent restores the full cadence", () => {
  const onceADay = /^\d+ \d+ \* \* \*$/;
  const daily = cronsFor(undefined);
  expect(daily.every(({ schedule }) => onceADay.test(schedule))).toBe(true);
  expect(config.crons).toEqual(cronsFor(process.env.FIREROUND_SCHEDULE));
  expect(cronsFor("Frequent ")).toEqual(cronsFor("frequent"));
  const frequent = cronsFor("frequent");
  // Every route that runs at all runs in both schedules; only the cadence differs.
  expect(daily.map((c) => c.path).sort()).toEqual(frequent.map((c) => c.path).sort());
  expect(frequent).toContainEqual({ path: "/api/cron/sweep", schedule: "0 * * * *" });
  expect(frequent).toContainEqual({ path: "/api/cron/verify-rounds", schedule: "*/15 * * * *" });
  expect(frequent).toContainEqual({ path: "/api/cron/health", schedule: "*/10 * * * *" });
  for (const { path } of frequent) expect(existsSync(new URL(`../app${path}/route.ts`, import.meta.url))).toBe(true);
  expect(deploy).toContain("FIREROUND_SCHEDULE=frequent");
  expect(deploy).toContain("### Vercel Hobby");
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
