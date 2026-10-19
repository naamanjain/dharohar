import { DEMO_PASSWORD, IS_PRODUCTION } from '../config/env';
import { Pool } from 'pg';
import { UserAccount, AuditLogEntry } from '../types/backend';
import { hashPassword } from '../utils/crypto';

export type StorageMode = 'postgres-postgis' | 'dev-fallback';

export interface DbHealth {
  connected: boolean;
  storageMode: StorageMode;
  postgisAvailable: boolean;
  postgisVersion?: string;
  database?: string;
  error?: string;
  uptimeSeconds: number;
}

const startTime = Date.now();
let activeStorageMode: StorageMode = 'dev-fallback';
let postgisAvailable = false;
let postgisVersionString = '';
let connectedDatabaseName = '';
let connectionError: string | undefined = undefined;

// pg natively honours PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, and DATABASE_URL wins when
// set. The prototype's `postgres`/`postgres`@localhost defaults are deliberately gone: they
// let the server connect to an unrelated local database and report success.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  connectionTimeoutMillis: 3000,
});

// Pre-seeded demo user accounts with cryptographic salts & PBKDF2 hashes
const defaultSalt = 'dharohar_salt_demo_2026';
// Supplied by the environment (see server/src/config/env.ts); never a literal in this repository.
const defaultPassword = DEMO_PASSWORD;
const defaultHash = hashPassword(defaultPassword, defaultSalt).hash;

export const INITIAL_USERS: UserAccount[] = [
  {
    id: 'USR-TEH-01',
    email: 'tehsildar@dharohar.local',
    passwordHash: defaultHash,
    salt: defaultSalt,
    role: 'TEHSILDAR',
    displayName: 'Shri Arvind Sharma, RAS',
    designation: 'Revenue Officer / Tehsildar',
    badgeNumber: 'RJ-REV-2018-0941',
    jurisdiction: 'Tehsil Sanganer, Circle Jaipur South',
    district: 'Jaipur',
    state: 'Rajasthan',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'USR-VER-02',
    email: 'patwari@dharohar.local',
    passwordHash: defaultHash,
    salt: defaultSalt,
    role: 'PATWARI',
    displayName: 'Smt. Sunita Choudhary',
    designation: 'Senior Verification Officer',
    badgeNumber: 'RJ-REV-2021-3812',
    jurisdiction: 'Central Digitization Center, Jodhpur',
    district: 'Jodhpur',
    state: 'Rajasthan',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'USR-OPR-03',
    email: 'operator@dharohar.local',
    passwordHash: defaultHash,
    salt: defaultSalt,
    role: 'DATA_ENTRY_OPERATOR',
    displayName: 'Vikram Singh Rathore',
    designation: 'Verification Operator',
    badgeNumber: 'RJ-OPS-2023-1109',
    jurisdiction: 'Tehsil Girwa Record Room',
    district: 'Udaipur',
    state: 'Rajasthan',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'USR-AUD-04',
    email: 'auditor@dharohar.local',
    passwordHash: defaultHash,
    salt: defaultSalt,
    role: 'AUDITOR',
    displayName: 'Dr. Meenakshi Sundaram, IAS',
    designation: 'State Land Records Auditor',
    badgeNumber: 'RJ-AUDIT-2015-0012',
    jurisdiction: 'Board of Revenue for Rajasthan, Ajmer',
    district: 'Ajmer',
    state: 'Rajasthan',
    createdAt: new Date().toISOString(),
  },
];

// Fallback in-memory store for development/demo when PostgreSQL is not configured.
//
// The demo personas are deliberately ABSENT in production. They are loaded at module import,
// so leaving them in place let a fixture persona mint a real Tehsildar token against an empty
// users table — which bypassed every role check. Production accounts must be created deliberately
// (npm run db:seed, or your own provisioning), never inherited from a fixture that ships in the
// repository.
export const DEMO_PERSONAS_ENABLED = !IS_PRODUCTION;

/**
 * Capability grants that belong to the demo personas, keyed by user id.
 *
 * This single map is written into `user_capabilities` by db:seed AND used by the in-memory principal
 * loader, so the development store and PostgreSQL cannot drift into different authorization
 * behaviour. Nothing here grants anything to a real officer: capabilities for people are issued by
 * an administrator through the provisioning path, and a user with no rows can do nothing.
 *
 * `STATE_WIDE_READ` is on the demo auditor because the prototype walkthrough shows a Board of
 * Revenue officer reading across districts. Under design default D3 that is a separate, explicitly
 * granted capability — not what the AUDITOR role means.
 */
