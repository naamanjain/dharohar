/**
 * DHAROHAR PostgreSQL / PostGIS Integration Verification
 *
 * Drives a RUNNING API server end-to-end (register -> update -> field inspect -> seal ->
 * archive) and, after each write, reads the PostgreSQL row directly with `pool` to prove the
 * database — not process memory — holds the result. The seal checks are the core of this suite:
 * sealing previously mutated only in-memory state and never wrote the parcels row.
 *
 * DATABASE-DEPENDENT. Fails loudly (exit 1) when PostgreSQL is unreachable or when the API
 * server under test is not answering; it never degrades into an in-memory pass.
 *
 * Run: npm run test:db
 * Server override: TEST_BASE_URL (default http://localhost:PORT/api, PORT default 3001)
 */

import { pool, initDbConnection } from './db/db';

const API_PORT = Number(process.env.TEST_PORT || process.env.PORT) || 3001;
const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${API_PORT}/api`;

const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints. This suite will not guess one.');
  process.exit(2);
}
const TEHSILDAR_ID = 'USR-TEH-01';
const TEHSILDAR_NAME = 'Shri Arvind Sharma, RAS';
const PATWARI_EMAIL = 'patwari@dharohar.local';
const PATWARI_NAME = 'Smt. Sunita Choudhary';
const AUDITOR_EMAIL = 'auditor@dharohar.local';

// The single parcel this suite creates, seals, archives and removes. Seeded records are only read.
const FIXTURE_ID = 'DH-JPR-RAM-001099';
const FIXTURE_KHASRA = '415/3';
const SEED_PARCEL_IDS = ['DH-JPR-RAM-001024', 'DH-UDA-KOT-001117', 'DH-JOD-OSI-001245'];

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

async function api(path: string, init?: { method?: string; token?: string; body?: any }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method || 'GET',
    headers: jsonHeaders(init?.token),
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as any) };
}

async function verifyIntegration() {
  console.log('===========================================================');
  console.log('  DHAROHAR PostgreSQL / PostGIS Integration Verification  ');
  console.log(`  API under test: ${BASE_URL}`);
  console.log('===========================================================\n');

  // 0. THE SUBJECT OF THIS SUITE IS THE DATABASE.
  console.log('0. STORAGE MODE GATE');
  const health = await initDbConnection();
  assert(
    health.storageMode === 'postgres-postgis',
    'Direct PostgreSQL connection is live (source of truth for this suite)',
    `storageMode=${health.storageMode} error=${health.error || 'n/a'}. Export DATABASE_URL pointing at a migrated dharohar_db and re-run.`
  );
  if (health.storageMode !== 'postgres-postgis') {
    throw new Error(`Refusing to run database assertions in ${health.storageMode} mode.`);
  }
  assert(health.postgisAvailable === true, 'PostGIS extension is available on the connected database', `postgisAvailable=${health.postgisAvailable}`);

  const dbVersion = await pool.query('SELECT PostGIS_Version() AS v, current_database() AS db');
  console.log(`   - Connected database: ${dbVersion.rows[0].db} | PostGIS ${dbVersion.rows[0].v}`);

  // 1. SERVER HEALTH
  console.log('\n1. BACKEND HEALTH (GET /api/health)');
  let resHealth;
  try {
    resHealth = await api('/health');
  } catch (err: any) {
    assert(false, `API server under test is reachable at ${BASE_URL}`, `fetch failed: ${err.message}. Start it (npm run server) or set TEST_BASE_URL.`);
    throw new Error('No live API server to integrate against.');
  }
  assert(resHealth.status === 200, 'GET /api/health returns HTTP 200', `got ${resHealth.status}`);
  assert(
    resHealth.body.storageMode === 'postgres-postgis',
    'Server under test reports storageMode "postgres-postgis" (not dev-fallback)',
    `got ${resHealth.body.storageMode}`
  );
  assert(resHealth.body.postgisAvailable === true, 'Server under test sees PostGIS', `got ${resHealth.body.postgisAvailable}`);
  assert(Boolean(resHealth.body.postgisVersion), 'Server reports a PostGIS version string', `got ${resHealth.body.postgisVersion}`);

  // 2. AUTHENTICATION
  console.log('\n2. OFFICER AUTHENTICATION (POST /api/auth/login)');
  const anon = await api('/parcels');
  assert(anon.status === 401, 'GET /api/parcels without a Bearer token is refused (HTTP 401)', `got ${anon.status}`);

  const noPassword = await api('/auth/login', { method: 'POST', body: { officerId: TEHSILDAR_ID } });
  assert(noPassword.status === 400 && noPassword.body.error?.code === 'MISSING_CREDENTIALS', 'Login without a password returns HTTP 400 MISSING_CREDENTIALS', `got ${noPassword.status}`);
  // No wrong-password probe here on purpose: POST /api/auth/login throttles every attempt per
  // ip+identifier (10 per 10 minutes) and the budget is consumed by successful logins too. This
  // suite talks to a long-lived server, so spending slots on a negative probe would make re-runs
  // flaky. The 401-on-bad-password path is asserted by test_api.ts, which owns its own server.

  const tehLogin = await api('/auth/login', { method: 'POST', body: { officerId: TEHSILDAR_ID, password: DEMO_PASSWORD } });
  if (tehLogin.status === 429) {
    assert(false, 'Login is not rate-limited for this run', `HTTP 429 ${JSON.stringify(tehLogin.body.error || {})} — the server under test has used its 10-attempt window for ${TEHSILDAR_ID}. Wait for the window to expire or point TEST_BASE_URL at a freshly started server.`);
    throw new Error('Login throttled (HTTP 429) by the server under test; stopping instead of cascading false failures.');
  }
  const tehsildarToken: string | undefined = tehLogin.body.data?.token;
  assert(tehLogin.status === 200 && tehLogin.body.success === true, 'Tehsildar (USR-TEH-01) logs in with the seeded demo password', `got ${tehLogin.status} ${JSON.stringify(tehLogin.body.error || {})}`);
  assert(Boolean(tehsildarToken), 'Login response carries data.token');
  assert(tehLogin.body.data?.user?.role === 'TEHSILDAR', 'Sealing rights confirmed by the TEHSILDAR role in the token', `got ${tehLogin.body.data?.user?.role}`);

  const patLogin = await api('/auth/login', { method: 'POST', body: { email: PATWARI_EMAIL, password: DEMO_PASSWORD } });
  const patwariToken: string | undefined = patLogin.body.data?.token;
  assert(patLogin.status === 200 && patLogin.body.data?.user?.role === 'PATWARI', 'Patwari logs in with role PATWARI', `got ${patLogin.status}`);

  const audLogin = await api('/auth/login', { method: 'POST', body: { email: AUDITOR_EMAIL, password: DEMO_PASSWORD } });
  const auditorToken: string | undefined = audLogin.body.data?.token;
  assert(audLogin.status === 200 && audLogin.body.data?.user?.role === 'AUDITOR', 'Auditor logs in with role AUDITOR', `got ${audLogin.status}`);

  // 3. PARCEL READS
  console.log('\n3. PARCEL READS (GET /api/parcels)');
  const resParcels = await api('/parcels', { token: tehsildarToken });
  assert(resParcels.status === 200 && resParcels.body.success === true, 'Authorised parcel list returns HTTP 200', `got ${resParcels.status}`);
  assert(Array.isArray(resParcels.body.data?.parcels), 'Parcels arrive under data.parcels (envelope { success, data, storageMode })');
  assert(resParcels.body.parcels === undefined, 'No top-level parcels field is left on the response');
  assert(resParcels.body.data?.total === resParcels.body.data?.parcels?.length, `data.total equals data.parcels length (${resParcels.body.data?.total})`);
  const apiIds: string[] = (resParcels.body.data?.parcels || []).map((p: any) => p.id);
  console.log(`   - Tehsildar (Jaipur) active parcel ids: ${apiIds.join(', ')}`);
  assert(apiIds.includes('DH-JPR-RAM-001024') && !apiIds.includes('DH-UDA-KOT-001117'), 'Registry list is limited to the caller’s district', apiIds.join(','));

  // The two whole-registry checks need a state-wide reader: a district officer's list is scoped, so
  // comparing it against an unscoped SQL count would fail even with both sides reading one database.
  const resAllParcels = await api('/parcels', { token: auditorToken });
  const allIds: string[] = (resAllParcels.body.data?.parcels || []).map((p: any) => p.id);
  assert(SEED_PARCEL_IDS.every((id) => allIds.includes(id)), 'All three seeded parcels are served from PostgreSQL (state-wide auditor)', allIds.join(','));

  const dbActive = await pool.query('SELECT count(*)::int AS n FROM parcels WHERE is_archived = FALSE');
  assert(
    dbActive.rows[0]?.n === resAllParcels.body.data?.total,
    'API and this test process read the SAME database (active parcel counts agree)',
    `db=${dbActive.rows[0]?.n} api=${resParcels.body.data?.total}. If these differ, DATABASE_URL/TEST_BASE_URL point at different systems.`
  );

  const resDetail = await api(`/parcels/DH-JPR-RAM-001024`, { token: tehsildarToken });
  assert(resDetail.status === 200 && resDetail.body.data?.parcel?.status === 'Verified', 'Sealed seed parcel DH-JPR-RAM-001024 reads as Verified through the API', `got ${resDetail.body.data?.parcel?.status}`);
  const dbSeed = await pool.query('SELECT status, verified_by FROM parcels WHERE id = $1', ['DH-JPR-RAM-001024']);
  assert(dbSeed.rows[0]?.status === 'Verified' && Boolean(dbSeed.rows[0]?.verified_by), '…and the same values are held in the PostgreSQL row', JSON.stringify(dbSeed.rows[0]));

  // 4. CREATE
  console.log('\n4. CREATE PARCEL (POST /api/parcels)');
  // Remove a fixture left behind by an interrupted run. Scoped to this suite's own id.
  await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);

  const newParcel = {
    id: FIXTURE_ID,
    khasraNo: FIXTURE_KHASRA,
    khataNo: '92',
    khewatNo: '31',
    patwarCircle: 'Rampur South',
    district: 'Jaipur',
    tehsil: 'Sanganer',
    village: 'Rampur',
    mappedAreaHectares: 1.45,
    recordedAreaHectares: 1.45,
    colour: '#7c3aed',
    ownerName: 'Mohan Lal Sharma',
    owners: [
      {
        id: 'own-test-1',
        name: 'Mohan Lal Sharma',
        hindiName: 'मोहन लाल शर्मा',
        relationType: 's/o',
        relativeName: 'Ganga Ram Sharma',
        relativeHindiName: 'गंगा राम शर्मा',
        shareFraction: '1/1',
        sharePercentage: 100,
        status: 'Active Co-sharer',
      },
    ],
    boundary: [
      { lat: 26.840, lng: 75.790 },
      { lat: 26.843, lng: 75.795 },
      { lat: 26.840, lng: 75.798 },
      { lat: 26.837, lng: 75.793 },
    ],
    landType: 'Chahi (Well Irrigated)',
    inheritance: 'Ancestral',
    status: 'Draft',
  };

  const resCreate = await api('/parcels', { method: 'POST', token: tehsildarToken, body: newParcel });
  assert(resCreate.status === 201 && resCreate.body.success === true, 'Parcel creation returns HTTP 201', `got ${resCreate.status} ${JSON.stringify(resCreate.body.error || {})}`);
  assert(resCreate.body.data?.parcel?.id === FIXTURE_ID, 'Created id is returned under data.parcel.id', `got ${resCreate.body.data?.parcel?.id}`);

  const dbGeom = await pool.query(
    'SELECT ST_AsText(geom) AS wkt, ST_IsValid(geom) AS valid FROM parcels WHERE id = $1',
    [FIXTURE_ID]
  );
  assert(Boolean(dbGeom.rows[0]?.wkt?.startsWith('POLYGON')), 'Boundary persisted as a PostGIS POLYGON', `got ${dbGeom.rows[0]?.wkt}`);
  assert(dbGeom.rows[0]?.valid === true, 'PostGIS reports the stored polygon as valid', `valid=${dbGeom.rows[0]?.valid}`);

  // 5. UPDATE
  console.log('\n5. UPDATE PARCEL (PUT /api/parcels/:id)');
  const resSelfSeal = await api(`/parcels/${FIXTURE_ID}`, {
    method: 'PUT',
    token: tehsildarToken,
    body: { status: 'Verified', verifiedBy: TEHSILDAR_NAME, certificateNumber: 'SELF-ISSUED' },
  });
  assert(resSelfSeal.status === 400 && resSelfSeal.body.error?.code === 'SEALED_FIELDS_NOT_PATCHABLE', 'Self-declaring a seal through PUT is refused (HTTP 400)', `got ${resSelfSeal.status} ${resSelfSeal.body.error?.code}`);

  const resBadStatus = await api(`/parcels/${FIXTURE_ID}`, {
    method: 'PUT',
    token: tehsildarToken,
    body: { status: 'Verified' },
  });
  assert(resBadStatus.status === 400 && resBadStatus.body.error?.code === 'INVALID_STATUS', "PUT with status 'Verified' is refused; only the seal route sets it", `got ${resBadStatus.status} ${resBadStatus.body.error?.code}`);

  const resUpdate = await api(`/parcels/${FIXTURE_ID}`, {
    method: 'PUT',
    token: tehsildarToken,
    body: { landType: 'Nahri (Canal Irrigated)', khataNo: '92' },
  });
  assert(resUpdate.status === 200 && resUpdate.body.success === true, 'Parcel update returns HTTP 200', `got ${resUpdate.status} ${JSON.stringify(resUpdate.body.error || {})}`);
  assert(resUpdate.body.data?.parcel?.landType === 'Nahri (Canal Irrigated)', 'Updated landType returned under data.parcel', `got ${resUpdate.body.data?.parcel?.landType}`);
  const dbUpdate = await pool.query('SELECT land_type, status FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbUpdate.rows[0]?.land_type === 'Nahri (Canal Irrigated)', 'land_type change is committed in PostgreSQL', `got ${dbUpdate.rows[0]?.land_type}`);
  // KNOWN API BEHAVIOUR, asserted neither way: `status` is validated against WORKFLOW_STATUSES but
  // is absent from PATCHABLE_COLUMNS in server/src/routes/parcels.ts, so a legal status in a PUT is
  // accepted with HTTP 200 and silently not written. Workflow status here is changed only by the
  // field-inspection route below, which does persist it.
  console.log(`   - NOTE: PUT accepted a workflow status; row still reads '${dbUpdate.rows[0]?.status}' (status is not a PATCHABLE_COLUMNS field).`);

  // 6. FIELD INSPECTION
  console.log('\n6. FIELD INSPECTION (POST /api/verifications/field-inspection)');
  // Filed by the officer whose district owns the fixture (Jaipur Tehsildar is a permitted inspector
  // role). A Patwari filing on it would be refused for jurisdiction, which test:jurisdiction proves.
  const resInsp = await api('/verifications/field-inspection', {
    method: 'POST',
    token: tehsildarToken,
    body: {
      parcelId: FIXTURE_ID,
      inspectedBy: 'Anyone The Client Names',
      inspectorRole: 'Implied Role',
      discrepancyObserved: true,
      discrepancyNotes: 'Northern merh shifted inward by 1.2 m; area confirmed against khata 92.',
      observedLandUse: 'Nahri (Canal Irrigated)',
      gpsCoords: { latitude: 26.8405, longitude: 75.7935, accuracy: 3.1 },
      checkpoints: [{ id: 'cp-1', name: 'North Boundary Stone', passed: false }],
    },
  });
  assert(resInsp.status === 201 && resInsp.body.success === true, 'Permitted officer field inspection returns HTTP 201', `got ${resInsp.status} ${JSON.stringify(resInsp.body.error || {})}`);
  assert(Boolean(resInsp.body.data?.inspection?.id), 'Inspection id is returned under data.inspection', `got ${resInsp.body.data?.inspection?.id}`);
  assert(resInsp.body.data?.inspection?.inspectedBy === TEHSILDAR_NAME, 'Inspector identity is bound to the JWT, not the request body', `got ${resInsp.body.data?.inspection?.inspectedBy}`);
  const dbInsp = await pool.query('SELECT count(*)::int AS n, max(inspected_by) AS who FROM field_inspections WHERE parcel_id = $1', [FIXTURE_ID]);
  assert(dbInsp.rows[0]?.n === 1 && dbInsp.rows[0]?.who === TEHSILDAR_NAME, 'Field inspection row exists in PostgreSQL for the authenticated officer', JSON.stringify(dbInsp.rows[0]));

  const dbStatusAfterInsp = await pool.query('SELECT status FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbStatusAfterInsp.rows[0]?.status === 'Needs Review', 'Discrepancy inspection moved the PostgreSQL row to "Needs Review"', `got ${dbStatusAfterInsp.rows[0]?.status}`);

  // 7. OFFICER SEAL — the point of this suite
  console.log('\n7. OFFICER SEAL (POST /api/verifications/seal) + PostgreSQL TRUTH');
  const resPatSeal = await api('/verifications/seal', { method: 'POST', token: patwariToken, body: { parcelId: FIXTURE_ID, officerNotes: 'Patwari attempt' } });
  assert(resPatSeal.status === 403, 'Patwari cannot seal: sealing is TEHSILDAR-only (HTTP 403)', `got ${resPatSeal.status}`);

  const dbBeforeSeal = await pool.query('SELECT status, verified_at FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbBeforeSeal.rows[0]?.status !== 'Verified' && dbBeforeSeal.rows[0]?.verified_at === null, 'Parcel is unsealed in PostgreSQL immediately before the seal call', JSON.stringify(dbBeforeSeal.rows[0]));

  // The audit chain is append-only, so entries from earlier runs of this suite are still there.
  // Counting this seal as a delta keeps the assertion correct on a fresh database and on a re-run.
  const sealAuditBefore = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'RECORD_SEALED'",
    [FIXTURE_ID]
  );

  const resSeal = await api('/verifications/seal', {
    method: 'POST',
    token: tehsildarToken,
    body: {
      parcelId: FIXTURE_ID,
      officerName: 'Anyone The Client Names',
      officerBadge: 'RAS-JPR-2024-88',
      officerNotes: 'Ownership shares 100% verified against Master Shajra Cadastre.',
    },
  });
  assert(resSeal.status === 200 && resSeal.body.success === true, 'Tehsildar seal returns HTTP 200', `got ${resSeal.status} ${JSON.stringify(resSeal.body.error || {})}`);
  const certificateNumber: string | undefined = resSeal.body.data?.certificateNumber;
  const signatureHash: string | undefined = resSeal.body.data?.signatureHash;
  assert(Boolean(certificateNumber), 'Certificate number is returned under data.certificateNumber', `got ${certificateNumber}`);
  assert(/^[0-9a-f]{64}$/.test(String(signatureHash || '')), 'Seal signature is a 64-hex HMAC-SHA256 digest', `got ${signatureHash}`);

  // The whole point of the recent fix: the seal must be in the row, not only in server memory.
  const dbSeal = await pool.query(
    'SELECT id, status, verified_by, verified_at, certificate_number, seal_signature, verification_notes FROM parcels WHERE id = $1',
    [FIXTURE_ID]
  );
  const sealedRow = dbSeal.rows[0] || {};
  console.log(`   - Sealed parcel DB row: ${JSON.stringify({ id: sealedRow.id, status: sealedRow.status, verified_by: sealedRow.verified_by, certificate_number: sealedRow.certificate_number })}`);
  assert(sealedRow.status === 'Verified', "PostgreSQL parcels.status became 'Verified'", `got ${sealedRow.status}`);
  assert(Boolean(sealedRow.verified_by), 'PostgreSQL parcels.verified_by names the sealing officer', `got ${sealedRow.verified_by}`);
  assert(sealedRow.verified_by === `${TEHSILDAR_NAME} (Revenue Officer / Tehsildar)`, 'verified_by is the token officer + designation, not the client-supplied name', `got ${sealedRow.verified_by}`);
  assert(sealedRow.verified_at !== null && sealedRow.verified_at !== undefined, 'PostgreSQL parcels.verified_at is timestamped', `got ${sealedRow.verified_at}`);
  assert(sealedRow.certificate_number === certificateNumber, 'PostgreSQL parcels.certificate_number equals the issued certificate', `got ${sealedRow.certificate_number} vs ${certificateNumber}`);
  assert(sealedRow.seal_signature === signatureHash, 'PostgreSQL parcels.seal_signature equals the returned signature hash', `got ${sealedRow.seal_signature}`);

  const resSealedRead = await api(`/parcels/${FIXTURE_ID}`, { token: tehsildarToken });
  assert(resSealedRead.body.data?.parcel?.certificateNumber === certificateNumber, 'API reads the certificate back out of the sealed row', `got ${resSealedRead.body.data?.parcel?.certificateNumber}`);
  assert(resSealedRead.body.data?.parcel?.verifiedBy === `${TEHSILDAR_NAME} (Revenue Officer / Tehsildar)`, 'API reads verified_by back out of the sealed row', `got ${resSealedRead.body.data?.parcel?.verifiedBy}`);

  const resReseal = await api('/verifications/seal', { method: 'POST', token: tehsildarToken, body: { parcelId: FIXTURE_ID, officerNotes: 'Second seal attempt' } });
  const dbAfterReseal = await pool.query('SELECT verified_at, certificate_number FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(resReseal.status === 409 && resReseal.body.error?.code === 'ALREADY_SEALED', 'Re-sealing a sealed parcel is refused (HTTP 409 ALREADY_SEALED)', `got ${resReseal.status} ${resReseal.body.error?.code}`);
  assert(
    String(dbAfterReseal.rows[0]?.verified_at) === String(dbSeal.rows[0]?.verified_at) && dbAfterReseal.rows[0]?.certificate_number === certificateNumber,
    'The refused re-seal changed nothing in PostgreSQL (no silent overwrite)',
    JSON.stringify(dbAfterReseal.rows[0])
  );

  // 8. AUDIT TRAIL
  console.log('\n8. APPEND-ONLY AUDIT TRAIL (GET /api/verifications/audit-logs)');
  const resAudit = await api(`/verifications/audit-logs?parcelId=${FIXTURE_ID}`, { token: tehsildarToken });
  assert(resAudit.status === 200 && resAudit.body.success === true, 'Audit log read returns HTTP 200', `got ${resAudit.status}`);
  assert(resAudit.body.auditLogs === undefined && Array.isArray(resAudit.body.data?.auditLogs), 'Audit logs are nested under data.auditLogs');
  const auditActions: string[] = (resAudit.body.data?.auditLogs || []).map((l: any) => l.actionType);
  console.log(`   - Audit actions for fixture, newest first: ${auditActions.join(' > ')}`);
  assert(resAudit.body.data?.total >= 4, `At least 4 audit events recorded for the fixture (got ${resAudit.body.data?.total})`);
  assert(['PARCEL_CREATED', 'PARCEL_UPDATED', 'FIELD_INSPECTION_RECORDED', 'RECORD_SEALED'].every((a) => auditActions.includes(a)), 'Create, update, inspection and seal are all present in the audit trail', auditActions.join(','));
  assert(auditActions[0] === 'RECORD_SEALED', 'Newest audit event is the seal (logs are returned newest-first)', `got ${auditActions[0]}`);

  const resChainDenied = await api('/verifications/audit-logs/verify-chain', { token: tehsildarToken });
  assert(resChainDenied.status === 403, 'District officer is refused the state-wide chain report (HTTP 403)', `got ${resChainDenied.status}`);

  const resChain = await api('/verifications/audit-logs/verify-chain', { token: auditorToken });
  assert(resChain.status === 200 && resChain.body.success === true && resChain.body.data?.isValid === true, 'Whole audit hash chain verifies in PostgreSQL', JSON.stringify(resChain.body.data?.message ?? resChain.status));

  const dbAuditForSeal = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'RECORD_SEALED'",
    [FIXTURE_ID]
  );
  const sealAuditDelta = (dbAuditForSeal.rows[0]?.n ?? 0) - (sealAuditBefore.rows[0]?.n ?? 0);
  assert(sealAuditDelta === 1, 'The seal appended exactly one durable RECORD_SEALED audit row', `delta=${sealAuditDelta}`);

  // 9. ARCHIVE + CLEANUP
  console.log('\n9. SOFT-DELETE AND CLEANUP');
  const resArchive = await api(`/parcels/${FIXTURE_ID}`, {
    method: 'DELETE',
    token: tehsildarToken,
    body: { reason: 'Integration test soft-delete cleanup.' },
  });
  assert(resArchive.status === 200 && resArchive.body.data?.isArchived === true, 'Archive returns isArchived inside data (HTTP 200)', `got ${resArchive.status} ${JSON.stringify(resArchive.body.data)}`);
  const dbArchive = await pool.query('SELECT status, is_archived FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbArchive.rows[0]?.is_archived === true && dbArchive.rows[0]?.status === 'Archived', 'PostgreSQL row is archived rather than destroyed', JSON.stringify(dbArchive.rows[0]));

  const resFinal = await api('/parcels', { token: tehsildarToken });
  assert(!(resFinal.body.data?.parcels || []).some((p: any) => p.id === FIXTURE_ID), 'Archived fixture is excluded from the active parcel list');

  // Hard delete of the fixture row this suite created, so re-runs start from the same state.
  const cleanup = await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);
  console.log(`   - Removed fixture parcel row(s): ${cleanup.rowCount}`);
  assert(cleanup.rowCount === 1, 'Fixture parcel removed (scoped to the id this suite created)', `rowCount=${cleanup.rowCount}`);

  const residue = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM parcels
         WHERE is_archived = false AND NOT (id = ANY($2::text[]))) AS live_others,
       coalesce((SELECT array_agg(id ORDER BY id) FROM parcels
         WHERE is_archived = false AND NOT (id = ANY($2::text[]))), '{}') AS live_ids,
       (SELECT count(*)::int FROM parcel_owners WHERE parcel_id = $1) AS owners,
       (SELECT count(*)::int FROM field_inspections WHERE parcel_id = $1) AS inspections`,
    [FIXTURE_ID, SEED_PARCEL_IDS]
  );
  // Counted over LIVE rows rather than the whole table: other suites archive their fixtures on
  // purpose, because a land record is retired rather than deleted, and an absolute row count would
  // then fail over history this suite never wrote.
  assert(residue.rows[0]?.live_others === 0, 'No unarchived parcel remains beyond the three seeded ones', JSON.stringify(residue.rows[0]?.live_ids));
  assert(residue.rows[0]?.owners === 0 && residue.rows[0]?.inspections === 0, 'Fixture owner and inspection rows cascaded away', JSON.stringify(residue.rows[0]));

  const seedUntouched = await pool.query('SELECT status, verified_at FROM parcels WHERE id = $1', ['DH-UDA-KOT-001117']);
  assert(seedUntouched.rows[0]?.verified_at === null && seedUntouched.rows[0]?.status === 'Needs Field Verification', 'Seeded parcel DH-UDA-KOT-001117 was left untouched', JSON.stringify(seedUntouched.rows[0]));

  console.log('\n===========================================================');
  console.log(`  INTEGRATION SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('===========================================================');

  if (failedCount > 0) {
    throw new Error(`${failedCount} integration assertion(s) failed.`);
  }
  console.log('  POSTGRESQL CONFIRMED AS SOURCE OF TRUTH');
  console.log('===========================================================\n');
}

verifyIntegration()
  .then(() => pool.end().finally(() => process.exit(0)))
  .catch(async (err) => {
    console.error('\n[INTEGRATION] Verification FAILED:', err instanceof Error ? err.message : err);
    console.error(`[INTEGRATION] Assertions at failure: ${passedCount} passed, ${failedCount} failed.`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
