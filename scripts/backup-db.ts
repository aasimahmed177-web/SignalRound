// Back up DATABASE_URL to a dated pg_dump archive, and prove a copy restores (docs/deploy.md#back-up-and-restore-the-database):
//   pnpm backup-db -- --dir ~/fireround-backups --label prod --keep 14
//   pnpm backup-db -- --verify ~/fireround-backups/fireround-prod-2026-09-25T181018Z.dump --into postgres://postgres@localhost:55418/restore
// The backup refuses a Neon pooler host and a client whose major differs from the server's (lib/db-backup.ts
// says why). It holds one read-only transaction open, dumps from that transaction's exported snapshot, and
// counts every table's rows in the same snapshot, so the manifest written beside the dump (same name, .json)
// matches the archive exactly. Only then are the label's dumps past the newest --keep pruned.
// --verify restores an archive into an empty database on this machine only and compares every table's rows
// with its manifest; any difference exits 1. The client is psql, pg_dump, and pg_restore from PG_BIN (a
// directory, such as /opt/homebrew/opt/postgresql@18/bin), else from PATH.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  COUNTS_SQL,
  compareCounts,
  dumpName,
  dumpsToPrune,
  isLocalHost,
  isPoolerHost,
  isPoolerPort,
  libpqEnv,
  majorOf,
  parseCounts,
} from "../lib/db-backup.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1]?.replace(/^~(?=\/)/, process.env.HOME ?? "~") : undefined;
};
const bin = (name: string) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);

function fail(message: string): never {
  console.error(`backup-db: ${message}`);
  process.exit(1);
}

/** The caller's environment without any libpq variable or DATABASE_URL, plus the given ones: a stray PGHOST or PGSERVICE cannot redirect a child. */
function childEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG") && key !== "DATABASE_URL"));
  return { ...env, ...vars } as NodeJS.ProcessEnv;
}

