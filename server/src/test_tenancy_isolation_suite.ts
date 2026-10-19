/**
 * Tenancy and jurisdiction isolation suite — the pre-RLS measurement.
 *
 * docs/DISTRICT-TENANCY-MODEL.md settled the architecture: an organization is a tenant, a district
 * is canonical geography shared between tenants, and `organization_districts` is the relationship
 * that says who may administer what. Row-Level Security can only be designed against a stated
 * requirement, and the requirement is this file. Every assertion below is the behaviour a deployed
 * multi-organization DHAROHAR must have.
 *
 * THIS SUITE IS EXPECTED TO BE RED. That is not a defect in it. The application authorizes a request
 * from `user_jurisdictions` (which districts THIS officer may reach) and does not consult
 * `organizations` or `organization_districts` anywhere in the request path, so the assertions that
 * require organization scoping fail until that enforcement exists. Running it green-washed would
 * hide exactly the hole it was written to find, so the failures are left loud and wired into
 * scripts/test-authorization-on-copy.sh, and docs/SECURITY.md lists the gap.
 *
 * It also asserts the parts that DO work today — per-district isolation and the capability model —
 * because a suite that is entirely red proves nothing about the machinery it depends on.
 *
 * Run against a disposable copy, never against the only demo database (it plants a second
 * organization and re-parents one officer):
 *
 *   TEST_BASE_URL=http://127.0.0.1:8099/api \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... DEMO_PASSWORD=... \
 *   TENANCY_DB_URL=postgres://postgres:...@127.0.0.1:55432/<copy> \
 *   npx tsx server/src/test_tenancy_isolation_suite.ts
 */

import { Client } from 'pg';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sysadmin@dharohar.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
const DB_URL = process.env.TENANCY_DB_URL || '';

