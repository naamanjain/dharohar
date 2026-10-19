/**
 * Proves migration 0003 (stable district identifiers + enforced district references) does what the
 * P0 instruction requires — and, just as importantly, what it refuses to do.
 *
 * Four phases, each against a throwaway database this run creates and drops:
 *   A. a fresh database migrates through the real runner and seeds under the new trigger;
 *   B. write-time refusals: an unregistered jurisdiction, a bogus key, a colliding spelling, and a
 *      deactivated district are all refused, while an UPDATE that does not touch the district on a
 *      legacy invalid row still succeeds;
 *   C. an ambiguous registry STOPS the migration — with the transaction rolled back and nothing
 *      half-applied, because choosing between two spellings is the department's decision;
 *   D. a record whose district cannot be resolved migrates with district_code NULL: the row is
 *      reported, not repaired, and no registry entry is invented for it.
 *
 *   REGISTRY_ADMIN_URL=postgres://…can-CREATE-DATABASE…@127.0.0.1:55432/postgres npm run test:registry
 *
 * Phase C and D need a database that is genuinely at 0002, so the harness applies 0001 and 0002
 * itself using the runner's own exported loader and checksum, then calls the real `db:migrate` for
 * 0003. Anything else would be testing a copy of the runner.
 */
import { Client } from 'pg';
import { applyMigrationsUpTo, createScratchDatabase, runServerScript } from './utils/testHarness';
import { loadMigrations } from './db/migrate';

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, evidence = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${evidence ? ' — ' + evidence.slice(0, 400) : ''}`);
  }
}

async function columnExists(client: Client, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`,
    [table, column]
  );
  return r.rowCount! > 0;
}

async function constraintNames(client: Client, table: string): Promise<string[]> {
  const r = await client.query(
    `select conname from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname=$1 and t.relnamespace='public'::regnamespace`,
    [table]
  );
  return r.rows.map((x: any) => x.conname as string);
}

async function triggerNames(client: Client, table: string): Promise<string[]> {
  const r = await client.query('select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal', [table]);
  return r.rows.map((x: any) => x.tgname as string);
}

async function errorOf(client: Client, sql: string): Promise<string> {
  try {
    await client.query(sql);
    return '';
  } catch (e: any) {
    // MESSAGE, DETAIL and HINT are separate driver fields; a trigger's guidance lives in the hint,
    // so an assertion that only read e.message would "fail" on a refusal that worked perfectly.
    return `${e.code ?? ''} ${e.message ?? e} ${e.detail ?? ''} ${e.hint ?? ''}`;
  }
}

/** Some states only a restore can produce, because a constraint now forbids them through SQL. */
async function insertBypassingTriggers(client: Client, sql: string): Promise<string> {
  await client.query('set session_replication_role = replica');
  try {
    await client.query(sql);
    return '';
  } catch (e: any) {
    return `${e.code ?? ''} ${e.message ?? e}`;
  } finally {
    await client.query('set session_replication_role = origin');
  }
}

const PARCEL_COLS = `id, khasra_no, khata_no, district, mapped_area_ha, owner_name, status, is_archived, created_at, updated_at`;

/** Fixture parcel; `code` is only named when the assertion is about the foreign key itself. */
function parcelInsert(id: string, district: string | null, code?: string): string {
  const cols = PARCEL_COLS + (code ? ', district_code' : '');
  const vals = `'${id}', '1/1', '7', ${district === null ? 'NULL' : quote(district)}${code ? ', ' + quote(code) : ''}, 1.0, 'Fixture', 'Draft', false, now(), now()`;
  return `insert into parcels (${cols}) values (${vals})`;
}

