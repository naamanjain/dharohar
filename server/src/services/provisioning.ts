/**
 * Officer provisioning (design default D4).
 *
 * No self-registration exists anywhere: every function here is called either by an authenticated
 * holder of the USER_ADMIN capability, or by the offline bootstrap command that creates the first
 * one. Each mutation writes the same transactional, hash-chained audit entry as the land records do,
 * so "who was given which jurisdiction, by whom, when" is part of the durable trail rather than a
 * side note in a log file.
 *
 * Revocation sets `revoked_at` instead of deleting the row. History must survive the change of mind.
 */

import { PoolClient } from 'pg';
import { pool, getDbHealth } from '../db/db';
import { recordAuditLog } from './auditService';
import { hashPassword } from '../utils/crypto';
import { UserRole } from '../types/backend';
import { Capability, RequestPrincipal } from './jurisdiction';

export const VALID_ROLES: UserRole[] = ['TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR', 'AUDITOR'];
export const VALID_CAPABILITIES: Capability[] = ['STATE_WIDE_READ', 'USER_ADMIN', 'PARCEL_REHOME'];

export class ProvisioningRejected extends Error {
  constructor(readonly code: string, message: string, readonly details?: any) {
    super(message);
    this.name = 'ProvisioningRejected';
  }
}

const POSTGRES_ONLY = 'Officer provisioning requires PostgreSQL. No in-memory user was created or changed.';

function requirePostgres() {
  if (getDbHealth().storageMode !== 'postgres-postgis') {
    throw new ProvisioningRejected('PROVISIONING_REQUIRES_DATABASE', POSTGRES_ONLY);
  }
}

const normalise = (v: unknown) => String(v ?? '').trim().toLowerCase();

function cleanDistricts(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ProvisioningRejected('INVALID_DISTRICTS', 'districts must be an array of district names.');
  }
  const out: string[] = [];
  for (const d of input) {
    const value = String(d ?? '').trim();
    if (!value) continue;
    if (!out.some((existing) => normalise(existing) === normalise(value))) out.push(value);
  }
  return out;
}

/**
 * Jurisdiction grants may only name a district the department has declared.
 *
 * This used to `INSERT ... ON CONFLICT DO NOTHING` the district first, which meant an administrator
 * typing "Nowhpur" silently created a jurisdiction and gave one officer authority over it — the exact
 * invention migration 0003 exists to make impossible, performed by the layer that is supposed to be
 * governed by it. Declaring a district is now a separate, audited decision (`POST /api/admin/districts`).
 * The 0003 trigger on user_jurisdictions is the backstop if this check is ever bypassed.
 */
