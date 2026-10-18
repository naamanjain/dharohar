/**
 * District registry administration.
 *
 * This exists because migration 0003 made the registry load-bearing: a record whose district is not
 * registered is now refused at write time, by design, because this server will not invent a
 * jurisdiction for a land record. Enforcement without a management path is an outage, so declaring a
 * district is an audited, capability-gated operation rather than something an operator does by hand
 * in psql at 2am.
 *
 * The caller never supplies a code. `code = lower(trim(name))` is enforced by a CHECK on the table,
 * and the canonical-name unique index is what stops two spellings becoming two jurisdictions — so a
 * supplied code could only ever be a way to create the exact ambiguity this table now forbids.
 */

import { pool, getDbHealth } from '../db/db';
import { recordAuditLog } from './auditService';
import { RequestPrincipal } from './jurisdiction';

export class RegistryRejected extends Error {
  constructor(readonly code: string, message: string, readonly details?: any) {
    super(message);
    this.name = 'RegistryRejected';
  }
}

export interface DistrictRow {
  code: string;
  name: string;
  organizationId: string | null;
  provenance: 'derived' | 'declared';
  isActive: boolean;
  records: number;
  officers: number;
}

const POSTGRES_ONLY =
  'The district registry lives in PostgreSQL. Nothing was created or changed in memory.';

function requirePostgres() {
  if (getDbHealth().storageMode !== 'postgres-postgis') {
    throw new RegistryRejected('REGISTRY_REQUIRES_DATABASE', POSTGRES_ONLY);
  }
}

function canonicalCode(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The registry with its live counts, so an administrator can see what deactivating a district would
 * strand. `records` counts parcels and filed documents; `officers` counts unrevoked assignments.
 */
export async function listDistricts(): Promise<DistrictRow[]> {
  requirePostgres();
  const result = await pool.query(
    `SELECT d.code, d.name, d.organization_id, d.provenance, d.is_active,
            (SELECT count(*)::int FROM parcels p WHERE p.district_code = d.code) AS parcels,
            (SELECT count(*)::int FROM land_documents l WHERE l.district_code = d.code) AS documents,
            (SELECT count(*)::int FROM user_jurisdictions j
              WHERE j.district_code = d.code AND j.revoked_at IS NULL) AS officers
       FROM districts d ORDER BY lower(d.name), d.code`
  );
  return result.rows.map((r: any) => ({
    code: r.code,
    name: r.name,
    organizationId: r.organization_id,
    provenance: r.provenance,
    isActive: r.is_active,
    records: r.parcels + r.documents,
    officers: r.officers,
  }));
}

/**
 * Declare a district as the department spells it. Returns the row, existing or new; an existing code
 * is reported rather than silently overwritten, because renaming a district is a different decision
 * from creating one and neither is made here.
 */
export async function declareDistrict(
  input: { name?: unknown; organizationId?: unknown },
  principal: RequestPrincipal
): Promise<{ district: DistrictRow; created: boolean }> {
  requirePostgres();

  const name = String(input?.name ?? '').trim();
  if (!name) {
    throw new RegistryRejected('DISTRICT_NAME_REQUIRED', 'A district needs the name the department uses.');
  }
  if (name.length > 256) {
    throw new RegistryRejected('DISTRICT_NAME_TOO_LONG', 'District names are limited to 256 characters.');
  }
  const code = canonicalCode(name);
  if (!code) {
    throw new RegistryRejected('DISTRICT_NAME_REQUIRED', 'A district name cannot be only whitespace.');
  }

  const organizationId =
    input?.organizationId === undefined || input.organizationId === null
      ? null
      : String(input.organizationId).trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT code FROM districts WHERE code = $1 FOR UPDATE', [code]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      const rows = await listDistricts();
      const district = rows.find((d) => d.code === code);
      if (!district) throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${code} vanished between checks.`);
      return { district, created: false };
    }

    if (organizationId) {
      const org = await client.query('SELECT 1 FROM organizations WHERE id = $1', [organizationId]);
      if ((org.rowCount ?? 0) === 0) {
        throw new RegistryRejected(
          'ORGANIZATION_NOT_FOUND',
          `Organization ${organizationId} does not exist. Create the tenant first, then its districts.`,
          { organizationId }
        );
      }
    }

    // Two spellings of one jurisdiction cannot be told apart by software, so the collision is
    // reported before the insert rather than letting the unique index raise it: once a statement has
    // failed, this transaction is aborted and any follow-up query answers "current transaction is
    // aborted" instead of naming the row that clashed. The index stays as the race-condition backstop.
    const clash = await client.query(
      `SELECT code, name FROM districts
        WHERE lower(translate(name, ' ', '')) = lower(translate($2, ' ', '')) AND code <> $1`,
      [code, name]
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new RegistryRejected(
        'DISTRICT_SPELLING_AMBIGUOUS',
        `"${name}" is the same jurisdiction as ${clash.rows
          .map((r: any) => `"${r.name}" (${r.code})`)
          .join(', ')}. Decide which spelling the department uses; this server will not register two.`,
        { clashes: clash.rows, name }
      );
    }

    // The unique canonical-name index is what refuses a second spelling of an existing jurisdiction.
    // Its error is opaque, so the collision is reported here in the terms the department thinks in.
    try {
      await client.query(
        `INSERT INTO districts (code, name, organization_id, provenance) VALUES ($1, $2, $3, 'declared')`,
        [code, name, organizationId]
      );
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new RegistryRejected(
          'DISTRICT_SPELLING_AMBIGUOUS',
          `The registry already holds a district whose name normalizes to "${name}". Decide which spelling is the jurisdiction; this server will not register two.`,
          { name, code }
        );
      }
      if (err?.code === '23514') {
        throw new RegistryRejected(
          'DISTRICT_NAME_REJECTED',
          `The registry refused "${name}". A district code must be the lower-case form of its name and the name must not collide with an existing jurisdiction.`,
          { detail: err.detail }
        );
      }
      throw err;
    }

    await recordAuditLog(
      {
        actionType: 'DISTRICT_DECLARED',
        entityType: 'DISTRICT',
        entityId: code,
        performedBy: principal.userId,
        officerBadge: principal.badgeNumber ?? null,
        details: { name, organizationId, by: principal.email, provenance: 'declared' },
      },
      client
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rows = await listDistricts();
  const district = rows.find((d) => d.code === code);
  if (!district) throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${code} was not recorded.`);
  return { district, created: true };
}

