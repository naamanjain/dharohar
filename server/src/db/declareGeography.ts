/**
 * DHAROHAR — declare authoritative geography and a tenant's relationship to it (schema-owner one-shot).
 *
 * Why this command exists: the registry does not inherit authoritative districts from a code push. In
 * the demo deployment the four canonical rows were already present when migration 0004 ran, so 0004
 * classified what the database already held. A NEW database has no districts at all, which means
 *
 *   - migration 0006 refuses to assign ownership (`[TENANCY_NO_CANONICAL_GEOGRAPHY]`) because there is
 *     no stated basis for an assignment, and
 *   - the demo tenant has no `organization_districts` grant, so even a correctly bootstrapped officer
 *     would be refused by every record route.
 *
 * Both are the intended fail-closed behaviour, and both are resolved by the same act: a person states
 * what geography is authoritative and which tenant holds which relationship to it. That statement is
 * exactly what the HTTP workflow (declareDistrict / promoteDistrict) records for an authenticated
 * officer; this is the same decision made before any officer exists, by the operator who holds the
 * schema-owner credential.
 *
 * Required, and every one of them is recorded:
 *
 *   GEOGRAPHY_DISTRICTS     comma-separated district names, e.g. "Jaipur,Ajmer,Jodhpur,Udaipur"
 *   GEOGRAPHY_ORGANIZATION  an organization id that already exists (created by migration 0004)
 *   GEOGRAPHY_BY            who made the decision — a name and address, not "system"
 *   GEOGRAPHY_REASON        why, at least 10 characters
 *
 * Optional:
 *   GEOGRAPHY_RELATIONSHIP  administers | audits | reads   (default: administers)
 *   GEOGRAPHY_OVERWRITE=true  re-classify a registry row that is already something else
 *
 * It refuses rather than guesses. A name that collides with an existing district under a different
 * code is a decision to be made by a person, not a `min()`. Re-running is safe: rows that are already
 * canonical, and grants that already exist, are reported and left alone.
 *
 *   docker compose -f docker-compose.prod.yml --profile tools run --rm \
 *     -e GEOGRAPHY_DISTRICTS='Jaipur,Ajmer,Jodhpur,Udaipur' -e GEOGRAPHY_ORGANIZATION=ORG-DHAROHAR-DEMO \
 *     -e GEOGRAPHY_BY='Naaman Jain, Urban Techx' -e GEOGRAPHY_REASON='Rajasthan land-records districts' \
 *     maint dist-server/db/declareGeography.js
 *
 * Then re-run `npm run db:migrate`: 0006 can now see the basis it was asked to refuse without.
 */

import { pool, initDbConnection } from './db';
import { recordAuditLog } from '../services/auditService';

const RELATIONSHIPS = ['administers', 'audits', 'reads'] as const;

