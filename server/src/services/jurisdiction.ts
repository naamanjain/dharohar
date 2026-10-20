/**
 * Jurisdiction scoping and request principal.
 *
 * This is the single authority for "may this officer touch this record". It lives on the server
 * because the frontend filters lists by district in places, and that is presentation only — the API
 * is the boundary.
 *
 * Two rules the design defaults in docs/DATA-MODEL-JURISDICTION.md §2 impose on this file:
 *
 *   D2 — an officer's jurisdictions are the rows in `user_jurisdictions`, resolved fresh per
 *        request. The district string inside the JWT is kept for display and certificate prefixes
 *        only; it is never consulted as authority, so a revocation takes effect on the next request
 *        instead of whenever the token expires.
 *   D3 — STATE_WIDE_READ is a separately granted capability. It opens reads across districts and
 *        confers no write anywhere: every write path is checked against assignments only.
 *
 * Deny-by-default: no assignment rows and no capabilities means no records, not all records.
 */

import { PoolClient } from 'pg';
import { tenantQuery } from '../db/tenant';
import { pool, getDbHealth, memoryStore, INITIAL_USERS, DEMO_CAPABILITY_GRANTS } from '../db/db';
import { recordAuditLog } from './auditService';
import { AuthTokenPayload, UserRole } from '../types/backend';

/**
 * Maps an authorization error that every router must answer the same way. Returns null when the error
 * is not one this helper owns, so the caller keeps its existing handling.
 *
 * `TenantContextMissing` is deliberately NOT folded into the 404 path: a 404 on every record would
 * tell an operator nothing when the real condition is that the officer account has no organization,
 * which is a disposition task for an administrator. It is 403 and it names the fix.
 */
export function authorizationErrorResponse(err: unknown): { status: number; body: any } | null {
  if (err instanceof TenantContextMissing) {
    return {
      status: 403,
      body: {
        success: false,
        error: {
          code: 'TENANT_CONTEXT_MISSING',
          message:
            'This officer account is not associated with an organization, so no record can be scoped to it. An administrator must assign the account to an organization; no records were read and nothing was changed.',
        },
      },
    };
  }
  return null;
}

/** Raised when a record exists but is outside the caller's jurisdiction. */
export class OutOfJurisdiction extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super();
    // Identical wording to the real not-found path so the two cannot be told apart.
    this.name = 'OutOfJurisdiction';
  }
}

export type Capability = 'STATE_WIDE_READ' | 'USER_ADMIN' | 'PARCEL_REHOME';

/**
 * The organization the in-memory development fixtures belong to. It exists so that tenant scoping is
 * one code path rather than two: demo mode has exactly one tenant, and the predicate below still runs
 * instead of being skipped — a rule that is only applied in production is a rule that is only tested
 * in production. Quarantine cannot be exercised in memory mode (no fixture is unowned), which is why
 * server/src/test_tenancy_isolation_suite.ts runs against a real database.
 */
export const DEV_TENANT_ORGANIZATION = 'ORG-DEV-IN-MEMORY';

/**
 * Thrown when a caller is authenticated but belongs to no organization, so there is no tenant scope to
 * answer with. Reported as 403 with an explanation rather than as a 404 on every record: an empty
 * register after migration 0006 is a disposition task, and the officer deserves to be told that
 * rather than to be shown a wall of not-found pages.
 */
export class TenantContextMissing extends Error {
  constructor() {
    super('The signed-in officer is not associated with an organization, so no record can be scoped to them.');
    this.name = 'TenantContextMissing';
  }
}

/**
 * Everything the authorization layer knows about the caller. Built from the database (or, in
 * development mode, from the in-memory personas) — never from a client-supplied field.
 */
export interface RequestPrincipal {
  userId: string;
  email: string;
  role: UserRole;
  displayName: string;
  designation?: string;
  badgeNumber: string;
  organizationId: string | null;
  /** Active jurisdiction assignments. The authority for every read and write. */
  districts: string[];
  /** Active capability grants. */
  capabilities: Capability[];
  /**
   * The districts the caller's ORGANIZATION holds, with the relationship kind, read from
   * `organization_districts` where revoked_at IS NULL. Loaded with the principal so a grant or a
   * revocation takes effect on the next request rather than at token expiry. Empty for an identity
   * that belongs to no organization — which is why such an identity can administer accounts but
   * cannot read a single record.
   */
  organizationGrants: Array<{ district: string; relationship: 'administers' | 'audits' | 'reads' }>;
  /** Display/certificate prefix only. Never used to authorize anything. */
  primaryDistrict: string;
}