const DEMO_TENANT = 'ORG-DHAROHAR-DEMO';
const OTHER_TENANT = 'ORG-TENANCY-OTHER';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function call(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function login(identifier: string, password: string): Promise<string> {
  const r = await call('/auth/login', { method: 'POST', body: { email: identifier, password } });
  if (r.status !== 200 || !r.body?.data?.token) {
    throw new Error(`login failed for ${identifier}: HTTP ${r.status} ${JSON.stringify(r.body?.error || {})}`);
  }
  return r.body.data.token;
}

async function main() {
  const run = Date.now().toString().slice(-6);
  console.log('\n============================================================');
  console.log('  DHAROHAR TENANCY / JURISDICTION ISOLATION — run ' + run);
  console.log(`  target: ${BASE_URL}`);
  console.log('============================================================\n');

  if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !DB_URL) {
    console.error('  ABORT: ADMIN_PASSWORD, DEMO_PASSWORD and TENANCY_DB_URL are all required.');
    console.error('  Use scripts/test-authorization-on-copy.sh, which supplies them against a copy.');
    process.exit(2);
  }

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  // A parcel per canonical district, read from the registry rather than assumed. Without this the
  // whole suite would be asserting against district names that may not carry records.
  const parcelRows = await db.query(
    `select d.code, p.id from districts d
       join parcels p on p.district_code = d.code
      where d.code in ('jaipur','jodhpur','ajmer','udaipur')
      group by d.code, p.id order by d.code`
  );
  const byDistrict: Record<string, string> = {};
  for (const r of parcelRows.rows) if (!byDistrict[r.code]) byDistrict[r.code] = r.id;
  const have = ['jaipur', 'jodhpur', 'ajmer', 'udaipur'].filter((c) => byDistrict[c]);
  assert(have.length >= 3, `premise: parcels exist in at least three canonical districts (found ${have.join(',')})`);
  if (have.length < 3) { console.error('  ABORT: not enough districts carry records to test isolation.'); process.exit(2); }

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // -------------------------------------------------------------
  console.log('\n1. PER-DISTRICT ISOLATION TODAY (the layer that does exist)');
  // -------------------------------------------------------------
  const jaipurTehsildar = await login('tehsildar@dharohar.local', DEMO_PASSWORD);
  const homeRead = await call(`/parcels/${byDistrict.jaipur}`, { token: jaipurTehsildar });
  assert(homeRead.status === 200, 'An officer reads a parcel in their own district', `got ${homeRead.status}`);
  if (byDistrict.jodhpur) {
    const awayRead = await call(`/parcels/${byDistrict.jodhpur}`, { token: jaipurTehsildar });
    assert(awayRead.status === 404, 'The same officer is refused a parcel in another district (404, not 403)', `got ${awayRead.status}`);
  }

  // -------------------------------------------------------------
  console.log('\n2. AN OFFICER ASSIGNED TO MULTIPLE DISTRICTS');
  // -------------------------------------------------------------
  const multiEmail = `multi.${run}@dharohar.test`;
  const multiPassword = `Multi-tenant-${run}-pw`;
  const created = await call('/admin/officers', {
    token: admin, method: 'POST',
    body: {
      email: multiEmail, displayName: `Multi District Officer ${run}`, role: 'TEHSILDAR',
      districts: ['Jaipur', 'Ajmer'], password: multiPassword,
    },
  });
  assert(created.status === 201, 'An officer can be created with two districts', `got ${created.status} ${JSON.stringify(created.body?.error || {})}`);
  const multiToken = await login(multiEmail, multiPassword);

  if (byDistrict.ajmer) {
    const ajmerRead = await call(`/parcels/${byDistrict.ajmer}`, { token: multiToken });
    assert(ajmerRead.status === 200, 'Both assigned districts are readable', `got ${ajmerRead.status}`);
  }
  const jaipurRead = await call(`/parcels/${byDistrict.jaipur}`, { token: multiToken });
  assert(jaipurRead.status === 200, 'The first assigned district is still readable (no implicit narrowing)');
  if (byDistrict.udaipur) {
    const third = await call(`/parcels/${byDistrict.udaipur}`, { token: multiToken });
    assert(third.status === 404, 'A third district the officer was NOT assigned to stays invisible', `got ${third.status}`);
  }

  const multiId = created.body?.data?.officer?.id;
  const demoted = await call(`/admin/officers/${multiId}/jurisdictions`, {
    token: admin, method: 'PUT',
    body: { districts: ['Ajmer'], reason: `Tenancy suite ${run}: drop Jaipur to prove revocation takes effect at once` },
  });
  assert(demoted.status === 200, 'Revoking one of two districts is accepted', `got ${demoted.status}`);
  const afterRevoke = await call(`/parcels/${byDistrict.jaipur}`, { token: multiToken });
  assert(afterRevoke.status === 404, 'The revoked district is refused on the NEXT request, not after token expiry', `got ${afterRevoke.status}`);

  // -------------------------------------------------------------
  console.log('\n3. A STATE-WIDE READ-ONLY AUDITOR');
  // -------------------------------------------------------------
  const auditorEmail = `auditor.${run}@dharohar.test`;
  const auditorPassword = `Auditor-${run}-pw`;
  const auditorCreated = await call('/admin/officers', {
    token: admin, method: 'POST',
    body: {
      email: auditorEmail, displayName: `State Auditor ${run}`, role: 'AUDITOR',
      districts: ['Jaipur'], capabilities: ['STATE_WIDE_READ'], password: auditorPassword,
    },
  });
  assert(auditorCreated.status === 201, 'An auditor can be created with STATE_WIDE_READ', `got ${auditorCreated.status}`);
  const auditorToken = await login(auditorEmail, auditorPassword);

  const distant = byDistrict.jodhpur || byDistrict.udaipur;
  if (distant) {
    const wideRead = await call(`/parcels/${distant}`, { token: auditorToken });
    assert(wideRead.status === 200, 'STATE_WIDE_READ reaches a district the auditor was not assigned to', `got ${wideRead.status}`);
    const wideWrite = await call(`/parcels/${distant}/jurisdiction`, {
      token: auditorToken, method: 'POST',
      body: { toDistrict: 'Ajmer', reason: `Tenancy suite ${run}: an auditor must not be able to move records` },
    });
    assert(wideWrite.status >= 400,
      'STATE_WIDE_READ opens reads only — the re-homing mutation is refused', `got ${wideWrite.status} ${JSON.stringify(wideWrite.body?.error || {})}`);
  }

  // -------------------------------------------------------------
  console.log('\n4. ORGANIZATION SCOPING (the requirement RLS must satisfy)');
  // -------------------------------------------------------------
  // A second tenant, granted a district by the relationship table the architecture settled on.
  // Nothing here invents official ownership of any record: the grant is stamped with this run and
  // the copy is dropped afterwards.
  await db.query('begin');
  await db.query(
    `insert into organizations (id, name) values ($1, $2)
     on conflict (id) do update set name = excluded.name`,
    [OTHER_TENANT, `Tenancy Other Organization ${run}`]
  );
  const grantDistrict = byDistrict.jaipur ? 'jaipur' : have[0];
  await db.query(
    `insert into organization_districts (organization_id, district_id, relationship, granted_by, reason)
     select $1, d.id, 'administers', $2, $3
       from districts d where d.code = $4
      on conflict do nothing`,
    [OTHER_TENANT, `tenancy-suite@urbantechx.local`, `Tenancy suite ${run}: a second tenant over ${grantDistrict}`, grantDistrict]
  );
  await db.query('commit');

  // Premise first. A grant that was not written makes every assertion below vacuous — this suite has
  // been fooled by a phantom column before, so the plant itself is asserted.
  const grantCount = await db.query(
    `select count(*)::int n from organization_districts od
       join districts d on d.id = od.district_id
      where od.organization_id = $1 and d.code = $2 and od.revoked_at is null`, [OTHER_TENANT, grantDistrict]
  );
  assert(grantCount.rows[0].n === 1, `premise: the second tenant really holds a grant over ${grantDistrict}`);

  // The record under test must belong to the FIRST tenant. It did not: parcels were never labelled
  // with an organization by any migration (section 5 reports that as the blocker), so the copy is
  // given the label this suite is meant to run against. Without it the read below returns 404 for a
  // reason that has nothing to do with tenancy, and the assertion would be measuring nothing — which
  // is exactly what happened on the first run of this file.
  const labelled = await db.query(
    `update parcels set organization_id = $1 where id = $2 and organization_id is null`,
    [DEMO_TENANT, byDistrict[grantDistrict]]
  );
  assert(labelled.rowCount === 1, `premise: the ${grantDistrict} record under test now belongs to the demo tenant`);

  // An officer of the OTHER tenant who legitimately holds that district personally: jurisdiction
  // granted through the admin API, tenancy re-parented in the database. This is the strongest
  // possible position for the request, so a refusal can only come from organization scoping.
  const otherEmail = `other-tenant.${run}@dharohar.test`;
  const otherPassword = `Other-Tenant-${run}-pw`;
  const otherCreated = await call('/admin/officers', {
    token: admin, method: 'POST',
    body: {
      email: otherEmail, displayName: `Second Tenant Officer ${run}`, role: 'TEHSILDAR',
      districts: [grantDistrict.charAt(0).toUpperCase() + grantDistrict.slice(1)], password: otherPassword,
    },
  });
  assert(otherCreated.status === 201, 'premise: the second tenant\'s officer is granted the shared district', `got ${otherCreated.status}`);
  const reparent = await db.query(
    `update users set organization_id = $1 where lower(email) = $2`, [OTHER_TENANT, otherEmail.toLowerCase()]
  );
  assert(reparent.rowCount === 1, 'premise: that officer really belongs to the second tenant');

  const otherToken = await login(otherEmail, otherPassword);
  const sameDistrictRead = await call(`/parcels/${byDistrict[grantDistrict]}`, { token: otherToken });
  assert(sameDistrictRead.status === 404,
    'An officer of one organization cannot read another organization\'s record in a district both are granted',
    `got HTTP ${sameDistrictRead.status} — the request path never consults organizations, so this is the leak RLS must close`);

  const crossList = await call(`/parcels?district=${grantDistrict}`, { token: otherToken });
  const leaked = (crossList.body?.data?.parcels || []).some((p: any) => p.id === byDistrict[grantDistrict]);
  assert(crossList.status === 200 && !leaked,
    'The district listing does not return records from a different organization',
    leaked ? 'the record appears in the list' : `got ${crossList.status}`);

  const inertProbe = await db.query(
    `select count(*)::int n from organization_districts where organization_id = $1`, [OTHER_TENANT]
  );
  console.log(`  note  organization_districts rows for the second tenant: ${inertProbe.rows[0].n}; the request path reads none of them.`);

  // -------------------------------------------------------------
  console.log('\n5. THE DEMO TENANT IS LABELLED, NOT ASSUMED');
  // -------------------------------------------------------------
  const tenantRows = await db.query(`select id, name from organizations order by id`);
  assert(tenantRows.rowCount! >= 1, 'The demo tenant exists as a named row');
  const demo = tenantRows.rows.find((r: any) => r.id === DEMO_TENANT);
  assert(!!demo && /demo/i.test(String(demo.name)), `the demo tenant is named as a demo (${demo?.name ?? 'missing'})`, '');
  const unlabeledParcels = await db.query(
    `select count(*) filter (where organization_id is null)::int unlabelled, count(*)::int total from parcels`
  );
  assert(unlabeledParcels.rows[0].unlabelled === 0,
    'Every parcel carries an organization, so a tenant filter is possible at all',
    `${unlabeledParcels.rows[0].unlabelled} of ${unlabeledParcels.rows[0].total} parcel(s) have none — no migration has ever labelled them`);

  const unlabelledUsers = await db.query(`select count(*)::int n from users where organization_id is null`);
  assert(unlabelledUsers.rows[0].n === 0, 'Every officer carries an organization', `${unlabelledUsers.rows[0].n} officer(s) have none`);

  console.log(`\n  ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('  These failures are the enforcement the application does not have yet, not flakiness:');
    console.log('  (a) records are not labelled with an organization, so there is nothing to filter on;');
    console.log('  (b) the request path never consults organizations or organization_districts, so a');
    console.log('      tenant granted a district by the relationship table can still see the other tenant.');
    console.log('  Both are the work RLS is meant to do — see docs/DISTRICT-TENANCY-MODEL.md §7.');
  }

  // Reversed dependency order: users reference organizations, so the tenant row cannot go while an
  // officer still points at it. Getting this wrong threw the FK error out of the suite and swallowed
  // the summary line, which is how a red run ends up reporting nothing.
  try {
    await db.query(`update users set organization_id = $1 where organization_id = $2`, [DEMO_TENANT, OTHER_TENANT]);
    await db.query(`delete from organization_districts where organization_id = $1`, [OTHER_TENANT]);
    await db.query(`delete from organizations where id = $1`, [OTHER_TENANT]);
    await db.query(`update parcels set organization_id = null where organization_id = $1 and id = $2`, [DEMO_TENANT, byDistrict[grantDistrict]]);
  } catch (err: any) {
    console.log(`  note  cleanup on the copy did not complete: ${err.message} (the copy is dropped by the harness regardless)`);
  }

  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n[TENANCY] suite errored: ${err?.message || err}`);
  process.exit(1);
});