function quote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function main() {
  const adminUrl = process.env.REGISTRY_ADMIN_URL || process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error('[REGISTRY] REGISTRY_ADMIN_URL (a role that can CREATE DATABASE) is required.');
    process.exit(2);
  }

  const files = loadMigrations();
  const mig3 = files.find((m) => m.version === '0003');
  console.log('\n============================================================');
  console.log('  DHAROHAR MIGRATION 0003 — STABLE DISTRICT IDENTIFIERS');
  console.log(`  ${mig3 ? mig3.filename : '0003 MISSING'} (checksum ${mig3 ? mig3.checksum.slice(0, 17) : '-'})`);
  console.log('============================================================\n');
  if (!mig3) {
    console.error('[REGISTRY] server/src/db/migrations/0003_*.sql does not exist.');
    process.exit(1);
  }

  const created: string[] = [];
  const dbs: { drop: () => Promise<void> }[] = [];

  try {
    // ══ A. fresh database, real runner ══════════════════════════════════════════════════════
    const A = await createScratchDatabase('dharohar_registry_a', adminUrl);
    dbs.push(A);
    created.push(A.name);
    console.log(`  note  scratch A ${A.name}\n`);

    const a1 = runServerScript('db/migrate.ts', A.url);
    assert('A: db:migrate applies every migration on disk', a1.status === 0, a1.output);

    const ac = new Client({ connectionString: A.url });
    await ac.connect();
    const ledger = await ac.query('select version, filename, checksum, runner from schema_migrations order by version');
    // Counted against the directory, not a literal 3. A hard-coded three went red the moment 0004
    // and 0005 existed: the fact this assertion cares about is "the runner applied what is on disk",
    // and a number that has to be edited every time a migration is added tests the calendar.
    assert(`A: ledger records every migration file (${files.length})`, ledger.rowCount === files.length,
      `rows=${ledger.rowCount} vs ${files.length} files: ${files.map((m) => m.version).join(',')}`);
    assert('A: ledger includes 0003, the migration this suite is about',
      ledger.rows.some((r: any) => r.version === '0003'), '0003 is not in schema_migrations');
    assert(
      'A: ledger checksums match the files on disk',
      files.every((m) => ledger.rows.some((r: any) => r.version === m.version && r.checksum === m.checksum)),
      'the runner recorded a different checksum than loadMigrations computes'
    );

    for (const t of ['parcels', 'land_documents', 'users', 'user_jurisdictions']) {
      assert(`A: ${t}.district_code exists`, await columnExists(ac, t, 'district_code'));
      const cons = await constraintNames(ac, t);
      assert(
        `A: ${t} has both a district_code foreign key and a text/code CHECK`,
        cons.some((c) => c.startsWith(`fk_${t}_district_code`)) && cons.some((c) => c.startsWith(`ck_${t}_district_code_matches`)),
        cons.join(', ')
      );
      assert(`A: ${t} carries the write-time trigger`, (await triggerNames(ac, t)).includes(`trg_${t}_district_code`));
    }
    assert('A: parcel tenant column exists', await columnExists(ac, 'parcels', 'organization_id'));
    const fnExists = await ac.query(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='dharohar_sync_district_code'`);
    assert('A: the resolver function exists in the database, not only in SQL files', fnExists.rowCount! > 0);

    const a2 = runServerScript('db/seed.ts', A.url, { SEED_CONFIRM: 'demo' });
    assert('A: demo seed still succeeds under the trigger', a2.status === 0, a2.output);

    const unresolved = await ac.query(
      `select 'parcels' as t, count(*)::int as n from parcels where district_code is null and btrim(coalesce(district,'')) <> ''
       union all select 'documents', count(*)::int from land_documents where district_code is null and btrim(coalesce(district,'')) <> ''
       union all select 'users', count(*)::int from users where district_code is null and btrim(coalesce(district,'')) <> ''
       union all select 'assignments', count(*)::int from user_jurisdictions where district_code is null`);
    assert(
      'A: every seeded jurisdiction resolved to a code (no invented values needed)',
      unresolved.rows.every((r: any) => r.n === 0),
      unresolved.rows.map((r: any) => `${r.t}=${r.n}`).join(', ')
    );

    const a3 = runServerScript('verify_district_integrity.ts', A.url);
    assert('A: integrity checker passes on a freshly migrated + seeded database', a3.status === 0, a3.output);
    assert('A: integrity checker reports 0003 as applied', /0003[\s\S]*?: applied/.test(a3.output), a3.output.slice(0, 300));

    // ── B. write-time refusals on the same database ───────────────────────────────────────────
    const refusedUnregistered = await errorOf(ac, parcelInsert('P-REFUSE-1', 'Fakepur'));
    assert(
      'B: INSERT of a parcel in an unregistered district is refused, not guessed',
      /DISTRICT_NOT_REGISTERED/.test(refusedUnregistered),
      refusedUnregistered || 'the insert succeeded — the trigger is not firing'
    );

    const okOddCase = await errorOf(ac, parcelInsert('P-CASE-1', '  JAIPUR '));
    const coded = await ac.query(`select district_code from parcels where id='P-CASE-1'`);
    assert('B: a differently-spelled but resolvable district is accepted and coded', okOddCase === '' && coded.rows[0]?.district_code === 'jaipur', JSON.stringify(coded.rows));

    // The foreign key is the backstop, not the front line: while the trigger is in place a made-up
    // key is refused before PostgreSQL reaches the constraint. So test the constraint the way a
    // restore-with-triggers-disabled meets it — by removing the front line in this scratch database.
    await ac.query('drop trigger trg_parcels_district_code on parcels');
    const badKey = await errorOf(
      ac,
      `insert into parcels (${PARCEL_COLS}, district_code) values ('P-BADKEY','1/1','7',NULL,1.0,'Fixture','Draft',false,now(),now(),'nosuchdistrict')`
    );
    assert(
      'B: a district_code that is not in the registry violates the foreign key',
      /23503|foreign key/i.test(badKey),
      badKey || 'the insert succeeded — the foreign key is decorative'
    );
    await ac.query(`delete from parcels where id='P-BADKEY'`);
    await ac.query(
      `CREATE TRIGGER trg_parcels_district_code BEFORE INSERT OR UPDATE OF district ON parcels FOR EACH ROW EXECUTE FUNCTION dharohar_sync_district_code()`
    );
    assert('B: the trigger is restored after probing the constraint underneath it', (await triggerNames(ac, 'parcels')).includes('trg_parcels_district_code'));

    const conflict = await errorOf(
      ac,
      `insert into parcels (${PARCEL_COLS}, district_code) values ('P-CONFLICT','1/1','7','Jaipur',1.0,'Fixture','Draft',false,now(),now(),'jodhpur')`
    );
    assert(
      'B: a caller cannot smuggle a district_code that disagrees with its own district text',
      /DISTRICT_CODE_CONFLICT/.test(conflict),
      conflict || 'the trigger overwrote the supplied key instead of refusing it'
    );

    const changeToBad = await errorOf(ac, `update parcels set district='Fakepur' where id='P-CASE-1'`);
    assert('B: changing a record to an unregistered district is refused', /DISTRICT_NOT_REGISTERED/.test(changeToBad), changeToBad);

    const legalMove = await errorOf(ac, `update parcels set district='Jodhpur' where id='P-CASE-1'`);
    const moved = await ac.query(`select district, district_code from parcels where id='P-CASE-1'`);
    assert(
      'B: an ordinary district change to a registered district still works, and re-codes itself',
      legalMove === '' && moved.rows[0]?.district_code === 'jodhpur',
      `${legalMove} ${JSON.stringify(moved.rows)}`
    );

    // A legacy row that 0003 could not resolve must not lock the record against unrelated work.
    await insertBypassingTriggers(
      ac,
      `insert into parcels (${PARCEL_COLS}) values ('P-LEGACY','1/1','7','Fakepur',1.0,'Legacy Owner','Draft',false,now(),now())`
    );
    const legacyBefore = await ac.query(`select district, district_code from parcels where id='P-LEGACY'`);
    const editUnrelated = await errorOf(ac, `update parcels set owner_name='Renamed Owner' where id='P-LEGACY'`);
    const legacyAfter = await ac.query(`select district, district_code, owner_name from parcels where id='P-LEGACY'`);
    assert(
      'B: an UPDATE that does not touch the district still works on an unresolved legacy row',
      editUnrelated === '' && legacyAfter.rows[0].owner_name === 'Renamed Owner' && legacyAfter.rows[0].district_code === null,
      `${editUnrelated} ${JSON.stringify(legacyAfter.rows)}`
    );
    const rewriteSame = await errorOf(ac, `update parcels set district='Fakepur' where id='P-LEGACY'`);
    assert(
      'B: re-writing an unresolved legacy value unchanged is allowed, by design',
      rewriteSame === '',
      `${rewriteSame} — a full-row ORM save would otherwise be unable to touch this record`
    );
    const changeLegacy = await errorOf(ac, `update parcels set district='Nowhpur' where id='P-LEGACY'`);
    assert('B: changing that legacy district to another unregistered value is refused', /DISTRICT_NOT_REGISTERED/.test(changeLegacy), changeLegacy);

    // Two registry rows that differ only by an internal space are one jurisdiction wearing two
    // identifiers. The first is legitimate; the second is exactly what silently splits a district.
    const firstSpelling = await errorOf(ac, `insert into districts (code, name, provenance) values ('jaipur district','Jaipur District','declared')`);
    const collide = await errorOf(ac, `insert into districts (code, name, provenance) values ('jaipurdistrict','JaipurDistrict','declared')`);
    assert(
      'B: a second registry row whose name normalizes to an existing jurisdiction is refused',
      firstSpelling === '' && /unique|duplicate|23505/i.test(collide),
      `${firstSpelling} / ${collide || 'both spellings were accepted, so no stable identifier exists for that jurisdiction'}`
    );
    await ac.query(`delete from districts where code in ('jaipur district','jaipurdistrict')`).catch(() => {});

    await ac.query(`update districts set is_active = false where code = 'udaipur'`);
    const inactive = await errorOf(ac, parcelInsert('P-INACTIVE', 'Udaipur'));
    assert('B: filing under a deactivated district is refused', /DISTRICT_NOT_REGISTERED[\s\S]*inactive/i.test(inactive), inactive);
    await ac.query(`update districts set is_active = true where code = 'udaipur'`);
    const revived = await errorOf(ac, parcelInsert('P-REVIVED', 'Udaipur'));
    assert('B: re-activating the district makes the same write succeed', revived === '', revived);

    const mismatch = await errorOf(ac, `update parcels set district_code = lower(btrim(district)) || '-x' where id='P-CASE-1'`);
    assert('B: text and key are not allowed to disagree', /ck_parcels_district_code_matches|check constraint|23514/i.test(mismatch), mismatch);

    const blank = await errorOf(ac, parcelInsert('P-BLANK', '   '));
    const blankRow = await ac.query(`select district, district_code from parcels where id='P-BLANK'`);
    assert(
      'B: a blank district is stored with a NULL code rather than guessed or rejected',
      blank === '' && blankRow.rows[0]?.district_code === null,
      `${blank} ${JSON.stringify(blankRow.rows)}`
    );

    await ac.query(`delete from parcels where id in ('P-CASE-1','P-REVIVED','P-LEGACY','P-BLANK')`).catch(() => {});
    await ac.end();

    // ══ C. an ambiguous registry STOPS the migration ══════════════════════════════════════════
    const B = await createScratchDatabase('dharohar_registry_b', adminUrl);
    dbs.push(B);
    created.push(B.name);
    console.log(`\n  note  scratch B ${B.name} (deliberately kept at 0002, the state a real deployment is in)`);
    const bc = new Client({ connectionString: B.url });
    await bc.connect();
    await applyMigrationsUpTo(bc, 2);
    assert('C: pre-0003 database has no district_code column', !(await columnExists(bc, 'parcels', 'district_code')));

    // Canonical codes, so the ONLY defect here is the ambiguity — otherwise the migration's second
    // pre-check would also fire and the evidence would not say which problem stopped it.
    await bc.query(`insert into districts (code, name, provenance) values ('jaipur district','Jaipur District','derived'), ('jaipurdistrict','JaipurDistrict','derived')`);
    await bc.query(`insert into parcels (${PARCEL_COLS}) values ('P-AMBIG','1/1','7','Jaipur District',1.0,'Fixture','Draft',false,now(),now())`);
    await bc.end();

    const b1 = runServerScript('db/migrate.ts', B.url);
    assert('C: db:migrate STOPS on the ambiguous registry (non-zero exit)', b1.status !== 0, 'the migration applied anyway — it picked a district for us');
    assert('C: the failure names the colliding spellings it refuses to choose between', /jaipur district/i.test(b1.output) && /jaipurdistrict/i.test(b1.output), b1.output.slice(-500));
    assert('C: the failure message says nothing was changed', /rolling back|Nothing was changed/i.test(b1.output), b1.output.slice(-500));
    assert('C: the failure message tells the operator what to run', /test:integrity/.test(b1.output), b1.output.slice(-500));

    const bc2 = new Client({ connectionString: B.url });
    await bc2.connect();
    const ledgerB = await bc2.query('select version from schema_migrations order by version');
    assert(
      'C: rollback is complete — the ledger still shows only 0001 and 0002',
      ledgerB.rows.map((r: any) => r.version).join(',') === '0001,0002',
      ledgerB.rows.map((r: any) => r.version).join(',')
    );
    assert('C: nothing half-applied — district_code is still absent', !(await columnExists(bc2, 'parcels', 'district_code')));
    const stillBoth = await bc2.query(`select count(*)::int as n from districts where code in ('jaipur district','jaipurdistrict')`);
    assert('C: the migration did not merge or delete either spelling', stillBoth.rows[0].n === 2, `found ${stillBoth.rows[0].n}`);

    // The department decides which spelling is the district; only then can the migration proceed.
    await bc2.query(`delete from districts where code='jaipurdistrict'`);
    await bc2.end();

    const b2 = runServerScript('db/migrate.ts', B.url);
    assert('C: after the ambiguity is resolved, the migration applies', b2.status === 0, b2.output.slice(-400));

    const bc3 = new Client({ connectionString: B.url });
    await bc3.connect();
    const ambig = await bc3.query(`select district, district_code from parcels where id='P-AMBIG'`);
    assert(
      'C: the record that survived the stop resolves to the spelling the department kept',
      ambig.rows[0]?.district_code === 'jaipur district',
      JSON.stringify(ambig.rows)
    );
    await bc3.end();

    // ══ D. an unresolved record migrates NULL, and no district is invented for it ═════════════
    const C = await createScratchDatabase('dharohar_registry_c', adminUrl);
    dbs.push(C);
    created.push(C.name);
    console.log(`\n  note  scratch C ${C.name}`);
    const cc = new Client({ connectionString: C.url });
    await cc.connect();
    await applyMigrationsUpTo(cc, 2);
    await cc.query(`insert into districts (code, name, provenance) values ('jaipur','Jaipur','derived')`);
    await cc.query(`insert into parcels (${PARCEL_COLS}) values ('P-UNRESOLVED','1/1','7','Jaipur',1.0,'Fixture','Draft',false,now(),now())`);
    // A value the registry has never seen, already stored on a real record.
    await cc.query(`insert into parcels (${PARCEL_COLS}) values ('P-FAKEPUR','1/2','8','Fakepur',1.0,'Legacy Fixture','Draft',false,now(),now())`);
    await cc.end();

    const c1 = runServerScript('db/migrate.ts', C.url);
    assert('D: migration applies over data it cannot resolve', c1.status === 0, c1.output.slice(-400));

    const cc2 = new Client({ connectionString: C.url });
    await cc2.connect();
    const codes = await cc2.query(`select id, district, district_code from parcels where id in ('P-UNRESOLVED','P-FAKEPUR') order by id`);
    const fakepur = codes.rows.find((r: any) => r.id === 'P-FAKEPUR');
    assert('D: the resolvable record was coded', codes.rows.find((r: any) => r.id === 'P-UNRESOLVED')?.district_code === 'jaipur', JSON.stringify(codes.rows));
    assert('D: the unresolvable record was left NULL, not guessed', fakepur?.district_code === null, JSON.stringify(fakepur));
    assert('D: the stored district text was not rewritten', fakepur?.district === 'Fakepur', JSON.stringify(fakepur));
    const invented = await cc2.query(`select count(*)::int as n from districts where code='fakepur' or lower(btrim(name))='fakepur'`);
    assert('D: no registry row was invented to make the number look clean', invented.rows[0].n === 0, `districts contains fakepur`);

    const c2 = runServerScript('verify_district_integrity.ts', C.url);
    assert('D: the checker reports the unresolved record and exits non-zero', c2.status === 1 && /P-FAKEPUR/.test(c2.output), `exit ${c2.status}`);
    assert(
      'D: the checker separates unresolved from invalid, and reports both',
      /unresolved parcel district_code/.test(c2.output) && /not a registered district/.test(c2.output),
      c2.output.slice(-400)
    );
    await cc2.end();
  } finally {
    for (const db of dbs) await db.drop().catch((e) => console.error('  note  drop failed:', e?.message ?? e));
    console.log(`\n  note  scratch databases dropped: ${created.join(', ')}\n`);
  }

  console.log(`  ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[REGISTRY] suite crashed:', err?.message ?? err);
  process.exit(1);
});