async function requireRegisteredDistricts(client: PoolClient, districts: string[]): Promise<void> {
  if (districts.length === 0) return;
  const found = await client.query(
    'SELECT code, name, is_active FROM districts WHERE code = ANY($1::text[])',
    [districts.map(normalise)]
  );
  const byCode = new Map(found.rows.map((r: any) => [r.code, r]));
  const unknown = districts.filter((d) => !byCode.has(normalise(d)));
  const retired = districts.filter((d) => byCode.has(normalise(d)) && byCode.get(normalise(d))!.is_active === false);

  if (unknown.length > 0) {
    throw new ProvisioningRejected(
      'DISTRICT_NOT_REGISTERED',
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not declared district(s). An administrator must declare a jurisdiction ` +
        '(POST /api/admin/districts) before any officer can be granted authority over it. Nothing was assigned.' ,
      { unknown }
    );
  }
  if (retired.length > 0) {
    throw new ProvisioningRejected(
      'DISTRICT_INACTIVE',
      `${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} retired. Officers keep access to the records already filed there, ` +
        'but a retired jurisdiction cannot take new grants. Reactivate it first if that is the department\'s decision.',
      { retired }
    );
  }
}

function cleanCapabilities(input: unknown): Capability[] {  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new ProvisioningRejected('INVALID_CAPABILITIES', 'capabilities must be an array.');
  }
  const out: Capability[] = [];
  for (const c of input) {
    const value = String(c ?? '').trim().toUpperCase();
    if (!value) continue;
    if (!VALID_CAPABILITIES.includes(value as Capability)) {
      throw new ProvisioningRejected(
        'UNKNOWN_CAPABILITY',
        `Unknown capability '${value}'. Permitted: ${VALID_CAPABILITIES.join(', ')}.`
      );
    }
    if (!out.includes(value as Capability)) out.push(value as Capability);
  }
  return out;
}

async function loadOfficer(client: PoolClient | typeof pool, userId: string) {
  const result = await client.query(
    'SELECT id, email, role, display_name, designation, badge_number, district, state, organization_id FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) throw new ProvisioningRejected('OFFICER_NOT_FOUND', `Officer ${userId} was not found.`);
  return result.rows[0];
}

async function activeDistricts(client: PoolClient | typeof pool, userId: string): Promise<string[]> {
  const result = await client.query(
    'SELECT district FROM user_jurisdictions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY district',
    [userId]
  );
  return result.rows.map((r: any) => r.district);
}

async function activeCapabilities(client: PoolClient | typeof pool, userId: string): Promise<string[]> {
  const result = await client.query(
    'SELECT capability FROM user_capabilities WHERE user_id = $1 AND revoked_at IS NULL ORDER BY capability',
    [userId]
  );
  return result.rows.map((r: any) => r.capability);
}

export interface NewOfficer {
  id?: string;
  email: string;
  displayName: string;
  designation?: string;
  badgeNumber?: string;
  role: UserRole;
  districts: string[];
  capabilities?: Capability[];
  password: string;
  state?: string;
}

/**
 * Create an officer with their jurisdictions and capabilities in one transaction. A half-provisioned
 * officer — an account with no assignment, or an assignment with no account — is never left behind.
 */
export async function createOfficer(input: NewOfficer, actor: RequestPrincipal): Promise<any> {
  requirePostgres();

  const email = String(input.email ?? '').trim().toLowerCase();
  const displayName = String(input.displayName ?? '').trim();
  if (!email || !email.includes('@')) throw new ProvisioningRejected('INVALID_EMAIL', 'A valid email is required.');
  if (!displayName) throw new ProvisioningRejected('INVALID_NAME', 'display_name is required.');
  if (!VALID_ROLES.includes(input.role)) {
    throw new ProvisioningRejected('INVALID_ROLE', `role must be one of ${VALID_ROLES.join(', ')}.`);
  }
  if (String(input.password ?? '').length < 10) {
    throw new ProvisioningRejected('WEAK_PASSWORD', 'The initial password must be at least 10 characters.');
  }

  const districts = cleanDistricts(input.districts);
  const capabilities = cleanCapabilities(input.capabilities);
  if (districts.length === 0 && !capabilities.includes('STATE_WIDE_READ')) {
    // Not a convenience check: an officer with no assignment and no state-wide read can see nothing,
    // so accepting it would report success for an account that cannot work.
    throw new ProvisioningRejected(
      'NO_JURISDICTION',
      'At least one district assignment is required (or the STATE_WIDE_READ capability, for an auditor who reads the whole state).'
    );
  }

  // The new account belongs to whoever created it. There is deliberately no organizationId on the
  // input type: a body field naming a tenant is a claim about who will own the record, and letting it
  // through would let one organization's administrator plant accounts inside another's.
  // An actor with no organization produces an unowned account, which migration 0006's CHECK accepts
  // and which row-level security then refuses to show anyone — that is the bootstrap/platform case,
  // and it is resolved by the disposition command, not by a guess here.
  const organizationId = actor.organizationId ?? null;
  const id = String(input.id ?? '').trim() || `USR-${normalise(input.role).slice(0, 3).toUpperCase()}-${Date.now().toString().slice(-6)}`;
  const { hash, salt } = hashPassword(input.password);
  const createdAt = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const clash = await client.query('SELECT id, email FROM users WHERE id = $1 OR LOWER(email) = $2', [id, email]);
    if (clash.rows.length > 0) {
      throw new ProvisioningRejected('OFFICER_EXISTS', `An officer with id or email '${input.email}' already exists.`);
    }

    await client.query(
      `INSERT INTO users (id, email, password_hash, salt, role, display_name, designation, badge_number, jurisdiction, district, state, created_at,
                          organization_id, organization_granted_by, organization_grant_reason, organization_granted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
      [
        id, email, hash, salt, input.role, displayName,
        input.designation || input.role, input.badgeNumber || null,
        districts.join(', '), districts[0] || '', input.state || 'Rajasthan', createdAt,
        // Migration 0006 refuses an owner with no attribution, so the grantor and the reason are
        // written with it or not at all.
        organizationId,
        organizationId ? `officer:${actor.email}` : null,
        organizationId ? `Provisioned through the API by ${actor.displayName} (${actor.badgeNumber}).` : null,
      ]
    );

    await requireRegisteredDistricts(client, districts);
    for (const district of districts) {
      await client.query(
        `INSERT INTO user_jurisdictions (user_id, district, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, district) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
        [id, district, actor.userId]
      );
    }

    for (const capability of capabilities) {
      await client.query(
        `INSERT INTO user_capabilities (user_id, capability, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, capability) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
        [id, capability, actor.userId]
      );
    }

    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'OFFICER',
        entityId: id,
        actionType: 'OFFICER_PROVISIONED',
        performedBy: actor.displayName,
        officerBadge: actor.badgeNumber,
        actor,
        createdAt,
        details: { role: input.role, districts, capabilities, email },
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

  return { id, email, role: input.role, displayName, districts, capabilities };
}

/**
 * Replace an officer's jurisdiction set. Diffed rather than rewritten so the audit entry states what
 * was added and what was revoked — "the list changed" proves nothing to a reviewer.
 */
export async function setOfficerJurisdictions(
  userId: string,
  districts: string[],
  reason: string,
  actor: RequestPrincipal
): Promise<{ before: string[]; after: string[] }> {  requirePostgres();
  const wanted = cleanDistricts(districts);
  const why = String(reason ?? '').trim();
  if (!why) throw new ProvisioningRejected('REASON_REQUIRED', 'A jurisdiction change must state its reason.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await loadOfficer(client, userId);

    const before = await activeDistricts(client, userId);
    await client.query('UPDATE user_jurisdictions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

    await requireRegisteredDistricts(client, wanted);
    for (const district of wanted) {
      await client.query(
        `INSERT INTO user_jurisdictions (user_id, district, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, district) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
        [userId, district, actor.userId]
      );
    }

    const after = await activeDistricts(client, userId);
    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'OFFICER',
        entityId: userId,
        actionType: 'OFFICER_JURISDICTIONS_CHANGED',
        performedBy: actor.displayName,
        officerBadge: actor.badgeNumber,
        actor,
        details: { added: after.filter((d) => !before.includes(d)), revoked: before.filter((d) => !after.includes(d)), reason: why },
      },
      client
    );

    await client.query('COMMIT');
    return { before, after };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function setOfficerCapabilities(
  userId: string,
  capabilities: Capability[],
  reason: string,
  actor: RequestPrincipal
): Promise<{ before: string[]; after: string[] }> {
  requirePostgres();
  const wanted = cleanCapabilities(capabilities);
  const why = String(reason ?? '').trim();
  if (!why) throw new ProvisioningRejected('REASON_REQUIRED', 'A capability change must state its reason.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await loadOfficer(client, userId);

    const before = await activeCapabilities(client, userId);
    await client.query('UPDATE user_capabilities SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

    for (const capability of wanted) {
      await client.query(
        `INSERT INTO user_capabilities (user_id, capability, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, capability) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = NOW()`,
        [userId, capability, actor.userId]
      );
    }

    const after = await activeCapabilities(client, userId);
    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'OFFICER',
        entityId: userId,
        actionType: 'OFFICER_CAPABILITIES_CHANGED',
        performedBy: actor.displayName,
        officerBadge: actor.badgeNumber,
        actor,
        details: { added: after.filter((c) => !before.includes(c)), revoked: before.filter((c) => !after.includes(c)), reason: why },
      },
      client
    );

    await client.query('COMMIT');
    return { before, after };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function setOfficerRole(
  userId: string,
  role: UserRole,
  reason: string,
  actor: RequestPrincipal
): Promise<{ before: string; after: string }> {
  requirePostgres();
  if (!VALID_ROLES.includes(role)) {
    throw new ProvisioningRejected('INVALID_ROLE', `role must be one of ${VALID_ROLES.join(', ')}.`);
  }
  const why = String(reason ?? '').trim();
  if (!why) throw new ProvisioningRejected('REASON_REQUIRED', 'A role change must state its reason.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await loadOfficer(client, userId);
    const before = row.role;

    await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);

    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'OFFICER',
        entityId: userId,
        actionType: 'OFFICER_ROLE_CHANGED',
        performedBy: actor.displayName,
        officerBadge: actor.badgeNumber,
        actor,
        details: { from: before, to: role, reason: why },
      },
      client
    );

    await client.query('COMMIT');
    return { before, after: role };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Issue a new password. The old one stops working on the next read of the row; sessions already
 * carrying a signed token keep it until it expires (docs/SECURITY.md §7.2 — no revocation list yet),
 * which is why the reset is recorded and the officer should be told to sign in again.
 */
export async function resetOfficerPassword(
  userId: string,
  newPassword: string,
  reason: string,
  actor: RequestPrincipal
): Promise<void> {
  requirePostgres();
  if (String(newPassword ?? '').length < 10) {
    throw new ProvisioningRejected('WEAK_PASSWORD', 'The replacement password must be at least 10 characters.');
  }
  const why = String(reason ?? '').trim();
  if (!why) throw new ProvisioningRejected('REASON_REQUIRED', 'A password reset must state its reason.');

  const { hash, salt } = hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await loadOfficer(client, userId);
    await client.query('UPDATE users SET password_hash = $2, salt = $3 WHERE id = $1', [userId, hash, salt]);

    // Never the password, not even hashed: the audit chain is readable by auditors.
    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'OFFICER',
        entityId: userId,
        actionType: 'OFFICER_PASSWORD_RESET',
        performedBy: actor.displayName,
        officerBadge: actor.badgeNumber,
        actor,
        details: { reason: why },
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
}

/** Officer roster for administrators: accounts with their live assignments and capabilities. */
export async function listOfficers(actingPrincipal: RequestPrincipal): Promise<any[]> {
  requirePostgres();

  // A tenant administrator sees their own accounts plus the unowned ones — the latter are the
  // disposition queue, not another tenant's roster. An identity with no organization at all sees
  // every account, which is the platform/bootstrap case and is reachable only by an officer holding
  // USER_ADMIN whose own row carries no tenant.
  const rows = await pool.query(
    `SELECT u.id, u.email, u.role, u.display_name, u.designation, u.badge_number, u.district, u.state, u.organization_id,
            COALESCE((SELECT json_agg(j.district ORDER BY j.district) FROM user_jurisdictions j WHERE j.user_id = u.id AND j.revoked_at IS NULL), '[]') AS jurisdictions,
            COALESCE((SELECT json_agg(c.capability ORDER BY c.capability) FROM user_capabilities c WHERE c.user_id = u.id AND c.revoked_at IS NULL), '[]') AS capabilities
       FROM users u
       ${actingPrincipal.organizationId ? 'WHERE u.organization_id = $1 OR u.organization_id IS NULL' : ''}
       ORDER BY u.id`,
    actingPrincipal.organizationId ? [actingPrincipal.organizationId] : []
  );

  // Password hash and salt are never selected, so they cannot be returned by accident either.
  return rows.rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    displayName: r.display_name,
    designation: r.designation,
    badgeNumber: r.badge_number,
    primaryDistrict: r.district,
    state: r.state,
    organizationId: r.organization_id,
    districts: r.jurisdictions,
    capabilities: r.capabilities,
  }));
}

/** True when no administrator exists — the state the bootstrap command is meant to leave behind. */
export async function hasAnyAdministrator(): Promise<boolean> {
  requirePostgres();
  const result = await pool.query(
    "SELECT 1 FROM user_capabilities WHERE capability = 'USER_ADMIN' AND revoked_at IS NULL LIMIT 1"
  );
  return result.rows.length > 0;
}
