// The health checks' verdicts from fixtures, the schedule each lane owes under the coverage plan, and
// the incident state machine that keeps alerts rare: two failing checks to open, one message per
// incident, two passing checks to recover, and a daily cap.

import { describe, expect, test } from "vitest";
import { coverageFor } from "../lib/coverage";
import {
  advance,
  alertMessage,
  CONFIRM_CHECKS,
  DAILY_ALERT_CAP,
  dbFinding,
  delivered,
  deliveriesFinding,
  emptyHealthState,
  errorRateFindings,
  type Finding,
  freshnessFinding,
  type HealthState,
  type LaneContext,
  laneExpectations,
  laneFindings,
  lastDueTick,
  longestTickGapMs,
  pagesFinding,
  parseHealthState,
  redact,
  spendFinding,
  undelivered,
} from "../lib/health";

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date("2026-09-25T14:05:00Z"); // a Friday

const fail = (key: string, title = `${key} fails`): Finding => ({ key, ok: false, title, detail: "detail", cause: "cause", link: "/runs" });
const ok = (key: string): Finding => ({ key, ok: true, title: key, detail: "", cause: "", link: "/runs" });
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

/** Runs one check and applies the delivery the runner would make. */
function check(state: HealthState, findings: Finding[], when: Date, complete = true) {
  const step = advance(state, findings, when, complete);
  return { step, state: delivered(step) };
}

