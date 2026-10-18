/**
 * DHAROHAR migration runner.
 *
 * Migrations are plain, version-controlled SQL files in `server/src/db/migrations/`, applied in
 * filename order and recorded in a `schema_migrations` ledger table.
 *
 * Hard rules, because this database holds land records:
 *   - Forward-only and additive. Nothing here drops, truncates or reseeds anything. Seeding is a
 *     separate, explicitly-invoked operation (`npm run db:seed`) and is never wired in below.
 *   - Each migration runs inside its own transaction together with its ledger row, so a failed
 *     migration leaves the database exactly as it was and is NOT recorded as applied.
 *   - A migration file that has already been applied must never change. The runner compares a
 *     SHA-256 checksum of every applied file and stops with a non-zero exit on a mismatch
 *     instead of silently skipping it.
 *   - Re-running when everything is applied is a no-op.
 *   - An unreachable database still throws and exits non-zero (a deploy script must not believe
 *     the schema is in place when it is not).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool, initDbConnection } from './db';

const LEDGER_TABLE = 'schema_migrations';

/** Session lock key so two runners can never interleave DDL against the same database. */
const MIGRATION_LOCK_KEY = 478_201_610;

/**
 * Statements PostgreSQL refuses to run inside a transaction block. The runner wraps every
 * migration in a transaction (that is what makes a failure roll back cleanly), so a file using
 * one of these must be rewritten rather than silently failing mid-way.
 */
const NON_TRANSACTIONAL_STATEMENTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, label: 'CREATE INDEX CONCURRENTLY' },
  { pattern: /DROP\s+INDEX\s+CONCURRENTLY\b/i, label: 'DROP INDEX CONCURRENTLY' },
  { pattern: /^\s*(?:VACUUM|ANALYZE|ANALYSE)\b/im, label: 'VACUUM / ANALYZE' },
  { pattern: /^\s*ALTER\s+SYSTEM\b/im, label: 'ALTER SYSTEM' },
  { pattern: /^\s*CREATE\s+(?:DATABASE|TABLESPACE)\b/im, label: 'CREATE DATABASE / TABLESPACE' },
];

/** Removes line and block SQL comments so the guard below never trips on prose. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationSummary {
  appliedVersions: number;
  newlyApplied: string[];
  pendingBefore: number;
}

/**
 * Checksums the file contents, normalising CRLF first so that a checkout made with
 * `core.autocrlf=true` is not reported as an edit to an applied migration.
 */
