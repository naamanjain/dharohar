/**
 * District / jurisdiction integrity check.
 *
 * Run before and after any migration that touches jurisdiction, and as a gate step. It reports
 * findings by primary key and exits non-zero when anything needs authoritative resolution — it never
 * repairs a row, never guesses a district, and never deletes anything to make the numbers look clean.
 *
 *   DATABASE_URL=... npm run test:integrity
 *   VERIFY_INTEGRITY_WARN_ONLY=true  -> report without failing (useful on a legacy import mid-cleanup)
 *
 * Why each check exists:
 *   - The `districts` registry was populated by migration 0002 FROM the values already stored on
 *     real rows. That makes "is this district in the registry?" trivially true for existing data and
 *     only useful for FUTURE typos — so a clean report here is not the same as an authoritative one,
 *     and the `provenance` column exists to show which rows were declared by an administrator
 *     ('declared') versus derived from data ('derived').
 *   - A parcel whose district and linked documents' district disagree is reachable by one officer
 *     through the parcel and by another through the document. That ambiguity is a jurisdiction
 *     problem, not a formatting one, so it is reported separately.
 */

import { pool, initDbConnection } from './db/db';

interface Finding {
  check: string;
  detail: string;
}

const WARN_ONLY = process.env.VERIFY_INTEGRITY_WARN_ONLY === 'true';

async function rows(sql: string, label: string): Promise<Finding[]> {
  const result = await pool.query(sql);
  return result.rows.map((r: any) => ({ check: label, detail: r.detail }));
}