async function run(name: string, argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(bin(name), argv, { env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const { stderr, message } = err as { stderr?: string; message: string };
    fail(`${name} failed: ${(stderr || message).trim()}`);
  }
}

/** The one major every client tool shares, or a refusal naming the tools that disagree. */
async function clientMajor(tools: string[]): Promise<number> {
  const majors = await Promise.all(tools.map(async (tool) => ({ tool, major: majorOf(await run(tool, ["--version"], process.env)) })));
  const first = majors[0].major;
  if (first === null || majors.some((m) => m.major !== first)) {
    fail(
      `client tools disagree on their version (${majors.map((m) => `${m.tool} ${m.major}`).join(", ")}); set PG_BIN to one install's bin directory`,
    );
  }
  return first;
}

async function backup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const dir = arg("--dir");
  const keep = Number(arg("--keep") ?? 14);
  if (!url) fail("DATABASE_URL is not set");
  if (!dir) fail("--dir <folder for the dumps> is required");
  if (!Number.isInteger(keep) || keep < 1) fail("--keep takes a whole number of dumps, 1 or more");
  const conn = libpqEnv(url);
  if (isPoolerHost(conn.PGHOST ?? "")) {
    fail(
      `${conn.PGHOST} is a pooler host. pg_dump leaks its session settings through the pooler; use the direct host (drop "-pooler" from the hostname)`,
    );
  }
  if (isPoolerPort(conn.PGPORT) || (conn.PGUSER ?? "").includes("|")) {
    fail("that URL reaches PgBouncer (port 6432, or a |bouncer user). pg_dump needs Postgres itself: use port 5432 and the plain user");
  }
  const label = arg("--label") ?? conn.PGDATABASE ?? "db";
  const env = childEnv({ ...conn, PGOPTIONS: [conn.PGOPTIONS, "-c default_transaction_read_only=on"].filter(Boolean).join(" ") });
  const major = await clientMajor(["psql", "pg_dump", "pg_restore"]);

  const holder = spawn(bin("psql"), ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: holder.stdout })[Symbol.asyncIterator]();
  const END = "-- backup-db end --";
  const ask = async (sql: string): Promise<string[]> => {
    holder.stdin.write(`${sql}\nselect '${END}';\n`);
    const out: string[] = [];
    for (;;) {
      const { value, done } = await lines.next();
      if (done) fail("psql exited before answering (its error is above)");
      if (value === END) return out;
      out.push(value);
    }
  };
  const [versionNum, snapshot] = (
    await ask(
      "begin isolation level repeatable read read only;\nselect current_setting('server_version_num') || '|' || pg_export_snapshot();",
    )
  )[0].split("|");
  const serverMajor = majorOf(versionNum);
  if (serverMajor !== major) {
    fail(
      `the server is PostgreSQL ${serverMajor} and the client is ${major}; set PG_BIN to a PostgreSQL ${serverMajor} client's bin directory`,
    );
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const startedAt = new Date();
  const file = join(dir, dumpName(label, startedAt));
  console.log(`backup-db: dumping ${conn.PGDATABASE} on ${conn.PGHOST} (PostgreSQL ${serverMajor}) to ${file}`);
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`, `--file=${file}.partial`], env);
  const tables = parseCounts(await ask(COUNTS_SQL));
  await ask("commit;");
  holder.stdin.end();

  const toc = await run("pg_restore", ["--list", `${file}.partial`], env);
  const dataEntries = toc.split("\n").filter((line) => / TABLE DATA /.test(line)).length;
  if (dataEntries !== Object.keys(tables).length) {
    await rm(`${file}.partial`);
    fail(`the archive lists ${dataEntries} tables' data but the database has ${Object.keys(tables).length} tables; nothing kept`);
  }
  await chmod(`${file}.partial`, 0o600);
  await rename(`${file}.partial`, file);
  const manifest = {
    file: dumpName(label, startedAt),
    startedAt: startedAt.toISOString(),
    host: conn.PGHOST,
    database: conn.PGDATABASE,
    serverVersionNum: Number(versionNum),
    clientMajor: major,
    tables,
  };
  await writeFile(file.replace(/\.dump$/, ".json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const rows = Object.values(tables).reduce((sum, n) => sum + n, 0);
  console.log(`backup-db: ${Object.keys(tables).length} tables, ${rows} rows, archive checked with pg_restore --list`);

  for (const old of dumpsToPrune(await readdir(dir), label, keep)) {
    await rm(join(dir, old));
    await rm(join(dir, old.replace(/\.dump$/, ".json")), { force: true });
    console.log(`backup-db: pruned ${old}`);
  }
}

async function verify(file: string): Promise<void> {
  const into = arg("--into");
  if (!into) fail("--verify needs --into <postgres:// URL of an empty database on this machine>");
  const manifest = JSON.parse(await readFile(file.replace(/\.dump$/, ".json"), "utf8")) as {
    tables: Record<string, number>;
    clientMajor: number;
  };
  const target = libpqEnv(into);
  if (!isLocalHost(target.PGHOST ?? "")) fail(`${target.PGHOST} is not this machine; --verify restores only into a local database`);
  if (!target.PGDATABASE) fail("--into must name a database");
  const env = childEnv(target);
  const major = await clientMajor(["psql", "pg_restore"]);
  if (major < manifest.clientMajor) fail(`the archive was written by pg_dump ${manifest.clientMajor}; pg_restore ${major} cannot read it`);
  const existing = await run(
    "psql",
    [
      "-X",
      "-A",
      "-t",
      "-c",
      "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')",
    ],
    env,
  );
  if (Number(existing.trim()) !== 0) fail(`${target.PGDATABASE} already has tables; restore into an empty database`);

  console.log(`backup-db: restoring ${file} into ${target.PGDATABASE} on ${target.PGHOST || "the local socket"}`);
  await run(
    "pg_restore",
    ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--dbname=${target.PGDATABASE}`, file],
    env,
  );
  const actual = parseCounts((await run("psql", ["-X", "-A", "-t", "-c", COUNTS_SQL], env)).split("\n"));
  const diffs = compareCounts(manifest.tables, actual);
  for (const d of diffs) console.log(`  ${d.table}: manifest ${d.expected ?? "absent"}, restored ${d.actual ?? "absent"}`);
  const rows = Object.values(actual).reduce((sum, n) => sum + n, 0);
  if (diffs.length > 0) fail(`${diffs.length} table(s) differ from the manifest`);
  console.log(`backup-db: restore matches the manifest: ${Object.keys(actual).length} tables, ${rows} rows`);
}

const verifyFile = arg("--verify");
await (verifyFile ? verify(verifyFile) : backup());
