/**
 * DHAROHAR Append-Only Cryptographic Audit Service
 * 
 * Provides verifiable tamper-evident event logging using cryptographic SHA-256 hash chaining.
 * Every state change generates an entry where entry_hash = SHA256(previous_hash + payload).
 */

import { PoolClient } from 'pg';
import { pool, getDbHealth, memoryStore } from '../db/db';
import { computeAuditEntryHash, GENESIS_AUDIT_HASH } from '../utils/crypto';
import { AuditLogEntry } from '../types/backend';
import { withTenant } from '../db/tenant';
import type { RequestPrincipal } from './jurisdiction';

export interface CreateAuditLogParams {
  parcelId?: string | null;
  documentId?: string | null;
  entityType?: 'PARCEL' | 'DOCUMENT' | 'FIELD_INSPECTION' | 'VERIFICATION_SEAL' | 'SYSTEM' | 'OFFICER' | 'DISTRICT';
  entityId?: string;
  actionType: string;
  performedBy: string;
  officerBadge?: string;
  /**
   * Who performed the action, as the server knows it. Written into `actor_user_id` /
   * `actor_organization_id` by migration 0008 so that an entry about an ACCOUNT — a reset, a grant, a
   * declaration — can be attributed to a tenant without reading a display name or a nullable badge
   * back. Never taken from a request body.
   *
   * Both fields are optional because not every actor is an officer: the owner-side disposition command
   * has an organization and no user, and an entry with no actor at all stays attributable only through
   * the record it describes.
   */
  actor?: { userId?: string | null; organizationId?: string | null } | null;
  details?: Record<string, any>;
  signatureHash?: string;
  createdAt?: string;
}

/**
 * Serialises audit appends so two concurrent writes cannot both read the same tip and fork
 * the chain. A fixed lock id because there is exactly one chain.
 */
const AUDIT_CHAIN_LOCK_ID = 784120;

async function appendToChain(client: PoolClient, params: Required<Pick<CreateAuditLogParams, 'actionType' | 'performedBy'>> & CreateAuditLogParams, timestamp: string, entityType: string, entityId: string, details: Record<string, any>) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_ID]);

  const lastRowRes = await client.query('SELECT entry_hash FROM append_only_audit_logs ORDER BY id DESC LIMIT 1');
  const previousHash = lastRowRes.rows.length > 0 && lastRowRes.rows[0].entry_hash
    ? lastRowRes.rows[0].entry_hash
    : GENESIS_AUDIT_HASH;

  const entryHash = computeAuditEntryHash(previousHash, entityId, params.actionType, params.performedBy, timestamp, details);

  const insertRes = await client.query(
    `INSERT INTO append_only_audit_logs (
      parcel_id, document_id, entity_type, entity_id, action_type,
      performed_by, officer_badge, details, previous_hash, entry_hash,
      signature_hash, created_at, actor_user_id, actor_organization_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id`,
    [
      params.parcelId || null,
      params.documentId || null,
      entityType,
      entityId,
      params.actionType,
      params.performedBy,
      params.officerBadge || null,
      JSON.stringify(details),
      previousHash,
      entryHash,
      params.signatureHash || null,
      timestamp,
      // Not part of entry_hash: the chain covers previousHash:entityId:actionType:performedBy:
      // timestamp:detailsHash, so attributing an entry after the fact cannot rewrite history.
      params.actor?.userId ?? null,
      params.actor?.organizationId ?? null,
    ]
  );

  return { id: insertRes.rows[0].id, previousHash, entryHash };
}

/**
 * Record a new append-only audit entry with cryptographic hash chaining.
 *
 * Pass `client` to append inside the caller's transaction so a state change and the entry
 * describing it commit or roll back together.
 */