export function checksumOf(sql: string): string {
  const normalised = sql.replace(/\r\n/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

function versionOf(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  const match = /^(\d+)/.exec(base);
  return match ? match[1] : base;
}

function nameOf(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

/** Absolute path of the migrations directory, resolved from this module next to the source. */
export function migrationsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    path.join(__dirname, 'migrations'),
    path.resolve(process.cwd(), 'server/src/db/migrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    `Migration directory not found. Expected SQL files in one of:\n  ${candidates.join('\n  ')}`
  );
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const migrations = files.map((filename) => {
    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    return {
      version: versionOf(filename),
      name: nameOf(filename),
      filename,
      sql,
      checksum: checksumOf(sql),
    };
  });

  for (const mig of migrations) {
    const bare = stripSqlComments(mig.sql);
    const offending = NON_TRANSACTIONAL_STATEMENTS.filter(({ pattern }) => pattern.test(bare));
    if (offending.length > 0) {
      throw new Error(
        `Migration ${mig.filename} uses ${offending.map((o) => o.label).join(', ')}, which ` +
          'PostgreSQL cannot run inside a transaction. The runner applies every migration in one ' +
          'transaction so that a failure rolls back completely. Split that statement into a ' +
          'separate, explicitly-documented out-of-band step instead of a migration file.'
      );
    }
  }

  const seen = new Map<string, string>();
  for (const mig of migrations) {
    const clash = seen.get(mig.version);
    if (clash) {
      throw new Error(
        `Duplicate migration version ${mig.version}: ${clash} and ${mig.filename} share it. ` +
          'Every file needs a unique numeric prefix.'
      );
    }
    seen.set(mig.version, mig.filename);
  }

  return migrations;
}

async function ensureLedgerTable(client: { query: (sql: string, params?: any[]) => Promise<any> }) {
  // Additive only: created if absent, never altered destructively.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      version     VARCHAR(64) PRIMARY KEY,
      name        VARCHAR(256) NOT NULL,
      filename    VARCHAR(256),
      checksum    VARCHAR(128) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by  TEXT NOT NULL DEFAULT CURRENT_USER,
      runner      VARCHAR(64)
    );
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_${LEDGER_TABLE}_applied_at ON ${LEDGER_TABLE}(applied_at)`
  );
}

async function readApplied(client: {
  query: (sql: string, params?: any[]) => Promise<any>;
}): Promise<Map<string, { name: string; checksum: string }>> {
  const res = await client.query(
    `SELECT version, name, checksum FROM ${LEDGER_TABLE} ORDER BY version`
  );
  const map = new Map<string, { name: string; checksum: string }>();
  for (const row of res.rows) map.set(row.version, { name: row.name, checksum: row.checksum });
  return map;
}

export async function runMigrations(): Promise<MigrationSummary> {
  console.log('[DHAROHAR DB] Running database migrations...');
  const health = await initDbConnection();

  if (health.storageMode !== 'postgres-postgis') {
    // An unreachable database used to print a warning and exit 0, so a deploy script that ran
    // `npm run db:migrate` believed the schema was in place.
    throw new Error(
      `PostgreSQL is not reachable (${health.error || 'no connection'}). ` +
        'Set DATABASE_URL or the PG* environment variables, then re-run npm run db:migrate.'
    );
  }

  const migrations = loadMigrations();
  if (migrations.length === 0) {
    throw new Error(`No .sql migration files found in ${migrationsDir()}`);
  }

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await ensureLedgerTable(client);
    const applied = await readApplied(client);

    // ---- Integrity gate: an applied migration file must never have been edited. -------------
    const tampered: string[] = [];
    const missingFiles: string[] = [];
    for (const [version, record] of applied) {
      const file = migrations.find((m) => m.version === version);
      if (!file) {
        missingFiles.push(`${version} (${record.name})`);
        continue;
      }
      if (file.checksum !== record.checksum) {
        tampered.push(
          `${file.filename}\n      ledger: ${record.checksum}\n      on disk: ${file.checksum}`
        );
      }
    }

    if (missingFiles.length > 0) {
      console.warn(
        '[DHAROHAR DB] WARNING: these migrations are recorded as applied but their files are ' +
          'gone from server/src/db/migrations/:\n  ' +
          missingFiles.join('\n  ') +
          '\n  A fresh database can no longer reach the same structure as this one.'
      );
    }

    if (tampered.length > 0) {
      throw new Error(
        'MIGRATION INTEGRITY FAILURE — an already-applied migration file has been edited.\n\n  ' +
          tampered.join('\n  ') +
          '\n\nThis database was built from the previous contents of that file, so re-applying ' +
          'the edited version would silently do nothing (or diverge the schema of every other ' +
          'environment). Revert the file, or move the change into a NEW ' +
          'server/src/db/migrations/00NN_*.sql file. Nothing was applied on this run.'
      );
    }

    const pending = migrations.filter((m) => !applied.has(m.version));

    // Applying an older version after a newer one is a real ordering hazard (two environments
    // end up with different structures), so make it loud even though we proceed.
    if (applied.size > 0 && pending.length > 0) {
      const maxApplied = Math.max(...[...applied.keys()].map((v) => Number(v) || 0));
      const outOfOrder = pending.filter((m) => (Number(m.version) || 0) < maxApplied);
      if (outOfOrder.length > 0) {
        console.warn(
          `[DHAROHAR DB] WARNING: applying ${outOfOrder
            .map((m) => m.filename)
            .join(', ')} after a higher version is already recorded.`
        );
      }
    }

    if (pending.length === 0) {
      console.log(
        `[DHAROHAR DB] No pending migrations. ${applied.size} applied, schema up to date ` +
          '(no-op).'
      );
      return { appliedVersions: applied.size, newlyApplied: [], pendingBefore: 0 };
    }

    console.log(
      `[DHAROHAR DB] ${pending.length} pending migration(s): ${pending
        .map((m) => m.filename)
        .join(', ')}`
    );

    const newlyApplied: string[] = [];
    for (const mig of pending) {
      try {
        await client.query('BEGIN');
        await client.query(mig.sql);
        await client.query(
          `INSERT INTO ${LEDGER_TABLE} (version, name, filename, checksum, applied_at, runner)
           VALUES ($1, $2, $3, $4, NOW(), $5)`,
          [mig.version, mig.name, mig.filename, mig.checksum, 'server/src/db/migrate.ts']
        );
        await client.query('COMMIT');
        newlyApplied.push(mig.filename);
        console.log(`[DHAROHAR DB]   applied ${mig.filename} (checksum ${mig.checksum.slice(0, 17)}...)`);
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(
          `[DHAROHAR DB] Migration ${mig.filename} FAILED and was rolled back — the database is ` +
            `unchanged and it was NOT recorded as applied: ${err.message}`
        );
        // A migration that stops on purpose says WHY in MESSAGE and WHAT TO DO in HINT/DETAIL. The
        // operator needs both, and the driver returns them as separate fields.
        if (err.detail) console.error(`[DHAROHAR DB]   detail: ${err.detail}`);
        if (err.hint) console.error(`[DHAROHAR DB]   hint:   ${err.hint}`);
        throw err;
      }
    }

    const finalApplied = await readApplied(client);
    console.log(
      `[DHAROHAR DB] Migrations applied successfully with PostGIS spatial tables ` +
        `(${newlyApplied.length} new, ${finalApplied.size} total recorded in ${LEDGER_TABLE}).`
    );
    return {
      appliedVersions: finalApplied.size,
      newlyApplied,
      pendingBefore: pending.length,
    };
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

/**
 * True when this module is the process entry point.
 *
 * `process.argv[1]` is whatever the caller typed, so `node dist-server/db/migrate.js` (which is
 * how the container entrypoint invokes migrations) arrives as a RELATIVE path while
 * import.meta.url is absolute. Comparing them verbatim silently skipped the whole run and still
 * exited 0 — a deploy that believes the schema is in place when nothing ran. Hence: resolve,
 * normalise separators, and ignore the file extension (tsx vs compiled .js).
 */
function isCalledAsEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalise = (p: string) =>
    path.resolve(p).replace(/\\/g, '/').replace(/\.[cm]?[jt]sx?$/, '');
  return normalise(entry) === normalise(fileURLToPath(import.meta.url));
}

if (isCalledAsEntrypoint()) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err: any) => {
      // Loud AND non-zero: the previous runner swallowed the message here, so a failed deploy
      // produced an empty log. The reason must be visible to whoever reads the CI output.
      console.error('[DHAROHAR DB] Migration run ABORTED — nothing new was applied:');
      console.error(err?.message ?? String(err));
      process.exit(1);
    });
}
