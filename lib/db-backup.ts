// The rules behind scripts/backup-db.ts, kept pure so they are tested without a database.
//
// A dump runs over Neon's direct host only. The pooler (PgBouncer in transaction mode) hands
// pg_dump's session settings (search_path, statement_timeout, read-only snapshots) on to whichever
// app connection gets that server connection next, and on 2026-09-25 that took the site down for
// four minutes. pg_dump also refuses a server newer than itself, so the client's major must match.

/** A Neon pooler endpoint names itself in the first label ("ep-name-123-pooler.region.aws.neon.tech"). */
export function isPoolerHost(hostname: string): boolean {
  return /-pooler(\.|$)/i.test(hostname);
}

/** PlanetScale's PgBouncer answers on 6432 of the database's own host, beside Postgres on 5432. */
export function isPoolerPort(port: string | undefined): boolean {
  return port === "6432";
}

/** A restore target this script may write to: this machine only, so a typo can never restore over production. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("/");
}

/** The major version from `pg_dump --version` ("pg_dump (PostgreSQL) 18.6 (Homebrew)") or server_version_num ("180006"). */
export function majorOf(version: string): number | null {
  const trimmed = version.trim();
  if (/^\d{5,6}$/.test(trimmed)) return Math.floor(Number(trimmed) / 10_000);
  const match = trimmed.match(/\(PostgreSQL\)\s+(\d+)/) ?? trimmed.match(/^(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : null;
}

/** libpq's own variables for a postgres:// URL, so the password never sits in a child's argv (visible in `ps`). */
export function libpqEnv(url: string): Record<string, string> {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error(`not a postgres:// URL (${u.protocol})`);
  const env: Record<string, string> = {};
  if (u.hostname) env.PGHOST = u.hostname.replace(/^\[|\]$/g, "");
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (database) env.PGDATABASE = database;
  const params: Record<string, string> = {
    sslmode: "PGSSLMODE",
    channel_binding: "PGCHANNELBINDING",
    sslrootcert: "PGSSLROOTCERT",
    options: "PGOPTIONS",
    application_name: "PGAPPNAME",
  };
  for (const [key, value] of u.searchParams) {
    const name = params[key];
    // An unknown parameter would be dropped silently and the connection would differ from the URL.
    if (!name) throw new Error(`unsupported connection parameter "${key}"`);
    env[name] = value;
  }
  return env;
}

/** `fireround-<label>-2026-09-25T181018Z.dump`: UTC to the second, so names sort by time and two runs never collide. */
export function dumpName(label: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, "")
    .replace(/^(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  return `fireround-${label}-${stamp}.dump`;
}

/** The dumps under one label beyond the newest `keep`, oldest first; files that are not this label's dumps are never listed. */
export function dumpsToPrune(names: string[], label: string, keep: number): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^fireround-${escaped}-\\d{4}-\\d{2}-\\d{2}T\\d{6}Z\\.dump$`);
  const dumps = names.filter((name) => pattern.test(name)).sort();
  return dumps.slice(0, Math.max(0, dumps.length - Math.max(1, keep)));
}

export interface CountDiff {
  table: string;
  expected: number | null;
  actual: number | null;
}

/** Every table whose row count differs between the dump's manifest and a restore, including tables on one side only. */
export function compareCounts(expected: Record<string, number>, actual: Record<string, number>): CountDiff[] {
  const tables = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return tables
    .map((table) => ({ table, expected: expected[table] ?? null, actual: actual[table] ?? null }))
    .filter((d) => d.expected !== d.actual);
}

/** Exact row counts for every ordinary table, one "schema.table|count" line each; run inside the dump's snapshot they match it exactly. */
export const COUNTS_SQL = `select table_schema || '.' || table_name || '|' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
order by 1;`;

/** Parse COUNTS_SQL's "schema.table|count" lines. */
export function parseCounts(lines: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const at = line.lastIndexOf("|");
    if (at > 0) counts[line.slice(0, at)] = Number(line.slice(at + 1));
  }
  return counts;
}