describe("the incident state machine", () => {
  test("one failing check never alerts, and a pass forgets it (flap suppression)", () => {
    let s = emptyHealthState(T0);
    const a = check(s, [fail("db")], at(0));
    expect(a.step.opened).toEqual([]);
    s = a.state;
    expect(s.incidents.db.fails).toBe(1);
    const b = check(s, [ok("db")], at(10));
    expect(b.step.recovered).toEqual([]);
    expect(b.state.incidents.db).toBeUndefined();
    // Fail, pass, fail, pass: never two in a row, never a message.
    s = b.state;
    for (let i = 0; i < 6; i++) {
      const c = check(s, [i % 2 === 0 ? fail("db") : ok("db")], at(20 + i * 10));
      expect(c.step.opened).toEqual([]);
      expect(c.step.recovered).toEqual([]);
      s = c.state;
    }
    expect(s.sent).toBe(0);
  });

  test("the second consecutive failure opens the incident once; later failures stay quiet (dedupe)", () => {
    let s = emptyHealthState(T0);
    s = check(s, [fail("db")], at(0)).state;
    const second = check(s, [fail("db")], at(10));
    expect(CONFIRM_CHECKS).toBe(2);
    expect(second.step.opened.map((o) => o.key)).toEqual(["db"]);
    expect(second.step.opened[0].since).toBe(at(0).toISOString());
    s = second.state;
    expect(s.incidents.db.alerted).toBe(true);
    expect(s.sent).toBe(1);
    for (let i = 2; i < 10; i++) {
      const next = check(s, [fail("db", `db fails differently ${i}`)], at(i * 10));
      expect(next.step.opened).toEqual([]);
      s = next.state;
    }
    // The detail follows the latest check; the start stays the first failure.
    expect(s.incidents.db.title).toBe("db fails differently 9");
    expect(s.incidents.db.since).toBe(at(0).toISOString());
    expect(s.sent).toBe(1);
  });

  test("an announced incident recovers after two passing checks, with one message; a relapse in between stays quiet", () => {
    let s = emptyHealthState(T0);
    s = check(s, [fail("pages")], at(0)).state;
    s = check(s, [fail("pages")], at(10)).state;
    const firstPass = check(s, [ok("pages")], at(20));
    expect(firstPass.step.recovered).toEqual([]);
    const relapse = check(firstPass.state, [fail("pages")], at(30));
    expect(relapse.step.opened).toEqual([]);
    expect(relapse.state.incidents.pages.passes).toBe(0);
    s = check(relapse.state, [ok("pages")], at(40)).state;
    const recovery = check(s, [ok("pages")], at(50));
    expect(recovery.step.recovered.map((r) => r.key)).toEqual(["pages"]);
    expect(recovery.state.incidents.pages).toBeUndefined();
    // Nothing more once it has cleared.
    expect(check(recovery.state, [ok("pages")], at(60)).step.recovered).toEqual([]);
  });

  test("conditions confirmed on the same check open together in one message", () => {
    let s = emptyHealthState(T0);
    s = check(s, [fail("lane:sweep"), fail("lane:trending"), ok("db")], at(0)).state;
    const both = check(s, [fail("lane:sweep"), fail("lane:trending"), ok("db")], at(10));
    expect(both.step.opened.map((o) => o.key)).toEqual(["lane:sweep", "lane:trending"]);
    expect(both.state.sent).toBe(1);
  });

  test("the daily cap holds back new incidents until the next UTC day, then they open if still failing", () => {
    let s = emptyHealthState(T0);
    let minute = 0;
    const failing = (n: number) => Array.from({ length: n }, (_, i) => fail(`k${i}`));
    for (let i = 0; i < DAILY_ALERT_CAP; i++) {
      s = check(s, failing(i + 1), at(minute)).state;
      minute += 10;
      const opened = check(s, failing(i + 1), at(minute));
      expect(opened.step.opened).toHaveLength(1);
      s = opened.state;
      minute += 10;
    }
    expect(s.sent).toBe(DAILY_ALERT_CAP);
    const extra = [...failing(DAILY_ALERT_CAP), fail("late")];
    s = check(s, extra, at(minute)).state;
    const capped = check(s, extra, at(minute + 10));
    expect(capped.step.opened).toEqual([]);
    expect(capped.step.capped.map((c) => c.key)).toEqual(["late"]);
    expect(capped.state.incidents.late.alerted).toBe(false);
    // Recoveries of announced incidents still go out past the cap.
    s = check(capped.state, [ok("k0"), ...extra.slice(1)], at(minute + 20)).state;
    expect(check(s, [ok("k0"), ...extra.slice(1)], at(minute + 30)).step.recovered.map((r) => r.key)).toEqual(["k0"]);
    // The next UTC day the held incident opens.
    const tomorrow = check(capped.state, extra, new Date("2026-09-26T00:05:00Z"));
    expect(tomorrow.step.opened.map((o) => o.key)).toEqual(["late"]);
    expect(tomorrow.state.sent).toBe(1);
    expect(tomorrow.state.day).toBe("2026-09-26");
  });

  test("a message that fails to send is retried: the opening stays unannounced and the recovery stays pending", () => {
    let s = emptyHealthState(T0);
    s = check(s, [fail("db")], at(0)).state;
    const step = advance(s, [fail("db")], at(10), true);
    expect(step.opened).toHaveLength(1);
    const kept = undelivered(s, step);
    expect(kept.incidents.db.alerted).toBe(false);
    expect(kept.sent).toBe(0);
    expect(advance(kept, [fail("db")], at(20), true).opened.map((o) => o.key)).toEqual(["db"]);

    s = delivered(advance(kept, [fail("db")], at(20), true));
    s = check(s, [ok("db")], at(30)).state;
    const recovery = advance(s, [ok("db")], at(40), true);
    expect(recovery.recovered).toHaveLength(1);
    const pending = undelivered(s, recovery);
    expect(advance(pending, [ok("db")], at(50), true).recovered.map((r) => r.key)).toEqual(["db"]);
  });

  test("an incomplete check leaves unnamed incidents alone; a complete one clears an incident no check names any more", () => {
    let s = emptyHealthState(T0);
    s = check(s, [fail("lane:watch"), ok("db")], at(0)).state;
    s = check(s, [fail("lane:watch"), ok("db")], at(10)).state;
    // The database fails, so the lane checks are skipped: the lane incident is untouched.
    const skipped = check(s, [fail("db")], at(20), false);
    expect(skipped.state.incidents["lane:watch"]).toEqual(s.incidents["lane:watch"]);
    // A complete check that no longer names the lane counts it as passing.
    s = check(skipped.state, [ok("db")], at(30)).state;
    const cleared = check(s, [ok("db")], at(40));
    expect(cleared.step.recovered.map((r) => r.key)).toEqual(["lane:watch"]);
  });

  test("stored state round-trips, and anything unreadable starts clean", () => {
    const s = check(emptyHealthState(T0), [fail("db")], at(0)).state;
    expect(parseHealthState(JSON.parse(JSON.stringify(s)), T0)).toEqual(s);
    expect(parseHealthState(null, T0)).toEqual(emptyHealthState(T0));
    expect(parseHealthState({ nope: 1 }, T0).incidents).toEqual({});
  });
});

