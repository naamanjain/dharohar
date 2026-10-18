/**
 * DHAROHAR Phase 4 Automated Backend Test Suite
 * 
 * Verifies:
 * 1. Authentication (JWT token issuance, verification, bad credentials, expired tokens)
 * 2. Role-Based Access Control (RBAC: Tehsildar vs. Patwari vs. Operator)
 * 3. Authoritative Cadastral Validation (0.96 ha vs 0.82 ha discrepancy, 100% ownership, mandatory fields)
 * 4. Append-Only Cryptographic Audit Trail & SHA-256 Hash Chaining
 * 5. Field Inspection & Official Verification Sealing
 * 6. Parcel & Document CRUD & search/filtering
 */

import { app } from './index';
import { seedDatabase } from './db/seed';
import { getAuditLogs, verifyAuditChain } from './services/auditService';
import { validateParcel } from './services/validationService';
import { createJwtToken, verifyJwtToken, hashPassword, verifyPassword, sha256 } from './utils/crypto';
import http from 'http';

let server: http.Server;
const PORT = 3099;

const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints.');
  process.exit(2);
}
const BASE_URL = `http://localhost:${PORT}/api`;

async function runPhase4Tests() {
  console.log('================================================================');
  console.log('  DHAROHAR Phase 4: Authoritative Backend & Security Test Suite ');
  console.log('================================================================\n');

  // Start local test server
  await seedDatabase();
  server = app.listen(PORT);

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

  try {
    // -------------------------------------------------------------
    // 1. CRYPTO & TOKEN UTILITIES
    // -------------------------------------------------------------
    console.log('1. CRYPTOGRAPHIC & TOKEN ENGINE');
    const testSalt = 'test_salt_123';
    const pwdHash = hashPassword('MySecretPassword@2026', testSalt);
    assert(verifyPassword('MySecretPassword@2026', pwdHash.hash, testSalt), 'PBKDF2 Password verification with valid password');
    assert(!verifyPassword('WrongPassword', pwdHash.hash, testSalt), 'PBKDF2 Password verification rejects wrong password');

    const sampleJwt = createJwtToken({
      userId: 'USR-TEH-01',
      email: 'tehsildar@dharohar.local',
      role: 'TEHSILDAR',
      displayName: 'Shri Arvind Sharma, RAS',
      badgeNumber: 'RJ-REV-2018-0941',
      district: 'Jaipur',
    });
    assert(Boolean(sampleJwt && sampleJwt.split('.').length === 3), 'JWT creation produces valid 3-part HMAC-SHA256 token');

    const decodedJwt = verifyJwtToken(sampleJwt);
    assert(decodedJwt !== null && decodedJwt.role === 'TEHSILDAR', 'JWT verification successfully decodes payload and verifies role');
    assert(verifyJwtToken('invalid.token.signature') === null, 'JWT verification rejects forged/malformed token');

    // -------------------------------------------------------------
    // 2. AUTHENTICATION ENDPOINTS
    // -------------------------------------------------------------
    console.log('\n2. AUTHENTICATION ENDPOINTS (POST /api/auth/login, GET /api/auth/me)');

    // 2.1 Tehsildar Login
    const tehLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tehsildar@dharohar.local', password: DEMO_PASSWORD }),
    });
    const tehLoginData = await tehLoginRes.json();
    assert(tehLoginRes.status === 200 && tehLoginData.success === true, 'Tehsildar login returns HTTP 200 and success=true');
    assert(Boolean(tehLoginData.data?.token), 'Tehsildar login returns signed JWT access token');
    assert(tehLoginData.data?.user?.role === 'TEHSILDAR', 'Tehsildar user profile returns TEHSILDAR role');
    const tehsildarToken = tehLoginData.data?.token;

    // 2.2 Patwari Login
    const patLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'patwari@dharohar.local', password: DEMO_PASSWORD }),
    });
    const patLoginData = await patLoginRes.json();
    assert(patLoginRes.status === 200 && patLoginData.data?.user?.role === 'PATWARI', 'Patwari login returns PATWARI role');
    const patwariToken = patLoginData.data?.token;

    // 2.3 Data Entry Operator Login
    const oprLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'operator@dharohar.local', password: DEMO_PASSWORD }),
    });
    const oprLoginData = await oprLoginRes.json();
    assert(oprLoginRes.status === 200 && oprLoginData.data?.user?.role === 'DATA_ENTRY_OPERATOR', 'Operator login returns DATA_ENTRY_OPERATOR role');
    const operatorToken = oprLoginData.data?.token;

    // 2.4 Bad credentials
    const badLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tehsildar@dharohar.local', password: 'WrongPassword999' }),
    });
    assert(badLoginRes.status === 401, 'Login with incorrect password returns HTTP 401');

    // 2.5 Auth Me endpoint
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.data?.user?.email === 'tehsildar@dharohar.local', 'GET /api/auth/me returns authenticated officer info');

    const unauthMeRes = await fetch(`${BASE_URL}/auth/me`, { method: 'GET' });
    assert(unauthMeRes.status === 401, 'GET /api/auth/me without Bearer token returns HTTP 401');

    // -------------------------------------------------------------
    // 3. SERVER-AUTHORITATIVE VALIDATION ENGINE
    // -------------------------------------------------------------
    console.log('\n3. SERVER-AUTHORITATIVE VALIDATION (POST /api/parcels/:id/validate)');

    // 3.1 Primary Discrepancy Demo Parcel DH-UDA-KOT-001117
    //
    // The district of the parcel and the district in the officer's token must match: DHAROHAR now
    // enforces jurisdiction on every read and write, so a Jaipur Tehsildar validating an Udaipur
    // parcel is answered 404. The Udaipur DATA_ENTRY_OPERATOR is the correct caller for a
    // validation run (the endpoint has no role gate, only the read-only gate + jurisdiction).
    const valDiscrepancyRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
    });
    const valDiscrepancyData = await valDiscrepancyRes.json();
    assert(valDiscrepancyRes.status === 200 && valDiscrepancyData.success === true, 'Validation endpoint executes successfully');
    
    const areaVal = valDiscrepancyData.data?.areaValidation;
    assert(areaVal?.mappedAreaHa === 0.82, `Mapped area is authoritative (0.82 ha) - got ${areaVal?.mappedAreaHa}`);
    assert(areaVal?.recordedAreaHa === 0.96, `Recorded area is authoritative (0.96 ha) - got ${areaVal?.recordedAreaHa}`);
    assert(areaVal?.differenceHa === 0.14, `Area difference accurately computed as 0.14 ha - got ${areaVal?.differenceHa}`);
    assert(areaVal?.hasDiscrepancy === true, 'Discrepancy flag is TRUE for 0.14 ha delta');
    assert(areaVal?.status === 'AREA_MISMATCH_REQUIRES_FIELD_INSPECTION', 'Area status is AREA_MISMATCH_REQUIRES_FIELD_INSPECTION');

    const ownVal = valDiscrepancyData.data?.ownershipValidation;
    assert(ownVal?.totalSharePercentage === 100.0, 'Ownership shares equal exactly 100.00%');
    assert(valDiscrepancyData.data?.checklist?.length >= 7, 'Validation checklist contains all required check items');

    // Same parcel, an officer from another district: denied as 404, not 403, so the response does
    // not confirm that the Udaipur parcel exists.
    const valForeignRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
    });
    assert(valForeignRes.status === 404, `Cross-district validation denied (HTTP ${valForeignRes.status}, expected 404)`);

    // 3.2 Verified Demo Parcel DH-JPR-RAM-001024
    const valVerifiedRes = await fetch(`${BASE_URL}/parcels/DH-JPR-RAM-001024/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
    });
    const valVerifiedData = await valVerifiedRes.json();
    assert(valVerifiedData.data?.cadastralFieldsValidation?.khasraNo === true, 'Khasra 412/1 validated');
    assert(valVerifiedData.data?.cadastralFieldsValidation?.khataNo === true, 'Khata 78 validated');
    assert(valVerifiedData.data?.ownershipValidation?.totalSharePercentage === 100.0, 'Co-sharer total share is 100%');

    // -------------------------------------------------------------
    // 4. ROLE-BASED ACCESS CONTROL (RBAC) GUARDS
    // -------------------------------------------------------------
    console.log('\n4. ROLE-BASED ACCESS CONTROL (RBAC)');

    // 4.1 Data Entry Operator attempted sealing -> MUST BE 403 FORBIDDEN
    const oprSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        parcelId: 'DH-UDA-KOT-001117',
        officerNotes: 'Unauthorized seal attempt',
      }),
    });
    assert(oprSealRes.status === 403, 'Data Entry Operator denied final sealing (HTTP 403 Forbidden)');

    // 4.2 Operator attempted field inspection on parcel endpoint -> MUST BE 403 FORBIDDEN
    const oprInspRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/field-inspections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        gpsCoords: { latitude: 26.845, longitude: 75.785 },
        checkpoints: [{ id: 'cp1', name: 'Boundary Stone', passed: true }],
      }),
    });
    assert(oprInspRes.status === 403, 'Data Entry Operator denied field inspection submission (HTTP 403 Forbidden)');

    // 4.3 Patwari allowed field inspection -> MUST BE 201 CREATED
    // Run against the parcel in the Patwari's own district (Jodhpur); the Udaipur parcel is outside
    // their jurisdiction and would be refused before the role check ever applied.
    const patInspRes = await fetch(`${BASE_URL}/parcels/DH-JOD-OSI-001245/field-inspections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patwariToken}`,
      },
      body: JSON.stringify({
        gpsCoords: { latitude: 26.302, longitude: 22.885, accuracyMeters: 2.1 },
        deviceHeadingDeg: 142.5,
        discrepancyObserved: true,
        discrepancyNotes: 'Boundary stone at north corner confirmed 0.14 ha encroachment by canal embankment.',
        checkpoints: [
          { id: 'cp-1', name: 'North Boundary Stone', passed: false },
          { id: 'cp-2', name: 'South Road Edge', passed: true },
        ],
      }),
    });
    const patInspData = await patInspRes.json();
    assert(patInspRes.status === 201 && patInspData.success === true, 'Patwari permitted to submit field inspection (HTTP 201 Created)');
    assert(Boolean(patInspData.data?.inspection?.evidenceHash), 'Field inspection generates cryptographic SHA-256 evidenceHash');

    // 4.4 Patwari attempted sealing -> MUST BE 403 FORBIDDEN
    const patSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patwariToken}`,
      },
      body: JSON.stringify({
        parcelId: 'DH-JOD-OSI-001245',
        officerNotes: 'Patwari seal attempt',
      }),
    });
    assert(patSealRes.status === 403, 'Patwari denied final sealing without Tehsildar role (HTTP 403 Forbidden)');

    // 4.5 Tehsildar allowed verification & digital sealing -> MUST BE 200 OK
    //
    // Sealing a record the suite created inside the sealing officer's own district. Neither demo
    // parcel can demonstrate a first successful seal any more: the Udaipur one is outside the
    // Tehsildar's jurisdiction (refused 404) and DH-JPR-RAM-001024 is already sealed (refused 409).
    const sealTargetId = `DH-JPR-SEAL-${Date.now()}`;
    // Run-scoped khasra: parcels carry a unique (khasra_no, village, district, tehsil) identity, and
    // a fixed one here collided with another suite's fixture on the second run against the same
    // database. A fixture that cannot be created twice is a fixture that fails for the wrong reason.
    const sealKhasra = `999/${Date.now() % 1000000}`;
    const sealTargetRes = await fetch(`${BASE_URL}/parcels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({
        id: sealTargetId,
        khasraNo: sealKhasra,
        khataNo: '45',
        khewatNo: '12',
        patwarCircle: 'Sanganer South',
        district: 'Jaipur',
        tehsil: 'Sanganer',
        village: 'Rampur',
        mappedAreaHectares: 1.0,
        recordedAreaHectares: 1.0,
        ownerName: 'Seal Fixture Co-sharer',
        boundary: [
          { lat: 26.9, lng: 75.8 },
          { lat: 26.9, lng: 75.81 },
          { lat: 26.89, lng: 75.81 },
          { lat: 26.89, lng: 75.8 },
        ],
      }),
    });
    assert(sealTargetRes.status === 201, `Seal-target parcel created in the Tehsildar's own district (HTTP ${sealTargetRes.status})`);

    const tehSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({
        parcelId: sealTargetId,
        officerNotes: 'Reviewed Patwari field inspection notes. Provisional boundary validated under Section 133.',
      }),
    });
    const tehSealData = await tehSealRes.json();
    assert(
      tehSealRes.status === 200 && tehSealData.success === true,
      'Tehsildar authorized to digitally seal record (HTTP 200 OK)',
      `HTTP ${tehSealRes.status} ${JSON.stringify(tehSealData?.error ?? tehSealData?.message ?? tehSealData)}`
    );
    assert(Boolean(tehSealData.data?.certificateNumber), `Generated certificate number: ${tehSealData.data?.certificateNumber}`);
    assert(Boolean(tehSealData.data?.signatureHash), 'Generated deterministic SHA-256 digital signature hash');

    // The same officer sealing a parcel in a different district is refused with 404 — this is the
    // assertion the pre-isolation suite used as a *success* case on DH-UDA-KOT-001117.
    const crossSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({ parcelId: 'DH-UDA-KOT-001117', officerNotes: 'Cross-district seal attempt' }),
    });
    assert(crossSealRes.status === 404, `Cross-district seal denied (HTTP ${crossSealRes.status}, expected 404)`);

    // -------------------------------------------------------------
    // 5. APPEND-ONLY AUDIT TRAIL & HASH CHAINING
    // -------------------------------------------------------------
    console.log('\n5. APPEND-ONLY CRYPTOGRAPHIC AUDIT LOGS (GET /api/verifications/audit-logs)');

    const auditUnauthRes = await fetch(`${BASE_URL}/verifications/audit-logs`);
    assert(auditUnauthRes.status === 401, 'Audit log endpoint refuses unauthenticated reads (HTTP 401)');

    const auditRes = await fetch(`${BASE_URL}/verifications/audit-logs`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const auditData = await auditRes.json();
    assert(auditRes.status === 200 && auditData.success === true, 'Audit log endpoint returns HTTP 200');
    assert(auditData.data?.total > 0, `Total audit records recorded: ${auditData.data?.total}`);

    // Verify cryptographic chain
    const chainVerification = await verifyAuditChain();
    assert(chainVerification.isValid === true, 'Audit log SHA-256 cryptographic hash chain is unbroken and 100% verified');
    console.log(`     Chain verification message: "${chainVerification.message}"`);

    // Verify parcel-specific audit trail — on the parcel this suite actually exercised from inside
    // its own district (validation + seal both landed on the Jaipur record).
    const parcelAuditRes = await fetch(`${BASE_URL}/parcels/DH-JPR-RAM-001024/audit`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const parcelAuditData = await parcelAuditRes.json();
    assert(parcelAuditRes.status === 200, `Home-district parcel audit trail readable (HTTP ${parcelAuditRes.status})`);
    // Asserted by content rather than by a count. `total >= 2` was only ever satisfied on a database
    // that had been run against before: DH-JPR-RAM-001024 arrives from the seed already sealed, and a
    // seeded state has no chain entry behind it, so one clean run leaves exactly the validation event.
    const homeActions: string[] = (parcelAuditData.data?.auditLogs || []).map((e: any) => e.actionType || e.action_type);
    assert(homeActions.includes('VALIDATION_EXECUTED'), 'The validation this run performed is recorded on the parcel it validated', `actions: ${homeActions.join(', ') || 'none'}`);

    // And the seal this run actually applied — on the record it created for the purpose, because the
    // demo parcel is already sealed and a second seal is correctly refused — must be in its trail.
    const sealedTrailRes = await fetch(`${BASE_URL}/parcels/${sealTargetId}/audit`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const sealedTrail = await sealedTrailRes.json();
    const sealedActions: string[] = (sealedTrail.data?.auditLogs || []).map((e: any) => e.actionType || e.action_type);
    assert(sealedActions.includes('RECORD_SEALED'), 'The seal this run applied is recorded on the record it sealed', `actions: ${sealedActions.join(', ') || 'none'}`);

    // Another district's audit trail is not readable at all.
    const foreignAuditRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/audit`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    assert(foreignAuditRes.status === 404, `Cross-district audit read denied (HTTP ${foreignAuditRes.status}, expected 404)`);

    // -------------------------------------------------------------
    // 6. PARCEL CRUD & SOFT-DELETE ARCHIVE
    // -------------------------------------------------------------
    console.log('\n6. PARCEL REGISTRY CRUD & SOFT-DELETE');

    // 6.1 Create new parcel
    //
    // The khasra number varies per run because parcels carry a unique (khasra_no, village, district,
    // tehsil) identity and an ARCHIVED fixture still occupies its identity — so a fixed value made the
    // second run of this suite collide with its own archived record.
    const crudKhasra = `888/${Date.now() % 1000000}`;
    const createParcelRes = await fetch(`${BASE_URL}/parcels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({
        khasraNo: crudKhasra,
        khataNo: '190',
        district: 'Jaipur',
        tehsil: 'Sanganer',
        village: 'Rampur',
        mappedAreaHectares: 1.10,
        recordedAreaHectares: 1.10,
        ownerName: 'Ram Lal',
        boundary: [
          { lat: 26.840, lng: 75.780 },
          { lat: 26.842, lng: 75.785 },
          { lat: 26.839, lng: 75.788 },
          { lat: 26.837, lng: 75.782 },
        ],
      }),
    });
    const createParcelData = await createParcelRes.json();
    assert(createParcelRes.status === 201 && createParcelData.success === true, 'Parcel creation succeeds (HTTP 201)');
    const createdId = createParcelData.data?.parcel?.id;

    // 6.2 Filter / Search
    const searchRes = await fetch(`${BASE_URL}/parcels?search=${encodeURIComponent(crudKhasra)}`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const searchData = await searchRes.json();
    assert(searchData.data?.parcels?.some((p: any) => p.id === createdId), `Parcel search by Khasra ${crudKhasra} finds created parcel`);

    // 6.3 Soft-delete / Archive
    const archiveRes = await fetch(`${BASE_URL}/parcels/${createdId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({ reason: 'Test parcel archiving' }),
    });
    const archiveData = await archiveRes.json();
    assert(archiveRes.status === 200 && archiveData.data?.isArchived === true, 'DELETE soft-archives parcel without permanent destruction');

    // -------------------------------------------------------------
    // 4.9 CLEANUP — archive the record this suite sealed
    // -------------------------------------------------------------
    // A sealed fixture left live is worse than a slow test: it occupies a cadastral identity, shows
    // up in the registry an officer reads, and makes the residue checks in other suites fail for a
    // record nobody seeded. Archiving (never deleting) is what the application itself does with a
    // record that is finished with.
    const sealCleanupRes = await fetch(`${BASE_URL}/parcels/${sealTargetId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({ reason: `Phase 4 run ${sealTargetId}: seal fixture archived after verification` }),
    });
    assert(sealCleanupRes.status === 200, 'Seal fixture archived after the run (HTTP 200)');

    // -------------------------------------------------------------
    // 7. SUMMARY
    // -------------------------------------------------------------
    console.log('\n================================================================');
    console.log(`  PHASE 4 TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
    console.log('================================================================\n');

    if (failedCount > 0) {
      throw new Error(`${failedCount} test(s) failed in Phase 4 suite.`);
    }
  } finally {
    server.close();
  }
}

runPhase4Tests()
  .then(() => {
    console.log('Phase 4 verification completed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Phase 4 verification error:', err);
    if (server) server.close();
    process.exit(1);
  });
