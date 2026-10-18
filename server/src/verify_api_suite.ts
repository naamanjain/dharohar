/**
 * DHAROHAR Phase 5 Comprehensive REST API Suite
 *
 * Drives the full record lifecycle over HTTP — register, update, field inspect, officer seal,
 * audit read, soft-delete — and fails when any step does not produce the documented
 * { success, data, storageMode } envelope, the documented status code, or the documented row in
 * PostgreSQL. Assertions cover substance (RBAC refusals, seal persisted into the parcels row,
 * append-only audit growth), not just HTTP 200.
 *
 * DATABASE-DEPENDENT. Refuses to run in dev-fallback mode: an in-memory "pass" here would say
 * nothing about the revenue record.
 *
 * Run: npm run test:db        (or)  DATABASE_URL=... npx tsx server/src/verify_api_suite.ts
 * Port override: TEST_PORT (default 3003)
 */

import http from 'http';
import { pool, getDbHealth } from './db/db';
import { seedDatabase } from './db/seed';
import { app } from './index';

const PORT = Number(process.env.TEST_PORT) || 3003;
const BASE_URL = `http://localhost:${PORT}/api`;

const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints. This suite will not guess one.');
  process.exit(2);
}
const TEHSILDAR_EMAIL = 'tehsildar@dharohar.local';
const TEHSILDAR_NAME = 'Shri Arvind Sharma, RAS';
const TEHSILDAR_DESIGNATION = 'Revenue Officer / Tehsildar';
const PATWARI_EMAIL = 'patwari@dharohar.local';
const PATWARI_NAME = 'Smt. Sunita Choudhary';
const OPERATOR_EMAIL = 'operator@dharohar.local';
const AUDITOR_EMAIL = 'auditor@dharohar.local';

const FIXTURE_ID = 'DH-TEST-VERIF-009999';
// Run-scoped because parcels carry a unique (khasra_no, village, district, tehsil) identity: another
// suite's sealed fixture shares this village/tehsil/district, and a fixed khasra made the two collide
// on the second run against the same database.
const FIXTURE_KHASRA = `999/${Date.now() % 1000000}`;

let server: http.Server;
let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
    failedCount++;
  }
}

const jsonHeaders = (token?: string) =>
  token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };

async function call(path: string, init?: { method?: string; token?: string; body?: any }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method || 'GET',
    headers: jsonHeaders(init?.token),
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) };
}

