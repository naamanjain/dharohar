/**
 * Tenancy and jurisdiction isolation suite — the requirement RLS has to satisfy, measured.
 *
 * docs/DISTRICT-TENANCY-MODEL.md settled the architecture. This file states what a deployed
 * multi-organization DHAROHAR must do, and then checks it against a running API and a running
 * PostgreSQL, as the actual application role:
 *
 *   * Record ownership (`organization_id` on the record) decides WHICH TENANT a record belongs to.
 *   * District jurisdiction (an officer's own `user_jurisdictions`, intersected with the tenant's
 *     `organization_districts` grants) decides WHERE inside that tenant an officer may work.
 *   * A district grant never implies ownership. Two tenants can both be granted Jaipur and must still
 *     be unable to read each other's records there — which is the case every "both have the district"
 *     test below is built around.
 *
 * Every refusal is also paired with a control that must SUCCEED, so a 404 coming from the wrong layer
 * cannot be read as proof of tenant isolation. That pairing is the point of the file: the first version
 * of this suite reported "cross-organization read refused" from a test whose officer had already lost
 * that district by revocation, and the assertion passed for entirely the wrong reason.
 *
 * Run it against a disposable copy — it plants a second and third organization and re-parents
 * officers, which is not something to do to the only copy of a register:
 *
 *   ./scripts/test-authorization-on-copy.sh        (does all of this, with the role credentials)
 *
 *   TEST_BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... DEMO_PASSWORD=... \
 *   TENANCY_DB_URL=postgres://postgres:...@host/copy TENANCY_APP_URL=postgres://dharohar_app:...@host/copy \
 *   npx tsx server/src/test_tenancy_isolation_suite.ts
 */

import { Client } from 'pg';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sysadmin@dharohar.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
const DB_URL = process.env.TENANCY_DB_URL || '';
const APP_URL = process.env.TENANCY_APP_URL || '';

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

type Res = { status: number; body: any };