const normalise = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const hasCapability = (p: RequestPrincipal, capability: Capability): boolean =>
  p.capabilities.includes(capability);

/** True when this caller may read records in districts they are not assigned to. */
export function hasStateWideRead(p: RequestPrincipal): boolean {
  return hasCapability(p, 'STATE_WIDE_READ');
}

/**
 * The districts a caller may READ, or null when they may read the whole state.
 * `districts` is normalised for LOWER/TRIM comparison in SQL and in JS alike.
 *
 * Two independent authorities have to agree: the officer's own assignment (who this person is posted
 * to) and the organization's grant over that district (what this tenant may work in). Personal
 * assignment alone is not enough — an officer cannot reach a district their organization was never
 * granted — and the organization grant alone is not enough either, because a grant does not say which
 * officer may use it. Relationship kind decides read versus write, so `reads` and `audits` open reads
 * and never mutations, exactly as STATE_WIDE_READ does.
 */
export function readScope(p: RequestPrincipal): string[] | null {
  const granted = districtsGrantedTo(p, ['reads', 'audits', 'administers']);
  if (granted.size === 0) {
    // No organization, or no grant: the caller's own assignments authorize nothing on their own. An
    // empty list is the deny-by-default case, and `= ANY('{}')` matches no row.
    return [];
  }
  if (hasStateWideRead(p)) {
    // `null` here means "not bounded by this officer's own postings", which is what the capability
    // grants and what every caller already treats it as. It is not a cross-tenant licence: the
    // organization predicate is applied independently, so a state-wide reader still reads only inside
    // their own tenant. The districts they are then shown are bounded by nothing in their own
    // assignment list — which is precisely why exercising it is written to the audit chain.
    return null;
  }
  return p.districts.map(normalise).filter((d) => d !== '' && granted.has(d));
}

/** The districts a caller may WRITE. State-wide read is deliberately not consulted here (D3). */
export function writeScope(p: RequestPrincipal): string[] {
  const granted = districtsGrantedTo(p, ['administers']);
  return p.districts.map(normalise).filter((d) => d !== '' && granted.has(d));
}

/**
 * The organization's active grants over districts, by relationship kind. Comes from the principal,
 * which is loaded from the database on every request — a client-supplied organization id never reaches
 * here (see createOfficer, which takes the actor's organization and no input field).
 */
function districtsGrantedTo(p: RequestPrincipal, kinds: string[]): Set<string> {
  if (!p.organizationId) return new Set();
  return new Set(
    (p.organizationGrants ?? [])
      .filter((g) => kinds.includes(g.relationship))
      .map((g) => normalise(g.district))
      .filter((d) => d !== '')
  );
}

/**
 * Whether the tenant holds ANY grant over a district, and of which kind. Reported separately from the
 * scopes above because a refusal needs to say which of the two authorities was missing — without
 * naming the record, which would confirm it exists.
 */
export function organizationGrantOver(
  p: RequestPrincipal,
  district: string | null
): 'administers' | 'audits' | 'reads' | null {
  const want = normalise(district);
  if (!p.organizationId || !want) return null;
  const grants = (p.organizationGrants ?? []).filter((g) => normalise(g.district) === want);
  if (grants.some((g) => g.relationship === 'administers')) return 'administers';
  if (grants.some((g) => g.relationship === 'audits')) return 'audits';
  if (grants.some((g) => g.relationship === 'reads')) return 'reads';
  return null;
}

/**
 * Kept for call sites that pre-dated the capability model: a caller whose only power is state-wide
 * read still cannot mutate, so this remains role-based.
 */
export function isReadOnlyRole(p: Pick<RequestPrincipal, 'role'>): boolean {
  return p.role === 'AUDITOR';
}

/** SQL fragment + parameter restricting a query to the caller's own organization. */
export function organizationScopeClause(
  p: RequestPrincipal,
  alias = 'p',
  paramIndex = 1
): { sql: string; params: any[] } {
  if (!p.organizationId) {
    // Fail closed in SQL. `1 = 0` rather than an empty parameter list, so a query that forgets to
    // check the principal still returns nothing instead of everything.
    return { sql: ' AND (1 = 0)', params: [] };
  }
  // Equality on organization_id excludes the unowned (quarantined) rows by definition: NULL = 'X'
  // is not true. That is the whole of the quarantine rule, and it is why no query needs a special
  // case for "unassigned".
  return {
    sql: ` AND ${alias}.organization_id = $${paramIndex}`,
    params: [p.organizationId],
  };
}