export async function recordAuditLog(
  params: CreateAuditLogParams,
  client?: PoolClient
): Promise<AuditLogEntry> {
  const timestamp = params.createdAt || new Date().toISOString();
  const entityType = params.entityType || 'PARCEL';
  const entityId = params.entityId || params.parcelId || params.documentId || 'SYSTEM';
  const details = params.details || {};

  const buildEntry = (chain: { id: number; previousHash: string; entryHash: string }): AuditLogEntry => ({
    id: chain.id,
    parcelId: params.parcelId || null,
    documentId: params.documentId || null,
    entityType,
    entityId,
    actionType: params.actionType,
    performedBy: params.performedBy,
    officerBadge: params.officerBadge,
    details,
    previousHash: chain.previousHash,
    entryHash: chain.entryHash,
    signatureHash: params.signatureHash,
    createdAt: timestamp,
  });

  if (client) {
    return buildEntry(await appendToChain(client, params, timestamp, entityType, entityId, details));
  }

  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    let own: PoolClient | null = null;
    try {
      own = await pool.connect();
      await own.query('BEGIN');
      const chain = await appendToChain(own, params, timestamp, entityType, entityId, details);
      await own.query('COMMIT');
      return buildEntry(chain);
    } catch (err: any) {
      await own?.query('ROLLBACK').catch(() => {});
      // A silently memory-only audit entry is the worst outcome: the record looks sealed in
      // the API response while the durable chain has no knowledge of it.
      throw new Error(`Audit entry could not be written to the durable chain: ${err.message}`);
    } finally {
      own?.release();
    }
  }

  // In-memory store fallback with hash chaining
  const lastLog = memoryStore.auditLogs.length > 0
    ? memoryStore.auditLogs[memoryStore.auditLogs.length - 1]
    : null;
  const previousHash = lastLog && lastLog.entryHash ? lastLog.entryHash : GENESIS_AUDIT_HASH;

  const entryHash = computeAuditEntryHash(
    previousHash,
    entityId,
    params.actionType,
    params.performedBy,
    timestamp,
    details
  );

  const entry: AuditLogEntry = {
    id: memoryStore.auditLogs.length + 1,
    parcelId: params.parcelId || null,
    documentId: params.documentId || null,
    entityType,
    entityId,
    actionType: params.actionType,
    performedBy: params.performedBy,
    officerBadge: params.officerBadge || undefined,
    details,
    previousHash,
    entryHash,
    signatureHash: params.signatureHash || undefined,
    createdAt: timestamp,
  };

  memoryStore.auditLogs.push(entry);
  return entry;
}

/**
 * Fetch chronological audit logs for a parcel or all entities
 */
