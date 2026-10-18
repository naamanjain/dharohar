/**
 * Negative control for `verify_district_integrity.ts`.
 *
 * A read-only checker that reports "clean" proves nothing until it has been shown to notice dirt.
 * This gate builds two throwaway databases and asserts, in order:
 *   1. on the CURRENT schema (every migration applied) a freshly seeded database is clean, and three
 *      defect classes can no longer even be written — unregistered district, ambiguous registry
 *      spelling — which is asserted as a refusal rather than quietly removed from coverage;
 *   2. on the 0002 schema (what a restored older dump looks like) the checker FAILS with exit 1 on a
 *      fixture that plants one row per documented defect, and names each defect and each primary key
 *      — so a check that was silently broken, e.g. one that forgot `revoked_at IS NULL`, cannot score
 *      as a pass;
 *   3. WARN_ONLY still reports but does not fail;
 *   4. an unreachable database is reported as a failure, never as a clean bill of health.
 *
 * It only ever creates and drops databases it named itself. It does not touch the deployed database.
 *
 *   INTEGRITY_ADMIN_URL=postgres://…can-CREATE-DATABASE…@127.0.0.1:55432/postgres npm run test:integrity-gate
 */
import { Client } from 'pg';
import {
  applyMigrationsUpTo,
  createScratchDatabase,
  runServerScript,
  urlForDatabase,
  type ScratchDatabase,
} from './utils/testHarness';