/**
 * SQL fragment + parameters restricting a parcel query to what the caller may read: their districts
 * AND their organization. The two are independent on purpose — `organization_districts` may grant two
 * tenants the same district, and that grant must not read as ownership of the other tenant's records.
 */
export function parcelScopeClause(
  p: RequestPrincipal,
  alias = 'p',
  paramIndex = 1
): { sql: string; params: any[] } {
  // Parameters are numbered by what is ACTUALLY emitted, not by a fixed offset. A state-wide reader
  // contributes no district parameter, so a hard-coded second position referenced a placeholder that
  // was never sent and PostgreSQL refused the query — which surfaced as an empty list under a 503, and
  // only showed up by running the jurisdiction suite against a migrated copy.
  const parts: string[] = [];
  const params: any[] = [];
  const district = districtScopeClause(p, alias, paramIndex + params.length);
  if (district.sql) { parts.push(district.sql); params.push(...district.params); }
  const organization = organizationScopeClause(p, alias, paramIndex + params.length);
  if (organization.sql) { parts.push(organization.sql); params.push(...organization.params); }
  return { sql: parts.join(''), params };
}

/** The district half of the rule, separated so a query can be scoped by geography alone if it must. */
export function districtScopeClause(
  p: RequestPrincipal,
  alias = 'p',
  paramIndex = 1
): { sql: string; params: any[] } {
  const scope = readScope(p);
  if (scope === null) return { sql: '', params: [] };
  // Comparison is case/whitespace-insensitive because district spelling is free text today;
  // docs/DATA-MODEL-JURISDICTION.md §4.1 tracks replacing this with a foreign key on `districts`.
  // An officer with no assignments gets an empty list, and `= ANY('{}')` matches nothing — that is
  // the deny-by-default case, not a bug to specialise around.
  return {
    sql: ` AND LOWER(TRIM(${alias}.district)) = ANY($${paramIndex}::text[])`,
    params: [scope],
  };
}

/** Narrow a caller's read scope by a client-supplied district without ever widening it. */
export function intersectReadScope(p: RequestPrincipal, requested: string): string[] | null {
  const scope = readScope(p);
  if (scope === null) return null;
  const want = normalise(requested);
  return scope.includes(want) ? [want] : [];
}

/** Look up a parcel's district from whichever store is authoritative right now. */
export async function parcelDistrict(
  p: RequestPrincipal,
  parcelId: string,
  client?: PoolClient
): Promise<string | null> {
  const owned = await parcelOwnership(p, parcelId, client);
  return owned ? owned.district : null;
}

/**
 * A parcel's jurisdiction AND its owner, in one read. Every single-record path goes through here, so
 * the two predicates cannot drift apart between the list query and the detail query — which is the
 * shape the leak had: the list was district-scoped and the detail was keyed by id alone.
 *
 * Returns null when the row does not exist for this caller. Under row-level security that is also what
 * happens for a row owned by a different organization, so the application's refusal and the database's
 * invisibility give the same answer and neither one has to trust the other.
 */
export async function parcelOwnership(
  p: RequestPrincipal,
  parcelId: string,
  client?: PoolClient
): Promise<{ district: string | null; organizationId: string | null } | null> {
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    const sql = 'SELECT district, organization_id FROM parcels WHERE id = $1';
    // A caller already inside a tenant transaction passes their client and the row-level policies
    // apply to that transaction's context. Anyone without one gets a transaction of their own —
    // there is no path here that reads parcels on the unbound pool, which is the only way this
    // function could silently return nothing for a legitimately visible record.
    const rows = client
      ? (await client.query(sql, [parcelId])).rows
      : (await tenantQuery(p, sql, [parcelId])).rows;
    if (rows.length === 0) return null;
    return { district: rows[0].district, organizationId: rows[0].organization_id ?? null };
  }

  const parcel = memoryStore.parcels.get(parcelId);
  if (!parcel) return null;
  return { district: parcel.district, organizationId: DEV_TENANT_ORGANIZATION };
}

