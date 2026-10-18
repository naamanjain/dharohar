/**
 * DHAROHAR Phase 4 Backend REST Test Suite
 *
 * Covers: JWT authentication enforcement, the { success, data, storageMode } response envelopes,
 * parcel registration writes, co-sharer persistence, assisted field inspection, append-only
 * audit reads and soft-delete archiving — each checked against the PostgreSQL row it produced.
 *
 * DATABASE-DEPENDENT. Every request authenticates as a seeded demo officer (INITIAL_USERS in
 * server/src/db/db.ts) because the API returns 401 for anonymous reads and writes. If the
 * database is unreachable this suite fails loudly instead of passing on the in-memory fallback.
 *
 * Run: npm run test:db        (or)  DATABASE_URL=... npx tsx server/src/test_api.ts
 * Port override: TEST_PORT (default 3002)
 */

import http from 'http';
import { pool, getDbHealth } from './db/db';
import { seedDatabase } from './db/seed';
import { app } from './index';

const PORT = Number(process.env.TEST_PORT) || 3002;
const BASE_URL = `http://localhost:${PORT}/api`;

// Seeded demo officers. The password is passed explicitly: nothing here may rely on a default.
const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints. This suite will not guess one.');
  process.exit(2);
}
const TEHSILDAR_ID = 'USR-TEH-01';
const TEHSILDAR_NAME = 'Shri Arvind Sharma, RAS';
const PATWARI_EMAIL = 'patwari@dharohar.local';
const PATWARI_NAME = 'Smt. Sunita Choudhary';
const OPERATOR_EMAIL = 'operator@dharohar.local';
const AUDITOR_EMAIL = 'auditor@dharohar.local';

// The only parcel this suite creates, mutates and removes. No seeded record is touched.
const FIXTURE_ID = 'DH-JPR-RAM-001098';
const FIXTURE_KHASRA = '415/8';
const SEED_PARCEL_IDS = ['DH-JPR-RAM-001024', 'DH-UDA-KOT-001117', 'DH-JOD-OSI-001245'];

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

async function postLogin(body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  return { res, data };
}

