/**
 * DHAROHAR — assign record ownership to an organization (schema-owner one-shot).
 *
 * Migration 0006 assigns owners only where the basis is stated in the migration itself, and leaves
 * everything else quarantined: `organization_id IS NULL`, invisible to every tenant, preserved in the
 * database. This command is the way out of that state, and it is deliberately an owner-identity
 * operation rather than an API endpoint: an officer of tenant A must not be able to hand tenant A's
 * records to tenant B, and no authenticated role inside the application should be able to re-tenant the
 * register at all.
 *
 * It refuses rather than guesses. Every one of these is required:
 *
 *   ASSIGN_TABLE          parcels | land_documents | users
 *   ASSIGN_ORGANIZATION   an organization id that already exists in `organizations`
 *   ASSIGN_BY             who made the decision, e.g. a name and address
 *   ASSIGN_REASON         why, at least 10 characters — a claim with no reason is a guess
 *   ASSIGN_IDS            comma-separated record ids, OR
 *   ASSIGN_DISTRICT_CODE  every record in one district code (explicit bulk form)
 *
 * Unknown ids abort the whole run before anything is written. Records already owned by a different
 * organization are refused unless ASSIGN_TAKEOVER=true, because moving a record between tenants is a
 * different act from labelling one that never had an owner.
 *
 *   docker compose -f docker-compose.prod.yml --profile tools run --rm \
 *     -e ASSIGN_TABLE=parcels -e ASSIGN_IDS=DH-PRB-016587 \
 *     -e ASSIGN_ORGANIZATION=ORG-DHAROHAR-DEMO \
 *     -e ASSIGN_BY='Records Officer, Jaipur' -e ASSIGN_REASON='Owner decision 2026-10-20' \
 *     maint dist-server/db/assignOwnership.js
 */

import { pool, initDbConnection } from './db';
import { recordAuditLog } from '../services/auditService';

const TABLES = ['parcels', 'land_documents', 'users'] as const;
type TableName = (typeof TABLES)[number];