/**
 * The tenant half of the decision, shared by every single-record path.
 *
 * A record with no owner is refused as not-found, in the caller's own words: quarantine must not be
 * distinguishable from absence, or an officer could probe the register for which unowned parcel ids
 * exist. A caller with no organization gets the explainable 403 instead, because that is a
 * configuration the operator has to see and fix.
 */
function assertSameOrganization(
  p: RequestPrincipal,
  organizationId: string | null,
  resource: string
): void {
  if (!p.organizationId) throw new TenantContextMissing();
  // No message is passed to OutOfJurisdiction on purpose. Unowned, foreign-owned and absent all have
  // to produce the same bytes on the wire, or the endpoint becomes a way to enumerate which records
  // exist in somebody else's tenant. `resource` is therefore only used for the developer log.
  if (!organizationId) {
    console.warn(`[JURISDICTION] ${resource} is quarantined (no owner); refused as not-found for ${p.email}`);
    throw new OutOfJurisdiction();
  }
  if (organizationId !== p.organizationId) {
    console.warn(`[JURISDICTION] ${resource} belongs to ${organizationId}, caller is ${p.organizationId}; refused as not-found`);
    throw new OutOfJurisdiction();
  }
}

function inScope(district: string | null, scope: string[] | null): boolean {
  if (scope === null) return true;
  if (district === null) return false;
  return scope.includes(normalise(district));
}

/**
 * Throws OutOfJurisdiction when the parcel is not readable by this caller.
 * Pass `client` when calling inside an existing transaction.
 *
 * A state-wide reader who reaches a parcel outside their own assignments is recorded there (D3), so
 * "read a record they were never posted to" is in the durable trail rather than only in the access
 * log. Reads inside their own districts are not recorded — that would be noise, not oversight.
 */
export async function assertParcelReadable(
  p: RequestPrincipal,
  parcelId: string,
  client?: PoolClient
): Promise<void> {
  const record = await parcelOwnership(p, parcelId, client);
  if (!record) throw new OutOfJurisdiction();

  // Ownership first, and independently of the district rule. A state-wide reader is not a
  // cross-tenant reader: the capability widens geography inside one organization, never tenancy.
  assertSameOrganization(p, record.organizationId, `parcel ${parcelId}`);

  const scope = readScope(p);

  if (scope === null) {
    if (!p.districts.map(normalise).includes(normalise(record.district))) {
      await logStateWideRead(p, 'parcel-read', { parcelId, district: record.district });
    }
    return;
  }

  if (!inScope(record.district, scope)) throw new OutOfJurisdiction();
}

/**
 * Write-side check. A state-wide reader is refused here exactly as any other caller outside the
 * parcel's district would be — capability opens reads, never mutations (D3).
 */
export async function assertParcelWritable(
  p: RequestPrincipal,
  parcelId: string,
  client?: PoolClient
): Promise<void> {
  if (isReadOnlyRole(p)) throw new OutOfJurisdiction();
  const record = await parcelOwnership(p, parcelId, client);
  if (!record) throw new OutOfJurisdiction();
  assertSameOrganization(p, record.organizationId, `parcel ${parcelId}`);
  if (!inScope(record.district, writeScope(p))) throw new OutOfJurisdiction();
}

/** What a document needs before either document assertion can decide anything. */
export interface DocumentScope {
  id?: string;
  district?: string | null;
  parcelId?: string | null;
  parcel_id?: string | null;
  /**
   * Required, not optional. A caller that has not selected the column cannot reach this type, so
   * "forgot to load the owner" is a compile error rather than a check that quietly passes.
   */
  organizationId: string | null;
}

/** Read access to a document: its own district when set, else the parcel it is attached to. */
export async function assertDocumentReadable(
  p: RequestPrincipal,
  document: DocumentScope,
  client?: PoolClient
): Promise<void> {
  assertSameOrganization(p, document.organizationId, `document ${document.id ?? '?'}`);

  const scope = readScope(p);
  if (scope === null) {
    // Logged here rather than by falling through to assertParcelReadable: a state-wide reader who
    // opens a document in a district they are not posted to is exercising the capability, and D3
    // requires that to be recorded whichever surface it happens on.
    const held = p.districts.map(normalise);
    const own = normalise(document.district);
    if (!own || !held.includes(own)) {
      await logStateWideRead(p, 'document-read', {
        documentId: document.id ?? null,
        district: document.district ?? null,
      });
    }
    return;
  }

  const own = document.district;
  if (own) {
    if (scope.includes(normalise(own))) return;
    throw new OutOfJurisdiction();
  }

  const linked = document.parcelId ?? document.parcel_id;
  if (!linked) throw new OutOfJurisdiction();

  await assertParcelReadable(p, linked, client);
}