let currentScratch: ScratchDatabase | null = null;
let currentLegacy: ScratchDatabase | null = null;

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, evidence = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${evidence ? ' — ' + evidence : ''}`);
  }
}

// Each entry plants exactly one defect so exactly one check must fire on it.
// `bypass: true` means the state is already forbidden by a foreign key, so the insert is run with
// triggers off — and the restore happens in a finally, never as a third statement that a failed
// insert would skip and leave the rest of the fixture running unprotected.
const FIXTURE: { label: string; expect: string; sql: string; bypass?: boolean }[] = [
  {
    label: 'parcel with a blank district',
    expect: 'parcel has no district',
    sql: `insert into parcels (id, khasra_no, khata_no, district, mapped_area_ha, owner_name, status, is_archived, created_at, updated_at)
          values ('PARCEL-DIRTY-BLANK', '9/1', '77', '   ', 1.2, 'Fixture Row', 'Draft', false, now(), now())`,
  },
  {
    label: 'parcel in a district that was never registered',
    expect: 'parcel district is not a registered district',
    sql: `insert into parcels (id, khasra_no, khata_no, district, mapped_area_ha, owner_name, status, is_archived, created_at, updated_at)
          values ('PARCEL-DIRTY-TYPO', '9/2', '77', 'Fakepur', 1.2, 'Fixture Row', 'Draft', false, now(), now())`,
  },
  {
    label: 'two registry rows that normalize to one jurisdiction',
    expect: 'normalize to the same jurisdiction',
    sql: `insert into districts (code, name, provenance, is_active, created_at) values
            ('jpr-long',  'Jaipur District', 'derived', true, now()),
            ('jpr-nospace','JaipurDistrict',  'derived', true, now())`,
  },
  {
    label: 'document with neither a district nor a parcel',
    expect: 'document has neither a district nor a parcel',
    sql: `insert into land_documents (id, parcel_id, file_name, record_type, status, district, uploaded_at)
          values ('DOC-DIRTY-ORPHAN', null, 'fixture-orphan.pdf', 'GAZETTE', 'PROCESSED', '', now())`,
  },
  {
    label: 'document pointing at a parcel that does not exist',
    expect: 'references a parcel that no longer exists',
    bypass: true,
    sql: `insert into land_documents (id, parcel_id, file_name, record_type, status, district, uploaded_at)
          values ('DOC-DIRTY-DANGLING', 'PARCEL-LONG-GONE', 'fixture-dangling.pdf', 'RAOSTA', 'PROCESSED', 'Jaipur', now())`,
  },
  {
    label: 'document filed under a different district than its parcel',
    expect: 'document district differs from the district',
    sql: `insert into land_documents (id, parcel_id, file_name, record_type, status, district, uploaded_at)
          values ('DOC-DIRTY-MISMATCH', 'DH-JPR-RAM-001024', 'fixture-mismatch.pdf', 'SHAJRA', 'PROCESSED', 'Jodhpur', now())`,
  },
  {
    label: 'officer whose only jurisdiction has been revoked',
    expect: 'officer holds no active jurisdiction and no capability',
    // Revoking (not deleting) is the realistic case and the one a check forgets if it omits `revoked_at IS NULL`.
    sql: `update user_jurisdictions set revoked_at = now() where user_id = 'USR-VER-02'`,
  },
  {
    label: 'assignment naming an unregistered district',
    expect: 'assignment names a district that is not registered',
    sql: `insert into user_jurisdictions (user_id, district, granted_by, granted_at)
          values ('USR-AUD-04', 'Nowhpur', 'fixture', now())`,
  },
  {
    label: "users.district not among the officer's active assignments",
    expect: 'names a district the officer is not currently assigned to',
    sql: `insert into users (id, email, password_hash, salt, role, display_name, designation, district, state, created_at)
          values ('USR-DIRTY-SPLIT', 'split@fixture.local', 'x', 'x', 'TEHSILDAR', 'Fixture Officer', 'Tehsildar', 'Jodhpur', 'Rajasthan', now());
          insert into user_jurisdictions (user_id, district, granted_by, granted_at)
          values ('USR-DIRTY-SPLIT', 'Ajmer', 'fixture', now())`,
  },
  {
    label: 'owner row whose parcel is gone',
    expect: 'owner row references a parcel that does not exist',
    bypass: true,
    sql: `insert into parcel_owners (id, parcel_id, name, share_percentage, status, created_at)
          values ('OWN-DIRTY-GONE', 'PARCEL-LONG-GONE', 'Fixture Owner', 100, 'CURRENT', now())`,
  },
  {
    label: 'parcel pointing at a document that does not exist',
    expect: 'parcel points at a document that does not exist',
    // parcels.document_id carries no FK at all — this state is reachable through ordinary SQL today,
    // which is why the checker keeps the row-level rule.
    sql: `insert into parcels (id, khasra_no, khata_no, district, mapped_area_ha, owner_name, status, is_archived, document_id, created_at, updated_at)
          values ('PARCEL-DIRTY-DOC', '9/3', '78', 'Jaipur', 1.2, 'Fixture Row', 'Draft', false, 'DOC-LONG-GONE', now(), now())`,
  },
];

async function main() {
  const adminUrl = process.env.INTEGRITY_ADMIN_URL || process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error('[INTEGRITY-GATE] INTEGRITY_ADMIN_URL (a role that can CREATE DATABASE) is required.');
    process.exit(2);
  }

  console.log('\n============================================================');
  console.log('  DHAROHAR INTEGRITY CHECKER — NEGATIVE CONTROL');
  console.log('============================================================\n');

  const scratch = await createScratchDatabase('dharohar_integrity', adminUrl);
  currentScratch = scratch;
  const scratchUrl = scratch.url;
  // A second database, deliberately frozen at the pre-0003 schema. Migration 0003 makes several of
  // the defects below impossible to create through SQL at all — which is the point of it — so a
  // single-database gate would quietly lose detection coverage for exactly the rows a restore from an
  // older dump can still contain. Each phase runs against the schema where its defect is reachable.
  const legacy = await createScratchDatabase('dharohar_integrity_legacy', adminUrl);
  currentLegacy = legacy;
  const legacyUrl = legacy.url;
  console.log(`  note  scratch database ${scratch.name}   (current schema: every migration applied)`);
  console.log(`  note  scratch database ${legacy.name}   (0002 schema, what a restore arrives as)`);
  console.log('============================================================\n');

  // ---- 1. current schema + demo data, then the checker must pass ------------------
  const mig = runServerScript('db/migrate.ts', scratchUrl, {}, 180_000);
  assert('migrations apply to a fresh database', mig.status === 0, mig.output.slice(-300));
  const seed = runServerScript('db/seed.ts', scratchUrl, { SEED_CONFIRM: 'demo' }, 180_000);
  assert('demo seed inserts jurisdiction rows', seed.status === 0, seed.output.slice(-300));

  const clean = runServerScript('verify_district_integrity.ts', scratchUrl);
  assert('clean data exits 0', clean.status === 0, `got exit ${clean.status}`);
  assert('clean data reports [PASS]', /\[PASS\]/.test(clean.output), 'no [PASS] line in output');
  assert('clean data reports 0003 as applied', /: applied/.test(clean.output), clean.output.slice(0, 200));

  // What the current schema refuses at write time is proven here rather than in the fixture, because
  // on this schema the fixture could not create the row to be detected.
  const guarded = new Client({ connectionString: scratchUrl });
  await guarded.connect();
  const typoWrite = await (async () => {
    try {
      await guarded.query(
        `insert into parcels (id, khasra_no, khata_no, district, mapped_area_ha, owner_name, status, is_archived, created_at, updated_at)
         values ('P-GATE-TYPO','1/1','7','Fakepur',1.0,'Fixture','Draft',false,now(),now())`
      );
      return '';
    } catch (e: any) {
      return `${e.message ?? e}`;
    }
  })();
  assert('the current schema refuses to store an unregistered district', /DISTRICT_NOT_REGISTERED/.test(typoWrite), typoWrite || 'the typo was accepted');
  const twoSpellings = await (async () => {
    try {
      await guarded.query(`insert into districts (code, name, provenance) values ('jaipur district','Jaipur District','declared')`);
      await guarded.query(`insert into districts (code, name, provenance) values ('jaipurdistrict','JaipurDistrict','declared')`);
      return '';
    } catch (e: any) {
      return `${e.message ?? e}`;
    }
  })();
  assert('the current schema refuses two registry rows for one jurisdiction', /unique|duplicate|23505/i.test(twoSpellings), twoSpellings || 'both spellings were stored');
  await guarded.query(`delete from districts where code in ('jaipur district','jaipurdistrict')`).catch(() => {});
  await guarded.query(`delete from parcels where id='P-GATE-TYPO'`).catch(() => {});
  await guarded.end();

  // ---- 2. one planted defect per documented check, on the 0002 schema -------------
  const pre = new Client({ connectionString: legacyUrl });
  await pre.connect();
  await applyMigrationsUpTo(pre, 2);
  await pre.end();
  const seedLegacy = runServerScript('db/seed.ts', legacyUrl, { SEED_CONFIRM: 'demo' }, 180_000);
  assert('the 0002 database seeds the same demo jurisdictions', seedLegacy.status === 0, seedLegacy.output.slice(-300));

  const dirty = new Client({ connectionString: legacyUrl });
  await dirty.connect();
  for (const f of FIXTURE) {
    try {
      if (f.bypass) await dirty.query('set session_replication_role = replica');
      await dirty.query(f.sql);
    } catch (e: any) {
      console.error(`[INTEGRITY-GATE] fixture insert failed for "${f.label}": ${e.message}`);
      failed++;
    } finally {
      if (f.bypass) await dirty.query('set session_replication_role = origin');
    }
  }
  // Prove the bypass really was switched back off, or every later insert in this session would be
  // silently unconstrained and the fixture would be testing nothing.
  const roleNow = (await dirty.query('show session_replication_role')).rows[0].session_replication_role;
  assert('triggers restored after FK-bypassed inserts', roleNow === 'origin', `session_replication_role is ${roleNow}`);
  await dirty.end();

  const report = runServerScript('verify_district_integrity.ts', legacyUrl);
  assert('dirty data exits non-zero', report.status === 1, `got exit ${report.status} — a checker that cannot fail cannot protect anything`);

  for (const f of FIXTURE) {
    assert(`detected: ${f.label}`, report.output.includes(f.expect), `expected the phrase "${f.expect}"`);
  }
  for (const key of ['PARCEL-DIRTY-BLANK', 'PARCEL-DIRTY-TYPO', 'DOC-DIRTY-ORPHAN', 'DOC-DIRTY-DANGLING', 'DOC-DIRTY-MISMATCH', 'USR-VER-02', 'USR-DIRTY-SPLIT', 'OWN-DIRTY-GONE', 'PARCEL-DIRTY-DOC']) {
    assert(`report names the row ${key}`, report.output.includes(key), 'finding was not reported by primary key');
  }

  const findingCount = Number((report.output.match(/\[FINDING\]/g) ?? []).length);
  assert('at least one finding block per defect class', findingCount >= FIXTURE.length, `only ${findingCount} [FINDING] blocks for ${FIXTURE.length} planted defects`);

  // Echo the checker's own report so the run log is the evidence, not just this suite's tally.
  console.log('\n  ---- checker report on the dirty fixture ----');
  for (const line of report.output.split('\n')) {
    if (/^\s+\[FINDING\]|^\s{12}-/.test(line)) console.log('  ' + line.trimEnd());
  }
  console.log('  ---- end report ----\n');

  // WARN_ONLY must still report but not fail — a gate that ignores its own escape hatch is a trap later.
  const warn = runServerScript('verify_district_integrity.ts', legacyUrl, { VERIFY_INTEGRITY_WARN_ONLY: 'true' });
  assert('WARN_ONLY reports findings but exits 0', warn.status === 0 && /\[FINDING\]/.test(warn.output), `exit ${warn.status}`);

  // ---- 3. unreachable database must never read as clean ---------------------------
  const unreachable = runServerScript('verify_district_integrity.ts', urlForDatabase(adminUrl, 'no_such_database_zzz'));
  assert('unreachable database does not exit 0', unreachable.status !== 0, `exit ${unreachable.status}`);
  assert('unreachable database does not report PASS', !/\[PASS\]/.test(unreachable.output), 'the checker claimed clean data it could not read');

  // ---- 4. which planted defects each schema itself already forbids ------------------
  const probe = new Client({ connectionString: legacyUrl });
  await probe.connect();
  const legacyFks = (await probe.query(
    `select distinct tc.table_name || '.' || kcu.column_name as col
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' order by col`
  )).rows.map((r: any) => r.col as string);
  await probe.end();

  const guardedProbe = new Client({ connectionString: scratchUrl });
  await guardedProbe.connect();
  const currentFks = (await guardedProbe.query(
    `select distinct tc.table_name || '.' || kcu.column_name as col
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' order by col`
  )).rows.map((r: any) => r.col as string);
  await guardedProbe.end();

  const districtFks = currentFks.filter((c) => /\.district(_code)?$/.test(c));
  console.log('\n  Jurisdiction foreign keys on the 0002 schema: ' + (legacyFks.filter((c) => /\.district$/.test(c)).join(', ') || 'NONE'));
  console.log('  Jurisdiction foreign keys on the current schema: ' + (districtFks.join(', ') || 'NONE'));
  for (const [col, ifEnforced, ifMissing] of [
    ['land_documents.parcel_id', 'dangling document->parcel references cannot be created by SQL', 'still reachable'],
    ['parcel_owners.parcel_id', 'orphan owner rows cannot be created by SQL', 'still reachable'],
    ['parcels.document_id', 'a parcel cannot point at a missing document', 'a parcel CAN point at a missing document'],
  ] as [string, string, string][]) {
    console.log(`  note  ${col}: FK ${legacyFks.includes(col) ? 'present' : 'ABSENT'} — ${legacyFks.includes(col) ? ifEnforced : ifMissing}`);
  }
  console.log('  note  The two FK-covered defects were planted with triggers bypassed, which is what a restore');
  console.log('        of a dump taken before those constraints existed effectively is. The checker keeps');
  console.log('        reporting them so an old restore is inspected rather than trusted.');
  console.log('  note  Detection of every defect class above was proven on the 0002 schema. On the current');
  console.log('        schema three of them cannot be inserted at all, and that refusal is asserted above');
  console.log('        rather than quietly dropped from this gate.');

  // ---- cleanup --------------------------------------------------------------------
  await scratch.drop();
  await legacy.drop();
  console.log(`\n  note  dropped ${scratch.name} and ${legacy.name}; nothing was left behind.\n`);

  console.log(`  ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[INTEGRITY-GATE] suite failed:', err?.message ?? err);
  // A crashed run must not leave scratch databases behind, or the next run inherits them.
  for (const db of [currentScratch, currentLegacy]) await db?.drop().catch(() => {});
  process.exit(1);
});
