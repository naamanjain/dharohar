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
import { beginTenantTransaction, tenantQuery } from '../db/tenant';
import { recordAuditLog } from './auditService';
import { mayProvisionOfficers } from './jurisdiction';
import type { RequestPrincipal } from './jurisdiction';

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
  /**
   * What the registry claims this row IS. Since migration 0007 a declaration produces 'candidate':
   * registered, grantable to a tenant, workable — and not canonical geography until somebody with
   * USER_ADMIN promotes it with a reason. Exposed here because hiding it would make the review queue
   * invisible to the people who have to clear it.
   */
  kind: 'candidate' | 'canonical' | 'test_fixture' | 'retired';
  isActive: boolean;
  records: number;
  officers: number;
}

/** The three kinds of authority an organization can hold over a district. */
export const DISTRICT_RELATIONSHIPS = ['administers', 'audits', 'reads'] as const;
export type DistrictRelationship = (typeof DISTRICT_RELATIONSHIPS)[number];

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
export async function listDistricts(principal?: RequestPrincipal): Promise<DistrictRow[]> {
  requirePostgres();
  // The counts are what makes this endpoint a leak rather than a catalogue: "412 records in Jaipur"
  // is somebody else's register volume. With a caller, the query runs in that caller's row-level
  // security context, so the parcel and document counts can only ever count their own tenant, and the
  // officer count is restricted to officers of their organization. Without a caller (the one-shot
  // services) the counts are the platform-wide totals they have always been.
  const scoped = Boolean(principal?.organizationId);
  const orgParams = scoped ? [principal!.organizationId] : [];
  const result = principal
    ? await tenantQuery(principal,
        `SELECT d.code, d.name, d.organization_id, d.provenance, d.kind, d.is_active,
                (SELECT count(*)::int FROM parcels p WHERE p.district_code = d.code) AS parcels,
                (SELECT count(*)::int FROM land_documents l WHERE l.district_code = d.code) AS documents,
                (SELECT count(*)::int FROM user_jurisdictions j
                   JOIN users u ON u.id = j.user_id
                  WHERE j.district_code = d.code AND j.revoked_at IS NULL
                    ${scoped ? 'AND u.organization_id = $1' : ''}) AS officers
           FROM districts d ORDER BY lower(d.name), d.code`,
        orgParams)
    : await (async () => {
        // No caller means the one-shot services, which connect as an identity exempt from row-level
        // security, and the counts are the platform-wide totals they have always been. Since migration
        // 0010 that exemption is what makes the totals true: a runtime-role connection with no tenant
        // bound would report `officers = 0` for every district and present it as a fact. Refuse the
        // identity rather than publish a number it cannot see.
        const identity = await pool.query(
          `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                   OR (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS exempt,
               (SELECT relrowsecurity FROM pg_class WHERE oid = 'user_jurisdictions'::regclass) AS scoped`
        );
        if (identity.rows[0]?.scoped === true && identity.rows[0]?.exempt !== true) {
          throw new RegistryRejected(
            'PRINCIPAL_REQUIRED',
            'The registry counts cannot be produced honestly without a caller: this database identity is ' +
              'subject to row-level security over the officer and record tables, so every count would read ' +
              'zero and be presented as a total.'
          );
        }
        return pool.query(
          `SELECT d.code, d.name, d.organization_id, d.provenance, d.kind, d.is_active,
                  (SELECT count(*)::int FROM parcels p WHERE p.district_code = d.code) AS parcels,
                  (SELECT count(*)::int FROM land_documents l WHERE l.district_code = d.code) AS documents,
                  (SELECT count(*)::int FROM user_jurisdictions j
                    WHERE j.district_code = d.code AND j.revoked_at IS NULL) AS officers
             FROM districts d ORDER BY lower(d.name), d.code`
        );
      })();
  return result.rows.map((r: any) => ({
    code: r.code,
    name: r.name,
    organizationId: r.organization_id,
    provenance: r.provenance,
    kind: r.kind,
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
  input: { name?: unknown; organizationId?: unknown; relationship?: unknown },
  principal: RequestPrincipal
): Promise<{ district: DistrictRow; created: boolean; granted: boolean }> {
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

  // The kind of authority the declaring tenant is taking on. Validated rather than defaulted silently:
  // `reads` and `audits` open no write path (see writeScope), so getting this wrong is not cosmetic.
  const requestedRelationship = String(input?.relationship ?? 'administers').trim();
  if (!(DISTRICT_RELATIONSHIPS as readonly string[]).includes(requestedRelationship)) {
    throw new RegistryRejected(
      'INVALID_RELATIONSHIP',
      `A district grant is one of ${DISTRICT_RELATIONSHIPS.join(', ')}. "${requestedRelationship}" is not a kind of authority this server understands.`,
      { relationship: requestedRelationship }
    );
  }
  const relationship = requestedRelationship as DistrictRelationship;

  let granted = false;
  // Inside the acting officer's tenant transaction: since migration 0010 the tenant-district grant
  // table carries a WITH CHECK clause, so a declaration written on an unbound connection is refused
  // by the database instead of landing in whichever organization the column happens to name.
  const client = await beginTenantTransaction(principal);
  try {

    const existing = await client.query('SELECT code, kind FROM districts WHERE code = $1 FOR UPDATE', [code]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      const rows = await listDistricts(principal);
      const district = rows.find((d) => d.code === code);
      if (!district) throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${code} vanished between checks.`);
      return { district, created: false, granted: false };
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

    // Declaring a district also says who may work in it, and that grant is what makes the row usable:
    // since migration 0007 a declaration lands as 'candidate' geography, and an officer can only reach
    // districts their own organization holds. Without this, declaring would produce a district that
    // nobody can file a record under.
    //
    // The tenant is the ACTOR's, never a value from the body — the same rule createOfficer applies.
    if (principal.organizationId) {
      const grant = await client.query(
        `INSERT INTO organization_districts (organization_id, district_id, relationship, granted_by, reason)
         SELECT $1, d.id, $2, $3, $4
           FROM districts d WHERE d.code = $5
         ON CONFLICT (organization_id, district_id, relationship) DO NOTHING`,
        [principal.organizationId, relationship, principal.email,
         `Declared by ${principal.displayName}, so the tenant that declared it may work there.`, code]
      );
      granted = (grant.rowCount ?? 0) > 0;
    }

    await recordAuditLog(
      {
        actionType: 'DISTRICT_DECLARED',
        entityType: 'DISTRICT',
        entityId: code,
        performedBy: principal.userId,
        officerBadge: principal.badgeNumber ?? null,
        actor: principal,
        details: {
          name, organizationId, by: principal.email, provenance: 'declared',
          // 'candidate' is the whole point of migration 0007: a declaration is not canonical geography
          // until somebody promotes it. Recorded here so the trail shows what was claimed.
          kind: 'candidate', grantedTo: principal.organizationId ?? null, relationship,
        },
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

  const rows = await listDistricts(principal);
  const district = rows.find((d) => d.code === code);
  if (!district) throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${code} was not recorded.`);
  return { district, created: true, granted };
}

/**
 * Promote a candidate district to canonical geography — the explicit, validated workflow that
 * migration 0007 exists to require. A reason of its own, a named actor, an audit entry, and nothing
 * else about the record changes.
 *
 * Retired and fixture rows are refused rather than rescued: retiring `probe 790279` was itself a
 * decision by the owner, and an endpoint that quietly promotes test residue back into geography would
 * undo it with a plausible-looking reason attached.
 */
export async function promoteDistrict(
  code: string,
  reason: string,
  principal: RequestPrincipal
): Promise<{ district: DistrictRow; promoted: boolean }> {
  requirePostgres();
  const key = canonicalCode(String(code ?? ''));
  if (!key) throw new RegistryRejected('DISTRICT_NOT_FOUND', 'A district code is required.');
  const note = String(reason ?? '').trim();
  if (note.length < 10) {
    throw new RegistryRejected(
      'REASON_REQUIRED',
      'Promoting a district to canonical geography needs a written reason of at least 10 characters for the audit trail.',
      { code: key }
    );
  }
  if (!mayProvisionOfficers(principal)) {
    throw new RegistryRejected(
      'PROMOTION_AUTHORITY_REQUIRED',
      'Only an officer holding the USER_ADMIN capability may decide what counts as canonical geography.',
      { code: key }
    );
  }

  // Inside the acting officer's tenant transaction: since migration 0010 the tenant-district grant
  // table carries a WITH CHECK clause, so a declaration written on an unbound connection is refused
  // by the database instead of landing in whichever organization the column happens to name.
  const client = await beginTenantTransaction(principal);
  try {
    const found = await client.query('SELECT code, kind FROM districts WHERE code = $1 FOR UPDATE', [key]);
    if ((found.rowCount ?? 0) === 0) {
      throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${key} is not registered.`, { code: key });
    }
    const kind = String(found.rows[0].kind);
    if (kind === 'canonical') {
      throw new RegistryRejected('NOT_A_CANDIDATE', `District ${key} is already canonical geography.`, { code: key, kind });
    }
    if (kind === 'retired' || kind === 'test_fixture') {
      throw new RegistryRejected(
        'REFUSES_TO_PROMOTE_FIXTURE',
        `District ${key} is ${kind} — retired by an owner decision. Promoting test residue into canonical geography is not what this endpoint does; resolve the registry row first.`,
        { code: key, kind }
      );
    }

    await client.query(
      `UPDATE districts SET kind = 'canonical',
              notes = btrim(coalesce(notes, '') || ' [0007 workflow] promoted from candidate by ' || $2 || ': ' || $3)
        WHERE code = $1`,
      [key, principal.email, note]
    );
    await recordAuditLog(
      {
        actionType: 'DISTRICT_PROMOTED',
        entityType: 'DISTRICT',
        entityId: key,
        performedBy: principal.userId,
        officerBadge: principal.badgeNumber ?? null,
        actor: principal,
        details: { reason: note, by: principal.email, before: kind, after: 'canonical' },
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

  const promotedRows = await listDistricts(principal);
  const promotedDistrict = promotedRows.find((d) => d.code === key);
  if (!promotedDistrict) throw new RegistryRejected('DISTRICT_NOT_FOUND', `District ${key} vanished after promotion.`);
  return { district: promotedDistrict, promoted: true };
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

  // Inside the acting officer's tenant transaction: since migration 0010 the tenant-district grant
  // table carries a WITH CHECK clause, so a declaration written on an unbound connection is refused
  // by the database instead of landing in whichever organization the column happens to name.
  const client = await beginTenantTransaction(principal);
  try {
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
        actor: principal,
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

  const rows = await listDistricts(principal);
  const district = rows.find((d) => d.code === key);
  return {
    code: key,
    isActive: active,
    records: district?.records ?? 0,
    officers: district?.officers ?? 0,
  };
}