async function runApiSuite() {
  console.log('----------------------------------------------------------------');
  console.log('  DHAROHAR Phase 5 Comprehensive REST API Suite (live DB)       ');
  console.log('----------------------------------------------------------------\n');

  await seedDatabase();

  // 0. THE SUBJECT OF THIS SUITE IS THE DATABASE.
  console.log('0. STORAGE MODE GATE');
  const health = getDbHealth();
  assert(
    health.storageMode === 'postgres-postgis',
    'Suite is connected to live PostgreSQL + PostGIS',
    `storageMode=${health.storageMode} error=${health.error || 'n/a'}. Export DATABASE_URL for a migrated dharohar_db and re-run.`
  );
  if (health.storageMode !== 'postgres-postgis') {
    throw new Error(`Refusing to run API assertions in ${health.storageMode} mode.`);
  }

  server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(PORT, () => resolve(s));
    s.on('error', reject);
  });
  console.log(`\n[TEST] Server listening on ${BASE_URL}\n`);

  // 1. HEALTH
  console.log('1. HEALTH CHECK (GET /api/health)');
  const resHealth = await call('/health');
  assert(resHealth.status === 200, 'GET /api/health returns HTTP 200', `got ${resHealth.status}`);
  assert(resHealth.body.storageMode === 'postgres-postgis', 'Health reports postgres-postgis storage mode', `got ${resHealth.body.storageMode}`);

  // 2. AUTHENTICATION
  console.log('\n2. AUTHENTICATION (POST /api/auth/login)');
  const resAnon = await call('/parcels');
  assert(resAnon.status === 401, 'Unauthenticated GET /api/parcels is refused (HTTP 401)', `got ${resAnon.status}`);

  const resAnonAudit = await call('/verifications/audit-logs');
  assert(resAnonAudit.status === 401, 'Unauthenticated audit-log read is refused (HTTP 401)', `got ${resAnonAudit.status}`);

  const resNoCreds = await call('/auth/login', { method: 'POST', body: { email: TEHSILDAR_EMAIL } });
  assert(resNoCreds.status === 400, 'Login without a password returns HTTP 400', `got ${resNoCreds.status}`);

  const resTeh = await call('/auth/login', { method: 'POST', body: { email: TEHSILDAR_EMAIL, password: DEMO_PASSWORD } });
  const tehsildarToken: string | undefined = resTeh.body.data?.token;
  assert(resTeh.status === 200 && resTeh.body.success === true, 'Tehsildar login returns HTTP 200 success=true', `got ${resTeh.status} ${JSON.stringify(resTeh.body.error || {})}`);
  assert(Boolean(tehsildarToken), 'Tehsildar login returns data.token');
  assert(resTeh.body.data?.user?.role === 'TEHSILDAR', 'Tehsildar profile carries role TEHSILDAR', `got ${resTeh.body.data?.user?.role}`);

  const resPat = await call('/auth/login', { method: 'POST', body: { email: PATWARI_EMAIL, password: DEMO_PASSWORD } });
  const patwariToken: string | undefined = resPat.body.data?.token;
  assert(resPat.status === 200 && resPat.body.data?.user?.role === 'PATWARI', 'Patwari login returns role PATWARI', `got ${resPat.status}`);

  const resOpr = await call('/auth/login', { method: 'POST', body: { email: OPERATOR_EMAIL, password: DEMO_PASSWORD } });
  const operatorToken: string | undefined = resOpr.body.data?.token;
  assert(resOpr.status === 200 && resOpr.body.data?.user?.role === 'DATA_ENTRY_OPERATOR', 'Operator login returns role DATA_ENTRY_OPERATOR', `got ${resOpr.status}`);

  const resAud = await call('/auth/login', { method: 'POST', body: { email: AUDITOR_EMAIL, password: DEMO_PASSWORD } });
  const auditorToken: string | undefined = resAud.body.data?.token;
  assert(resAud.status === 200 && resAud.body.data?.user?.role === 'AUDITOR', 'Auditor login returns role AUDITOR', `got ${resAud.status}`);

  // 3. PARCEL LIST ENVELOPE
  console.log('\n3. LIST PARCELS (GET /api/parcels)');
  const resParcels = await call('/parcels', { token: tehsildarToken });
  assert(resParcels.status === 200 && resParcels.body.success === true, 'Authorised GET /api/parcels returns HTTP 200', `got ${resParcels.status}`);
  assert(Array.isArray(resParcels.body.data?.parcels) && resParcels.body.data.parcels.length > 0, 'Seeded parcels are returned under data.parcels');
  assert(resParcels.body.parcels === undefined, 'No legacy top-level parcels field remains', `keys=${Object.keys(resParcels.body).join(',')}`);
  assert(resParcels.body.data?.total === resParcels.body.data?.parcels?.length, `data.total equals data.parcels length (${resParcels.body.data?.total})`);
  assert(resParcels.body.storageMode === 'postgres-postgis', 'Response echoes storageMode postgres-postgis', `got ${resParcels.body.storageMode}`);

  // 4. CREATE
  console.log('\n4. CREATE PARCEL (POST /api/parcels)');
  await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);

  const newParcelPayload = {
    id: FIXTURE_ID,
    khasraNo: FIXTURE_KHASRA,
    khataNo: '100',
    khewatNo: '44',
    patwarCircle: 'Rampur South',
    district: 'Jaipur',
    tehsil: 'Sanganer',
    village: 'Rampur',
    mappedAreaHectares: 1.5,
    recordedAreaHectares: 1.5,
    owners: [
      {
        id: 'own-test-verif',
        name: 'Kailash Meena',
        hindiName: 'कैलाश मीणा',
        relationType: 's/o',
        relativeName: 'Ram Lal Meena',
        relativeHindiName: 'राम लाल मीणा',
        shareFraction: '1/1',
        sharePercentage: 100,
        status: 'Active Co-sharer',
      },
    ],
    boundary: [
      { lat: 26.85, lng: 75.79 },
      { lat: 26.855, lng: 75.795 },
      { lat: 26.85, lng: 75.8 },
      { lat: 26.845, lng: 75.795 },
    ],
    landType: 'Chahi (Well Irrigated)',
    status: 'Draft',
  };

  const resCreate = await call('/parcels', { method: 'POST', token: tehsildarToken, body: newParcelPayload });
  assert(resCreate.status === 201 && resCreate.body.success === true, 'Create returns HTTP 201', `got ${resCreate.status} ${JSON.stringify(resCreate.body.error || {})}`);
  assert(resCreate.body.data?.parcel?.id === FIXTURE_ID, 'Created parcel id is nested under data.parcel', `got ${resCreate.body.data?.parcel?.id}`);
  assert(typeof resCreate.body.message === 'string', 'Create returns a human-readable message', `got ${resCreate.body.message}`);

  const dbCreated = await pool.query(
    `SELECT status, district, (SELECT COALESCE(SUM(share_percentage),0) FROM parcel_owners o WHERE o.parcel_id = p.id) AS share_sum,
       ST_IsValid(geom) AS valid
     FROM parcels p WHERE id = $1`,
    [FIXTURE_ID]
  );
  assert(dbCreated.rowCount === 1, 'Created parcel is a PostgreSQL row', `rowCount=${dbCreated.rowCount}`);
  assert(Number(dbCreated.rows[0]?.share_sum) === 100, 'Co-sharer share persisted at 100%', `share_sum=${dbCreated.rows[0]?.share_sum}`);
  assert(dbCreated.rows[0]?.valid === true, 'Created polygon is valid in PostGIS');

  const resAnonCreate = await call('/parcels', { method: 'POST', body: newParcelPayload });
  assert(resAnonCreate.status === 401, 'Anonymous parcel creation is refused (HTTP 401)', `got ${resAnonCreate.status}`);

  // 5. UPDATE
  console.log('\n5. UPDATE PARCEL (PUT /api/parcels/:id)');
  const resPatchSeal = await call(`/parcels/${FIXTURE_ID}`, {
    method: 'PUT',
    token: tehsildarToken,
    body: { certificateNumber: 'HAND-ROLLED-CERT', verifiedAt: new Date().toISOString() },
  });
  assert(resPatchSeal.status === 400 && resPatchSeal.body.error?.code === 'SEALED_FIELDS_NOT_PATCHABLE', 'Patching seal fields is refused (HTTP 400)', `got ${resPatchSeal.status} ${resPatchSeal.body.error?.code}`);

  const resUpdate = await call(`/parcels/${FIXTURE_ID}`, {
    method: 'PUT',
    token: tehsildarToken,
    body: { landType: 'Nahri (Canal Irrigated)', khasraNo: FIXTURE_KHASRA },
  });
  assert(resUpdate.status === 200 && resUpdate.body.success === true, 'Update returns HTTP 200', `got ${resUpdate.status} ${JSON.stringify(resUpdate.body.error || {})}`);
  assert(resUpdate.body.data?.parcel?.landType === 'Nahri (Canal Irrigated)', 'Updated parcel returned under data.parcel', `got ${resUpdate.body.data?.parcel?.landType}`);
  const dbUpdate = await pool.query('SELECT land_type FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbUpdate.rows[0]?.land_type === 'Nahri (Canal Irrigated)', 'land_type change committed to PostgreSQL', `got ${dbUpdate.rows[0]?.land_type}`);

  const resEmptyPatch = await call(`/parcels/${FIXTURE_ID}`, { method: 'PUT', token: tehsildarToken, body: { nonsenseField: 1 } });
  assert(resEmptyPatch.status === 400 && resEmptyPatch.body.error?.code === 'EMPTY_PATCH', 'Patch with no recognised fields is refused (HTTP 400)', `got ${resEmptyPatch.status}`);

  // 6. FIELD INSPECTION
  console.log('\n6. FIELD INSPECTION (POST /api/verifications/field-inspection)');
  const inspectionBody = {
    parcelId: FIXTURE_ID,
    inspectedBy: 'Rajesh Sharma (Kanungo)',
    inspectorRole: 'Field Kanungo',
    gpsCoords: { latitude: 26.8501, longitude: 75.7902, accuracy: 3.8 },
    deviceHeadingDeg: 180,
    checkpoints: [
      { id: 'c-1', label: 'Boundary stones in place', status: 'passed' },
      { id: 'c-2', label: 'Possession verified', status: 'passed' },
    ],
    discrepancyObserved: false,
    observedLandUse: 'Nahri (Canal Irrigated)',
    photoUri: 'data:image/jpeg;base64,mockFieldPhotoData',
  };

  const resInspDenied = await call('/verifications/field-inspection', { method: 'POST', token: operatorToken, body: inspectionBody });
  assert(resInspDenied.status === 403, 'Operator cannot submit a field inspection (HTTP 403)', `got ${resInspDenied.status}`);

  // The fixture parcel is in Jaipur, so a Jaipur officer files the inspection. A Patwari (Jodhpur)
  // filing against it is refused for jurisdiction — proved by test:jurisdiction and
  // scripts/validate-stack.sh rather than by making this persistence check depend on district.
  const resInsp = await call('/verifications/field-inspection', { method: 'POST', token: tehsildarToken, body: inspectionBody });
  assert(resInsp.status === 201 && resInsp.body.success === true, 'Permitted officer field inspection returns HTTP 201', `got ${resInsp.status} ${JSON.stringify(resInsp.body.error || {})}`);
  assert(Boolean(resInsp.body.data?.inspection?.id), 'Inspection is returned under data.inspection', `got ${resInsp.body.data?.inspection?.id}`);
  assert(resInsp.body.data?.inspection?.inspectedBy === TEHSILDAR_NAME, 'Inspection officer identity comes from the JWT, not the payload', `got ${resInsp.body.data?.inspection?.inspectedBy}`);
  assert(/^[0-9a-f]{64}$/.test(String(resInsp.body.data?.inspection?.evidenceHash || '')), 'Inspection carries a SHA-256 evidence hash');
  const dbInsp = await pool.query('SELECT count(*)::int AS n FROM field_inspections WHERE parcel_id = $1', [FIXTURE_ID]);
  assert(dbInsp.rows[0]?.n === 1, 'Inspection row persisted in field_inspections', `count=${dbInsp.rows[0]?.n}`);

  // 7. SEAL
  console.log('\n7. OFFICER SEAL (POST /api/verifications/seal) + PostgreSQL TRUTH');
  const sealPayload = {
    parcelId: FIXTURE_ID,
    officerName: 'Someone The Client Named',
    officerBadge: 'RJ-REV-84920',
    officerNotes: 'Inspected and verified against Master Cadastre.',
  };

  const resSealAnon = await call('/verifications/seal', { method: 'POST', body: sealPayload });
  assert(resSealAnon.status === 401, 'Anonymous sealing is refused (HTTP 401)', `got ${resSealAnon.status}`);

  const resSealOperator = await call('/verifications/seal', { method: 'POST', token: operatorToken, body: sealPayload });
  assert(resSealOperator.status === 403, 'Data Entry Operator cannot seal (HTTP 403)', `got ${resSealOperator.status}`);

  const resSealPatwari = await call('/verifications/seal', { method: 'POST', token: patwariToken, body: sealPayload });
  assert(resSealPatwari.status === 403, 'Patwari cannot seal; TEHSILDAR only (HTTP 403)', `got ${resSealPatwari.status}`);

  const sealAuditBefore = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'RECORD_SEALED'",
    [FIXTURE_ID]
  );

  const resSeal = await call('/verifications/seal', { method: 'POST', token: tehsildarToken, body: sealPayload });
  assert(resSeal.status === 200 && resSeal.body.success === true, 'Tehsildar seal returns HTTP 200', `got ${resSeal.status} ${JSON.stringify(resSeal.body.error || {})}`);
  const certificateNumber: string | undefined = resSeal.body.data?.certificateNumber;
  const signatureHash: string | undefined = resSeal.body.data?.signatureHash;
  assert(Boolean(certificateNumber), 'certificateNumber is nested under data (no top-level field)', `got ${certificateNumber}`);
  assert(resSeal.body.certificateNumber === undefined, 'No legacy top-level certificateNumber remains', `keys=${Object.keys(resSeal.body).join(',')}`);
  assert(Boolean(signatureHash), 'signatureHash is returned under data', `got ${signatureHash}`);
  assert(resSeal.body.data?.verifiedBy === `${TEHSILDAR_NAME} (${TEHSILDAR_DESIGNATION})`, 'Seal names the authenticated officer and designation', `got ${resSeal.body.data?.verifiedBy}`);

  // Core guarantee: sealing writes the PostgreSQL row, not only server memory.
  const dbSeal = await pool.query(
    'SELECT status, verified_by, verified_at, certificate_number, seal_signature FROM parcels WHERE id = $1',
    [FIXTURE_ID]
  );
  const row = dbSeal.rows[0] || {};
  console.log(`   - Sealed row in PostgreSQL: ${JSON.stringify({ status: row.status, verified_by: row.verified_by, certificate_number: row.certificate_number })}`);
  assert(row.status === 'Verified', "PostgreSQL status is 'Verified' after the seal", `got ${row.status}`);
  assert(Boolean(row.verified_by), 'PostgreSQL verified_by is populated by the seal', `got ${row.verified_by}`);
  assert(row.verified_at != null, 'PostgreSQL verified_at is populated by the seal', `got ${row.verified_at}`);
  assert(row.certificate_number === certificateNumber, 'PostgreSQL certificate_number equals the issued certificate', `got ${row.certificate_number}`);
  assert(row.seal_signature === signatureHash, 'PostgreSQL seal_signature equals the returned signature', `got ${row.seal_signature}`);

  const dbSealAudit = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'RECORD_SEALED'",
    [FIXTURE_ID]
  );
  const sealAuditDelta = (dbSealAudit.rows[0]?.n ?? 0) - (sealAuditBefore.rows[0]?.n ?? 0);
  assert(sealAuditDelta === 1, 'Seal appended exactly one durable RECORD_SEALED audit entry', `delta=${sealAuditDelta}`);

  const resReseal = await call('/verifications/seal', { method: 'POST', token: tehsildarToken, body: sealPayload });
  assert(resReseal.status === 409 && resReseal.body.error?.code === 'ALREADY_SEALED', 'Sealing an already-sealed parcel is refused (HTTP 409 ALREADY_SEALED)', `got ${resReseal.status} ${resReseal.body.error?.code}`);
  const dbAfterReseal = await pool.query('SELECT certificate_number, verified_at FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbAfterReseal.rows[0]?.certificate_number === certificateNumber, 'Refused re-seal left the stored certificate untouched', `got ${dbAfterReseal.rows[0]?.certificate_number}`);

  // 8. AUDIT LOGS
  console.log('\n8. APPEND-ONLY AUDIT LOGS (GET /api/verifications/audit-logs)');
  const resAudit = await call(`/verifications/audit-logs?parcelId=${FIXTURE_ID}`, { token: tehsildarToken });
  assert(resAudit.status === 200 && resAudit.body.success === true, 'Audit read returns HTTP 200', `got ${resAudit.status}`);
  assert(Array.isArray(resAudit.body.data?.auditLogs), 'Audit logs nested under data.auditLogs');
  assert(resAudit.body.auditLogs === undefined, 'No legacy top-level auditLogs field remains', `keys=${Object.keys(resAudit.body).join(',')}`);
  assert(resAudit.body.data?.total === resAudit.body.data?.auditLogs?.length, `data.total equals data.auditLogs length (${resAudit.body.data?.total})`);
  const actions: string[] = (resAudit.body.data?.auditLogs || []).map((l: any) => l.actionType);
  assert(['PARCEL_CREATED', 'PARCEL_UPDATED', 'FIELD_INSPECTION_RECORDED', 'RECORD_SEALED'].every((a) => actions.includes(a)), 'Lifecycle produced create/update/inspection/seal audit events', actions.join(','));
  assert(actions[0] === 'RECORD_SEALED', 'Audit list is newest-first with the seal on top', `got ${actions[0]}`);

  // The state-wide chain report is the AUDITOR's oversight function; a district officer is refused.
  const resChainDenied = await call('/verifications/audit-logs/verify-chain', { token: tehsildarToken });
  assert(resChainDenied.status === 403, 'District officer cannot pull the state-wide chain report (HTTP 403)', `got ${resChainDenied.status}`);

  const resChain = await call('/verifications/audit-logs/verify-chain', { token: auditorToken });
  assert(resChain.status === 200 && resChain.body.data?.isValid === true, 'Cryptographic audit chain verifies against PostgreSQL', JSON.stringify(resChain.body.data?.message ?? resChain.status));

  // 9. SOFT-DELETE / ARCHIVE
  console.log('\n9. SOFT-DELETE ARCHIVE (DELETE /api/parcels/:id)');
  const resDeleteDenied = await call(`/parcels/${FIXTURE_ID}`, { method: 'DELETE', token: patwariToken, body: { reason: 'RBAC probe' } });
  assert(resDeleteDenied.status === 403, 'Patwari cannot archive a parcel (HTTP 403)', `got ${resDeleteDenied.status}`);

  const resDelete = await call(`/parcels/${FIXTURE_ID}`, {
    method: 'DELETE',
    token: tehsildarToken,
    body: { reason: 'Archived for partition re-survey by Phase 5 suite.' },
  });
  assert(resDelete.status === 200 && resDelete.body.success === true, 'Archive returns HTTP 200', `got ${resDelete.status} ${JSON.stringify(resDelete.body.error || {})}`);
  assert(resDelete.body.data?.isArchived === true, 'isArchived true is returned under data', `got ${JSON.stringify(resDelete.body.data)}`);

  const resCheck = await call(`/parcels/${FIXTURE_ID}`, { token: tehsildarToken });
  assert(resCheck.status === 200 && resCheck.body.data?.parcel?.status === 'Archived', 'Parcel detail reads back as Archived', `got ${resCheck.body.data?.parcel?.status}`);

  const dbArchive = await pool.query('SELECT is_archived, status FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbArchive.rows[0]?.is_archived === true, 'PostgreSQL row is archived, not destroyed', `is_archived=${dbArchive.rows[0]?.is_archived}`);

  const resAuditAfterArchive = await call(`/verifications/audit-logs?parcelId=${FIXTURE_ID}`, { token: tehsildarToken });
  const actionsAfter: string[] = (resAuditAfterArchive.body.data?.auditLogs || []).map((l: any) => l.actionType);
  assert(actionsAfter.includes('PARCEL_ARCHIVED'), 'Archive appended an audit event, so history is retained', actionsAfter.slice(0, 3).join(','));

  // CLEANUP — hard delete only the row this suite created.
  console.log('\n10. CLEANUP');
  const cleanup = await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(cleanup.rowCount === 1, 'Fixture parcel removed (scoped to the id this suite created)', `rowCount=${cleanup.rowCount}`);
  const residue = await pool.query(
    `SELECT (SELECT count(*)::int FROM parcels WHERE id = $1) AS parcel,
            (SELECT count(*)::int FROM parcel_owners WHERE parcel_id = $1) AS owners,
            (SELECT count(*)::int FROM field_inspections WHERE parcel_id = $1) AS inspections`,
    [FIXTURE_ID]
  );
  assert(residue.rows[0]?.parcel === 0 && residue.rows[0]?.owners === 0 && residue.rows[0]?.inspections === 0, 'No fixture residue remains (owner/inspection rows cascaded)', JSON.stringify(residue.rows[0]));

  console.log('\n----------------------------------------------------------------');
  console.log(`  REST API SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('----------------------------------------------------------------\n');

  if (failedCount > 0) {
    throw new Error(`${failedCount} assertion(s) failed in the Phase 5 REST API suite.`);
  }
}

runApiSuite()
  .then(() => {
    console.log('REST API suite passed.');
    if (server) server.close();
    return pool.end().finally(() => process.exit(0));
  })
  .catch(async (err) => {
    console.error('[SUITE] REST API suite FAILED:', err instanceof Error ? err.message : err);
    if (server) server.close();
    await pool.end().catch(() => {});
    process.exit(1);
  });