/** Write access to a document, same rule as parcels: state-wide read never applies. */
export async function assertDocumentWritable(
  p: RequestPrincipal,
  document: DocumentScope,
  client?: PoolClient
): Promise<void> {
  if (isReadOnlyRole(p)) throw new OutOfJurisdiction();
  assertSameOrganization(p, document.organizationId, `document ${document.id ?? '?'}`);

  const own = document.district;
  const scope = writeScope(p);
  if (own) {
    if (scope.includes(normalise(own))) return;
    throw new OutOfJurisdiction();
  }

  const linked = document.parcelId ?? document.parcel_id;
  if (!linked) throw new OutOfJurisdiction();

  await assertParcelWritable(p, linked, client);
}

/**
 * Guard for creating or re-homing a record: an officer may only write rows into a district they are
 * assigned to. Without this, editing `district` would be a one-line escape from every rule above —
 * which is exactly what PATCH /api/parcels/:id used to be.
 */
export function assertWritableDistrict(p: RequestPrincipal, targetDistrict: unknown): void {
  if (isReadOnlyRole(p)) throw new OutOfJurisdiction();
  // Creating a record also creates its owner claim, so a caller with no organization may not create
  // one at all: the alternative is a row that no tenant can ever read.
  if (!p.organizationId) throw new TenantContextMissing();
  if (!writeScope(p).includes(normalise(targetDistrict))) throw new OutOfJurisdiction();
}

/** Re-districting needs an explicit grant as well as authority over both ends (D5). */
export function mayRehomeParcels(p: RequestPrincipal): boolean {
  return hasCapability(p, 'PARCEL_REHOME') && !isReadOnlyRole(p);
}

/** Officer roster administration (D4). */
export function mayProvisionOfficers(p: RequestPrincipal): boolean {
  return hasCapability(p, 'USER_ADMIN') && !isReadOnlyRole(p);
}

/**
 * Migration 0003's triggers refuse a jurisdiction the registry does not contain. That refusal is an
 * answer, not an outage: mapped nowhere, it surfaces as 503 "the write failed, no change was
 * committed", which tells an operator to retry something that will never succeed. The fix is to
 * declare the district, and the response has to say so.
 *
 * The database message is quoted back; the HINT is deliberately not, because it contains SQL.
 */
export function districtRefusal(err: any): { code: string; message: string } | null {
  const text = String(err?.message ?? '');
  if (text.includes('DISTRICT_CODE_CONFLICT')) {
    return {
      code: 'DISTRICT_CODE_CONFLICT',
      message:
        'A jurisdiction key was supplied that disagrees with the district written on this record. The server derives that key from the district itself.',
    };
  }
  if (text.includes('DISTRICT_NOT_REGISTERED')) {
    const named = text.match(/DISTRICT_NOT_REGISTERED: '?([^'\n]+?)'? matches|DISTRICT_NOT_REGISTERED: '?([^'\n]+?)'? is registered/);
    const district = (named?.[1] ?? named?.[2] ?? '').slice(0, 120);
    return {
      code: 'DISTRICT_NOT_REGISTERED',
      message: district
        ? `"${district}" is not an available jurisdiction, so nothing can be filed under it. An administrator must declare it first.`
        : 'This jurisdiction is not available, so nothing can be filed under it. An administrator must declare it first.',
    };
  }
  return null;
}

/**
 * Record that a state-wide read was actually served (D3: "state-wide access must be logged").
 *
 * Deliberately narrow: it fires only where the caller's read scope was null, i.e. where records
 * outside their own assignments were returned. Entries carry no parcel, so the district-scoped audit
 * read cannot see them — only a state-wide reader can.
 *
 * Volume note: every such request appends one chained entry. That is the cost of the requirement,
 * and the reason the helper is called from the four state-wide surfaces rather than from a blanket
 * read hook.
 */
