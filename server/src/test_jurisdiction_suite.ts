/**
 * Jurisdiction isolation suite — negative tests.
 *
 * Proves an authenticated officer of one district cannot reach another district's records by
 * changing ids, query parameters, endpoints, document references or audit reads.
 *
 * Requires a running API against PostgreSQL (NODE_ENV=production recommended) with the demo
 * dataset seeded, so that parcels exist in more than one district:
 *
 *   DATABASE_URL=... TEST_BASE_URL=http://127.0.0.1:8088/api npm run test:jurisdiction
 *
 * It refuses to run (non-zero exit) if it cannot find parcels in two different districts, because
 * a vacuous pass here would be worse than no test at all.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001/api';

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
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
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
    throw new Error(`Login failed for ${identifier}: HTTP ${r.status} ${JSON.stringify(r.body?.error || {})}`);
  }
  return r.body.data.token;
}

async function main() {
  console.log('\n============================================================');
  console.log('  DHAROHAR JURISDICTION ISOLATION — NEGATIVE TESTS');
  console.log(`  target: ${BASE_URL}`);
  console.log('============================================================\n');

  const PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
  if (!PASSWORD) { console.error('DEMO_PASSWORD is not set; this suite cannot sign in as the demo personas without it.'); process.exit(2); }

  // tehsildar=Jaipur, patwari=Jodhpur, operator=Udaipur, auditor=Ajmer (district-scoped by default)
  const jaipur = await login('tehsildar@dharohar.local', PASSWORD);
  const jodhpur = await login('patwari@dharohar.local', PASSWORD);
  const udaipur = await login('operator@dharohar.local', PASSWORD);
  const auditor  = await login('auditor@dharohar.local', PASSWORD);
  assert(true, 'Three officers authenticated in three different districts');

  // ---- discover one parcel per district, from each district's OWN officer ----
  //
  // This used to lean on the auditor's state-wide view. Under design default D3 the AUDITOR role is
  // district-scoped and cross-district reading is a separately granted capability, so a suite that
  // assumed state-wide access would fail for a reason unrelated to what it is testing. Building the
  // fixture set from scoped lists also proves those lists are scoped.
  const districtOf: Array<[string, string]> = [
    ['jaipur', jaipur],
    ['jodhpur', jodhpur],
    ['udaipur', udaipur],
  ];

  const byDistrict = new Map<string, string[]>();
  for (const [label, token] of districtOf) {
    const res = await call('/parcels', { token });
    assert(res.status === 200, `${label} officer can list their own registry`, `HTTP ${res.status}`);
    for (const p of res.body?.data?.parcels || []) {
      const key = String(p.district || '').trim().toLowerCase();
      byDistrict.set(key, [...(byDistrict.get(key) || []), p.id]);
    }
  }

  console.log(`\n  districts present: ${[...byDistrict.keys()].join(', ') || '(none)'}`);
  [...byDistrict.entries()].forEach(([d, ids]) => console.log(`    ${d}: ${ids.join(', ')}`));

  if (byDistrict.size < 2) {
    console.error('\n  ABORT: need parcels in at least two districts to test isolation.');
    console.error('  Seeding did not run, or the dataset is single-district. This suite cannot pass vacuously.');
    await new Promise((r) => setTimeout(r, 10));
    process.exit(1);
  }

  const homeId = byDistrict.get('jaipur')?.[0];
  const foreignId = byDistrict.get('jodhpur')?.[0];
  if (!homeId || !foreignId) {
    console.error('\n  ABORT: could not locate both a Jaipur and a Jodhpur parcel.');
    process.exit(1);
  }
  console.log(`\n  home parcel (Jaipur)   = ${homeId}`);
  console.log(`  foreign parcel (Jodhpur) = ${foreignId}\n`);

  // Snapshot the foreign record BEFORE the attack attempts so the end of the suite can prove the
  // denials were real and not "404 after successfully writing anyway". Read with the officer who
  // legitimately holds that district.
  const foreignBefore = (await call(`/parcels/${foreignId}`, { token: jodhpur })).body?.data?.parcel;
  assert(Boolean(foreignBefore), 'Foreign parcel is readable by its own district officer (baseline exists)', JSON.stringify(foreignBefore?.id));

  // ---- 1. list scoping ----
  const ownList = await call('/parcels', { token: jaipur });
  const ownParcels: any[] = ownList.body?.data?.parcels || [];
  assert(ownParcels.length > 0, 'Jaipur officer sees their own parcels');
  assert(
    ownParcels.every((p) => String(p.district).toLowerCase() === 'jaipur'),
    'Jaipur list contains ONLY Jaipur rows',
    ownParcels.map((p) => p.district).join(',')
  );
  assert(
    !ownParcels.some((p) => p.id === foreignId),
    'Foreign parcel absent from Jaipur list'
  );

  // ---- 2. direct id access across every endpoint ----
  const endpoints: Array<[string, string, any?]> = [
    ['GET', `/parcels/${foreignId}`],
    ['PATCH', `/parcels/${foreignId}`, { khasraNo: 'HACKED' }],
    ['PUT', `/parcels/${foreignId}`, { khasraNo: 'HACKED' }],
    ['DELETE', `/parcels/${foreignId}`, { reason: 'cross-district attempt' }],
    ['POST', `/parcels/${foreignId}/validate`],
    ['GET', `/parcels/${foreignId}/documents`],
    ['POST', `/parcels/${foreignId}/documents`, { fileName: 'x.pdf', recordType: 'Jamabandi' }],
    ['GET', `/parcels/${foreignId}/field-inspections`],
    ['POST', `/parcels/${foreignId}/field-inspections`, { checkpoints: [] }],
    ['POST', `/parcels/${foreignId}/verify`, { officerNotes: 'cross-district seal attempt' }],
    ['GET', `/parcels/${foreignId}/audit`],
  ];

  for (const [method, path] of endpoints) {
    const r = await call(path, { method, token: jaipur });
    // 404, not 403: a 403 would confirm the id exists in another district.
    assert(r.status === 404, `${method} ${path} -> 404 for foreign district`, `got ${r.status}`);
  }

  // ---- 3. alternate endpoints that take the id in the body ----
  const bodySeal = await call('/verifications/seal', { method: 'POST', token: jaipur, body: { parcelId: foreignId } });
  assert(bodySeal.status === 404, 'POST /verifications/seal with foreign parcelId -> 404', `got ${bodySeal.status}`);

  const bodyInsp = await call('/verifications/field-inspection', {
    method: 'POST', token: jaipur, body: { parcelId: foreignId, checkpoints: [] },
  });
  assert(bodyInsp.status === 404, 'POST /verifications/field-inspection with foreign parcelId -> 404', `got ${bodyInsp.status}`);

  const bodyDocs = await call('/documents', {
    method: 'POST', token: jaipur, body: { parcelId: foreignId, fileName: 'attach.pdf', recordType: 'Jamabandi' },
  });
  assert(bodyDocs.status === 404, 'POST /documents attaching to a foreign parcel -> 404', `got ${bodyDocs.status}`);

  // ---- 4. query-parameter attempts to widen scope ----
  const q1 = await call('/parcels?district=Jodhpur', { token: jaipur });
  assert(
    (q1.body?.data?.parcels || []).length === 0,
    '?district=Jodhpur as Jaipur officer returns nothing',
    `${(q1.body?.data?.parcels || []).length} rows`
  );

  const q2 = await call(`/parcels?search=${encodeURIComponent(foreignId)}`, { token: jaipur });
  assert(
    !(q2.body?.data?.parcels || []).some((p: any) => p.id === foreignId),
    'Search by the foreign parcel id does not surface it',
    JSON.stringify((q2.body?.data?.parcels || []).map((p: any) => p.id))
  );

  const q3 = await call(`/verifications/audit-logs?parcelId=${foreignId}`, { token: jaipur });
  assert(q3.status === 404, 'Audit-log read for a foreign parcel -> 404', `got ${q3.status}`);

  // Seed a Jaipur-attributed audit entry with a legitimate write, so the scope assertion below is
  // never vacuous. On a freshly seeded database the audit chain holds no parcel-attributed rows at
  // all, and "no other district's parcels appear" is trivially true about an empty list.
  const baselineWrite = await call(`/parcels/${homeId}`, {
    token: jaipur,
    method: 'PATCH',
    body: { inheritance: 'Jurisdiction suite baseline write (legitimate, in-district)' },
  });
  assert(baselineWrite.status === 200, 'In-district baseline write accepted', `got ${baselineWrite.status}`);

  const q4 = await call('/verifications/audit-logs', { token: jaipur });
  const unscoped: any[] = q4.body?.data?.auditLogs || [];
  const jaipurIds = new Set(byDistrict.get('jaipur') || []);
  const foreignParcelIds = new Set([
    ...(byDistrict.get('jodhpur') || []),
    ...(byDistrict.get('udaipur') || []),
    ...(byDistrict.get('ajmer') || []),
  ]);

  // There is no state-wide reader in the default model (D3 makes one an explicit grant), so the
  // invariant is asserted directly instead of as a count comparison: every entry this officer pulls
  // from the unfiltered audit read belongs to a parcel in a district they hold. An empty result
  // would make that vacuously true, so the suite fails on empty data rather than passing it.
  assert(
    unscoped.length > 0,
    'Unfiltered audit read returned this district\'s own history (not running the scope test on empty data)',
    `jaipur entries=${unscoped.length}`
  );
  // Every entry this officer pulls from the unfiltered audit read must belong to a parcel they are
  // allowed to see, or to a parcel that no longer exists (fixtures are hard-deleted by the suites
  // that create them, and history survives the row). "Not in my live list" is therefore NOT evidence
  // of a leak — so each unexpected id is probed against the other districts' officers. If one of
  // THEM can read it, the row is theirs and this read leaked it: that is the failure this catches.
  const unexpectedIds = [...new Set(unscoped.filter((e) => e.parcelId && !jaipurIds.has(e.parcelId)).map((e) => String(e.parcelId)))].slice(0, 25);
  const leakedIds: string[] = [];
  for (const id of unexpectedIds) {
    for (const token of [jodhpur, udaipur]) {
      const probe = await call(`/parcels/${id}`, { token });
      if (probe.status === 200) {
        leakedIds.push(`${id} (readable by ${probe.body?.data?.parcel?.district})`);
        break;
      }
    }
  }
  assert(
    leakedIds.length === 0,
    'No audit entry in the unfiltered read belongs to another district\'s parcel',
    leakedIds.join(', ') || `${unexpectedIds.length} historical/destroyed id(s) checked against every other district`
  );
  assert(
    !unscoped.some((e) => e.parcelId && foreignParcelIds.has(e.parcelId)),
    'No audit entry references a parcel this run already identified as another district\'s',
    unscoped.filter((e) => e.parcelId && foreignParcelIds.has(e.parcelId)).map((e) => e.parcelId).join(',')
  );

  // ---- 5. write into another district ----
  const create = await call('/parcels', {
    method: 'POST',
    token: jaipur,
    body: {
      khasraNo: '999/1', khataNo: '999', district: 'Jodhpur', tehsil: 'Osian', village: 'Bhed',
      ownerName: 'Intruder', mappedAreaHectares: 1,
      boundary: [{ lat: 26.8, lng: 75.7 }, { lat: 26.9, lng: 75.8 }, { lat: 26.7, lng: 75.9 }],
    },
  });
  assert(create.status === 400, 'Creating a parcel in another district -> 400', `got ${create.status}`);

  // ---- 6. the reverse direction: Jodhpur officer must not see Jaipur's ----
  const revList = await call('/parcels', { token: jodhpur });
  const revParcels: any[] = revList.body?.data?.parcels || [];
  assert(
    revParcels.every((p) => String(p.district).toLowerCase() === 'jodhpur'),
    'Jodhpur officer sees only Jodhpur rows',
    revParcels.map((p) => p.district).join(',')
  );
  const revGet = await call(`/parcels/${homeId}`, { token: jodhpur });
  assert(revGet.status === 404, 'Jodhpur officer reading a Jaipur parcel -> 404', `got ${revGet.status}`);

  // ---- 7. legitimate access must still work (guards against over-blocking) ----
  const ownGet = await call(`/parcels/${homeId}`, { token: jaipur });
  assert(ownGet.status === 200, 'Home-district parcel read still allowed', `got ${ownGet.status}`);
  const ownDocs = await call(`/parcels/${homeId}/documents`, { token: jaipur });
  assert(ownDocs.status === 200, 'Home-district documents read still allowed', `got ${ownDocs.status}`);
  const ownAudit = await call(`/parcels/${homeId}/audit`, { token: jaipur });
  assert(ownAudit.status === 200, 'Home-district audit read still allowed', `got ${ownAudit.status}`);

  // ---- 8. auditor under D3: the role is district-scoped until STATE_WIDE_READ is granted ----
  const audForeign = await call(`/parcels/${foreignId}`, { token: auditor });
  const audChain = await call('/verifications/audit-logs/verify-chain', { token: auditor });

  if (audChain.status === 200) {
    // This deployment has granted the capability, so the state-wide path must actually work.
    console.log('    note: this auditor holds STATE_WIDE_READ — asserting the state-wide path works.');
    assert(audForeign.status === 200, 'Auditor WITH STATE_WIDE_READ can read another district', `got ${audForeign.status}`);
    const stateList = await call('/parcels', { token: auditor });
    const districts = new Set((stateList.body?.data?.parcels || []).map((p: any) => String(p.district).toLowerCase()));
    assert(districts.size > 1, 'State-wide list spans more than the auditor\'s own district', [...districts].join(','));
  } else {
    assert(
      String(audChain.body?.error?.code) === 'STATE_WIDE_READ_REQUIRED',
      'Chain report refused, naming the missing capability rather than the role',
      `got ${audChain.status} ${JSON.stringify(audChain.body?.error)}`
    );
    assert(
      audForeign.status === 404,
      'Auditor without STATE_WIDE_READ is denied another district (404, not 200)',
      `got ${audForeign.status}`
    );
    assert(
      audForeign.status !== 200,
      'No cross-district record body was returned to a district-scoped auditor'
    );
  }

  const audHomeForeign = await call(`/parcels/${homeId}`, { token: auditor });
  assert(
    audHomeForeign.status === (audChain.status === 200 ? 200 : 404),
    'Jaipur parcel read by the Ajmer auditor tracks exactly the capability state',
    `got ${audHomeForeign.status} while chain status was ${audChain.status}`
  );

  const audPatch = await call(`/parcels/${foreignId}`, { method: 'PATCH', token: auditor, body: { khasraNo: 'X' } });
  assert(audPatch.status === 403, 'Auditor write denied as read-only role', `got ${audPatch.status}`);
  const audSeal = await call(`/parcels/${foreignId}/verify`, { method: 'POST', token: auditor, body: {} });
  assert(audSeal.status === 403, 'Auditor seal attempt denied', `got ${audSeal.status}`);

  const districtChain = await call('/verifications/audit-logs/verify-chain', { token: jaipur });
  assert(districtChain.status === 403, 'State-wide chain report denied to a district officer', `got ${districtChain.status}`);

  // ---- 9. no record was actually mutated by the attempts above ----
  const after = await call(`/parcels/${foreignId}`, { token: jodhpur });
  const foreignNow = after.body?.data?.parcel;
  assert(foreignNow?.khasraNo !== 'HACKED', 'Foreign parcel was NOT renamed by the PATCH attempts', `khasraNo=${foreignNow?.khasraNo}`);
  assert(
    foreignNow?.khasraNo === foreignBefore?.khasraNo,
    'Foreign khasraNo byte-identical to the pre-attack snapshot',
    `before=${foreignBefore?.khasraNo} after=${foreignNow?.khasraNo}`
  );
  assert(
    foreignNow?.status === foreignBefore?.status,
    'Foreign parcel status unchanged (no silent seal)',
    `before=${foreignBefore?.status} after=${foreignNow?.status}`
  );
  assert(
    foreignNow?.verifiedAt === foreignBefore?.verifiedAt,
    'Foreign verifiedAt untouched (seal attempts did not land)',
    `before=${foreignBefore?.verifiedAt} after=${foreignNow?.verifiedAt}`
  );
  assert(
    foreignNow?.isArchived === foreignBefore?.isArchived,
    'Foreign parcel was NOT archived by the DELETE attempt',
    `before=${foreignBefore?.isArchived} after=${foreignNow?.isArchived}`
  );

  console.log(`\n============================================================`);
  console.log(`  JURISDICTION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`============================================================\n`);

  if (failed > 0) {
    console.error(`  ${failed} isolation check(s) failed. Cross-district access is NOT closed.`);
    process.exit(1);
  }
  console.log('  All cross-district access paths denied; legitimate access preserved.');
}

main().catch((err) => {
  console.error('\nJurisdiction suite errored:', err?.message || err);
  console.error('This is a FAIL, not a pass.');
  process.exit(1);
});