function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    console.error(`[GEOGRAPHY] ${name} is required. Nothing was changed.`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const health = await initDbConnection();
  if (health.storageMode !== 'postgres-postgis') {
    console.error('[GEOGRAPHY] A PostgreSQL database is required. Nothing was checked or changed.');
    process.exit(2);
  }

  const names = required('GEOGRAPHY_DISTRICTS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const organization = required('GEOGRAPHY_ORGANIZATION');
  const declarant = required('GEOGRAPHY_BY');
  const reason = required('GEOGRAPHY_REASON');
  const relationship = (String(process.env.GEOGRAPHY_RELATIONSHIP ?? 'administers').trim().toLowerCase()) as
    | (typeof RELATIONSHIPS)[number];
  const overwrite = process.env.GEOGRAPHY_OVERWRITE === 'true';
  if (names.length === 0) {
    console.error('[GEOGRAPHY] GEOGRAPHY_DISTRICTS resolved to no names. Nothing was changed.');
    process.exit(2);
  }
  if (reason.length < 10) {
    console.error('[GEOGRAPHY] GEOGRAPHY_REASON is shorter than 10 characters. Declaring a boundary is a record, not a preference, and a one-word reason is not a basis.');
    process.exit(2);
  }
  if (!(RELATIONSHIPS as readonly string[]).includes(relationship)) {
    console.error(`[GEOGRAPHY] GEOGRAPHY_RELATIONSHIP must be one of ${RELATIONSHIPS.join(', ')}. Got "${relationship}".`);
    process.exit(2);
  }

  // The structures this command writes are migration 0004's. Checking for them rather than assuming
  // them: running this against an unmigrated database used to fail with a raw foreign-key error.
  const registry = await pool.query(
    `SELECT to_regclass('public.organization_districts') IS NOT NULL AS grants_present,
            exists (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'districts' AND column_name = 'kind') AS kind_present`
  );
  if (!registry.rows[0].grants_present || !registry.rows[0].kind_present) {
    console.error('[GEOGRAPHY] migration 0004 has not been applied (no districts.kind / organization_districts).');
    console.error('[GEOGRAPHY] Run npm run db:migrate up to 0004-0005 first, then declare geography, then finish the migration.');
    process.exit(2);
  }

  const org = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [organization]);
  if (org.rows.length === 0) {
    console.error(`[GEOGRAPHY] organization "${organization}" does not exist.`);
    console.error('[GEOGRAPHY] Migration 0004 creates the demo tenant. This command will not invent one to satisfy itself.');
    process.exit(2);
  }

  const duplicates = names.map((n) => n.toLowerCase()).filter((c, i, a) => a.indexOf(c) !== i);
  if (duplicates.length > 0) {
    console.error(`[GEOGRAPHY] GEOGRAPHY_DISTRICTS lists the same district more than once: ${[...new Set(duplicates)].join(', ')}`);
    console.error('[GEOGRAPHY] Nothing was changed. A repeated name is a typing accident or a disagreement; neither is resolved by writing it twice.');
    process.exit(2);
  }

  // Resolve every name before writing anything, so a typo or a collision is a refusal for the whole
  // run rather than half a registry.
  const rows: Array<{ name: string; code: string; existing?: any; clash?: string }> = [];
  for (const name of names) {
    const code = name.toLowerCase();
    const found = await pool.query(
      'SELECT code, name, kind, id, retired_at FROM districts WHERE code = $1', [code]
    );
    // A second row whose canonical name matches this one, under a different code, is the ambiguity
    // 0004 refused to resolve with min(). It stays a human decision.
    const ambiguous = await pool.query(
      `SELECT code FROM districts WHERE name_key = lower(btrim($1)) AND code <> $2`,
      [name, code]
    );
    rows.push({
      name,
      code,
      existing: found.rows[0],
      clash: ambiguous.rows.length > 0 ? ambiguous.rows.map((r: any) => r.code).join(', ') : undefined,
    });
  }
  const clashes = rows.filter((r) => r.clash);
  if (clashes.length > 0) {
    for (const c of clashes) console.error(`[GEOGRAPHY] "${c.name}" collides with existing code(s): ${c.clash}`);
    console.error('[GEOGRAPHY] [DISTRICT_CODE_AMBIGUOUS] which row is authoritative is a decision, not a default. Nothing was changed.');
    process.exit(2);
  }
  const needsDecision = rows.filter((r) => r.existing && r.existing.kind !== 'canonical');
  if (needsDecision.length > 0 && !overwrite) {
    for (const r of needsDecision) {
      console.error(`[GEOGRAPHY] "${r.code}" already exists as kind=${r.existing.kind}${r.existing.retired_at ? ' and is retired' : ''}.`);
    }
    console.error('[GEOGRAPHY] Re-running with GEOGRAPHY_OVERWRITE=true re-classifies those rows as canonical. Changing what a district IS is a different act from declaring a new one, so it is not implied here.');
    process.exit(2);
  }

  const client = await pool.connect();
  let declared = 0;
  let reclassified = 0;
  let granted = 0;
  let skippedAudit = false;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      if (!r.existing) {
        await client.query(
          // $2 feeds a varchar column (name), a text column (canonical_name) and lower(btrim()), and
          // PostgreSQL refuses to guess one type for it — hence the explicit casts.
          `INSERT INTO districts (code, name, provenance, is_active, kind, canonical_name, name_key, state_code, notes)
           VALUES ($1::varchar, $2::varchar, 'declared', true, 'canonical', $2::text, lower(btrim($2)), 'RJ', $3::text)
           ON CONFLICT (code) DO NOTHING`,
          [r.code, r.name, `declared canonical by ${declarant}: ${reason}`]
        );
        declared += 1;
      } else if (r.existing.kind !== 'canonical') {
        await client.query(
          `UPDATE districts
              SET kind = 'canonical',
                  canonical_name = $2::text,
                  name_key = lower(btrim($2)),
                  notes = btrim(coalesce(notes, '') || ' ' || $3::text)
            WHERE code = $1::varchar`,
          [r.code, r.name, `[declareGeography] re-classified from ${r.existing.kind} by ${declarant}: ${reason}`]
        );
        reclassified += 1;
      }
      const district = await client.query('SELECT id FROM districts WHERE code = $1', [r.code]);
      const grant = await client.query(
        `INSERT INTO organization_districts (organization_id, district_id, relationship, granted_by, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, district_id, relationship) DO NOTHING`,
        [organization, district.rows[0].id, relationship, declarant, reason]
      );
      granted += grant.rowCount ?? 0;
    }

    // The audit columns that name the actor arrive with migration 0008, and on a new database this
    // command runs between 0005 and 0006 — before they exist. The decision is still durably attributed
    // either way (organization_districts.granted_by / reason / granted_at, and districts.notes), so
    // the audit entry is added when the schema can carry it and announced as skipped when it cannot,
    // rather than failing the declaration or pretending it was written.
    const canAudit = await client.query(
      `SELECT exists (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'append_only_audit_logs'
                        AND column_name = 'actor_organization_id') AS ok`
    );
    if (canAudit.rows[0].ok) {
      await recordAuditLog(
        {
          parcelId: null,
          entityType: 'SYSTEM',
          entityId: `GEOGRAPHY:${organization}`,
          actionType: 'GEOGRAPHY_DECLARED',
          performedBy: declarant,
          // No officer stands behind this act — an operator with the schema-owner credential performed
          // it — but the decision is about the tenant's authority, so it is attributed to that tenant.
          actor: { userId: null, organizationId: organization },
          details: {
            organizationId: organization,
            relationship,
            reason,
            declared,
            reclassified,
            granted,
            districts: rows.map((r) => r.code),
          },
        },
        client
      );
    } else {
      skippedAudit = true;
    }
    await client.query('COMMIT');
    // Released on both paths, and before pool.end() on the failure path: pool.end() waits for every
    // checked-out client, so ending it while this one is still held is a deadlock, not a shutdown.
    client.release();
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[GEOGRAPHY] FAILED and rolled back — the registry is unchanged:', err.message);
    await pool.end();
    process.exit(1);
  }

  console.log(
    `[GEOGRAPHY] ${declared} district(s) declared, ${reclassified} re-classified as canonical, ` +
      `${granted} tenant grant(s) added for ${organization} (${relationship}), all attributed to "${declarant}".`
  );
  const already = rows.filter((r) => r.existing && r.existing.kind === 'canonical').map((r) => r.code);
  if (already.length > 0) {
    console.log(`[GEOGRAPHY] already canonical and left alone: ${already.join(', ')}`);
  }
  if (skippedAudit) {
    console.warn(
      '[GEOGRAPHY] no audit entry: append_only_audit_logs has no actor columns until migration 0008 is ' +
        'applied, and on a new database this command runs before it. The declaration itself is recorded in ' +
        'organization_districts (granted_by, reason, granted_at) and in districts.notes.'
    );
  }
  const summary = await pool.query(
    `SELECT count(*)::int AS canonical,
            (SELECT count(*)::int FROM organization_districts g
              JOIN districts d ON d.id = g.district_id
             WHERE g.organization_id = $1 AND g.revoked_at IS NULL) AS tenant_districts
       FROM districts WHERE kind = 'canonical'`,
    [organization]
  );
  console.log(
    `[GEOGRAPHY] registry now holds ${summary.rows[0].canonical} canonical district(s); ` +
      `${organization} holds ${summary.rows[0].tenant_districts} live district grant(s).`
  );
  console.log('[GEOGRAPHY] next: npm run db:migrate — 0006 can now see the basis it was refusing without.');
  await pool.end();
}

main().catch((err) => {
  console.error('[GEOGRAPHY] unexpected failure:', err?.message || err);
  process.exit(1);
});