export async function getAuditLogs(filter?: {
  /**
   * The caller. When present, the query runs inside that caller's row-level security context, so the
   * parcels subquery can only ever name records in their own organization — an entry about another
   * tenant's parcel drops out of the result rather than needing a column the audit table does not
   * have. Omitted only by verifyAuditChain(), which has to read the whole chain to judge its integrity.
   */
  principal?: RequestPrincipal;
  parcelId?: string;
  entityId?: string;
  /**
   * Restrict to entries whose parcel belongs to one of these districts. The audit table carries no
   * district column of its own, so scoping requires joining through parcels — see
   * docs/DATA-MODEL-JURISDICTION.md §4.3. Entries with no parcel (system/login events) are
   * excluded when a scope is supplied, because there is nothing to attribute them to.
   *
   * `null` means "no district restriction" and is reserved for holders of STATE_WIDE_READ.
   * An empty array restricts to nothing at all: an officer with no jurisdiction assignments reads
   * no audit history, which is the deny-by-default case.
   */
  districts?: string[] | null;
  /**
   * Include entries that belong to no parcel at all — officer provisioning, role changes, password
   * resets, state-wide read records. They cannot be attributed to a district because there is no
   * parcel to attribute them through, so they are shown only to someone whose authority is over
   * accounts rather than over a district's land records.
   */
  includeUnattributed?: boolean;
}): Promise<AuditLogEntry[]> {
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    try {
      // Building the query and running it are separated so the same statement can execute either
      // inside a tenant transaction (a caller) or on a plain connection (verifyAuditChain, which has
      // to read every entry to judge the chain and therefore cannot be scoped at all).
      const run = async (client: PoolClient) => {
        let query = 'SELECT a.* FROM append_only_audit_logs a';
        const params: any[] = [];
        const where: string[] = [];

        if (filter?.parcelId) {
          params.push(filter.parcelId);
          where.push(`(a.parcel_id = $${params.length} OR a.entity_id = $${params.length})`);
        } else if (filter?.entityId) {
          params.push(filter.entityId);
          where.push(`a.entity_id = $${params.length}`);
        }

        const org = filter?.principal?.organizationId;
        if (org) {
          // An entry is attributed to a tenant through the record it describes — a parcel by that
          // parcel's owner — or, when it describes an account rather than land, through the officer who
          // performed it or the account it was about. Since migration 0008 the actor is a column; the
          // name/badge/entity matchers are the fallback that keeps the entries written BEFORE 0008
          // readable, because hiding history would trade one defect for another.
          params.push(org, org, org, org);
          where.push(
            `((a.parcel_id IS NOT NULL AND a.parcel_id IN (SELECT id FROM parcels WHERE organization_id = $${params.length - 3}))` +
            ` OR (a.actor_organization_id = $${params.length - 2})` +
            ` OR (a.entity_id IN (SELECT id FROM users WHERE organization_id = $${params.length - 1}))` +
            ` OR (a.parcel_id IS NULL AND (` +
            `      a.officer_badge IN (SELECT badge_number FROM users WHERE organization_id = $${params.length} AND badge_number IS NOT NULL)` +
            `      OR a.performed_by IN (SELECT display_name FROM users WHERE organization_id = $${params.length})))` +
            `)`
          );
        }

        if (filter?.districts) {
          params.push(filter.districts);
          // Entries with no parcel (provisioning, logins, state-wide read records) cannot be
          // attributed to a district at all. They stay invisible to a district officer and become
          // visible to someone who administers accounts — never by widening what parcels they can
          // see, which is the part that must not leak.
          const unattributed = filter.includeUnattributed ? ' OR a.parcel_id IS NULL' : '';
          where.push(
            `(a.parcel_id IN (SELECT id FROM parcels WHERE LOWER(TRIM(district)) = ANY($${params.length}::text[]))${unattributed})`
          );
        }

        if (where.length > 0) query += ' WHERE ' + where.join(' AND ');
        query += ' ORDER BY a.id ASC';

        const result = await client.query(query, params);

        return result.rows.map((row) => ({
          id: row.id,
          parcelId: row.parcel_id,
          documentId: row.document_id,
          entityType: row.entity_type || 'PARCEL',
          entityId: row.entity_id || row.parcel_id || 'SYSTEM',
          actionType: row.action_type,
          performedBy: row.performed_by,
          officerBadge: row.officer_badge,
          details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details || {},
          previousHash: row.previous_hash,
          entryHash: row.entry_hash,
          signatureHash: row.signature_hash,
          createdAt: row.created_at,
        }));
      };

      if (filter?.principal) return await withTenant(filter.principal, run);
      const plain = await pool.connect();
      try {
        return await run(plain);
      } finally {
        plain.release();
      }
    } catch (err: any) {
      console.error('[AUDIT SERVICE] DB fetch error:', err.message);
    }
  }

  let logs = [...memoryStore.auditLogs];
  if (filter?.parcelId) {
    logs = logs.filter((l) => l.parcelId === filter.parcelId || l.entityId === filter.parcelId);
  } else if (filter?.entityId) {
    logs = logs.filter((l) => l.entityId === filter.entityId);
  }

  // The in-memory store had no district filtering at all, so development mode read further than
  // PostgreSQL would have allowed. Same rule as the SQL branch: attribute an entry through its
  // parcel, and drop entries that cannot be attributed.
  if (filter?.districts) {
    const scope = filter.districts;
    const includeUnattributed = Boolean(filter.includeUnattributed);
    logs = logs.filter((l) => {
      const parcel = l.parcelId ? memoryStore.parcels.get(l.parcelId) : null;
      const district = String(parcel?.district ?? '').trim().toLowerCase();
      if (district === '') return includeUnattributed;
      return scope.includes(district);
    });
  }

  return logs;
}

/**
 * What the chain validator can actually see, measured rather than assumed.
 *
 * The first version of this project produced 41 findings that did not exist because a diagnostic ran as
 * an identity subject to row-level security and read the rows it could not see as rows that were
 * missing. The same trap lives here in the opposite direction: a chain read that returns NO entries
 * "verifies" trivially — an empty list has no broken links — so a validator with a filtered view would
 * report a healthy chain while seeing none of it. Health therefore requires evidence of visibility,
 * not the absence of failures.
 */
export interface AuditChainVisibility {
  verifiedAs: string;
  identityExempt: boolean;
  rlsEnabled: boolean;
  entriesSeen: number;
  maxIdSeen: number;
  rowsInsertedEver: number;
  seesWholeLedger: boolean;
  reason: string;
}