async function call(path: string, opts: { method?: string; token?: string; body?: any } = {}): Promise<Res> {
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

const codeOf = (res: Res) => String(res.body?.error?.code ?? '');
const listIds = (res: Res): string[] => (res.body?.data?.parcels || []).map((p: any) => String(p.id));

/** Give a record an owner the way the schema demands: with the grantor and the reason. */
async function stampOwner(db: Client, table: 'parcels' | 'users', id: string, organization: string, by: string) {
  await db.query(
    `UPDATE ${table} SET organization_id = $2, organization_granted_by = $3,
                            organization_grant_reason = $4, organization_granted_at = now()
      WHERE id = $1`,
    [id, organization, by, `Tenancy suite: this record belongs to ${organization}.`]
  );
}

async function main() {
  const run = Date.now().toString().slice(-6);
  console.log('\n============================================================');
  console.log('  DHAROHAR TENANCY / JURISDICTION ISOLATION — run ' + run);
  console.log(`  target: ${BASE_URL}`);
  console.log('============================================================\n');

  if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !DB_URL || !APP_URL) {
    console.error('  ABORT: ADMIN_PASSWORD, DEMO_PASSWORD, TENANCY_DB_URL and TENANCY_APP_URL are all required.');
    console.error('  Use ./scripts/test-authorization-on-copy.sh, which supplies them against a copy.');
    process.exit(2);
  }

  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ---- fixtures -------------------------------------------------------------
  // The tenants have to exist before any record can be stamped as belonging to one: parcels
  // .organization_id is a foreign key, and the first run of this file failed on exactly that ordering
  // — it tried to hand a record to a tenant it had not created yet.
  // Only one new tenant: the `audits` / `reads` cases are exercised by changing the DEMO tenant's own
  // grant kind, which is what the requirement describes. A second empty tenant would be clutter.
  for (const [id, name] of [[OTHER_TENANT, `Second Tenant ${run}`]] as const) {
    await db.query(
      `insert into organizations (id, name) values ($1, $2)
       on conflict (id) do update set name = excluded.name`,
      [id, name]
    );
  }
  await db.query(
    `insert into organization_districts (organization_id, district_id, relationship, granted_by, reason)
     select $1, d.id, 'administers', $2, $3 from districts d where d.code = 'jaipur'
     on conflict do nothing`,
    [OTHER_TENANT, `tenancy-suite@urbantechx.local`, `Tenancy suite ${run}: a second tenant may administer Jaipur`]
  );

  // Two parcels in ONE district, owned by two different tenants. District is deliberately identical:
  // anything else would let a district rule do the work and credit it to tenancy.
  const jaipurParcels = await db.query(
    `select p.id, coalesce(p.organization_id,'NONE') as org
       from parcels p join districts d on d.code = p.district_code
      where d.code = 'jaipur' and d.kind = 'canonical' and p.is_archived = false
      order by p.id limit 4`
  );
  if (jaipurParcels.rowCount! < 2) {
    console.error('  ABORT: Jaipur needs at least two parcels to separate the two tenants. Nothing was asserted.');
    process.exit(2);
  }
  const demoParcel = jaipurParcels.rows[0].id as string;
  const otherParcel = jaipurParcels.rows[1].id as string;
  await stampOwner(db, 'parcels', demoParcel, DEMO_TENANT, 'tenancy-suite@urbantechx.local');
  await stampOwner(db, 'parcels', otherParcel, OTHER_TENANT, 'tenancy-suite@urbantechx.local');

  // Premise. If the two rows ended up in the same tenant, every assertion below would be measuring
  // something that does not exist.
  const owners = await db.query(
    `select id, organization_id from parcels where id = any($1::text[]) order by id`,
    [[demoParcel, otherParcel]]
  );
  const ownerOf = new Map(owners.rows.map((r: any) => [r.id, r.organization_id]));
  assert(ownerOf.get(demoParcel) === DEMO_TENANT && ownerOf.get(otherParcel) === OTHER_TENANT,
    `premise: two parcels in the SAME district owned by DIFFERENT tenants (${demoParcel}=${ownerOf.get(demoParcel)}, ${otherParcel}=${ownerOf.get(otherParcel)})`);

  const udParcels = await db.query(
    `select p.id from parcels p join districts d on d.code = p.district_code
      where d.code = 'udaipur' and d.kind = 'canonical' and p.is_archived = false order by p.id limit 1`
  );
  const udaipurParcel = udParcels.rowCount! > 0 ? udParcels.rows[0].id as string : null;

  // ---- 1. cross-tenant access in a shared district ---------------------------
  console.log('\n1. TWO TENANTS GRANTED THE SAME DISTRICT (the requirement RLS exists for)');

  const otherEmail = `tenant-b.${run}@dharohar.test`;
  const otherPassword = `Tenant-B-${run}-pw`;
  const createdB = await call('/admin/officers', {
    token: admin, method: 'POST',
    body: {
      email: otherEmail, displayName: `Second Tenant Officer ${run}`, role: 'TEHSILDAR',
      districts: ['Jaipur'], password: otherPassword,
    },
  });
  assert(createdB.status === 201, 'premise: the second tenant\'s officer is created and posted to Jaipur', `got ${createdB.status}`);
  await stampOwner(db, 'users', createdB.body.data.officer.id, OTHER_TENANT, 'tenancy-suite@urbantechx.local');

  const bToken = await login(otherEmail, otherPassword);
  const meAsB = await call('/auth/me', { token: bToken });
  assert(meAsB.body?.data?.user?.organizationId === OTHER_TENANT,
    'premise: that officer really belongs to the second tenant (per the server, not per this script)',
    JSON.stringify(meAsB.body?.data?.user?.organizationId));

  const bOwnParcel = await call(`/parcels/${otherParcel}`, { token: bToken });
  assert(bOwnParcel.status === 200,
    'control: the second tenant reads ITS OWN parcel in Jaipur',
    `got ${bOwnParcel.status} — if this fails, the refusal below proves nothing`);

  const bReadsDemo = await call(`/parcels/${demoParcel}`, { token: bToken });
  assert(bReadsDemo.status === 404,
    'the second tenant cannot read the first tenant\'s parcel in the same district',
    `got ${bReadsDemo.status} ${JSON.stringify(bReadsDemo.body?.error || {})}`);
  assert(bReadsDemo.status === 404 && codeOf(bReadsDemo) === 'PARCEL_NOT_FOUND',
    'the refusal is indistinguishable from absence (no enumeration of other tenants\' ids)', codeOf(bReadsDemo));

  const aReadsOther = await call(`/parcels/${otherParcel}`, { token: admin });
  assert(aReadsOther.status === 404,
    'and in the other direction: the first tenant\'s administrator cannot read the second tenant\'s parcel',
    `got ${aReadsOther.status}`);

  // ---- 2. lists, search, counts, nested resources and documents -------------
  console.log('\n2. INDIRECT PATHS (where a leak actually hides)');
  const bList = await call('/parcels', { token: bToken });
  const bIds = listIds(bList);
  assert(bList.status === 200 && bIds.includes(otherParcel) && !bIds.includes(demoParcel),
    'the district listing shows its own tenant\'s record and not the other\'s',
    `own=${bIds.includes(otherParcel)} foreign=${bIds.includes(demoParcel)} total=${bIds.length}`);

  const bTotal = Number(bList.body?.data?.total ?? -1);
  assert(bTotal === bIds.length, 'the reported total is the tenant\'s count, not the register\'s', `${bTotal} vs ${bIds.length}`);

  const demoParcelRow = await db.query('select khasra_no, village from parcels where id = $1', [demoParcel]);
  const searchTerm = String(demoParcelRow.rows[0].khasra_no || '').slice(0, 6);
  const bSearch = searchTerm
    ? await call(`/parcels?search=${encodeURIComponent(searchTerm)}`, { token: bToken })
    : { status: 200, body: { data: { parcels: [] } } };
  assert(!listIds(bSearch).includes(demoParcel),
    'a search for the other tenant\'s khasra number does not find it',
    `searched "${searchTerm}" -> ${listIds(bSearch).join(',')}`);

  const bNestedDocs = await call(`/parcels/${demoParcel}/documents`, { token: bToken });
  assert(bNestedDocs.status === 404, 'the other tenant\'s document list is not reachable through the nested route', `got ${bNestedDocs.status}`);

  const bNestedInspections = await call(`/parcels/${demoParcel}/field-inspections`, { token: bToken });
  assert(bNestedInspections.status === 404, 'the other tenant\'s field inspections are not reachable either', `got ${bNestedInspections.status}`);

  const bRehome = await call(`/parcels/${demoParcel}/jurisdiction`, {
    token: bToken, method: 'POST',
    body: { toDistrict: 'Ajmer', reason: `Tenancy suite ${run}: attempted move of another tenant's record` },
  });
  assert(bRehome.status >= 400, 'the other tenant cannot re-home a record it does not own', `got ${bRehome.status}`);

  const bAudit = await call(`/parcels/${demoParcel}/audit`, { token: bToken });
  assert(bAudit.status === 404, 'the other tenant cannot read the record\'s audit history', `got ${bAudit.status}`);

  const docId = `doc-tenant-b-${run}`;
  const bUpload = await call('/documents', {
    token: bToken, method: 'POST',
    body: { id: docId, fileName: `b-${run}.pdf`, recordType: 'Jamabandi', rawOcrText: `khasra ${run}`, parcelId: otherParcel },
  });
  assert(bUpload.status === 200 || bUpload.status === 201, 'the second tenant can file its own document', `got ${bUpload.status} ${JSON.stringify(bUpload.body?.error || {})}`);
  const aSeesBDoc = await call(`/documents/${docId}`, { token: admin });
  assert(aSeesBDoc.status === 404, 'the first tenant cannot read the second tenant\'s document by id', `got ${aSeesBDoc.status}`);
  const bDocList = await call('/documents', { token: bToken });
  const aDocList = await call('/documents', { token: admin });
  const bDocIds = (bDocList.body?.data?.documents || []).map((d: any) => d.id);
  const aDocIds = (aDocList.body?.data?.documents || []).map((d: any) => d.id);
  assert(bDocIds.includes(docId) && !aDocIds.includes(docId),
    'the document listing is per tenant in both directions',
    `b=${bDocIds.includes(docId)} a=${aDocIds.includes(docId)}`);

  const roster = await call('/admin/officers', { token: admin });
  const rosterIds = (roster.body?.data?.officers || []).map((o: any) => o.id);
  assert(roster.status === 200 && !rosterIds.includes(createdB.body.data.officer.id),
    'the first tenant\'s administrator cannot see the second tenant\'s officer in the roster',
    `present=${rosterIds.includes(createdB.body.data.officer.id)}`);

  const registry = await call('/admin/districts', { token: admin });
  const jaipurRow = (registry.body?.data?.districts || []).find((d: any) => d.code === 'jaipur');
  // Counted the way the registry counts: every parcel in the district, archived included, plus the
  // documents filed under it. The first version of this assertion filtered archived parcels out of the
  // expected side and then reported a mismatch of three — which was the comparison being wrong, not
  // the count. Verified separately below that the OTHER tenant's rows are excluded.
  const ownCounts = await db.query(
    `select (select count(*) from parcels where district_code='jaipur' and organization_id=$1)
          + (select count(*) from land_documents where district_code='jaipur' and organization_id=$1) as n`,
    [DEMO_TENANT]
  );
  const otherCounts = await db.query(
    `select (select count(*) from parcels where district_code='jaipur' and organization_id=$1)
          + (select count(*) from land_documents where district_code='jaipur' and organization_id=$1) as n`,
    [OTHER_TENANT]
  );
  // count(*) comes back as a string from the driver (it is a bigint), so both sides are coerced:
  // `46 === "46"` is false in JavaScript, and that is what this assertion was failing on once the
  // numbers themselves agreed.
  const ownRecords = Number(ownCounts.rows[0].n);
  const otherRecords = Number(otherCounts.rows[0].n);
  assert(!!jaipurRow && Number(jaipurRow.records) === ownRecords,
    'registry counts are exactly this tenant\'s records, not the register\'s',
    `reported=${jaipurRow?.records} own=${ownRecords} otherTenant=${otherRecords}`);
  // The premise that makes the equality above mean something: the second tenant really does hold rows
  // in this district. Without it, "the count equals my own records" could pass on an empty fixture and
  // read as proof of isolation.
  assert(otherRecords > 0,
    'premise: the second tenant holds records in Jaipur that the count must exclude',
    `other tenant holds ${otherRecords}`);

  // ---- 3. organization-level grants are enforced, by kind --------------------
  console.log('\n3. DISTRICT JURISDICTION: administer, audit, read, and revocation');
  const makeOfficer = async (label: string, districts: string[]) => {
    const email = `${label}.${run}@dharohar.test`;
    const password = `Officer-${label}-${run}-pw`;
    const r = await call('/admin/officers', {
      token: admin, method: 'POST',
      body: { email, displayName: `Suite ${label} ${run}`, role: 'TEHSILDAR', districts, password },
    });
    return { email, password, id: r.body?.data?.officer?.id, status: r.status };
  };

  // (a) posted to a district the tenant holds nothing over -> refused.
  const ungranted = await makeOfficer('ungranted', ['Udaipur']);
  assert(ungranted.status === 201, 'premise: an officer posted to Udaipur is created', `got ${ungranted.status}`);
  if (udaipurParcel) {
    await stampOwner(db, 'parcels', udaipurParcel, DEMO_TENANT, 'tenancy-suite@urbantechx.local');
    const t1 = await login(ungranted.email, ungranted.password);
    const held = await db.query(
      `select count(*)::int n from organization_districts od
         join districts d on d.id = od.district_id
        where od.organization_id = $1 and d.code = 'udaipur' and od.revoked_at is null`,
      [DEMO_TENANT]
    );
    if (held.rows[0].n === 0) {
      const denied = await call(`/parcels/${udaipurParcel}`, { token: t1 });
      assert(denied.status === 404,
        'a personal posting is not enough: the tenant must also hold the district',
        `got ${denied.status} with no organization grant in force`);
    } else {
      console.log('  note  the demo tenant already holds Udaipur, so this case is exercised by revocation below instead');
    }
  }

  // (b) revoke the tenant's grant over a district -> the tenant's officers lose it on the next request.
  const revoke = await db.query(
    `update organization_districts od set revoked_at = now()
       from districts d where od.district_id = d.id and od.organization_id = $1 and d.code = 'jaipur'
       and od.revoked_at is null returning od.district_id`,
    [OTHER_TENANT]
  );
  assert((revoke.rowCount ?? 0) === 1, 'premise: the second tenant\'s Jaipur grant is revoked');
  const bAfterRevoke = await call(`/parcels/${otherParcel}`, { token: bToken });
  assert(bAfterRevoke.status === 404,
    'revoking the ORGANIZATION\'s grant takes effect on the next request, not at token expiry',
    `got ${bAfterRevoke.status}`);
  await db.query(
    `update organization_districts od set revoked_at = null
       from districts d where od.district_id = d.id and od.organization_id = $1 and d.code = 'jaipur'`,
    [OTHER_TENANT]
  );
  const bRestored = await call(`/parcels/${otherParcel}`, { token: bToken });
  assert(bRestored.status === 200, 'control: restoring the grant gives the access back (the refusal above was the grant, not a coincidence)', `got ${bRestored.status}`);

  // (c) read-only relationship kinds open reads and never writes.
  const auditorOrgParcel = demoParcel; // the demo tenant's own record, reached by a demo auditor
  const auditor = await makeOfficer('audits-only', ['Jaipur']);
  assert(auditor.status === 201, 'premise: an audits-only officer is created', `got ${auditor.status}`);
  await db.query(
    `update organization_districts od set relationship = 'audits'
       from districts d where od.district_id = d.id and od.organization_id = $1 and d.code = 'jaipur'
       and od.relationship = 'administers'`,
    [DEMO_TENANT]
  );
  const auditorToken = await login(auditor.email, auditor.password);
  const auditorRead = await call(`/parcels/${auditorOrgParcel}`, { token: auditorToken });
  assert(auditorRead.status === 200, 'an `audits` grant opens the read', `got ${auditorRead.status}`);
  // `status` is a real workflow field on this endpoint, so a refusal here is a refusal of the write
  // and not a 400 about an unknown property. The officer's role is TEHSILDAR, so the read-only ROLE
  // rule is not what stops it — only the 'audits' grant is.
  const auditorWrite = await call(`/parcels/${auditorOrgParcel}`, {
    token: auditorToken, method: 'PATCH', body: { status: 'Verified' },
  });
  assert(auditorWrite.status >= 400, 'and `audits` never becomes a write', `got ${auditorWrite.status} ${codeOf(auditorWrite)}`);
  await db.query(
    `update organization_districts od set relationship = 'administers'
       from districts d where od.district_id = d.id and od.organization_id = $1 and d.code = 'jaipur'
       and od.relationship = 'audits'`,
    [DEMO_TENANT]
  );
  const tehsildarToken = await login('tehsildar@dharohar.local', DEMO_PASSWORD);
  const writeBack = await call(`/parcels/${demoParcel}`, { token: tehsildarToken, method: 'PATCH', body: { status: 'Needs Field Verification' } });
  assert(writeBack.status === 200, 'control: with `administers` restored the same write is accepted', `got ${writeBack.status} ${codeOf(writeBack)}`);

  // ---- 4. quarantine --------------------------------------------------------
  console.log('\n4. QUARANTINE: an unowned record is preserved and invisible');
  const quarantined = await db.query(
    `select p.id from parcels p join districts d on d.code = p.district_code
      where d.kind = 'retired' and p.organization_id is null limit 1`
  );
  if (quarantined.rowCount! > 0) {
    const qid = quarantined.rows[0].id as string;
    const asAdmin = await call(`/parcels/${qid}`, { token: admin });
    const asStateWide = await call(`/parcels/${qid}`, { token: tehsildarToken });
    assert(asAdmin.status === 404 && asStateWide.status === 404,
      `fixture record ${qid} (no owner) is invisible to every tenant, including a state-wide reader`,
      `admin=${asAdmin.status} tehsildar=${asStateWide.status}`);
    const stillThere = await db.query('select count(*)::int n from parcels where id = $1', [qid]);
    assert(stillThere.rows[0].n === 1, 'and it is still in the database — quarantine is not deletion');
  } else {
    assert(false, 'premise: at least one quarantined fixture record should exist on this copy', 'none found — the fixture case went untested');
  }

  const unowned = await db.query(`select count(*)::int n from parcels where organization_id is null`);
  console.log(`  note  records still unowned on this copy: ${unowned.rows[0].n} (disposition path: server/src/db/assignOwnership.ts)`);

  // ---- 5. identity and context cannot be forged -----------------------------
  console.log('\n5. DIRECT SQL THROUGH THE APPLICATION ROLE (the second layer, unaided)');
  const app = new Client({ connectionString: APP_URL });
  await app.connect();

  const roleAttrs = await app.query(
    `select current_user as who,
            (select rolsuper from pg_roles where rolname = current_user) as superuser,
            (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`
  );
  assert(roleAttrs.rows[0].who === 'dharohar_app' && roleAttrs.rows[0].superuser === false && roleAttrs.rows[0].bypassrls === false,
    'the application role is who we think it is, is not a superuser and cannot bypass row-level security',
    JSON.stringify(roleAttrs.rows[0]));

  const noContext = await app.query('select count(*)::int n from parcels');
  assert(noContext.rows[0].n === 0,
    'with NO tenant context the role reads zero rows — a request that forgets to bind its tenant fails closed',
    `got ${noContext.rows[0].n}`);

  let forgedOrgRows = -1;
  await app.query('BEGIN');
  await app.query(`select set_config('app.organization_id', $1, true)`, [DEMO_TENANT]);
  await app.query(`select set_config('app.user_id', $1, true)`, ['USR-OF-SOME-OTHER-TENANT']);
  const forged = await app.query('select count(*)::int n from parcels');
  forgedOrgRows = forged.rows[0].n;
  await app.query('ROLLBACK');
  assert(forgedOrgRows === 0,
    'an organization claimed without a matching user identity yields nothing (both halves must agree)',
    `got ${forgedOrgRows}`);

  const bUserId = createdB.body.data.officer.id;
  let honestRows = -1;
  await app.query('BEGIN');
  await app.query(`select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`, [OTHER_TENANT, bUserId]);
  const honest = await app.query('select id from parcels');
  honestRows = honest.rowCount ?? -1;
  const honestIds = (honest.rows || []).map((r: any) => r.id);
  await app.query('ROLLBACK');
  assert(honestRows > 0 && honestIds.includes(otherParcel) && !honestIds.includes(demoParcel),
    'the same role, honestly bound, sees its own tenant\'s rows and only those',
    `rows=${honestRows} own=${honestIds.includes(otherParcel)} foreign=${honestIds.includes(demoParcel)}`);

  let roleSwitch = '';
  try {
    await app.query('set role dharohar');
    const who = await app.query('select current_user as w');
    roleSwitch = who.rows[0].w;
    await app.query('reset role');
  } catch (err: any) {
    roleSwitch = 'refused: ' + String(err.message).slice(0, 60);
  }
  assert(!/^dharohar$/.test(roleSwitch),
    'the runtime role cannot change its database identity to the schema owner', roleSwitch);

  let ddl = '';
  try {
    await app.query('alter table parcels add column forged int');
    ddl = 'applied';
  } catch (err: any) {
    // PostgreSQL answers a non-owner's ALTER with "must be owner of table parcels", not with
    // "permission denied for table", so both wordings are the same refusal.
    ddl = /permission denied|must be owner/.test(String(err.message)) ? 'refused' : String(err.message).slice(0, 60);
  }
  assert(ddl === 'refused', 'and cannot alter the very table it is scoped to', ddl);

  // Documents are the other RLS-covered table; prove it independently rather than assume symmetry.
  const docNoContext = await app.query('select count(*)::int n from land_documents');
  assert(docNoContext.rows[0].n === 0, 'land_documents is under row-level security too', `got ${docNoContext.rows[0].n}`);

  await app.end();

  // ---- 6. unauthenticated and disabled --------------------------------------
  console.log('\n6. UNAUTHENTICATED, DISABLED AND MISSING-CONTEXT CALLERS');
  const anon = await call(`/parcels/${demoParcel}`);
  assert(anon.status === 401, 'no token, no record', `got ${anon.status}`);

  const orphan = await makeOfficer('orphan', ['Jaipur']);
  assert(orphan.status === 201, 'premise: an officer with no organization is created', `got ${orphan.status}`);
  await db.query(`update users set organization_id = null, organization_granted_by = null, organization_grant_reason = null where id = $1`, [orphan.id]);
  const orphanToken = await login(orphan.email, orphan.password);
  const orphanRead = await call('/parcels', { token: orphanToken });
  assert(orphanRead.status === 403 && codeOf(orphanRead) === 'TENANT_CONTEXT_MISSING',
    'an officer with no tenant is told so, rather than silently shown nothing',
    `got ${orphanRead.status} ${codeOf(orphanRead)}`);

  // A revoked assignment must not survive in the roster as a working account.
  const revokeB = await call(`/admin/officers/${bUserId}/jurisdictions`, {
    token: admin, method: 'PUT',
    body: { districts: ['Ajmer'], reason: `Tenancy suite ${run}: drop Jaipur from the second tenant's officer` },
  });
  assert(revokeB.status === 200, 'premise: the personal assignment is revoked');
  const bAfterPersonalRevoke = await call(`/parcels/${otherParcel}`, { token: bToken });
  assert(bAfterPersonalRevoke.status === 404,
    'a personal revocation removes access even while the tenant still holds the district',
    `got ${bAfterPersonalRevoke.status}`);

  // ---- teardown on the copy --------------------------------------------------
  try {
    await db.query(`update parcels set organization_id = null, organization_granted_by = null, organization_grant_reason = null where id = any($1::text[])`, [[demoParcel, otherParcel, udaipurParcel].filter(Boolean)]);
    await db.query(`update organization_districts od set relationship='administers' from districts d where od.district_id=d.id and od.organization_id=$1`, [DEMO_TENANT]);
    await db.query(`delete from organization_districts where organization_id = $1`, [OTHER_TENANT]);
    await db.query(`delete from organizations where id = $1`, [OTHER_TENANT]);
  } catch (err: any) {
    console.log(`  note  cleanup on the copy did not complete: ${err.message} (the copy is dropped by the harness regardless)`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('  Every failure above is a requirement the application does not yet meet. They are');
    console.log('  reported as failures on purpose: a tenancy gate that calls a leak "known" is how a');
    console.log('  leak becomes permanent. See docs/DISTRICT-TENANCY-MODEL.md §11.');
  }
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n[TENANCY] suite errored: ${err?.message || err}`);
  process.exit(1);
});