function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    console.error(`[OWNERSHIP] ${name} is required. Nothing was changed.`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const health = await initDbConnection();
  if (health.storageMode !== 'postgres-postgis') {
    console.error('[OWNERSHIP] A PostgreSQL database is required. Nothing was checked or changed.');
    process.exit(2);
  }

  const table = required('ASSIGN_TABLE') as TableName;
  if (!TABLES.includes(table)) {
    console.error(`[OWNERSHIP] ASSIGN_TABLE must be one of ${TABLES.join(', ')}. Got "${table}".`);
    process.exit(2);
  }

  const organization = required('ASSIGN_ORGANIZATION');
  const grantor = required('ASSIGN_BY');
  const reason = required('ASSIGN_REASON');
  if (reason.length < 10) {
    console.error('[OWNERSHIP] ASSIGN_REASON is shorter than 10 characters. A one-word reason is not a basis for moving a record between tenants.');
    process.exit(2);
  }
  const takeover = process.env.ASSIGN_TAKEOVER === 'true';

  const org = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [organization]);
  if (org.rows.length === 0) {
    console.error(`[OWNERSHIP] organization "${organization}" does not exist.`);
    console.error('[OWNERSHIP] Create the tenant first. This command will not invent one to satisfy itself.');
    process.exit(2);
  }
  console.log(`[OWNERSHIP] target organization: ${org.rows[0].id} (${org.rows[0].name})`);

  // Resolve the id set before touching anything, so a typo is a refusal rather than a partial run.
  let ids: string[] = [];
  const idList = String(process.env.ASSIGN_IDS ?? '').trim();
  const districtCode = String(process.env.ASSIGN_DISTRICT_CODE ?? '').trim();
  if (idList && districtCode) {
    console.error('[OWNERSHIP] ASSIGN_IDS and ASSIGN_DISTRICT_CODE are mutually exclusive.');
    process.exit(2);
  }
  if (idList) {
    ids = idList.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (districtCode) {
    const found = await pool.query(
      `SELECT id FROM ${table} WHERE district_code = $1 ORDER BY id`, [districtCode.toLowerCase()]
    );
    ids = found.rows.map((r: any) => String(r.id));
    if (ids.length === 0) {
      console.error(`[OWNERSHIP] no ${table} rows carry district_code "${districtCode}". Nothing was changed.`);
      process.exit(2);
    }
    console.log(`[OWNERSHIP] bulk form: ${ids.length} ${table} row(s) in district_code ${districtCode}`);
  } else {
    console.error('[OWNERSHIP] either ASSIGN_IDS or ASSIGN_DISTRICT_CODE is required. Nothing was changed.');
    process.exit(2);
  }

  const existing = await pool.query(
    `SELECT id, organization_id FROM ${table} WHERE id = ANY($1::text[])`, [ids]
  );
  const missing = ids.filter((i) => !existing.rows.some((r: any) => r.id === i));
  if (missing.length > 0) {
    console.error(`[OWNERSHIP] ${missing.length} id(s) do not exist in ${table}: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
    console.error('[OWNERSHIP] Nothing was changed. A name that does not resolve is not a reason to write the rest.');
    process.exit(2);
  }

  const ownedByOther = existing.rows.filter((r: any) => r.organization_id && r.organization_id !== organization);
  if (ownedByOther.length > 0 && !takeover) {
    console.error(`[OWNERSHIP] ${ownedByOther.length} row(s) already belong to another organization, e.g. ${ownedByOther[0].id} -> ${ownedByOther[0].organization_id}.`);
    console.error('[OWNERSHIP] Re-running with ASSIGN_TAKEOVER=true moves records between tenants. That is a different decision from labelling an unowned record, so it is not implied here.');
    process.exit(2);
  }

  const unowned = existing.rows.filter((r: any) => !r.organization_id);
  const targets = takeover ? existing.rows : unowned;
  if (targets.length === 0) {
    console.log(`[OWNERSHIP] nothing to do: every one of the ${ids.length} row(s) already belongs to ${organization}.`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The attribution columns are not decoration: migration 0006's CHECK refuses a row with an owner
    // and no grantor, so a silent assignment is impossible at the database level rather than only
    // discouraged in this script.
    await client.query(
      `UPDATE ${table}
          SET organization_id = $1,
              organization_granted_by = $2,
              organization_grant_reason = $3,
              organization_granted_at = NOW()
        WHERE id = ANY($4::text[])`,
      [organization, grantor, reason, targets.map((r: any) => r.id)]
    );
    await recordAuditLog(
      {
        parcelId: null,
        entityType: 'SYSTEM',
        entityId: `OWNERSHIP:${table}`,
        actionType: 'OWNERSHIP_ASSIGNED',
        performedBy: grantor,
        // There is no officer behind this act — it was performed by an operator with the schema-owner
        // credential — but the entry belongs to the tenant whose records were assigned, so it is
        // attributed to that organization and stays invisible to any other.
        actor: { userId: null, organizationId: organization },
        details: {
          table,
          organizationId: organization,
          reason,
          records: targets.length,
          takeover: takeover ? 'true' : 'false',
          recordIds: targets.slice(0, 100).map((r: any) => r.id),
        },
      },
      client
    );
    await client.query('COMMIT');
    console.log(`[OWNERSHIP] ${targets.length} ${table} row(s) assigned to ${organization}, attributed to ${grantor}, and written to the audit chain.`);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[OWNERSHIP] FAILED and rolled back — the database is unchanged:', err.message);
    await pool.end();
    process.exit(1);
  } finally {
    client.release();
  }

  const still = await pool.query(
    `SELECT count(*)::int AS unowned FROM ${table} WHERE organization_id IS NULL`
  );
  console.log(`[OWNERSHIP] ${table} rows still quarantined (no owner, invisible to every tenant): ${still.rows[0].unowned}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[OWNERSHIP] unexpected failure:', err?.message || err);
  process.exit(1);
});
