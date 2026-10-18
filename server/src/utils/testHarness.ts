/**
 * Shared harness for the suites that need a real, throwaway PostgreSQL database.
 *
 * Two things live here, both because a second copy would eventually disagree with the first in a way
 * that matters:
 *
 *  1. `createScratchDatabase` — the destructive half (CREATE / DROP DATABASE). One implementation, so
 *     no suite can drift into dropping a database it did not create: the name is generated here, an
 *     existing database of that name is a hard stop rather than a takeover, and `drop()` runs once,
 *     against that name only. Connection URLs are never logged; they carry the password.
 *
 *  2. `runServerScript` — spawns a `server/src/**` TypeScript entry point in a child process with the
 *     scratch database as its target. It resolves `tsx` through its real entry file because `npx` is a
 *     `.cmd` shim on Windows and a spawned `npx` throws ENOENT, which a naive suite then scores as a
 *     test failure — a broken runner that looks like a passing gate.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface ScratchDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

export interface ScriptResult {
  status: number | null;
  output: string;
}

function urlWithDatabase(base: URL, database: string): string {
  const u = new URL(base.toString());
  u.pathname = `/${database}`;
  return u.toString();
}

/** Same server and credentials, pointed at a different database. Used to name a database that does not exist. */
export function urlForDatabase(adminUrl: string, database: string): string {
  return urlWithDatabase(new URL(adminUrl), database);
}

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(64) PRIMARY KEY,
    name        VARCHAR(256) NOT NULL,
    filename    VARCHAR(256),
    checksum    VARCHAR(128) NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_by  TEXT NOT NULL DEFAULT CURRENT_USER,
    runner      VARCHAR(64)
  );`;

/**
 * Applies every migration up to `maxVersion`, exactly the way migrate.ts does (one transaction per
 * file, ledger row carrying the runner's own checksum), and stops there. This is how a suite reaches
 * the schema a real deployment is actually sitting on before a new migration runs — without
 * re-implementing the runner's integrity gate, which would make the test prove nothing.
 */
export async function applyMigrationsUpTo(client: { query: (sql: string, params?: any[]) => Promise<any> }, maxVersion: number) {
  const { loadMigrations } = await import('../db/migrate');
  await client.query(LEDGER_DDL);
  const have = new Set<string>(
    (await client.query('select version from schema_migrations')).rows.map((r: any) => r.version)
  );
  for (const mig of loadMigrations().filter((m) => Number(m.version) <= maxVersion && !have.has(m.version))) {
    await client.query('BEGIN');
    await client.query(mig.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, filename, checksum, runner) VALUES ($1,$2,$3,$4,$5)`,
      [mig.version, mig.name, mig.filename, mig.checksum, 'testHarness']
    );
    await client.query('COMMIT');
  }
}

/** Env for a child run: point it at one database, and leave no PG* variable behind to disagree with it. */
function childEnv(databaseUrl: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: extra.JWT_SECRET || 'harness_only_secret_0123456789abcdef_0000',
  };
  for (const k of ['PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT']) delete env[k];
  return env;
}

/** Runs `server/src/<script>` in a child process against `databaseUrl`. */
export function runServerScript(script: string, databaseUrl: string, extra: Record<string, string> = {}, timeoutMs = 180_000): ScriptResult {
  const r = spawnSync(process.execPath, [TSX, path.join(ROOT, 'server', 'src', script)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv(databaseUrl, extra),
    timeout: timeoutMs,
  });
  if (r.error) throw new Error(`could not spawn ${script}: ${r.error.message}`);
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function createScratchDatabase(
  prefix: string,
  adminUrl: string,
  opts: { postgis?: boolean } = {}
): Promise<ScratchDatabase> {
  const admin = new URL(adminUrl);
  const maintenance = urlWithDatabase(admin, 'postgres');
  const name = `${prefix}_${Date.now()}`;

  const ctl = new Client({ connectionString: maintenance });
  await ctl.connect();
  try {
    const clash = await ctl.query('select 1 from pg_database where datname = $1', [name]);
    if ((clash.rowCount ?? 0) > 0) {
      throw new Error(`${name} already exists — refusing to touch a database this run did not create.`);
    }
    await ctl.query(`CREATE DATABASE "${name}"`);
  } finally {
    await ctl.end();
  }

  if (opts.postgis !== false) {
    const db = new Client({ connectionString: urlWithDatabase(admin, name) });
    await db.connect();
    try {
      const available = await db.query("select 1 from pg_available_extensions where name = 'postgis'");
      if ((available.rowCount ?? 0) === 0) {
        throw new Error('this PostgreSQL server has no PostGIS, so the DHAROHAR schema cannot be built on it');
      }
      await db.query('CREATE EXTENSION postgis');
    } finally {
      await db.end();
    }
  }

  let dropped = false;
  return {
    name,
    url: urlWithDatabase(admin, name),
    async drop() {
      if (dropped) return;
      dropped = true;
      const bye = new Client({ connectionString: maintenance });
      await bye.connect();
      try {
        await bye.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);
        await bye.query(`DROP DATABASE "${name}"`);
      } finally {
        await bye.end();
      }
    },
  };
}
