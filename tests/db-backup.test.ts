import { describe, expect, test } from "vitest";
import {
  compareCounts,
  dumpName,
  dumpsToPrune,
  isLocalHost,
  isPoolerHost,
  isPoolerPort,
  libpqEnv,
  majorOf,
  parseCounts,
} from "../lib/db-backup";

describe("isPoolerPort", () => {
  test("PlanetScale's PgBouncer port is a pooler; Postgres's own port and no port are not", () => {
    expect(isPoolerPort("6432")).toBe(true);
    expect(isPoolerPort("5432")).toBe(false);
    expect(isPoolerPort(undefined)).toBe(false);
  });
});

describe("isPoolerHost", () => {
  test("a Neon pooler endpoint is refused and its direct host is not", () => {
    expect(isPoolerHost("ep-ancient-lab-123-pooler.c-11.us-east-1.aws.neon.tech")).toBe(true);
    expect(isPoolerHost("EP-X-POOLER.eu-central-1.aws.neon.tech")).toBe(true);
    expect(isPoolerHost("ep-ancient-lab-123.c-11.us-east-1.aws.neon.tech")).toBe(false);
    expect(isPoolerHost("localhost")).toBe(false);
  });
});

describe("isLocalHost", () => {
  test("only this machine is a restore target", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "", "/tmp"]) expect(isLocalHost(host)).toBe(true);
    for (const host of ["ep-x.us-east-1.aws.neon.tech", "db.example.com", "10.0.0.5"]) expect(isLocalHost(host)).toBe(false);
  });
});

describe("majorOf", () => {
  test("reads the client's --version line and the server's version number", () => {
    expect(majorOf("pg_dump (PostgreSQL) 18.6 (Homebrew)\n")).toBe(18);
    expect(majorOf("psql (PostgreSQL) 17.11")).toBe(17);
    expect(majorOf("180006")).toBe(18);
    expect(majorOf("170011")).toBe(17);
    expect(majorOf("96020")).toBe(9);
    expect(majorOf("nonsense")).toBeNull();
  });
});

describe("libpqEnv", () => {
  test("splits a URL into libpq variables, decoding the credentials", () => {
    expect(libpqEnv("postgresql://owner:p%40ss@ep-x.aws.neon.tech/neondb?sslmode=require&channel_binding=require")).toEqual({
      PGHOST: "ep-x.aws.neon.tech",
      PGUSER: "owner",
      PGPASSWORD: "p@ss",
      PGDATABASE: "neondb",
      PGSSLMODE: "require",
      PGCHANNELBINDING: "require",
    });
    expect(libpqEnv("postgres://postgres@localhost:55418/restore")).toEqual({
      PGHOST: "localhost",
      PGPORT: "55418",
      PGUSER: "postgres",
      PGDATABASE: "restore",
    });
  });

  test("refuses a parameter it would otherwise drop, and a URL that is not Postgres", () => {
    expect(() => libpqEnv("postgres://u@h/db?pgbouncer=true")).toThrow(/pgbouncer/);
    expect(() => libpqEnv("postgres://u@ep-x.aws.neon.tech/db?host=ep-x-pooler.aws.neon.tech")).toThrow(/host/);
    expect(() => libpqEnv("mysql://u@h/db")).toThrow(/postgres/);
  });
});

describe("dumpName and dumpsToPrune", () => {
  test("names sort by time to the second", () => {
    expect(dumpName("prod", new Date("2026-09-25T18:10:18.532Z"))).toBe("fireround-prod-2026-09-25T181018Z.dump");
  });

  test("keeps the newest dumps of one label and never lists another label's or a stray file", () => {
    const names = [
      "fireround-prod-2026-09-23T060000Z.dump",
      "fireround-prod-2026-09-23T060000Z.json",
      "fireround-prod-2026-09-25T060000Z.dump",
      "fireround-prod-2026-09-24T060000Z.dump",
      "fireround-prod-2026-09-22T060000Z.dump.partial",
      "fireround-staging-2026-09-01T060000Z.dump",
      "notes.txt",
    ];
    expect(dumpsToPrune(names, "prod", 2)).toEqual(["fireround-prod-2026-09-23T060000Z.dump"]);
    expect(dumpsToPrune(names, "prod", 5)).toEqual([]);
    expect(dumpsToPrune(names, "prod", 0)).toEqual(["fireround-prod-2026-09-23T060000Z.dump", "fireround-prod-2026-09-24T060000Z.dump"]);
  });
});

describe("parseCounts and compareCounts", () => {
  test("a restore that matches reports nothing; a missing or short table is named", () => {
    const manifest = parseCounts(["public.funding_rounds|1198", "public.runs|1741", "drizzle.__drizzle_migrations|20", ""]);
    expect(manifest).toEqual({ "public.funding_rounds": 1198, "public.runs": 1741, "drizzle.__drizzle_migrations": 20 });
    expect(compareCounts(manifest, { ...manifest })).toEqual([]);
    expect(compareCounts(manifest, { "public.funding_rounds": 1197, "public.runs": 1741, "public.extra": 0 })).toEqual([
      { table: "drizzle.__drizzle_migrations", expected: 20, actual: null },
      { table: "public.extra", expected: null, actual: 0 },
      { table: "public.funding_rounds", expected: 1198, actual: 1197 },
    ]);
  });
});