describe("the message", () => {
  test("says what fails, since when, the likely cause, and one link; no mentions; mrkdwn escaped", () => {
    let s = emptyHealthState(T0);
    const f: Finding = {
      key: "lane:sweep",
      ok: false,
      title: "Sweep lane is late for seed & growth",
      detail: "Owed a run since 12:00 UTC Sep 25.",
      cause: "Vercel Cron is not calling <the sweep>.",
      link: "/runs",
    };
    s = check(s, [f], at(0)).state;
    const step = advance(s, [f], at(10), true);
    const text = alertMessage(step, "https://fireround.dev", at(10), false) ?? "";
    expect(text).toContain("*Fireround alert: Sweep lane is late for seed &amp; growth*");
    expect(text).toContain("Failing since 14:05 UTC Sep 25 (10m 0s). Owed a run since 12:00 UTC Sep 25.");
    expect(text).toContain("Likely cause: Vercel Cron is not calling &lt;the sweep&gt;.");
    expect(text).toContain("<https://fireround.dev/runs|fireround.dev/runs>");
    expect(text.match(/<https?:/g)).toHaveLength(1);
    expect(text).not.toMatch(/<!channel>|<!here>|<!everyone>|@channel/);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  test("a recovery is one line; nothing to say is null; the last message under the cap says so", () => {
    const incident = {
      key: "db",
      title: "Database queries are failing",
      detail: "",
      cause: "",
      link: "/feed",
      since: at(0).toISOString(),
      fails: 0,
      passes: 2,
      alerted: true,
    };
    expect(alertMessage({ opened: [], recovered: [incident] }, "https://fireround.dev", at(75), false)).toBe(
      "*Fireround recovered: Database queries are failing* (failing since 14:05 UTC Sep 25, 1h 15m)",
    );
    expect(alertMessage({ opened: [], recovered: [] }, "https://fireround.dev", at(0), true)).toBeNull();
    expect(alertMessage({ opened: [{ ...incident, alerted: false }], recovered: [] }, "https://fireround.dev", at(10), true)).toContain(
      `Daily cap of ${DAILY_ALERT_CAP} alerts reached`,
    );
  });
});

describe("the database check", () => {
  test("a healthy probe passes", () => {
    expect(dbFinding({ ok: true }).ok).toBe(true);
  });

  test("an unqualified read failing while the qualified one answers names the search_path (September 25)", () => {
    const f = dbFinding({ ok: false, error: 'relation "funding_rounds" does not exist', qualifiedOk: true, searchPath: "" });
    expect(f.ok).toBe(false);
    expect(f.detail).toContain('relation "funding_rounds" does not exist');
    expect(f.cause).toBe('The connection\'s search_path no longer reaches the tables (search_path is "").');
  });

  test("both failing reads as unreachable, and a connection string never reaches the message", () => {
    const f = dbFinding({ ok: false, error: "connect ECONNREFUSED postgres://user:pw@db.example/neondb", qualifiedOk: false });
    expect(f.cause).toMatch(/unreachable/);
    expect(f.detail).not.toContain("user:pw");
    expect(redact("postgresql://a:b@h/d?x=1 failed")).toBe("postgres://[redacted] failed");
  });
});

describe("the pages check", () => {
  test("every probe 2xx passes; a 500 names the path and the logs; no answer names the deployment", () => {
    expect(
      pagesFinding([
        { path: "/", status: 200 },
        { path: "/feed", status: 200 },
      ]).ok,
    ).toBe(true);
    const broken = pagesFinding([
      { path: "/", status: 200 },
      { path: "/feed", status: 500 },
      { path: "/api/v1/rounds?limit=1", status: 503 },
    ]);
    expect(broken.title).toBe("Public pages are failing: /feed 500, /api/v1/rounds?limit=1 503");
    expect(broken.cause).toContain("/feed");
    expect(broken.link).toBe("/feed");
    const down = pagesFinding([{ path: "/", status: null, error: "The operation was aborted due to timeout" }]);
    expect(down.title).toBe("Public pages are failing: / no answer");
    expect(down.cause).toMatch(/did not answer in time/);
  });
});

describe("the lane schedule, from the coverage plan", () => {
  const presets = [
    { slug: "series-a-b", watchSites: ["https://a.test"], watchQueries: [] },
    { slug: "seed", watchSites: [], watchQueries: [] },
  ];
  const ctx = (tier: Parameters<typeof coverageFor>[0], now: Date, extra: Partial<LaneContext> = {}): LaneContext => ({
    plan: coverageFor(tier),
    presets,
    monitors: [],
    planSince: new Date(0),
    now,
    ...extra,
  });
  const since = (list: ReturnType<typeof laneExpectations>, lane: string) =>
    list.find((e) => e.lane === lane)?.since?.toISOString() ?? null;

  test("Max owes an hourly run from every lane, two hours back: one missed tick is covered by the next", () => {
    const list = laneExpectations(ctx("max", T0));
    for (const lane of ["sweep", "watch", "formd", "announcements", "trending"]) expect(since(list, lane)).toBe("2026-09-25T12:00:00.000Z");
    expect(list.find((e) => e.lane === "watch")?.presets).toEqual(["series-a-b"]);
    expect(list.find((e) => e.lane === "sweep")?.presets).toEqual(["series-a-b", "seed"]);
    expect(since(list, "monitor")).toBeNull();
  });

  test("Deep owes the 06:00 or 18:00 sweep and the 06:00 daily lanes; Lite owes Monday's sweep and nothing else", () => {
    const deep = laneExpectations(ctx("deep", T0));
    expect(since(deep, "sweep")).toBe("2026-09-25T06:00:00.000Z");
    expect(since(deep, "watch")).toBe("2026-09-25T06:00:00.000Z");
    expect(since(deep, "formd")).toBe("2026-09-25T06:00:00.000Z");
    expect(since(deep, "trending")).toBe("2026-09-25T12:00:00.000Z");
    const lite = laneExpectations(ctx("lite", T0));
    expect(since(lite, "sweep")).toBe("2026-09-21T06:00:00.000Z");
    for (const lane of ["watch", "formd", "announcements", "trending"]) expect(since(lite, lane)).toBeNull();
  });

  test("a tick before the plan last changed is not owed", () => {
    const list = laneExpectations(ctx("max", T0, { planSince: new Date("2026-09-25T13:30:00Z") }));
    expect(since(list, "sweep")).toBeNull();
  });

  test("monitor webhooks are owed within the monitor schedule plus a day, only for monitors older than that", () => {
    const monitors = [
      { presetSlug: "seed", createdAt: new Date("2026-09-20T00:00:00Z") },
      { presetSlug: "series-a-b", createdAt: new Date("2026-09-25T10:00:00Z") },
    ];
    const list = laneExpectations(ctx("deep", T0, { monitors }));
    const monitor = list.find((e) => e.lane === "monitor");
    expect(monitor?.presets).toEqual(["seed"]);
    expect(monitor?.since?.toISOString()).toBe(new Date(T0.getTime() - 6 * HOUR - 24 * HOUR).toISOString());
  });

  test("the tick helpers read the plan's clock", () => {
    const deep = coverageFor("deep");
    expect(lastDueTick(() => false, T0, new Date(0))).toBeNull();
    expect(longestTickGapMs((t) => t.getUTCHours() === 6 || t.getUTCHours() === 18, T0)).toBe(12 * HOUR);
    expect(deep.sweep.cadence).toBe("twice_daily");
  });

  test("a lane is late when a preset's newest run predates what it owes, and names the preset and its last run", () => {
    const expectations = laneExpectations(ctx("max", T0));
    const fresh = new Map<string, Date>();
    for (const key of ["sweep", "watch", "formd", "announcements", "trending"]) fresh.set(key, at(-5));
    fresh.set("sweep:series-a-b", at(-5));
    fresh.set("sweep:seed", at(-5));
    fresh.set("watch:series-a-b", at(-5));
    expect(laneFindings(expectations, fresh, T0).every((f) => f.ok)).toBe(true);

    const stale = new Map(fresh);
    stale.set("sweep:seed", new Date("2026-09-25T11:04:00Z"));
    stale.delete("trending");
    const findings = laneFindings(expectations, stale, T0);
    const sweep = findings.find((f) => f.key === "lane:sweep");
    expect(sweep?.ok).toBe(false);
    expect(sweep?.title).toBe("Sweep lane is late for seed");
    expect(sweep?.detail).toBe("Owed a run since 12:00 UTC Sep 25; last run 11:04 UTC Sep 25 (3h 1m ago).");
    expect(sweep?.cause).toContain("/api/cron/sweep");
    const trending = findings.find((f) => f.key === "lane:trending");
    expect(trending?.title).toBe("Trending lane is late");
    expect(trending?.detail).toContain("no run on record");
    expect(findings.filter((f) => !f.ok).map((f) => f.key)).toEqual(["lane:sweep", "lane:trending"]);
  });

  test("a preset new to a lane is excused until its first run; a lane with no run at all is not", () => {
    const expectations = laneExpectations(ctx("max", T0));
    const runs = new Map<string, Date>([
      ["sweep", at(-5)],
      ["sweep:series-a-b", at(-5)],
      ["formd", at(-5)],
      ["announcements", at(-5)],
      ["trending", at(-5)],
    ]);
    const findings = laneFindings(expectations, runs, T0);
    expect(findings.find((f) => f.key === "lane:sweep")?.ok).toBe(true);
    const watch = findings.find((f) => f.key === "lane:watch");
    expect(watch?.ok).toBe(false);
    expect(watch?.title).toBe("Watch sites lane is late for series-a-b");
    expect(watch?.detail).toContain("no run on record");
  });
});

describe("the error rate check", () => {
  const runs = (lane: string, errors: boolean[]) => errors.map((e, i) => ({ lane, startedAt: at(-i * 60), error: e ? `boom ${i}` : null }));

  test("half or more of a lane's last eight finished runs erroring fails it, with the newest error", () => {
    const f = errorRateFindings(runs("sweep", [true, false, true, false, true, false, true, false])).find((x) => x.key === "errors:sweep");
    expect(f?.ok).toBe(false);
    expect(f?.title).toBe("Sweep runs are failing: 4 of the last 8 errored");
    expect(f?.cause).toBe("Latest error: boom 0");
  });

  test("one bad sweep tick (three presets) stays under half; runs older than the last eight do not count", () => {
    expect(errorRateFindings(runs("sweep", [true, true, true, false, false, false, false, false])).every((f) => f.ok)).toBe(true);
    expect(
      errorRateFindings(runs("trending", [false, false, false, false, false, false, false, false, true, true, true])).every((f) => f.ok),
    ).toBe(true);
  });

  test("too few runs say nothing, and lanes outside the schedule (a deep dive's verdicts) are not read", () => {
    expect(errorRateFindings(runs("formd", [true, true, true])).every((f) => f.ok)).toBe(true);
    expect(errorRateFindings(runs("agent", [true, true, true, true, true, true])).every((f) => f.ok)).toBe(true);
  });
});

describe("the deliveries check", () => {
  test("no failing target passes; failing ones are named without their URL, with the latest error", () => {
    expect(deliveriesFinding([], "/settings").ok).toBe(true);
    const f = deliveriesFinding(
      [
        { label: "#deals in Acme", rows: 3, dead: 3, lastError: "slack: invalid_token" },
        { label: "Team hook", rows: 2, dead: 0, lastError: null },
      ],
      "/settings",
    );
    expect(f.title).toBe("Deliveries are failing to 2 targets");
    expect(f.detail).toBe("#deals in Acme (3 dead-lettered), Team hook (2 retrying)");
    expect(f.cause).toBe("Latest error: slack: invalid_token");
    expect(f.link).toBe("/settings");
  });
});

describe("the freshness check", () => {
  const max = coverageFor("max");

  test("on the hourly rung, thirteen quiet hours fail and twelve do not", () => {
    expect(freshnessFinding(new Date(T0.getTime() - 12 * HOUR), max, T0).ok).toBe(true);
    const f = freshnessFinding(new Date(T0.getTime() - 14 * HOUR), max, T0);
    expect(f.ok).toBe(false);
    expect(f.title).toBe("No new round on the feed for 14h 0m");
    expect(f.link).toBe("/feed");
  });

  test("the weekly rung allows its week; an empty store is not late", () => {
    expect(freshnessFinding(new Date(T0.getTime() - 6 * 24 * HOUR), coverageFor("lite"), T0).ok).toBe(true);
    expect(freshnessFinding(new Date(T0.getTime() - 8 * 24 * HOUR), coverageFor("lite"), T0).ok).toBe(false);
    expect(freshnessFinding(null, max, T0).ok).toBe(true);
  });
});

describe("the spend check", () => {
  const week = [90_000, 140_000, 120_000, 100_000, 150_000, 110_000, 95_000, 130_000];

  test("a day past twice the busiest of the eight before it fails; up to twice passes", () => {
    expect(spendFinding([300_000, ...week], null).ok).toBe(true);
    const f = spendFinding([300_001, ...week], null);
    expect(f.ok).toBe(false);
    expect(f.title).toBe("Credits are past the daily ceiling: 300,001 in the last 24 hours");
    expect(f.detail).toBe("Twice the busiest day of the week before (150,000).");
    expect(f.link).toBe("/runs");
  });

  test("a weekly rung's sweep day compares with last week's sweep day, not the quiet days between", () => {
    expect(spendFinding([2_400, 30, 20, 25, 30, 20, 25, 2_300, 30], null).ok).toBe(true);
  });

  test("under three days of history owes nothing; a ceiling the operator set applies from the first day", () => {
    expect(spendFinding([50_000, 100, 200, 0, 0, 0, 0, 0, 0], null).ok).toBe(true);
    expect(spendFinding([50_000], 40_000).ok).toBe(false);
    expect(spendFinding([50_000], 40_000).detail).toBe("CREDIT_ALERT_PER_DAY is 40,000.");
    expect(spendFinding([500_000, ...week], 600_000).ok).toBe(true);
  });
});