async function runBackendTests() {
  console.log('================================================================');
  console.log('  DHAROHAR Phase 4 Backend REST Test Suite (live PostgreSQL)     ');
  console.log('================================================================\n');

  await seedDatabase();

  // 0. THE SUBJECT OF THIS SUITE IS THE DATABASE. Refuse to grade in-memory state.
  console.log('0. STORAGE MODE GATE');
  const health = getDbHealth();
  assert(
    health.storageMode === 'postgres-postgis',
    'Test process is connected to live PostgreSQL + PostGIS',
    `storageMode=${health.storageMode} error=${health.error || 'n/a'}. Set DATABASE_URL (or PG*) to a migrated dharohar_db and re-run.`
  );
  if (health.storageMode !== 'postgres-postgis') {
    throw new Error(`Refusing to run database assertions in ${health.storageMode} mode.`);
  }

  server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(PORT, () => resolve(s));
    s.on('error', reject);
  });
  console.log(`\n[TEST] Server listening on ${BASE_URL}\n`);

  // 1. HEALTH ENDPOINT
  console.log('1. HEALTH ENDPOINT (GET /api/health)');
  const resHealth = await fetch(`${BASE_URL}/health`);
  const healthBody = (await resHealth.json()) as any;
  assert(resHealth.status === 200, 'GET /api/health returns HTTP 200', `got ${resHealth.status}`);
  assert(healthBody.status === 'healthy', 'Health reports status "healthy" because PostgreSQL is connected', `got ${healthBody.status}`);
  assert(
    healthBody.storageMode === 'postgres-postgis',
    'Server under test reports storageMode "postgres-postgis"',
    `got ${healthBody.storageMode}`
  );
  assert(healthBody.postgisAvailable === true, 'PostGIS extension detected by the server', `got ${healthBody.postgisAvailable}`);

  // 2. AUTHENTICATION IS ENFORCED
  console.log('\n2. AUTH ENFORCEMENT (401 for anonymous and forged tokens)');
  const resAnon = await fetch(`${BASE_URL}/parcels`);
  const anonBody = (await resAnon.json()) as any;
  assert(resAnon.status === 401, 'GET /api/parcels without a Bearer token returns HTTP 401', `got ${resAnon.status}`);
  assert(anonBody.success === false && anonBody.error?.code === 'UNAUTHORIZED', 'Anonymous rejection is an explicit UNAUTHORIZED envelope', JSON.stringify(anonBody));

  const resAnonAudit = await fetch(`${BASE_URL}/verifications/audit-logs`);
  assert(resAnonAudit.status === 401, 'GET /api/verifications/audit-logs without a token returns HTTP 401', `got ${resAnonAudit.status}`);

  const resForged = await fetch(`${BASE_URL}/parcels`, { headers: jsonHeaders('not.a.real.jwt') });
  const forgedBody = (await resForged.json()) as any;
  assert(resForged.status === 401 && forgedBody.error?.code === 'INVALID_TOKEN', 'Forged Bearer token is rejected (HTTP 401 INVALID_TOKEN)', `got ${resForged.status}`);

  // 3. LOGIN
  console.log('\n3. OFFICER LOGIN (POST /api/auth/login)');
  const resEmpty = await postLogin({});
  assert(resEmpty.res.status === 400 && resEmpty.data.error?.code === 'MISSING_CREDENTIALS', 'Login with no identifier and no password returns HTTP 400', `got ${resEmpty.res.status}`);

  const resBad = await postLogin({ officerId: TEHSILDAR_ID, password: 'WrongPassword999' });
  assert(resBad.res.status === 401 && resBad.data.success === false, 'Login with a wrong password returns HTTP 401', `got ${resBad.res.status}`);

  const tehLogin = await postLogin({ officerId: TEHSILDAR_ID, password: DEMO_PASSWORD });
  assert(tehLogin.res.status === 200 && tehLogin.data.success === true, 'Tehsildar logs in by officer id (HTTP 200)', `got ${tehLogin.res.status} ${JSON.stringify(tehLogin.data.error || {})}`);
  const tehsildarToken: string | undefined = tehLogin.data.data?.token;
  assert(Boolean(tehsildarToken), 'Tehsildar login returns a signed JWT');
  assert(tehLogin.data.data?.user?.role === 'TEHSILDAR', 'Tehsildar token carries role TEHSILDAR', `got ${tehLogin.data.data?.user?.role}`);
  assert(tehLogin.data.data?.user?.id === TEHSILDAR_ID, 'Tehsildar token identifies USR-TEH-01', `got ${tehLogin.data.data?.user?.id}`);

  const patLogin = await postLogin({ email: PATWARI_EMAIL, password: DEMO_PASSWORD });
  const patwariToken: string | undefined = patLogin.data.data?.token;
  assert(patLogin.res.status === 200 && patLogin.data.data?.user?.role === 'PATWARI', 'Patwari login returns role PATWARI', `got ${patLogin.res.status}`);
  assert(patLogin.data.data?.user?.displayName === PATWARI_NAME, 'Patwari identity comes from the stored officer record', `got ${patLogin.data.data?.user?.displayName}`);

  const oprLogin = await postLogin({ email: OPERATOR_EMAIL, password: DEMO_PASSWORD });
  const operatorToken: string | undefined = oprLogin.data.data?.token;
  assert(oprLogin.res.status === 200 && oprLogin.data.data?.user?.role === 'DATA_ENTRY_OPERATOR', 'Operator login returns role DATA_ENTRY_OPERATOR', `got ${oprLogin.res.status}`);

  const audLogin = await postLogin({ email: AUDITOR_EMAIL, password: DEMO_PASSWORD });
  const auditorToken: string | undefined = audLogin.data.data?.token;
  assert(audLogin.res.status === 200 && audLogin.data.data?.user?.role === 'AUDITOR', 'Auditor login returns role AUDITOR', `got ${audLogin.res.status}`);

  const resMe = await fetch(`${BASE_URL}/auth/me`, { headers: jsonHeaders(tehsildarToken) });
  const meBody = (await resMe.json()) as any;
  assert(resMe.status === 200 && meBody.data?.user?.id === TEHSILDAR_ID, 'GET /api/auth/me resolves the officer from the token', JSON.stringify(meBody.data?.user));

  // 4. PARCEL LIST ENVELOPE
  console.log('\n4. PARCEL REGISTRY READ (GET /api/parcels)');
  const resParcels = await fetch(`${BASE_URL}/parcels`, { headers: jsonHeaders(tehsildarToken) });
  const parcelsBody = (await resParcels.json()) as any;
  assert(resParcels.status === 200 && parcelsBody.success === true, 'GET /api/parcels with a token returns HTTP 200 success=true', `got ${resParcels.status}`);
  assert(Array.isArray(parcelsBody.data?.parcels), 'Parcels are nested in the data.parcels envelope');
  assert(parcelsBody.parcels === undefined && parcelsBody.total === undefined, 'No stale top-level parcels/total fields remain on the response', JSON.stringify(Object.keys(parcelsBody)));
  assert(parcelsBody.data?.total === parcelsBody.data?.parcels?.length, `data.total matches data.parcels length (${parcelsBody.data?.total})`);
  assert(parcelsBody.storageMode === 'postgres-postgis', 'Parcels response reports storageMode postgres-postgis', `got ${parcelsBody.storageMode}`);
  const listedIds: string[] = (parcelsBody.data?.parcels || []).map((p: any) => p.id);
  // Registry reads are scoped to the caller's district, so a Jaipur Tehsildar sees only the Jaipur
  // seed record. The state-wide read is the AUDITOR's job — that is what proves all three rows came
  // out of PostgreSQL rather than that one officer can see the whole state.
  assert(listedIds.includes('DH-JPR-RAM-001024'), 'Tehsildar list includes the home-district seed parcel', listedIds.join(','));
  assert(!listedIds.includes('DH-UDA-KOT-001117') && !listedIds.includes('DH-JOD-OSI-001245'), 'Tehsildar list excludes other districts’ parcels', listedIds.join(','));

  const resAuditorParcels = await fetch(`${BASE_URL}/parcels`, { headers: jsonHeaders(auditorToken) });
  const auditorBody = (await resAuditorParcels.json()) as any;
  const auditorListedIds: string[] = (auditorBody.data?.parcels || []).map((p: any) => p.id);
  assert(SEED_PARCEL_IDS.every((id) => auditorListedIds.includes(id)), 'All three seeded cadastral parcels are readable from PostgreSQL (state-wide auditor)', auditorListedIds.join(','));
  const firstParcel = (parcelsBody.data?.parcels || [])[0] as any;
  assert(Boolean(firstParcel?.khasraNo) && Array.isArray(firstParcel?.owners), 'Parcel rows come back camelCase with owners attached', `keys=${Object.keys(firstParcel || {}).join(',')}`);

  // 5. CREATE PARCEL (fixture owned by this suite)
  console.log('\n5. PARCEL REGISTRATION (POST /api/parcels)');
  // Drop a fixture left behind by an interrupted run. Scoped to this suite's own id.
  await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);

  const fixturePayload = {
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
        id: 'own-api-test-1',
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

  const resCreate = await fetch(`${BASE_URL}/parcels`, {
    method: 'POST',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify(fixturePayload),
  });
  const createBody = (await resCreate.json()) as any;
  assert(resCreate.status === 201 && createBody.success === true, 'Parcel creation returns HTTP 201', `got ${resCreate.status} ${JSON.stringify(createBody.error || {})}`);
  assert(createBody.data?.parcel?.id === FIXTURE_ID, 'Created parcel id is returned inside data.parcel', `got ${createBody.data?.parcel?.id}`);

  const dbCreated = await pool.query(
    `SELECT id, status, khasra_no, land_type, ST_AsText(geom) AS wkt,
       (SELECT COALESCE(SUM(share_percentage), 0) FROM parcel_owners o WHERE o.parcel_id = p.id) AS share_sum
     FROM parcels p WHERE id = $1`,
    [FIXTURE_ID]
  );
  assert(dbCreated.rowCount === 1, 'The created parcel exists as a PostgreSQL row', `rowCount=${dbCreated.rowCount}`);
  assert(dbCreated.rows[0]?.wkt?.startsWith('POLYGON'), 'Boundary was stored as a PostGIS POLYGON geometry', `got ${dbCreated.rows[0]?.wkt}`);
  assert(Number(dbCreated.rows[0]?.share_sum) === 100, 'Co-sharer row persisted with a 100% share', `share_sum=${dbCreated.rows[0]?.share_sum}`);
  assert(dbCreated.rows[0]?.status === 'Draft', 'Parcel persisted in Draft workflow state', `got ${dbCreated.rows[0]?.status}`);

  const resDuplicate = await fetch(`${BASE_URL}/parcels`, {
    method: 'POST',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify(fixturePayload),
  });
  const dupBody = (await resDuplicate.json()) as any;
  assert(resDuplicate.status === 409 && dupBody.error?.code === 'DUPLICATE_PARCEL_ID', 'Re-posting the same parcel id is refused (HTTP 409), not silently overwritten', `got ${resDuplicate.status} ${dupBody.error?.code}`);

  const resNoBoundary = await fetch(`${BASE_URL}/parcels`, {
    method: 'POST',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify({ ...fixturePayload, id: 'DH-JPR-RAM-001097', boundary: [] }),
  });
  assert(resNoBoundary.status === 400, 'Parcel without a polygon boundary is rejected (HTTP 400)', `got ${resNoBoundary.status}`);

  // 6. FIELD INSPECTION
  console.log('\n6. FIELD INSPECTION (POST /api/verifications/field-inspection)');
  const inspectionPayload = {
    parcelId: FIXTURE_ID,
    inspectedBy: 'Self-Declared Impersonator',
    inspectorRole: 'Whatever The Client Sent',
    gpsCoords: { latitude: 26.8411, longitude: 75.7922, accuracy: 2.4 },
    deviceHeadingDeg: 145,
    checkpoints: [
      { id: 'chk-1', label: 'Merh (boundary stone) present', status: 'passed' },
      { id: 'chk-2', label: 'Cultivation matches land type', status: 'passed' },
    ],
    discrepancyObserved: false,
    observedLandUse: 'Chahi (Well Irrigated)',
  };

  const resInspAnon = await fetch(`${BASE_URL}/verifications/field-inspection`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(inspectionPayload),
  });
  assert(resInspAnon.status === 401, 'Anonymous field inspection is refused (HTTP 401)', `got ${resInspAnon.status}`);

  const resInspOperator = await fetch(`${BASE_URL}/verifications/field-inspection`, {
    method: 'POST',
    headers: jsonHeaders(operatorToken),
    body: JSON.stringify(inspectionPayload),
  });
  assert(resInspOperator.status === 403, 'DATA_ENTRY_OPERATOR cannot submit a field inspection (HTTP 403)', `got ${resInspOperator.status}`);

  // The fixture parcel lives in Jaipur, so the inspection is filed by the Jaipur officer. A Patwari
  // (Jodhpur) filing it would be refused for jurisdiction before the role check mattered — that
  // path is covered by test:jurisdiction and scripts/validate-stack.sh.
  const resInsp = await fetch(`${BASE_URL}/verifications/field-inspection`, {
    method: 'POST',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify(inspectionPayload),
  });
  const inspBody = (await resInsp.json()) as any;
  assert(resInsp.status === 201 && inspBody.success === true, 'Permitted officer field inspection returns HTTP 201', `got ${resInsp.status} ${JSON.stringify(inspBody.error || {})}`);
  const inspectionId: string | undefined = inspBody.data?.inspection?.id;
  assert(Boolean(inspectionId), 'Inspection id is returned inside data.inspection', `got ${inspectionId}`);
  assert(inspBody.data?.inspection?.inspectedBy === TEHSILDAR_NAME, 'Inspector identity is taken from the JWT, not the client payload', `got ${inspBody.data?.inspection?.inspectedBy}`);
  assert(/^[0-9a-f]{64}$/.test(String(inspBody.data?.inspection?.evidenceHash || '')), 'Inspection carries a 64-hex SHA-256 evidence hash', `got ${inspBody.data?.inspection?.evidenceHash}`);

  const dbInsp = await pool.query(
    'SELECT id, inspected_by, evidence_hash, discrepancy_observed FROM field_inspections WHERE parcel_id = $1',
    [FIXTURE_ID]
  );
  assert(dbInsp.rowCount === 1, 'Field inspection is persisted in the field_inspections table', `rowCount=${dbInsp.rowCount}`);
  assert(dbInsp.rows[0]?.evidence_hash === inspBody.data?.inspection?.evidenceHash, 'Stored evidence hash matches the response');
  assert(dbInsp.rows[0]?.inspected_by === TEHSILDAR_NAME, 'Stored inspector is the authenticated officer from the JWT', `got ${dbInsp.rows[0]?.inspected_by}`);

  const dbAfterInsp = await pool.query('SELECT status FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbAfterInsp.rows[0]?.status === 'Needs Field Verification', 'Parcel row advanced to "Needs Field Verification"', `got ${dbAfterInsp.rows[0]?.status}`);

  // 7. AUDIT LOGS
  console.log('\n7. APPEND-ONLY AUDIT TRAIL (GET /api/verifications/audit-logs)');
  const resAudit = await fetch(`${BASE_URL}/verifications/audit-logs?parcelId=${FIXTURE_ID}`, {
    headers: jsonHeaders(tehsildarToken),
  });
  const auditBody = (await resAudit.json()) as any;
  assert(resAudit.status === 200 && auditBody.success === true, 'Audit log read with a token returns HTTP 200', `got ${resAudit.status}`);
  assert(Array.isArray(auditBody.data?.auditLogs), 'Audit logs are nested in data.auditLogs');
  assert(auditBody.auditLogs === undefined, 'No stale top-level auditLogs field remains on the response');
  assert(auditBody.data?.total === auditBody.data?.auditLogs?.length, `data.total matches data.auditLogs length (${auditBody.data?.total})`);
  const actions: string[] = (auditBody.data?.auditLogs || []).map((l: any) => l.actionType);
  assert(actions.includes('PARCEL_CREATED') && actions.includes('FIELD_INSPECTION_RECORDED'), 'Audit trail records the create and the inspection', actions.join(','));
  const chainOk = (auditBody.data?.auditLogs || []).every((l: any) => typeof l.entryHash === 'string' && typeof l.previousHash === 'string');
  assert(chainOk, 'Every audit entry carries previousHash/entryHash chain links');

  // 8. SOFT DELETE / ARCHIVE
  console.log('\n8. SOFT-DELETE ARCHIVE (DELETE /api/parcels/:id)');
  const resNoReason = await fetch(`${BASE_URL}/parcels/${FIXTURE_ID}`, {
    method: 'DELETE',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify({ reason: '   ' }),
  });
  assert(resNoReason.status === 400, 'Archive without a reason is refused (HTTP 400)', `got ${resNoReason.status}`);

  const resArchiveOperator = await fetch(`${BASE_URL}/parcels/${FIXTURE_ID}`, {
    method: 'DELETE',
    headers: jsonHeaders(operatorToken),
    body: JSON.stringify({ reason: 'RBAC probe' }),
  });
  assert(resArchiveOperator.status === 403, 'DATA_ENTRY_OPERATOR cannot archive a parcel (HTTP 403)', `got ${resArchiveOperator.status}`);

  // The audit chain is append-only and survives an earlier run of this suite, so the archive
  // entry is asserted as a delta rather than as an absolute count.
  const archiveAuditBefore = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'PARCEL_ARCHIVED'",
    [FIXTURE_ID]
  );

  const resArchive = await fetch(`${BASE_URL}/parcels/${FIXTURE_ID}`, {
    method: 'DELETE',
    headers: jsonHeaders(tehsildarToken),
    body: JSON.stringify({ reason: 'Phase 4 REST suite archive verification' }),
  });
  const archiveBody = (await resArchive.json()) as any;
  assert(resArchive.status === 200 && archiveBody.success === true, 'Tehsildar archive request returns HTTP 200', `got ${resArchive.status} ${JSON.stringify(archiveBody.error || {})}`);
  assert(archiveBody.data?.isArchived === true, 'isArchived true is returned inside data (not at the top level)', `got ${JSON.stringify(archiveBody.data)}`);
  assert(archiveBody.data?.id === FIXTURE_ID, 'Archive response names the archived parcel id');

  const dbArchived = await pool.query('SELECT status, is_archived, archive_reason FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(dbArchived.rows[0]?.is_archived === true, 'PostgreSQL row is flagged is_archived = TRUE');
  assert(dbArchived.rows[0]?.status === 'Archived', 'PostgreSQL row status is Archived', `got ${dbArchived.rows[0]?.status}`);
  assert(typeof dbArchived.rows[0]?.archive_reason === 'string' && dbArchived.rows[0]!.archive_reason.includes('archive verification'), 'Archive reason is persisted for the audit trail', `got ${dbArchived.rows[0]?.archive_reason}`);

  const resDetail = await fetch(`${BASE_URL}/parcels/${FIXTURE_ID}`, { headers: jsonHeaders(tehsildarToken) });
  const detailBody = (await resDetail.json()) as any;
  assert(resDetail.status === 200 && detailBody.data?.parcel?.status === 'Archived', 'GET /api/parcels/:id shows the archived parcel as Archived', `got ${detailBody.data?.parcel?.status}`);
  assert(Array.isArray(detailBody.data?.parcel?.inspections), 'Parcel detail nests inspections inside data.parcel');

  const resActive = await fetch(`${BASE_URL}/parcels`, { headers: jsonHeaders(tehsildarToken) });
  const activeBody = (await resActive.json()) as any;
  assert(!(activeBody.data?.parcels || []).some((p: any) => p.id === FIXTURE_ID), 'Archived parcel is excluded from the default active list');

  const resIncludeArchived = await fetch(`${BASE_URL}/parcels?includeArchived=true`, { headers: jsonHeaders(tehsildarToken) });
  const includedBody = (await resIncludeArchived.json()) as any;
  assert((includedBody.data?.parcels || []).some((p: any) => p.id === FIXTURE_ID), 'includeArchived=true returns the archived parcel');

  const dbArchiveAudit = await pool.query(
    "SELECT count(*)::int AS n FROM append_only_audit_logs WHERE parcel_id = $1 AND action_type = 'PARCEL_ARCHIVED'",
    [FIXTURE_ID]
  );
  const archiveAuditDelta = (dbArchiveAudit.rows[0]?.n ?? 0) - (archiveAuditBefore.rows[0]?.n ?? 0);
  assert(archiveAuditDelta === 1, 'PARCEL_ARCHIVED entry was appended to the durable audit chain', `delta=${archiveAuditDelta}`);

  // 9. CLEANUP — hard delete only the row this suite created; seeded records stay untouched.
  console.log('\n9. CLEANUP');
  const cleanup = await pool.query('DELETE FROM parcels WHERE id = $1', [FIXTURE_ID]);
  assert(cleanup.rowCount === 1, 'Fixture parcel removed (scoped to the id this suite created)', `rowCount=${cleanup.rowCount}`);
  const residueOwners = await pool.query('SELECT count(*)::int AS n FROM parcel_owners WHERE parcel_id = $1', [FIXTURE_ID]);
  assert(residueOwners.rows[0]?.n === 0, 'Cascade removed the fixture co-sharer rows');
  // Scoped to live rows, not to the whole table: other suites archive their fixtures deliberately
  // (land records are archived rather than deleted), so an absolute row count would fail over
  // history this suite did not write. What must be zero is an *unarchived* parcel nobody seeded.
  const residue = await pool.query(
    `SELECT coalesce(array_agg(id ORDER BY id), '{}')::text[] AS ids
       FROM parcels WHERE is_archived = false AND NOT (id = ANY($1::text[]))`,
    [SEED_PARCEL_IDS]
  );
  assert(residue.rows[0]?.ids.length === 0, 'No unarchived parcel remains beyond the three seeded ones', JSON.stringify(residue.rows[0]?.ids));
  const seedsPresent = await pool.query('SELECT count(*)::int AS n FROM parcels WHERE id = ANY($1::text[])', [SEED_PARCEL_IDS]);
  assert(seedsPresent.rows[0]?.n === SEED_PARCEL_IDS.length, 'The three seeded parcels survived the whole suite intact', `count=${seedsPresent.rows[0]?.n}`);

  console.log('\n================================================================');
  console.log(`  BACKEND REST TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    throw new Error(`${failedCount} assertion(s) failed in the backend REST suite.`);
  }
}

runBackendTests()
  .then(() => {
    console.log('Backend REST suite passed.');
    if (server) server.close();
    return pool.end().finally(() => process.exit(0));
  })
  .catch(async (err) => {
    console.error('[TEST] Backend REST suite FAILED:', err instanceof Error ? err.message : err);
    if (server) server.close();
    await pool.end().catch(() => {});
    process.exit(1);
  });