async function main() {
  const health = await initDbConnection();

  if (health.storageMode !== 'postgres-postgis') {
    console.error('[INTEGRITY] A PostgreSQL database is required. Nothing was checked.');
    console.error('[INTEGRITY] storageMode=' + health.storageMode + ' — set DATABASE_URL and re-run.');
    process.exit(2);
  }

  // This report must be produced by an identity that can SEE the register. Since migration 0006 the
  // runtime role is subject to row-level security with no tenant bound, so as `dharohar_app` it reads
  // zero parcels — and the report then invents findings ("owner row references a parcel that does not
  // exist") about records that are merely invisible to it. A diagnostic that cannot tell "absent" from
  // "hidden from me" is worse than no diagnostic, because someone signs off on it.
  // Refuse the identity instead of producing it.
  const identity = await pool.query(
    `select current_user as who,
            (select rolsuper from pg_roles where rolname = current_user) as super,
            (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
            (select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner
              where c.oid = 'parcels'::regclass) as parcels_owner`
  );
  const id = identity.rows[0] ?? {};
  const exempt = id.super === true || id.bypass === true || id.parcels_owner === id.who;
  if (!exempt) {
    console.error(`[INTEGRITY] refusing to run as "${id.who}": that role is subject to row-level security and would report records it cannot see as missing.`);
    console.error('[INTEGRITY] Run it as the schema owner instead:');
    console.error('  docker compose -f docker-compose.prod.yml --profile tools run --rm maint dist-server/verify_district_integrity.js');
    await pool.end().catch(() => {});
    process.exit(2);
  }
  console.log(`  identity    : ${id.who} (owner of parcels: ${id.parcels_owner === id.who ? 'yes' : 'no'}, bypassrls: ${String(id.bypass)}) — exempt from row-level security, so this report sees the whole register`);

  const has = async (relation: string) => {
    const r = await pool.query('SELECT to_regclass($1) AS o', [relation]);
    return r.rows[0].o !== null;
  };

  const have0003 = await has('districts') && await columnExists('parcels', 'district_code');

  console.log('\n============================================================');
  console.log('  DHAROHAR DISTRICT / JURISDICTION INTEGRITY');
  // current_database(), never an environment variable: a report that names the wrong database is
  // worse than no report, because someone will sign off on it.
  console.log(`  database: ${health.database ?? '(unknown)'}`);
  console.log(`  migration 0003 (stable district_code columns): ${have0003 ? 'applied' : 'not applied'}`);
  // And the whole ledger, not one migration. Naming only 0003 made this header read as if it had
  // verified the schema state after 0004 and 0005 had already changed what "consistent" means: the
  // reader should see which files the database says it has, on the line above the findings.
  let ledger = '(schema_migrations is not readable)';
  try {
    const rows = (await pool.query('select version from schema_migrations order by version')).rows.map((r: any) => r.version);
    ledger = rows.length ? rows.join(', ') : '(no migration recorded — a database the runner has never touched)';
  } catch { /* reported by the string above rather than crashing a read-only diagnostic */ }
  console.log(`  migrations recorded: ${ledger}`);
  console.log('============================================================\n');

  const findings: Finding[] = [];

  // ---- 1. Blank or missing jurisdiction on a land record -----------------------
  findings.push(...await rows(
    `select id || ' (khasra ' || coalesce(khasra_no,'?') || ', mauza ' || coalesce(village,'?') || ')' as detail
       from parcels where district is null or btrim(district) = '' order by id`,
    'parcel has no district — nobody can be authorized over it'
  ));

  // ---- 2. District value not present in the registry ---------------------------
  findings.push(...await rows(
    `select id || ' -> district=' || quote_literal(district) as detail
       from parcels p
      where btrim(coalesce(district,'')) <> ''
        and not exists (select 1 from districts d where d.code = lower(trim(p.district)))
      order by id`,
    'parcel district is not a registered district (typo, or the registry needs a declared row)'
  ));

  // ---- 3. Two registry rows that normalize to the same jurisdiction ------------
  findings.push(...await rows(
    `select 'ambiguous district spelling: ' || n || ' -> ' || string_agg(code || '=' || quote_literal(name), ', ' order by code) as detail
       from (select lower(translate(name, ' ', '')) as n, code, name from districts) x
      group by n having count(*) > 1`,
    'district registry contains spellings that normalize to the same jurisdiction'
  ));

  // ---- 4. Documents that cannot be attributed to any jurisdiction --------------
  findings.push(...await rows(
    `select id || ' (' || file_name || ')' as detail
       from land_documents
      where (district is null or btrim(district) = '') and parcel_id is null
      order by id`,
    'document has neither a district nor a parcel — unreachable to every officer including its uploader'
  ));

  findings.push(...await rows(
    `select l.id || ' -> parcel_id=' || l.parcel_id || ' which does not exist' as detail
       from land_documents l
      where l.parcel_id is not null
        and not exists (select 1 from parcels p where p.id = l.parcel_id)
      order by l.id`,
    'document references a parcel that no longer exists'
  ));

  // ---- 5. Document jurisdiction disagreeing with its parcel's -----------------
  findings.push(...await rows(
    `select l.id || ' document=' || quote_literal(l.district) || ' vs parcel ' || p.id || '=' || quote_literal(p.district) as detail
       from land_documents l join parcels p on p.id = l.parcel_id
      where coalesce(btrim(l.district),'') <> ''
        and lower(trim(l.district)) <> lower(trim(p.district))
      order by l.id`,
    'document district differs from the district of the parcel it is attached to'
  ));

  // ---- 6. Officer assignments -------------------------------------------------
  findings.push(...await rows(
    `select u.id || ' (' || u.email || ')' as detail
       from users u
      where not exists (select 1 from user_jurisdictions j where j.user_id = u.id and j.revoked_at is null)
        and not exists (select 1 from user_capabilities c where c.user_id = u.id and c.revoked_at is null)
      order by u.id`,
    'officer holds no active jurisdiction and no capability — they can reach no record at all. Whether they can still sign in is not established here: the retire step replaces the password with a value that is never printed, and this query does not read credentials.'
  ));

  findings.push(...await rows(
    `select j.user_id || ' -> ' || quote_literal(j.district) as detail
       from user_jurisdictions j
      where not exists (select 1 from districts d where d.code = lower(trim(j.district)))
      order by j.user_id, j.district`,
    'jurisdiction assignment names a district that is not registered'
  ));

  findings.push(...await rows(
    `select u.id || ' users.district=' || quote_literal(u.district) || ' but active assignments are ' ||
            coalesce(string_agg(j.district, ',' order by j.district), '(none)') as detail
       from users u
       left join user_jurisdictions j on j.user_id = u.id and j.revoked_at is null
      where coalesce(btrim(u.district),'') <> ''
      group by u.id, u.district
     having count(j.*) > 0 and NOT lower(trim(u.district)) = ANY(array_agg(lower(trim(j.district))))
      order by u.id`,
    'users.district (display/primary) names a district the officer is not currently assigned to'
  ));

  // ---- 7. Child rows without a parent -----------------------------------------
  findings.push(...await rows(
    `select o.id || ' -> parcel_id=' || o.parcel_id as detail
       from parcel_owners o
      where not exists (select 1 from parcels p where p.id = o.parcel_id) order by o.id`,
    'owner row references a parcel that does not exist'
  ));

  findings.push(...await rows(
    `select p.id || ' -> document_id=' || p.document_id as detail
       from parcels p
      where p.document_id is not null
        and not exists (select 1 from land_documents d where d.id = p.document_id)
      order by p.id`,
    'parcel points at a document that does not exist'
  ));

  // ---- 8. Organization (tenant) membership -------------------------------------
  // Only reports when BOTH sides name an organization, so a deployment that has not decided its
  // tenants yet does not show up as broken data. The undecided case is reported separately as a note.
  findings.push(...await rows(
    `select u.id || ' org=' || u.organization_id || ' but district ' || j.district || ' belongs to org ' || d.organization_id as detail
       from user_jurisdictions j
       join districts d on d.code = lower(trim(j.district))
       join users u on u.id = j.user_id
      where j.revoked_at is null and u.organization_id is not null
        and d.organization_id is not null and d.organization_id <> u.organization_id
      order by u.id, j.district`,
    'officer is assigned to a district owned by a different organization than the officer'
  ));

  const hasParcelsOrg = await columnExists('parcels', 'organization_id');
  findings.push(...(hasParcelsOrg ? await rows(
    `select p.id || ' district=' || quote_literal(p.district) || ' -> district ' || d.code || ' belongs to org ' || d.organization_id ||
            ' but the parcel names org ' || p.organization_id as detail
       from parcels p
       join districts d on d.code = lower(trim(p.district))
      where p.organization_id is not null and d.organization_id is not null
        and p.organization_id <> d.organization_id
      order by p.id`,
    'parcel organization disagrees with the organization that owns its district'
  ) : []));

  // ---- 9. Migration-0003 consistency (only when applied) ---------------------
  if (have0003) {
    findings.push(...await rows(
      `select id || ' district=' || quote_literal(district) || ' district_code=' || coalesce(quote_literal(district_code),'NULL') as detail
         from parcels
        where district_code is not null and lower(btrim(district)) <> district_code
        order by id`,
      'parcel district text and district_code disagree'
    ));
    findings.push(...await rows(
      `select id || ' district=' || quote_literal(district) || ' district_code=' || coalesce(quote_literal(district_code),'NULL') as detail
         from land_documents
        where district_code is not null and lower(btrim(district)) <> district_code
        order by id`,
      'document district text and district_code disagree'
    ));
    findings.push(...await rows(
      `select 'unresolved parcel district_code: ' || count(*)::text || ' row(s) -> ' ||
              coalesce(string_agg(id, ', ' order by id), '-') as detail
         from parcels where btrim(coalesce(district,'')) <> '' and district_code is null
        having count(*) > 0`,
      'parcel district could not be resolved to a registered code (reported, never guessed — the FK stays NULL until an administrator declares the district)'
    ));
  } else {
    console.log('  note  migration 0003 is not applied, so district_code consistency was not checked.\n');
  }

  // ---- 7. Ownership: the quarantine queue, split by whether it is expected ----
  // Since migration 0006 a record with no owner is invisible to every tenant. For a parcel under a
  // RETIRED test fixture that is the owner's standing decision (isolated synthetic history, never
  // attached to an organization), so it is reported as a note. A record with no owner inside a live
  // district is a different thing: somebody's land record that no tenant may work on. That is a finding.
  const orphanLive = await rows(
    `select p.id || ' (' || p.district_code || ')' as detail
       from parcels p join districts d on d.code = p.district_code
      where p.organization_id is null and d.kind in ('canonical','candidate') and d.is_active
      order by p.id`,
    'parcel has no owner while sitting in a live district — no tenant can read it and no tenant is responsible for it (disposition: server/src/db/assignOwnership.ts)'
  );
  findings.push(...orphanLive);

  const orphanDocs = await rows(
    `select d.id || ' (' || coalesce(d.district_code, 'no district') || ')' as detail
       from land_documents d
        where d.organization_id is null
          and (d.parcel_id is null or not exists (select 1 from parcels p where p.id = d.parcel_id and p.organization_id is not null))
        order by d.id`,
    'document has no owner and inherits none from a linked parcel — it is filed, and readable by nobody'
  );
  findings.push(...orphanDocs);

  const quarantineNotes = await pool.query(
    `select
       (select count(*)::int from parcels p join districts d on d.code = p.district_code
         where p.organization_id is null and d.kind = 'retired') as fixture_parcels,
       (select count(*)::int from users where organization_id is null) as unowned_officers,
       (select count(*)::int from districts where kind = 'candidate') as candidate_districts,
       (select count(*)::int from organization_districts where revoked_at is null) as active_grants`
  );
  const qn = quarantineNotes.rows[0];

  // ---- Notes: known-incomplete but not broken ---------------------------------
  const notes: string[] = [];
  const orgCount = Number((await pool.query('select count(*)::int as n from organizations')).rows[0].n);
  if (orgCount === 0) {
    notes.push('no organization (tenant) rows exist, so cross-tenant isolation cannot be exercised at all. That is a');
    notes.push('decision waiting on the revenue department, not corrupt data — see docs/DISTRICT-TENANCY-MODEL.md §8.');
  } else {
    // districts.organization_id being NULL is the settled model, not a gap: geography is shared between
    // tenants and authority over it lives in organization_districts. Reporting the old column as a
    // problem would point an operator at the wrong table.
    notes.push(`tenants: ${orgCount}; active organization_districts grants: ${qn.active_grants}. District rows are shared geography and carry no owner: authority is granted through organization_districts.`);
    if (Number(qn.candidate_districts) > 0) {
      notes.push(`${qn.candidate_districts} district(s) are declared but not yet canonical geography — promote or retire them (POST /api/admin/districts/:code/promote).`);
    }
    if (Number(qn.fixture_parcels) > 0) {
      notes.push(`${qn.fixture_parcels} parcel(s) under retired test fixtures are deliberately unowned (isolated synthetic history, owner decision 2026-10-19). They stay quarantined.`);
    }
    if (Number(qn.unowned_officers) > 0) {
      notes.push(`${qn.unowned_officers} officer account(s) belong to no organization, so they can administer nothing and read no record.`);
    }
  }
  const declared = Number((await pool.query(
    `select count(*)::int as n from districts where provenance = 'declared'`
  )).rows[0].n);
  notes.push(`district registry: provenance='declared' on ${declared} row(s) — the rest were derived from stored values,`);
  notes.push('so this report cannot certify that any district name is authoritative, only that rows agree with each other.');

  for (const n of notes) console.log('  note  ' + n);
  console.log('');

  // ---- Summary ---------------------------------------------------------------
  const byCheck = new Map<string, string[]>();
  for (const f of findings) {
    byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f.detail]);
  }

  if (byCheck.size === 0) {
    console.log('  [PASS] No invalid, ambiguous or orphaned jurisdiction references were found.');
    console.log('         Read the notes above before treating that as authoritative.');
    await pool.end();
    return;
  }

  let total = 0;
  for (const [check, details] of byCheck) {
    total += details.length;
    console.log(`  [FINDING] ${check} (${details.length})`);
    for (const d of details.slice(0, 20)) console.log('            - ' + d);
    if (details.length > 20) console.log(`            - … ${details.length - 20} more`);
  }

  console.log(`\n  ${total} finding(s). Nothing was modified: these rows need an authoritative decision,`);
  console.log('  and this tool will not invent one.');

  await pool.end();

  if (WARN_ONLY) {
    console.log('  VERIFY_INTEGRITY_WARN_ONLY=true, so exiting 0 despite findings.');
    return;
  }
  process.exit(1);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from information_schema.columns where table_name = $1 and column_name = $2 limit 1`,
    [table, column]
  );
  return r.rows.length > 0;
}

main().catch(async (err) => {
  console.error('[INTEGRITY] check failed:', err?.message ?? err);
  await pool.end().catch(() => {});
  process.exit(1);
});