export async function auditChainVisibility(): Promise<AuditChainVisibility> {
  const probe = await pool.query(
    `select current_user as who,
            (select rolsuper from pg_roles where rolname = current_user) as super,
            (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
            (select coalesce(relrowsecurity,false) from pg_class where oid = 'append_only_audit_logs'::regclass) as rls,
            (select count(*)::bigint from append_only_audit_logs) as seen,
            (select coalesce(max(id),0)::bigint from append_only_audit_logs) as max_id,
            (select coalesce(n_tup_ins,0)::bigint from pg_stat_user_tables where relname = 'append_only_audit_logs') as inserted`
  );
  const r = probe.rows[0] ?? {};
  const exempt = r.super === true || r.bypass === true;
  const seen = Number(r.seen ?? 0);
  const inserted = Number(r.inserted ?? 0);
  // n_tup_ins is a cumulative counter from the statistics collector: it is not filtered by row-level
  // security, so "how many rows were ever written" is an independent yardstick for "how many can I see".
  const complete = seen >= inserted;
  const seesWholeLedger = complete && (!r.rls || exempt);
  let reason = 'this identity can see every entry the ledger has ever had';
  if (!complete) {
    reason = `${inserted - seen} of ${inserted} inserted entries are not visible to "${r.who}" — the chain would be judged from a partial read`;
  } else if (r.rls && !exempt) {
    reason = `"${r.who}" is subject to row-level security on the audit table; a filtered chain read cannot prove anything about the entries it did not receive`;
  }
  return {
    verifiedAs: String(r.who ?? 'unknown'),
    identityExempt: exempt,
    rlsEnabled: r.rls === true,
    entriesSeen: seen,
    maxIdSeen: Number(r.max_id ?? 0),
    rowsInsertedEver: inserted,
    seesWholeLedger,
    reason,
  };
}

/**
 * Verify cryptographic integrity of the audit chain
 */
export async function verifyAuditChain(): Promise<{
  isValid: boolean;
  totalEntries: number;
  brokenLinkIndex?: number;
  message: string;
  verifiedAs?: string;
  seesWholeLedger?: boolean;
}> {
  const logs = await getAuditLogs();
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    const visibility = await auditChainVisibility();
    if (!visibility.seesWholeLedger) {
      // Reported as a refusal, not as a failure of the chain and not as health: the chain may be
      // perfectly intact, and this identity is simply not in a position to say so.
      return {
        isValid: false,
        totalEntries: visibility.entriesSeen,
        message: `NOT CERTIFIED: ${visibility.reason}. Run the check as the read-only verification identity: docker compose -f docker-compose.prod.yml --profile tools run --rm verify dist-server/verify_audit_chain.js`,
        verifiedAs: visibility.verifiedAs,
        seesWholeLedger: false,
      };
    }
    if (logs.length === 0) {
      return {
        isValid: true,
        totalEntries: 0,
        message: 'Audit chain is empty — the ledger has never had an entry written to it.',
        verifiedAs: visibility.verifiedAs,
        seesWholeLedger: true,
      };
    }
    // Entries cannot be deleted (the runtime role has no DELETE, and the 0001 append-only trigger
    // refuses it for everyone), so ids run 1..N without holes. A count that does not match the highest
    // id is therefore direct evidence that something was removed out of band — which is the one tamper
    // mode the hash chain itself cannot show, because a deleted middle entry leaves the surviving
    // neighbours still pointing at each other's successors only if the chain was rewritten; a plain
    // deletion leaves a gap that the sequential walk above would already catch. This check catches the
    // gap even when the walk starts at the genesis hash.
    if (visibility.maxIdSeen !== visibility.entriesSeen) {
      return {
        isValid: false,
        totalEntries: visibility.entriesSeen,
        message: `BROKEN: the ledger holds ${visibility.entriesSeen} entries but its highest id is ${visibility.maxIdSeen} — entries were removed out of band`,
        verifiedAs: visibility.verifiedAs,
        seesWholeLedger: true,
      };
    }
  }

  if (logs.length === 0) {
    return { isValid: true, totalEntries: 0, message: 'Audit chain is empty.' };
  }

  let currentExpectedPrevious = GENESIS_AUDIT_HASH;

  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i];
    if (entry.previousHash !== currentExpectedPrevious) {
      return {
        isValid: false,
        totalEntries: logs.length,
        brokenLinkIndex: i,
        message: `Broken chain link at index ${i}: expected previousHash ${currentExpectedPrevious}, got ${entry.previousHash}`,
      };
    }

    const recomputedHash = computeAuditEntryHash(
      entry.previousHash,
      entry.entityId || entry.parcelId || 'SYSTEM',
      entry.actionType,
      entry.performedBy,
      entry.createdAt,
      entry.details
    );

    if (entry.entryHash !== recomputedHash) {
      return {
        isValid: false,
        totalEntries: logs.length,
        brokenLinkIndex: i,
        message: `Tampered payload hash at index ${i}: stored ${entry.entryHash}, computed ${recomputedHash}`,
      };
    }

    currentExpectedPrevious = entry.entryHash;
  }

  return {
    isValid: true,
    totalEntries: logs.length,
    message: `Audit chain verified successfully. ${logs.length} entries cryptographically sealed with SHA-256.`,
  };
}