export async function logStateWideRead(
  p: RequestPrincipal,
  surface: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!hasStateWideRead(p)) return;

  try {
    await recordAuditLog({
      parcelId: null,
      entityType: 'SYSTEM',
      entityId: `STATE_WIDE_READ:${surface}`,
      actionType: 'STATE_WIDE_READ',
      performedBy: p.displayName,
      officerBadge: p.badgeNumber,
      actor: p,
      details: { surface, role: p.role, ...extra },
    });
  } catch (err: any) {
    // The read itself already succeeded; an inability to record it must not be reported as a
    // failure to the caller, but it must be loud — an unlogged state-wide read is a control gap.
    console.error('[JURISDICTION] state-wide read NOT logged:', err.message);
  }
}

/**
 * Load the caller's live authorisation state. Returns null when the officer behind a syntactically
 * valid token no longer exists, so the caller can refuse the request rather than run on stale
 * claims.
 */
export async function loadPrincipal(token: AuthTokenPayload): Promise<RequestPrincipal | null> {
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    const account = await pool.query(
      'SELECT id, email, role, display_name, designation, badge_number, district, organization_id FROM users WHERE id = $1 OR email = $2 LIMIT 1',
      [token.userId, token.email]
    );
    if (account.rows.length === 0) return null;
    const row = account.rows[0];

    // revoked_at IS NULL is what makes a revocation effective immediately rather than at token
    // expiry; assignments and capabilities are read fresh on every authenticated request.
    const jurisdictions = await pool.query(
      'SELECT district FROM user_jurisdictions WHERE user_id = $1 AND revoked_at IS NULL',
      [row.id]
    );
    const capabilities = await pool.query(
      'SELECT capability FROM user_capabilities WHERE user_id = $1 AND revoked_at IS NULL',
      [row.id]
    );

    // The tenant's own district grants, resolved through the account's organization. Revoked rows are
    // excluded, so withdrawing an organization's authority over a district is an immediate change
    // rather than a token-lifetime one.
    const organizationGrants = row.organization_id
      ? await pool.query(
          `SELECT d.code AS district, od.relationship
             FROM organization_districts od
             JOIN districts d ON d.id = od.district_id
            WHERE od.organization_id = $1 AND od.revoked_at IS NULL`,
          [row.organization_id]
        )
      : { rows: [] as Array<{ district: string; relationship: 'administers' | 'audits' | 'reads' }> };

    return {
      userId: row.id,
      email: row.email,
      role: row.role as UserRole,
      displayName: row.display_name,
      designation: row.designation,
      badgeNumber: row.badge_number,
      organizationId: row.organization_id ?? null,
      districts: jurisdictions.rows.map((r: any) => r.district).filter(Boolean),
      capabilities: capabilities.rows.map((r: any) => r.capability as Capability),
      organizationGrants: organizationGrants.rows.map((r: any) => ({
        district: String(r.district),
        relationship: r.relationship as 'administers' | 'audits' | 'reads',
      })),
      primaryDistrict: row.district || token.district || '',
    };
  }

  // Development/demo mode only. Mirrors the database shape so the authorization code has one path:
  // jurisdictions come from the persona's district, and demo capability grants come from
  // DEMO_CAPABILITY_GRANTS, which is also what seed.ts writes into user_capabilities.
  const stored = memoryStore.users.get(token.userId)
    || INITIAL_USERS.find((u) => u.id === token.userId || u.email === token.email);
  const districts = (stored?.district || token.district || '').trim();

  return {
    userId: token.userId,
    email: token.email,
    role: token.role,
    displayName: stored?.displayName || token.displayName,
    designation: stored?.designation || token.designation,
    badgeNumber: stored?.badgeNumber || token.badgeNumber,
    // Demo mode is one environment with one set of fixtures, so the fixtures and the personas share
    // one organization id. Tenant scoping therefore runs here too instead of being skipped.
    organizationId: DEV_TENANT_ORGANIZATION,
    districts: districts ? [districts] : [],
    capabilities: (DEMO_CAPABILITY_GRANTS[token.userId] ?? []) as Capability[],
    // The development store is one environment that administers wherever its own personas are
    // posted. Stating that here rather than skipping the check keeps the authorization code single
    // path; tenant isolation itself is only provable against PostgreSQL, where quarantine and the
    // row-level policies exist.
    organizationGrants: (districts ? [districts] : []).map((d) => ({ district: d, relationship: 'administers' as const })),
    primaryDistrict: districts,
  };
}