export const DEMO_CAPABILITY_GRANTS: Record<string, string[]> = {
  'USR-AUD-04': ['STATE_WIDE_READ'],
};

export const memoryStore = {
  users: new Map<string, UserAccount>(
    DEMO_PERSONAS_ENABLED ? INITIAL_USERS.map((u) => [u.id, u]) : []
  ),
  parcels: new Map<string, any>(),
  owners: new Map<string, any[]>(),
  documents: new Map<string, any>(),
  fieldInspections: new Map<string, any[]>(),
  auditLogs: [] as AuditLogEntry[],
};

export async function initDbConnection(): Promise<DbHealth> {
  try {
    const client = await pool.connect();
    try {
      // Which database did we actually land on? The connection string is never a reportable answer:
      // it can contain the password, and /api/health is unauthenticated.
      const where = await client.query('SELECT current_database() AS db').catch(() => null);
      if (where && where.rows.length > 0) connectedDatabaseName = String(where.rows[0].db);

      // Test PostGIS extension
      const postgisCheck = await client.query('SELECT PostGIS_Version();').catch(() => null);
      if (postgisCheck && postgisCheck.rows.length > 0) {
        postgisAvailable = true;
        postgisVersionString = postgisCheck.rows[0].postgis_version || 'Enabled';
      }

      activeStorageMode = 'postgres-postgis';
      connectionError = undefined;
      console.log(
        `[DHAROHAR DB] Connected to PostgreSQL. PostGIS: ${
          postgisAvailable ? postgisVersionString : 'Not detected'
        }`
      );
    } finally {
      client.release();
    }
  } catch (err: any) {
    // pg reports an unparseable connection string as "Invalid URL", which names neither the setting
    // nor the cause. The cause is almost always the password: compose interpolates it into
    // DATABASE_URL raw, and base64 alphabet includes / and +, both of which break the URL.
    const parseFailure = /invalid url|ERR_INVALID_URL/i.test(String(err?.message || ''));
    const cause = parseFailure
      ? ' — DATABASE_URL itself does not parse. Generate database passwords with `openssl rand -hex 32`:'
        + ' a base64 password can contain / or +, which compose interpolates into the connection string raw.'
      : '';
    if (IS_PRODUCTION) {
      // A production instance that quietly drops to the in-memory store accepts writes that look
      // successful and vanish on restart. For land records that is data loss, so refuse instead.
      console.error('[DHAROHAR DB] FATAL: PostgreSQL is unreachable in production mode:', err.message + cause);
      throw new Error(`Production startup requires a reachable PostgreSQL database: ${err.message}${cause}`);
    }
    activeStorageMode = 'dev-fallback';
    connectedDatabaseName = '';
    connectionError = err.message || 'Database connection error';
    console.warn(`[DHAROHAR DB] NOTICE: Running in EXPLICIT DEV-FALLBACK mode.`);
    console.warn(`[DHAROHAR DB] In-memory storage is active for local testing and demonstration.`);
    console.warn(`[DHAROHAR DB] NOTHING WRITTEN NOW IS PERSISTED. Restarts lose every record.`);
  }

  return getDbHealth();
}

/**
 * Active connectivity probe for readiness checks — reports whether the database answers right
 * now, not whether it answered at boot.
 */
export async function checkDbReachable(): Promise<{ ok: boolean; error?: string }> {
  // pool.connect() itself rejects when the database is down. Left outside the try, that became an
  // unhandled rejection in the async route handler — and Express 4 does not catch those, so a
  // single failed readiness probe took the whole API process down instead of answering 503.
  let client;
  try {
    client = await pool.connect();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }

  try {
    await client.query('SELECT 1');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

export function getDbHealth(): DbHealth {
  return {
    connected: activeStorageMode === 'postgres-postgis',
    storageMode: activeStorageMode,
    postgisAvailable,
    postgisVersion: postgisVersionString || undefined,
    database: connectedDatabaseName || undefined,
    error: connectionError,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  };
}

// An idle client that drops emits 'error'; without a listener that terminates the process.
pool.on('error', (err) => {
  console.error('[DHAROHAR DB] Idle pool client error:', err.message);
});