/**
 * Retire or restore a district. Nothing is deleted and no record moves: existing parcels keep their
 * code, and officers keep their assignments, because deactivating a jurisdiction that still has land
 * records must not make those records unreachable. What stops is new filing under it — the trigger
 * refuses an inactive district.
 */
export async function setDistrictActive(
  code: string,
  active: boolean,
  reason: unknown,
  principal: RequestPrincipal
): Promise<{ code: string; isActive: boolean; records: number; officers: number }> {
  requirePostgres();

  const key = canonicalCode(String(code ?? ''));
  if (!key) throw new RegistryRejected('DISTRICT_NOT_FOUND', 'A district code is required.');
  const note = String(reason ?? '').trim();
  if (!note) {
    throw new RegistryRejected(
      'REASON_REQUIRED',
      `Retiring or restoring a jurisdiction needs a written reason for the audit trail.`,
      { code: key }
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT code, is_active FROM districts WHERE code = $1 FOR UPDATE', [key]);
    if ((found.rowCount ?? 0) === 0) {
      throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${key} is not registered.`, { code: key });
    }

    await client.query('UPDATE districts SET is_active = $2 WHERE code = $1', [key, active]);
    await recordAuditLog(
      {
        actionType: active ? 'DISTRICT_REACTIVATED' : 'DISTRICT_DEACTIVATED',
        entityType: 'DISTRICT',
        entityId: key,
        performedBy: principal.userId,
        officerBadge: principal.badgeNumber ?? null,
        details: { reason: note, by: principal.email, before: found.rows[0].is_active, after: active },
      },
      client
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rows = await listDistricts();
  const district = rows.find((d) => d.code === key);
  return {
    code: key,
    isActive: active,
    records: district?.records ?? 0,
    officers: district?.officers ?? 0,
  };
}
