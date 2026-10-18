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
import { pool, getDbHealth, memoryStore, INITIAL_USERS, DEMO_CAPABILITY_GRANTS } from '../db/db';
import { recordAuditLog } from './auditService';
import { AuthTokenPayload, UserRole } from '../types/backend';

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
 */
export function readScope(p: RequestPrincipal): string[] | null {
  if (hasStateWideRead(p)) return null;
  return p.districts.map(normalise).filter((d) => d !== '');
}

/** The districts a caller may WRITE. State-wide read is deliberately not consulted here (D3). */
export function writeScope(p: RequestPrincipal): string[] {
  return p.districts.map(normalise).filter((d) => d !== '');
}

/**
 * Kept for call sites that pre-dated the capability model: a caller whose only power is state-wide
 * read still cannot mutate, so this remains role-based.
 */
export function isReadOnlyRole(p: Pick<RequestPrincipal, 'role'>): boolean {
  return p.role === 'AUDITOR';
}

/** SQL fragment + parameter restricting a parcel query to what the caller may read. */
export function parcelScopeClause(
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
export async function parcelDistrict(parcelId: string, client?: PoolClient): Promise<string | null> {
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    const run = client ?? pool;
    const result = await run.query('SELECT district FROM parcels WHERE id = $1', [parcelId]);
    if (result.rows.length === 0) return null;
    return result.rows[0].district;
  }

  const parcel = memoryStore.parcels.get(parcelId);
  return parcel ? parcel.district : null;
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
  const district = await parcelDistrict(parcelId, client);
  const scope = readScope(p);

  if (scope === null) {
    if (!p.districts.map(normalise).includes(normalise(district))) {
      await logStateWideRead(p, 'parcel-read', { parcelId, district });
    }
    return;
  }

  if (!inScope(district, scope)) throw new OutOfJurisdiction();
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
  const district = await parcelDistrict(parcelId, client);
  if (!inScope(district, writeScope(p))) throw new OutOfJurisdiction();
}

/** Read access to a document: its own district when set, else the parcel it is attached to. */
export async function assertDocumentReadable(
  p: RequestPrincipal,
  document: { district?: string | null; parcelId?: string | null; parcel_id?: string | null },
  client?: PoolClient
): Promise<void> {
  const scope = readScope(p);
  if (scope === null) {
    // Logged here rather than by falling through to assertParcelReadable: a state-wide reader who
    // opens a document in a district they are not posted to is exercising the capability, and D3
    // requires that to be recorded whichever surface it happens on.
    const held = p.districts.map(normalise);
    const own = normalise(document.district);
    if (!own || !held.includes(own)) {
      await logStateWideRead(p, 'document-read', {
        documentId: (document as { id?: string }).id ?? null,
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
  document: { district?: string | null; parcelId?: string | null; parcel_id?: string | null },
  client?: PoolClient
): Promise<void> {
  if (isReadOnlyRole(p)) throw new OutOfJurisdiction();

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
    organizationId: null,
    districts: districts ? [districts] : [],
    capabilities: (DEMO_CAPABILITY_GRANTS[token.userId] ?? []) as Capability[],
    primaryDistrict: districts,
  };
}
