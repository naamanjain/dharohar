/**
 * Provisioning, jurisdiction-assignment and re-districting suite.
 *
 * Proves the five design defaults in docs/DATA-MODEL-JURISDICTION.md §2 end to end over HTTP:
 *
 *   D2  jurisdiction comes from server-side assignment rows, so a grant or a revocation takes
 *       effect on the next request — not when the officer's token happens to expire.
 *   D3  STATE_WIDE_READ is a separate capability: it opens reads, never mutations, and its use is
 *       recorded in the audit chain.
 *   D4  officers are created, changed and revoked only by a USER_ADMIN holder; the first one comes
 *       from the offline bootstrap command, never from a registration form.
 *   D5  a parcel's district changes only through a controlled, reason-bearing, audited operation.
 *
 * Requires a running API against PostgreSQL with the demo dataset seeded and one bootstrapped
 * administrator:
 *
 *   BOOTSTRAP_ADMIN_EMAIL=... npm run db:bootstrap-admin        (once)
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... TEST_BASE_URL=http://127.0.0.1:8088/api npm run test:provisioning
 *
 * Every officer and parcel it creates is named with this run's id and archived afterwards, so the
 * demo dataset stays readable. It aborts non-zero if an administrator is missing rather than
 * skipping the checks that depend on one.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sysadmin@dharohar.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints. This suite will not guess one.');
  process.exit(2);
}

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
    throw new Error(`login failed for ${identifier}: HTTP ${r.status} ${JSON.stringify(r.body?.error || {})}`);
  }
  return r.body.data.token;
}

const codeOf = (res: Res) => String(res.body?.error?.code ?? '');
const parcelDistrict = (res: Res) => String(res.body?.data?.parcel?.district ?? '');

async function main() {
  const run = Date.now().toString().slice(-6);
  console.log('\n============================================================');
  console.log('  DHAROHAR PROVISIONING / ASSIGNMENT / RE-HOMING — run ' + run);
  console.log(`  target: ${BASE_URL}`);
  console.log('============================================================\n');

  if (!ADMIN_PASSWORD) {
    console.error('  ABORT: ADMIN_PASSWORD is not set. This suite provisions real accounts.');
    process.exit(1);
  }

  let admin: string;
  try {
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch (err: any) {
    console.error(`  ABORT: no administrator session (${err.message}).`);
    console.error('  Run `npm run db:bootstrap-admin` first — this suite cannot create the first one for itself.');
    process.exit(1);
  }

  const tehsildar = await login('tehsildar@dharohar.local', DEMO_PASSWORD);
  const patwari = await login('patwari@dharohar.local', DEMO_PASSWORD);
  const operator = await login('operator@dharohar.local', DEMO_PASSWORD);

  const homeList = await call('/parcels', { token: tehsildar });
  const homeId = (homeList.body?.data?.parcels || [])[0]?.id;
  const jodhpurList = await call('/parcels', { token: patwari });
  const foreignId = (jodhpurList.body?.data?.parcels || [])[0]?.id;
  if (!homeId || !foreignId) {
    console.error('  ABORT: need a Jaipur and a Jodhpur parcel. Seed the demo dataset first.');
    process.exit(1);
  }

  // -------------------------------------------------------------
  console.log('\n1. ONLY A USER_ADMIN HOLDER CAN PROVISION (D4)');
  // -------------------------------------------------------------
  const anonAdmin = await call('/admin/officers');
  assert(anonAdmin.status === 401, 'Unauthenticated /api/admin read -> 401', `got ${anonAdmin.status}`);

  const nonAdmin = await call('/admin/officers', { token: tehsildar });
  assert(nonAdmin.status === 403, 'A Tehsildar without the USER_ADMIN capability is refused', `got ${nonAdmin.status}`);
  assert(codeOf(nonAdmin) === 'USER_ADMIN_CAPABILITY_REQUIRED', 'Refusal names the missing capability', codeOf(nonAdmin));

  const roster = await call('/admin/officers', { token: admin });
  assert(roster.status === 200, 'The bootstrapped administrator can read the roster', `got ${roster.status}`);
  const officers: any[] = roster.body?.data?.officers || [];
  assert(officers.length >= 4, 'Roster includes the seeded officers', `count=${officers.length}`);
  const serialized = JSON.stringify(officers[0] || {});
  assert(
    !/passwordHash|password_hash|"salt"/.test(serialized),
    'Roster carries no password material',
    serialized.slice(0, 160)
  );

  // -------------------------------------------------------------
  console.log('\n2. MULTIPLE JURISDICTIONS BY EXPLICIT ASSIGNMENT (D2)');
  // -------------------------------------------------------------
  const multiEmail = `multi.${run}@dharohar.test`;
  const multiPassword = `Multi-jurisdiction-${run}-pw`;
  const created = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: {
      email: multiEmail,
      displayName: `Two District Officer ${run}`,
      role: 'TEHSILDAR',
      districts: ['Jaipur', 'Udaipur'],
      password: multiPassword,
    },
  });
  assert(created.status === 201, 'Officer created with two district assignments', `got ${created.status} ${JSON.stringify(created.body?.error || {})}`);
  const multiId = created.body?.data?.officer?.id;

  const multiToken = await login(multiEmail, multiPassword);
  assert(Boolean(multiToken), 'The provisioned officer can sign in');

  const multiList = await call('/parcels', { token: multiToken });
  const seenDistricts = new Set((multiList.body?.data?.parcels || []).map((p: any) => String(p.district).toLowerCase()));
  assert(
    seenDistricts.has('jaipur') && seenDistricts.has('udaipur'),
    'Both assigned districts appear in their registry list',
    [...seenDistricts].join(',')
  );
  assert(!seenDistricts.has('jodhpur'), 'An unassigned district does not appear', [...seenDistricts].join(','));

  const multiForeign = await call(`/parcels/${foreignId}`, { token: multiToken });
  assert(multiForeign.status === 404, 'Unassigned district parcel read by id -> 404', `got ${multiForeign.status}`);

  console.log('\n  -- provisioning refuses to create an officer who could not do anything --');
  const noDistrict = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: { email: `nodist.${run}@dharohar.test`, displayName: 'No District', role: 'DATA_ENTRY_OPERATOR', districts: [], password: `EnoughLength-${run}` },
  });
  assert(noDistrict.status === 400 && codeOf(noDistrict) === 'NO_JURISDICTION', 'Zero-district officer is refused, not silently created', `${noDistrict.status} ${codeOf(noDistrict)}`);

  const weak = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: { email: `weak.${run}@dharohar.test`, displayName: 'Weak', role: 'TEHSILDAR', districts: ['Jaipur'], password: 'short' },
  });
  assert(weak.status === 400 && codeOf(weak) === 'WEAK_PASSWORD', 'Short password is refused', `${weak.status} ${codeOf(weak)}`);

  const badCap = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: { email: `badcap.${run}@dharohar.test`, displayName: 'Bad Cap', role: 'TEHSILDAR', districts: ['Jaipur'], capabilities: ['BECOME_EVERYTHING'], password: `LongEnough-${run}-x` },
  });
  assert(badCap.status === 400 && codeOf(badCap) === 'UNKNOWN_CAPABILITY', 'Unknown capability is refused', `${badCap.status} ${codeOf(badCap)}`);

  const dupe = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: { email: multiEmail, displayName: 'Duplicate', role: 'TEHSILDAR', districts: ['Jaipur'], password: `LongEnough-${run}-y` },
  });
  assert(dupe.status === 409 && codeOf(dupe) === 'OFFICER_EXISTS', 'Duplicate email is refused (HTTP 409)', `${dupe.status} ${codeOf(dupe)}`);

  const tehsildarCreates = await call('/admin/officers', {
    token: tehsildar,
    method: 'POST',
    body: { email: `sneaky.${run}@dharohar.test`, displayName: 'Sneaky', role: 'TEHSILDAR', districts: ['Jaipur'], password: `LongEnough-${run}-z` },
  });
  assert(tehsildarCreates.status === 403, 'A role holder cannot self-promote into provisioning', `got ${tehsildarCreates.status}`);

  // -------------------------------------------------------------
  console.log('\n3. REVOCATION BITES ON THE NEXT REQUEST, NOT AT TOKEN EXPIRY (D2)');
  // -------------------------------------------------------------
  const beforeRevoke = await call(`/parcels/${homeId}`, { token: multiToken });
  assert(beforeRevoke.status === 200, 'Assignment present: home district parcel readable', `got ${beforeRevoke.status}`);

  const revoked = await call(`/admin/officers/${multiId}/jurisdictions`, {
    token: admin,
    method: 'PUT',
    body: { districts: [], reason: 'Posting withdrawn for the duration of this test run' },
  });
  assert(revoked.status === 200, 'Jurisdiction set replaced', `got ${revoked.status} ${JSON.stringify(revoked.body?.error || {})}`);
  assert(
    (revoked.body?.data?.before || []).length === 2 && (revoked.body?.data?.after || []).length === 0,
    'The change reports what was held before and what remains after',
    JSON.stringify(revoked.body?.data)
  );

  // Same token, no re-login: this is the property that a JWT-carried district could never give.
  const afterRevokeList = await call('/parcels', { token: multiToken });
  assert((afterRevokeList.body?.data?.parcels || []).length === 0, 'After revocation the same token sees zero parcels', JSON.stringify(afterRevokeList.body?.data?.total));
  const afterRevokeRead = await call(`/parcels/${homeId}`, { token: multiToken });
  assert(afterRevokeRead.status === 404, 'After revocation the same token gets 404 on its former district', `got ${afterRevokeRead.status}`);
  const afterRevokePatch = await call(`/parcels/${homeId}`, { token: multiToken, method: 'PATCH', body: { khasraNo: 'SHOULD-NOT-LAND' } });
  assert(afterRevokePatch.status === 404, 'After revocation no write is accepted either', `got ${afterRevokePatch.status}`);

  // -------------------------------------------------------------
  console.log('\n4. STATE-WIDE READ: READS ONLY, AND IT IS LOGGED (D3)');
  // -------------------------------------------------------------
  const wideEmail = `wide.${run}@dharohar.test`;
  const widePassword = `StateWideRead-${run}-pw`;
  const wideCreated = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: {
      email: wideEmail,
      displayName: `State Reader ${run}`,
      role: 'DATA_ENTRY_OPERATOR',
      districts: ['Jaipur'],
      capabilities: ['STATE_WIDE_READ'],
      password: widePassword,
    },
  });
  assert(wideCreated.status === 201, 'Officer created holding STATE_WIDE_READ but one district', `got ${wideCreated.status}`);
  const wideToken = await login(wideEmail, widePassword);

  const wideForeignRead = await call(`/parcels/${foreignId}`, { token: wideToken });
  assert(wideForeignRead.status === 200, 'STATE_WIDE_READ lets them READ another district', `got ${wideForeignRead.status}`);

  const wideForeignPatch = await call(`/parcels/${foreignId}`, { token: wideToken, method: 'PATCH', body: { khasraNo: 'WIDE-PATCH' } });
  assert(wideForeignPatch.status === 404, '…and never lets them MUTATE it (404, same as any outsider)', `got ${wideForeignPatch.status}`);

  const wideOwnPatch = await call(`/parcels/${homeId}`, { token: wideToken, method: 'PATCH', body: { inheritance: 'Read-only capability test' } });
  assert(wideOwnPatch.status === 200, 'Their assigned district still works normally', `got ${wideOwnPatch.status}`);

  const foreignNow = await call(`/parcels/${foreignId}`, { token: patwari });
  assert(foreignNow.body?.data?.parcel?.khasraNo !== 'WIDE-PATCH', 'The refused write really did not land', parcelDistrict(foreignNow));

  const wideAudit = await call('/verifications/audit-logs', { token: wideToken });
  const wideActions: string[] = (wideAudit.body?.data?.auditLogs || []).map((e: any) => e.actionType);
  assert(
    wideActions.includes('STATE_WIDE_READ'),
    'The state-wide reads were recorded in the audit chain',
    [...new Set(wideActions)].join(',')
  );

  // A state-wide DOCUMENT read is the same kind of access and must be logged the same way.
  const wideDocs = await call('/documents', { token: wideToken });
  const foreignDoc = (wideDocs.body?.data?.documents || []).find(
    (d: any) => String(d.district || '').trim().toLowerCase() !== 'jaipur'
  );
  if (foreignDoc) {
    const docRead = await call(`/documents/${foreignDoc.id}`, { token: wideToken });
    assert(docRead.status === 200, 'State-wide reader opened a document outside their district', `got ${docRead.status}`);
    const afterDoc = await call('/verifications/audit-logs', { token: wideToken });
    const logged = (afterDoc.body?.data?.auditLogs || []).some(
      (e: any) => e.actionType === 'STATE_WIDE_READ' && e.details?.surface === 'document-read'
    );
    assert(logged, 'That document read was written to the audit chain', foreignDoc.district);
  } else {
    assert(false, 'Fixture needs a document outside the wide reader\'s district to test document-read logging', JSON.stringify((wideDocs.body?.data?.documents || []).map((d: any) => d.district)));
  }

  const capabilityOff = await call(`/admin/officers/${wideCreated.body.data.officer.id}/capabilities`, {
    token: admin,
    method: 'PUT',
    body: { capabilities: [], reason: 'State-wide read withdrawn at the end of the check' },
  });
  assert(capabilityOff.status === 200, 'Capability withdrawn', `got ${capabilityOff.status}`);
  const afterWithdraw = await call(`/parcels/${foreignId}`, { token: wideToken });
  assert(afterWithdraw.status === 404, 'After withdrawal the same token is district-scoped again', `got ${afterWithdraw.status}`);

  // -------------------------------------------------------------
  console.log('\n5. PATCH CANNOT MOVE A RECORD BETWEEN DISTRICTS (D5)');
  // -------------------------------------------------------------
  const patchDistrict = await call(`/parcels/${homeId}`, { token: tehsildar, method: 'PATCH', body: { district: 'Fakepur' } });
  assert(patchDistrict.status === 400, 'PATCH with a district is refused outright', `got ${patchDistrict.status}`);
  assert(codeOf(patchDistrict) === 'JURISDICTION_CHANGE_REQUIRES_REHOMING', 'Refusal points at the re-homing operation', codeOf(patchDistrict));
  const stillHome = await call(`/parcels/${homeId}`, { token: tehsildar });
  assert(parcelDistrict(stillHome) === 'Jaipur', 'The record did not move', parcelDistrict(stillHome));

  // Re-home needs its own capability, even for a Tehsildar.
  const moverEmail = `mover.${run}@dharohar.test`;
  const moverPassword = `RehomeOfficer-${run}-pw`;
  const moverCreated = await call('/admin/officers', {
    token: admin,
    method: 'POST',
    body: {
      email: moverEmail,
      displayName: `Re Districting Officer ${run}`,
      role: 'TEHSILDAR',
      districts: ['Jaipur', 'Udaipur'],
      password: moverPassword,
    },
  });
  assert(moverCreated.status === 201, 'Re-homing officer created with both districts assigned', `got ${moverCreated.status}`);
  const moverToken = await login(moverEmail, moverPassword);
  const moverId = moverCreated.body?.data?.officer?.id;

  // A parcel this suite owns, so no demo record is ever moved.
  const testParcelId = `DH-JPR-TST-${run}`;
  const madeParcel = await call('/parcels', {
    token: moverToken,
    method: 'POST',
    body: {
      id: testParcelId,
      khasraNo: `9${run.slice(-2)}/1`,
      khataNo: '77',
      khewatNo: '12',
      patwarCircle: 'Sanganer South',
      district: 'Jaipur',
      tehsil: 'Sanganer',
      village: 'Rampur',
      mappedAreaHectares: 1.0,
      recordedAreaHectares: 1.0,
      ownerName: `Re-home Fixture ${run}`,
      boundary: [
        { lat: 26.95, lng: 75.85 }, { lat: 26.95, lng: 75.86 },
        { lat: 26.94, lng: 75.86 }, { lat: 26.94, lng: 75.85 },
      ],
    },
  });
  assert(madeParcel.status === 201, 'Fixture parcel created in Jaipur', `got ${madeParcel.status} ${JSON.stringify(madeParcel.body?.error || {})}`);

  const noCap = await call(`/parcels/${testParcelId}/jurisdiction`, {
    token: moverToken,
    method: 'POST',
    body: { toDistrict: 'Udaipur', reason: 'without the capability' },
  });
  assert(noCap.status === 403 && codeOf(noCap) === 'REHOME_CAPABILITY_REQUIRED', 'Assignments alone are not enough — PARCEL_REHOME is required', `${noCap.status} ${codeOf(noCap)}`);

  const singleDistrictMover = await login(moverEmail, moverPassword);
  await call(`/admin/officers/${moverId}/jurisdictions`, {
    token: admin,
    method: 'PUT',
    body: { districts: ['Jaipur'], reason: 'Trimmed to test the both-district rule' },
  });
  await call(`/admin/officers/${moverId}/capabilities`, {
    token: admin,
    method: 'PUT',
    body: { capabilities: ['PARCEL_REHOME'], reason: 'Re-homing authority granted for this test' },
  });
  const noDestination = await call(`/parcels/${testParcelId}/jurisdiction`, {
    token: singleDistrictMover,
    method: 'POST',
    body: { toDistrict: 'Udaipur', reason: 'destination not held' },
  });
  assert(
    codeOf(noDestination) === 'REHOME_REQUIRES_BOTH_JURISDICTIONS' && noDestination.status >= 400 && noDestination.status < 500,
    'Capability without assignment over the destination is refused',
    `${noDestination.status} ${codeOf(noDestination)}`
  );

  await call(`/admin/officers/${moverId}/jurisdictions`, {
    token: admin,
    method: 'PUT',
    body: { districts: ['Jaipur', 'Udaipur'], reason: 'Both districts restored for the re-homing check' },
  });

  const noReason = await call(`/parcels/${testParcelId}/jurisdiction`, {
    token: moverToken,
    method: 'POST',
    body: { toDistrict: 'Udaipur', reason: '   ' },
  });
  assert(noReason.status === 400 && codeOf(noReason) === 'REASON_REQUIRED', 'A re-homing order without a reason is refused', `${noReason.status} ${codeOf(noReason)}`);

  const sameDistrict = await call(`/parcels/${testParcelId}/jurisdiction`, {
    token: moverToken,
    method: 'POST',
    body: { toDistrict: 'Jaipur', reason: 'no move at all' },
  });
  assert(
    codeOf(sameDistrict) === 'NO_JURISDICTION_CHANGE' && sameDistrict.status >= 400 && sameDistrict.status < 500,
    'Re-homing to the current district is refused',
    `${sameDistrict.status} ${codeOf(sameDistrict)}`
  );

  const moved = await call(`/parcels/${testParcelId}/jurisdiction`, {
    token: moverToken,
    method: 'POST',
    body: { toDistrict: 'Udaipur', reason: `Boundary order ${run}: mauza transferred to Udaipur tehsil` },
  });
  assert(moved.status === 200, 'Authorized re-homing succeeds', `got ${moved.status} ${JSON.stringify(moved.body?.error || {})}`);

  const movedRead = await call(`/parcels/${testParcelId}`, { token: moverToken });
  assert(parcelDistrict(movedRead) === 'Udaipur', 'The parcel now sits in the destination district', parcelDistrict(movedRead));

  const opsOfficer = await login('operator@dharohar.local', DEMO_PASSWORD);
  const inUdaipurNow = await call(`/parcels/${testParcelId}`, { token: opsOfficer });
  assert(inUdaipurNow.status === 200, 'The destination district\'s own officer can now read it', `got ${inUdaipurNow.status}`);
  const jaipurOfficerLostIt = await call(`/parcels/${testParcelId}`, { token: tehsildar });
  assert(jaipurOfficerLostIt.status === 404, 'The source district\'s officer can no longer read it', `got ${jaipurOfficerLostIt.status}`);

  // `mutationHistory` is the field the API contract exposes (PARCEL_SELECT aggregates
  // parcel_mutations into it), so this proves the provenance row reached the officer, not just the
  // database.
  const provenance = movedRead.body?.data?.parcel?.mutationHistory || [];
  assert(
    (provenance as any[]).some((m: any) => /re-?district/i.test(String(m.type || ''))),
    'Mutation history carries the re-districting entry',
    JSON.stringify(provenance).slice(0, 220)
  );
  assert(
    (provenance as any[]).some((m: any) => String(m.note || '').includes('Boundary order')),
    'The stated reason is preserved in the provenance row',
    JSON.stringify(provenance).slice(0, 220)
  );

  const movedAudit = await call(`/parcels/${testParcelId}/audit`, { token: opsOfficer });
  const movedActions: string[] = (movedAudit.body?.data?.auditLogs || []).map((e: any) => e.actionType);
  assert(movedActions.includes('PARCEL_REDISTRICTED'), 'The move has its own chained audit entry', movedActions.join(','));

  const entry = (movedAudit.body?.data?.auditLogs || []).find((e: any) => e.actionType === 'PARCEL_REDISTRICTED');
  assert(
    entry?.details?.fromDistrict === 'Jaipur' && entry?.details?.toDistrict === 'Udaipur' && Boolean(entry?.details?.reason),
    'The audit entry records from, to and the stated reason',
    JSON.stringify(entry?.details)
  );

  const beforeThisRun = await call('/verifications/audit-logs', { token: admin });
  assert(
    (beforeThisRun.body?.data?.auditLogs || []).every((e: any) => e.entryHash),
    'Every audit entry still carries its chain hash'
  );

  // -------------------------------------------------------------
  console.log('\n6. DOCUMENT REGISTRY READS ARE DISTRICT-SCOPED TOO');
  // -------------------------------------------------------------
  const docList = await call('/documents', { token: tehsildar });
  assert(docList.status === 200, 'Document list responds for a district officer', `got ${docList.status}`);
  const docDistricts = new Set((docList.body?.data?.documents || []).map((d: any) => String(d.district || '').toLowerCase()));
  assert(
    [...docDistricts].every((d) => d === 'jaipur'),
    'Every listed document belongs to the caller\'s district',
    [...docDistricts].join(',') || '(none)'
  );
  const revokedList = await call('/documents', { token: multiToken });
  assert((revokedList.body?.data?.documents || []).length === 0, 'A revoked officer lists no documents at all', JSON.stringify(revokedList.body?.data?.total));

  // -------------------------------------------------------------
  console.log('\n7. PASSWORD RESET, AND CLEANUP');
  // -------------------------------------------------------------
  const reset = await call(`/admin/officers/${moverId}/password-reset`, {
    token: admin,
    method: 'POST',
    body: { password: `Rotated-${run}-pw2`, reason: 'Scheduled rotation check' },
  });
  assert(reset.status === 200, 'Password reset accepted with a reason', `got ${reset.status}`);
  const oldPasswordLogin = await call('/auth/login', { method: 'POST', body: { email: moverEmail, password: moverPassword } });
  assert(oldPasswordLogin.status === 401, 'The previous password no longer signs in', `got ${oldPasswordLogin.status}`);
  const newPasswordLogin = await call('/auth/login', { method: 'POST', body: { email: moverEmail, password: `Rotated-${run}-pw2` } });
  assert(newPasswordLogin.status === 200, 'The replacement password signs in', `got ${newPasswordLogin.status}`);
  const resetAudit = await call(`/verifications/audit-logs?entityId=${moverId}`, { token: admin });
  const resetEntries = (resetAudit.body?.data?.auditLogs || []).filter((e: any) => e.actionType === 'OFFICER_PASSWORD_RESET');
  assert(resetEntries.length > 0, 'The reset is on the audit chain');
  assert(!JSON.stringify(resetEntries).includes('Rotated-'), 'The new password never reaches the audit trail');

  // Archiving needs the Tehsildar role — and the parcel is in Udaipur now, which the re-homing
  // officer still holds, so this also confirms the destination officer owns the record afterwards.
  const cleanup = await call(`/parcels/${testParcelId}`, {
    token: moverToken,
    method: 'DELETE',
    body: { reason: `Test run ${run}: fixture archived after the re-homing check` },
  });
  assert(cleanup.status === 200, 'Fixture parcel archived', `got ${cleanup.status} ${JSON.stringify(cleanup.body?.error || {})}`);

  // -------------------------------------------------------------
  // 7b. RESTORE THE REVOKED OFFICER — a grant must take effect too
  // -------------------------------------------------------------
  // Deliberately late: sections 3 and 6 assert against the revoked state, so restoring the
  // assignment any earlier would have made those assertions pass for the wrong reason. This is the
  // mirror of the revocation test (a grant lands on the next request, not on the next login) and it
  // leaves no dead account behind — an officer with zero jurisdictions is something the integrity
  // checker is right to report, and a suite should not manufacture findings and then ignore them.
  console.log('\n7b. RE-GRANTING A JURISDICTION TAKES EFFECT IMMEDIATELY');
  const regranted = await call(`/admin/officers/${multiId}/jurisdictions`, {
    token: admin,
    method: 'PUT',
    body: { districts: ['Jaipur'], reason: `Test run ${run}: restoring the assignment after the revocation checks` },
  });
  assert(regranted.status === 200, 'Re-granting a jurisdiction is accepted', `got ${regranted.status} ${JSON.stringify(regranted.body?.error || {})}`);
  const afterRegrantList = await call('/parcels', { token: multiToken });
  assert(
    (afterRegrantList.body?.data?.parcels || []).length > 0,
    'The same token regains parcel access without signing in again',
    JSON.stringify(afterRegrantList.body?.data?.total)
  );
  const afterRegrantDocs = await call('/documents', { token: multiToken });
  assert(
    (afterRegrantDocs.body?.data?.documents || []).length > 0,
    'and its district\'s documents are listable again',
    JSON.stringify(afterRegrantDocs.body?.data?.total)
  );
  const afterRegrantRead = await call(`/parcels/${homeId}`, { token: multiToken });
  assert(afterRegrantRead.status === 200, 'Its former district reads normally again', `got ${afterRegrantRead.status}`);

  // -------------------------------------------------------------
  console.log('\n8. THE DISTRICT REGISTRY IS OPERABLE, AND REFUSES AMBIGUITY (0003)');
  // -------------------------------------------------------------
  // Migration 0003 made the registry authoritative: the database refuses a district it has never
  // heard of. That is only survivable if declaring one is an operation with a gate and an audit
  // entry, not a psql session somebody has to know the syntax for.
  const registryProbe = `Probe ${run}`;   // code: "probe <run>" — an internal space survives, on purpose
  const registryClash = `Probe${run}`;    // the same jurisdiction with the space removed
  const probeCode = registryProbe.toLowerCase();

  const list0 = await call('/admin/districts', { token: admin });
  const registryRows: any[] = list0.body?.data?.districts || [];
  assert(list0.status === 200 && registryRows.length > 0, 'A USER_ADMIN holder can read the registry', `got ${list0.status}`);
  assert(registryRows.every((d) => typeof d.code === 'string' && d.code.length > 0), 'Every registered district carries a stable code', JSON.stringify(registryRows.map((d) => d.code)));
  assert(registryRows.every((d) => typeof d.records === 'number'), 'Each district reports how many records depend on it');
  assert(
    registryRows.some((d) => d.code === 'jaipur' && d.records > 0),
    'Existing districts resolved to codes instead of staying free text',
    JSON.stringify(registryRows.find((d) => d.code === 'jaipur') || {})
  );

  const outsiderRead = await call('/admin/districts', { token: tehsildar });
  assert(outsiderRead.status === 403, 'An officer without USER_ADMIN cannot read or widen the registry', `got ${outsiderRead.status}`);

  // A name this run invented, so the check works on a database that earlier runs have already used.
  const undeclaredName = `Ghost${run}`;
  const unregisteredAssign = await call(`/admin/officers/${moverId}/jurisdictions`, {
    token: admin, method: 'PUT', body: { districts: [undeclaredName], reason: `Test run ${run}: assignment to an undeclared district` },
  });
  assert(
    unregisteredAssign.status === 400 && codeOf(unregisteredAssign) === 'DISTRICT_NOT_REGISTERED',
    'An officer cannot be assigned to a district nobody has declared',
    `got ${unregisteredAssign.status} ${codeOf(unregisteredAssign)}`
  );
  const inventedRow = await call('/admin/districts', { token: admin });
  assert(
    !(inventedRow.body?.data?.districts || []).some((d: any) => d.code === undeclaredName.toLowerCase()),
    'The refused assignment did NOT quietly register the district as a side effect',
    JSON.stringify((inventedRow.body?.data?.districts || []).map((d: any) => d.code))
  );

  const declared = await call('/admin/districts', { token: admin, method: 'POST', body: { name: registryProbe } });
  assert(
    declared.status === 201 && declared.body?.data?.district?.provenance === 'declared',
    'A new district can be declared over HTTP, marked declared rather than derived',
    `got ${declared.status} ${JSON.stringify(declared.body?.error || {})}`
  );

  const declaredTwice = await call('/admin/districts', { token: admin, method: 'POST', body: { name: registryProbe } });
  assert(
    declaredTwice.status === 200 && declaredTwice.body?.data?.district?.code === probeCode,
    'Declaring the same district twice changes nothing and says so, instead of duplicating it',
    `got ${declaredTwice.status}`
  );

  const clash = await call('/admin/districts', { token: admin, method: 'POST', body: { name: registryClash } });
  assert(
    clash.status === 400 && codeOf(clash) === 'DISTRICT_SPELLING_AMBIGUOUS',
    'A second spelling of one jurisdiction is refused, naming the row it clashes with',
    `got ${clash.status} ${codeOf(clash)} ${JSON.stringify(clash.body?.error?.details || {})}`
  );

  const nameless = await call('/admin/districts', { token: admin, method: 'POST', body: { name: '   ' } });
  assert(nameless.status === 400 && codeOf(nameless) === 'DISTRICT_NAME_REQUIRED', 'A district needs a real name', `got ${nameless.status}`);

  const wrongOrg = await call('/admin/districts', { token: admin, method: 'POST', body: { name: `Orphan ${run}`, organizationId: 'ORG-NOT-REAL' } });
  assert(
    wrongOrg.status === 404 && codeOf(wrongOrg) === 'ORGANIZATION_NOT_FOUND',
    'A district cannot be filed under a tenant that does not exist',
    `got ${wrongOrg.status} ${codeOf(wrongOrg)}`
  );

  const assignedNow = await call(`/admin/officers/${moverId}/jurisdictions`, {
    token: admin, method: 'PUT', body: { districts: [probeCode], reason: `Test run ${run}: assignment to the newly declared district` },
  });
  assert(
    assignedNow.status === 200 && JSON.stringify(assignedNow.body?.data || {}).includes(probeCode),
    'Once declared, that same district is assignable',
    `got ${assignedNow.status} ${JSON.stringify(assignedNow.body?.error || {})}`
  );

  const probeOfficer = await login(moverEmail, `Rotated-${run}-pw2`);
  const probeParcelId = `DH-PRB-${run}`;
  const filedInProbe = await call('/parcels', {
    token: probeOfficer,
    method: 'POST',
    body: {
      id: probeParcelId,
      khasraNo: `8${run.slice(-2)}/1`, khataNo: '77', khewatNo: '12', patwarCircle: 'Probe Circle',
      district: probeCode, tehsil: 'Probe Tehsil', village: 'Probe Village',
      mappedAreaHectares: 1.0, recordedAreaHectares: 1.0, ownerName: `Registry probe ${run}`,
      boundary: [
        { lat: 26.95, lng: 75.85 }, { lat: 26.95, lng: 75.86 },
        { lat: 26.94, lng: 75.86 }, { lat: 26.94, lng: 75.85 },
      ],
    },
  });
  assert(
    filedInProbe.status === 201 || filedInProbe.status === 200,
    'A land record can be filed under the newly declared district',
    `got ${filedInProbe.status} ${JSON.stringify(filedInProbe.body?.error || {})}`
  );

  const retiredNoReason = await call(`/admin/districts/${probeCode}/active`, { token: admin, method: 'PATCH', body: { isActive: false } });
  assert(retiredNoReason.status === 400 && codeOf(retiredNoReason) === 'REASON_REQUIRED', 'Retiring a district requires a written reason', `got ${retiredNoReason.status}`);

  const retired = await call(`/admin/districts/${probeCode}/active`, {
    token: admin, method: 'PATCH', body: { isActive: false, reason: `Test run ${run}: retirement check` },
  });
  assert(retired.status === 200 && retired.body?.data?.isActive === false, 'A district can be retired with a reason', `got ${retired.status}`);
  assert(
    (retired.body?.data?.records ?? 0) >= 1,
    'Retirement reports what still depends on the district rather than hiding it',
    JSON.stringify(retired.body?.data || {})
  );

  const stillReadable = await call(`/parcels/${probeParcelId}`, { token: probeOfficer });
  assert(
    stillReadable.status === 200,
    'Retiring a district does NOT lock its officers out of the records it already holds',
    `got ${stillReadable.status} ${JSON.stringify(stillReadable.body?.error || {})}`
  );

  const filedAfterRetirement = await call('/parcels', {
    token: probeOfficer,
    method: 'POST',
    body: {
      khasraNo: `8${run.slice(-2)}/2`, khataNo: '77', khewatNo: '12', patwarCircle: 'Probe Circle',
      district: probeCode, tehsil: 'Probe Tehsil', village: 'Probe Village',
      mappedAreaHectares: 1.0, recordedAreaHectares: 1.0, ownerName: `Retired probe ${run}`,
      boundary: [
        { lat: 26.95, lng: 75.85 }, { lat: 26.95, lng: 75.86 },
        { lat: 26.94, lng: 75.86 }, { lat: 26.94, lng: 75.85 },
      ],
    },
  });
  assert(
    filedAfterRetirement.status === 400 && codeOf(filedAfterRetirement) === 'DISTRICT_NOT_REGISTERED',
    'Nothing new can be filed under a retired district',
    `got ${filedAfterRetirement.status} ${codeOf(filedAfterRetirement)}`
  );

  const revived = await call(`/admin/districts/${probeCode}/active`, {
    token: admin, method: 'PATCH', body: { isActive: true, reason: `Test run ${run}: restoration check` },
  });
  assert(revived.status === 200 && revived.body?.data?.isActive === true, 'A retired district can be brought back', `got ${revived.status}`);

  const registryAudit = await call('/verifications/audit-logs', { token: admin });
  const declaredEntries: any[] = (registryAudit.body?.data?.auditLogs || []).filter((e: any) => e.actionType === 'DISTRICT_DECLARED');
  assert(declaredEntries.length > 0, 'Declaring a jurisdiction is on the hash-chained audit trail', `found ${declaredEntries.length}`);
  assert(declaredEntries.every((e: any) => e.entryHash), 'Those entries carry chain hashes like every other write');
  assert(
    declaredEntries.some((e: any) => JSON.stringify(e.details || {}).includes(probeCode) || JSON.stringify(e.details || {}).includes(registryProbe)),
    'The audit entry records which district was declared',
    JSON.stringify(declaredEntries.map((e: any) => e.entityId))
  );

  const archiveProbe = await call(`/parcels/${probeParcelId}`, {
    token: probeOfficer, method: 'DELETE', body: { reason: `Test run ${run}: registry probe fixture archived` },
  });
  assert(archiveProbe.status === 200, 'Probe parcel archived after the registry check', `got ${archiveProbe.status}`);

  const restore = await call(`/admin/officers/${moverId}/jurisdictions`, {
    token: admin, method: 'PUT', body: { districts: ['Jaipur'], reason: `Test run ${run}: restoring the fixture officer` },
  });
  assert(restore.status === 200, 'Fixture officer restored to a usable assignment', `got ${restore.status}`);
  console.log(`  [NOTE] declared district "${registryProbe}" (code ${probeCode}) stays in the registry, marked`);
  console.log('         declared and retired-ready: nothing here deletes a jurisdiction by design.');

  console.log('\n============================================================');
  console.log(`  PROVISIONING SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n  SUITE ERROR:', err.message);
  process.exit(1);
});
