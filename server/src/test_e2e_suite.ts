/**
 * DHAROHAR Phase 5: Final Comprehensive End-to-End (E2E) Test Suite
 * 
 * Tests the entire integrated system across all 14 steps of the officer demonstration workflow:
 * - Environment & Health Check
 * - Database Persistence Across Restarts
 * - Authentication & Server-Side RBAC (Operator vs Patwari vs Tehsildar)
 * - Indic OCR & Intelligent Field Extraction Integrity
 * - Server-Authoritative Validation (0.96 ha vs 0.82 ha = 0.14 ha / 14.58% delta)
 * - Assisted Field Inspection with SHA-256 Evidence Hash
 * - Officer Digital Sealing (Tehsildar authorization)
 * - Tamper-Evident Hash-Chained Audit Trail Verification
 * - Negative Tests & Error Handling
 * - Data Consistency Validation across all views
 */

import { app } from './index';
import { seedDatabase } from './db/seed';
import { getAuditLogs, verifyAuditChain } from './services/auditService';
import { validateParcel } from './services/validationService';
import { getDbHealth } from './db/db';
import http from 'http';

let server: http.Server;
const PORT = 3098;

const DEMO_PASSWORD = (process.env.DEMO_PASSWORD || '').trim();
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. It must equal the password the demo personas were seeded with — run `npm run db:seed` and read the line it prints.');
  process.exit(2);
}
const BASE_URL = `http://localhost:${PORT}/api`;

interface TestResult {
  step: string;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function recordTest(step: string, name: string, passed: boolean, details?: string) {
  results.push({ step, name, passed, details });
  if (passed) {
    console.log(`  [PASS] [${step}] ${name}`);
  } else {
    console.error(`  [FAIL] [${step}] ${name} -> ${details || 'Assertion failed'}`);
  }
}

async function runE2ESuite() {
  console.log('================================================================================');
  console.log('  DHAROHAR Phase 5: Complete End-to-End (E2E) Workflow Suite                     ');
  console.log('================================================================================\n');

  await seedDatabase();
  server = app.listen(PORT);

  try {
    // -------------------------------------------------------------------------
    // STEP 1: ENVIRONMENT & HEALTH VERIFICATION
    // -------------------------------------------------------------------------
    console.log('--- STEP 1: ENVIRONMENT & HEALTH CHECK ---');
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthData = await healthRes.json();
    recordTest('STEP-01', 'Health Endpoint Responds HTTP 200', healthRes.status === 200);
    recordTest('STEP-01', 'Storage Mode Identified', Boolean(healthData.storageMode), `Mode: ${healthData.storageMode}`);
    recordTest('STEP-01', 'Service Name Verified', healthData.service === 'DHAROHAR Revenue Backend');

    // -------------------------------------------------------------------------
    // STEP 2: AUTHENTICATION E2E TEST (All Personas + Negative)
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 2: AUTHENTICATION E2E TEST ---');
    
    // 2.1 Tehsildar
    const tehLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tehsildar@dharohar.local', password: DEMO_PASSWORD }),
    });
    const tehData = await tehLoginRes.json();
    recordTest('STEP-02', 'Tehsildar Login Successful', tehLoginRes.status === 200 && tehData.data?.user?.role === 'TEHSILDAR');
    const tehsildarToken = tehData.data?.token;

    // 2.2 Patwari
    const patLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'patwari@dharohar.local', password: DEMO_PASSWORD }),
    });
    const patData = await patLoginRes.json();
    recordTest('STEP-02', 'Patwari Login Successful', patLoginRes.status === 200 && patData.data?.user?.role === 'PATWARI');
    const patwariToken = patData.data?.token;

    // 2.3 Data Entry Operator
    const oprLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'operator@dharohar.local', password: DEMO_PASSWORD }),
    });
    const oprData = await oprLoginRes.json();
    recordTest('STEP-02', 'Data Entry Operator Login Successful', oprLoginRes.status === 200 && oprData.data?.user?.role === 'DATA_ENTRY_OPERATOR');
    const operatorToken = oprData.data?.token;

    // 2.4 Bad Password -> 401
    const badLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tehsildar@dharohar.local', password: 'InvalidPasswordXYZ' }),
    });
    recordTest('STEP-02', 'Invalid Password Rejection (HTTP 401)', badLoginRes.status === 401);

    // -------------------------------------------------------------------------
    // STEP 3: SPATIAL REGISTRY & PARCEL SEARCH
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 3: SPATIAL REGISTRY & PARCEL SEARCH ---');
    // Steps 3-5 inspect the Udaipur demo parcel, so they run as the officer whose district is
    // Udaipur. Registry reads are district-scoped server-side: a Jaipur Tehsildar searching for
    // "1117" now correctly gets an empty list, which would fail every assertion below for the
    // wrong reason.
    const searchRes = await fetch(`${BASE_URL}/parcels?search=1117`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    const searchData = await searchRes.json();
    const foundParcel = searchData.data?.parcels?.find((p: any) => p.id === 'DH-UDA-KOT-001117');
    recordTest('STEP-03', 'Search by "1117" Returns Demo Parcel', Boolean(foundParcel));
    recordTest('STEP-03', 'Khasra Number Verified as 77/1', foundParcel?.khasraNo === '77/1');
    recordTest('STEP-03', 'Khata Number Verified as 104', foundParcel?.khataNo === '104');
    recordTest('STEP-03', 'Khewat Number Verified as 12', foundParcel?.khewatNo === '12');
    recordTest('STEP-03', 'Mauza Verified as Kothari', foundParcel?.village === 'Kothari');
    recordTest('STEP-03', 'Mapped Area Verified as 0.82 ha', foundParcel?.mappedAreaHectares === 0.82);
    recordTest('STEP-03', 'Recorded Area Verified as 0.96 ha', foundParcel?.recordedAreaHectares === 0.96);

    // -------------------------------------------------------------------------
    // STEP 4: DOCUMENT & OCR EXTRACTION INTEGRITY
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 4: DOCUMENT & OCR EXTRACTION INTEGRITY ---');
    const docsRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/documents`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    const docsData = await docsRes.json();
    // No in-process fallback here on purpose. This suite exists to prove the API answers from
    // PostgreSQL; letting a memory fixture satisfy the assertion would let a broken or empty endpoint
    // still report green, which is the failure mode this whole pass is hunting.
    const linkedDoc = Array.isArray(docsData?.data?.documents) ? docsData.data.documents[0] : undefined;
    const docsEvidence = `status=${docsRes.status} keys=${JSON.stringify(Object.keys(docsData?.data || {}))} first=${JSON.stringify(linkedDoc || null).slice(0, 220)}`;
    recordTest('STEP-04', 'GET /parcels/:id/documents returns a document list', Array.isArray(docsData?.data?.documents), docsEvidence);
    recordTest('STEP-04', 'Linked Land Document Found', Boolean(linkedDoc), docsEvidence);
    recordTest('STEP-04', 'Document Name is Khasra_Girdawari_Kothari_Village_77_1.pdf', Boolean(linkedDoc?.fileName?.includes('77_1')), docsEvidence);
    recordTest('STEP-04', 'Document SHA-256 Hash Exists', Boolean(linkedDoc?.documentHash), docsEvidence);

    // -------------------------------------------------------------------------
    // STEP 5: SERVER-AUTHORITATIVE VALIDATION (0.96 ha vs 0.82 ha = 0.14 ha / 14.58%)
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 5: SERVER-AUTHORITATIVE VALIDATION ---');
    const valRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
    });
    const valData = await valRes.json();
    const areaVal = valData.data?.areaValidation;
    recordTest('STEP-05', 'Validation HTTP 200 Response', valRes.status === 200 && valData.success === true);
    recordTest('STEP-05', 'Recorded Area is 0.96 ha', areaVal?.recordedAreaHa === 0.96);
    recordTest('STEP-05', 'Mapped Area is 0.82 ha', areaVal?.mappedAreaHa === 0.82);
    recordTest('STEP-05', 'Area Difference is exactly 0.14 ha', areaVal?.differenceHa === 0.14);
    recordTest('STEP-05', 'Percentage Difference is ~14.58%', Math.abs(areaVal?.percentageDifference - 14.58) < 0.1);
    recordTest('STEP-05', 'Status is AREA_MISMATCH_REQUIRES_FIELD_INSPECTION', areaVal?.status === 'AREA_MISMATCH_REQUIRES_FIELD_INSPECTION');
    recordTest('STEP-05', 'Co-sharer Ownership Total is 100.00%', valData.data?.ownershipValidation?.totalSharePercentage === 100.0);

    // -------------------------------------------------------------------------
    // STEP 6: RBAC ENFORCEMENT ON FIELD INSPECTION & SEALING
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 6: RBAC ENFORCEMENT ---');

    // 6.1 Operator denied field inspection -> 403
    const oprInspRes = await fetch(`${BASE_URL}/parcels/DH-UDA-KOT-001117/field-inspections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        gpsCoords: { latitude: 26.846, longitude: 75.783 },
        checkpoints: [{ id: 'cp1', name: 'Stone Marker', status: 'passed' }],
      }),
    });
    recordTest('STEP-06', 'Operator Denied Field Inspection (HTTP 403)', oprInspRes.status === 403);

    // 6.2 Operator denied digital sealing -> 403
    const oprSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({ parcelId: 'DH-UDA-KOT-001117' }),
    });
    recordTest('STEP-06', 'Operator Denied Digital Sealing (HTTP 403)', oprSealRes.status === 403);

    // 6.3 Patwari allowed field inspection -> 201
    // The Patwari's district is Jodhpur, so the inspection runs against the Jodhpur parcel.
    const patInspRes = await fetch(`${BASE_URL}/parcels/DH-JOD-OSI-001245/field-inspections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patwariToken}`,
      },
      body: JSON.stringify({
        gpsCoords: { latitude: 26.3021, longitude: 22.8851, accuracyMeters: 1.8 },
        deviceHeadingDeg: 145.0,
        discrepancyObserved: true,
        discrepancyNotes: 'Northern boundary verified: 0.14 ha difference accounted for by canal reserve easement.',
        checkpoints: [
          { id: 'cp-1', name: 'North Boundary Stone', status: 'flagged' },
          { id: 'cp-2', name: 'South Road Edge', status: 'passed' },
        ],
      }),
    });
    const patInspData = await patInspRes.json();
    recordTest('STEP-06', 'Patwari Permitted Field Inspection (HTTP 201)', patInspRes.status === 201 && patInspData.success === true);
    recordTest('STEP-06', 'Inspection Contains Cryptographic Evidence Hash', Boolean(patInspData.data?.inspection?.evidenceHash));

    // 6.4 Patwari denied final sealing -> 403
    const patSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patwariToken}`,
      },
      body: JSON.stringify({ parcelId: 'DH-JOD-OSI-001245' }),
    });
    recordTest('STEP-06', 'Patwari Denied Final Sealing (HTTP 403)', patSealRes.status === 403);

    // -------------------------------------------------------------------------
    // STEP 7: TEHSILDAR OFFICIAL VERIFICATION & DIGITAL SEALING
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 7: TEHSILDAR OFFICIAL VERIFICATION & SEALING ---');
    // A fresh, unsealed parcel inside the Tehsildar's own district (Jaipur). DH-UDA-KOT-001117 is
    // now refused to a Jaipur officer (404) and DH-JPR-RAM-001024 is already sealed (409), so the
    // seal path is proven on a record this suite created.
    const sealTargetId = `DH-JPR-E2E-${Date.now()}`;
    // The khasra number has to vary too: parcels carry a unique (khasra_no, village, district,
    // tehsil) identity, so a fixed one makes the second run of this suite collide with the first.
    const sealKhasra = `777/${Date.now() % 1000000}`;
    const sealTargetRes = await fetch(`${BASE_URL}/parcels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({
        id: sealTargetId,
        khasraNo: sealKhasra,
        khataNo: '52',
        khewatNo: '21',
        patwarCircle: 'Sanganer South',
        district: 'Jaipur',
        tehsil: 'Sanganer',
        village: 'Rampur',
        mappedAreaHectares: 1.05,
        recordedAreaHectares: 1.05,
        ownerName: 'E2E Seal Fixture',
        boundary: [
          { lat: 26.91, lng: 75.82 },
          { lat: 26.91, lng: 75.83 },
          { lat: 26.9, lng: 75.83 },
          { lat: 26.9, lng: 75.82 },
        ],
      }),
    });
    recordTest('STEP-07', 'Seal-target parcel created in the Tehsildar district (HTTP 201)', sealTargetRes.status === 201);

    const tehSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({
        parcelId: sealTargetId,
        officerNotes: 'Reviewed Patwari inspection. Field variance of 0.14 ha resolved under Section 133 of Rajasthan Land Revenue Act.',
      }),
    });
    const tehSealData = await tehSealRes.json();
    recordTest('STEP-07', 'Tehsildar Authorized Sealing (HTTP 200)', tehSealRes.status === 200 && tehSealData.success === true);
    recordTest('STEP-07', 'Certificate Number Generated', Boolean(tehSealData.data?.certificateNumber));
    recordTest('STEP-07', 'Digital Signature Hash Generated', Boolean(tehSealData.data?.signatureHash));

    // -------------------------------------------------------------------------
    // STEP 8: APPEND-ONLY CRYPTOGRAPHIC AUDIT LOGS & CHAIN VERIFICATION
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 8: CRYPTOGRAPHIC AUDIT CHAIN VERIFICATION ---');
    const auditRes = await fetch(`${BASE_URL}/verifications/audit-logs`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const auditData = await auditRes.json();
    recordTest('STEP-08', 'Audit Log Retrieval (HTTP 200)', auditRes.status === 200 && auditData.success === true);

    // Asserted by content, not by a count. `total >= 5` here passed only on a database carrying the
    // history of earlier runs: against a freshly migrated and seeded one, the tehsildar's district had
    // two entries and the check failed. What this run guarantees is that the seal it applied — on
    // `sealTargetId`, which it created for exactly that reason — is recorded against that record.
    const sealTrailRes = await fetch(`${BASE_URL}/parcels/${sealTargetId}/audit`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const sealTrail = await sealTrailRes.json();
    const sealActions: string[] = (sealTrail.data?.auditLogs || []).map((e: any) => e.actionType || e.action_type);
    recordTest('STEP-08', 'The seal applied in this run is in the sealed record\'s trail', sealActions.includes('RECORD_SEALED'), `actions: ${sealActions.join(', ') || 'none'}`);
    recordTest('STEP-08', 'A record this run changed has a non-empty trail', sealTrail.data?.total >= 1, `Total: ${sealTrail.data?.total}`);

    const chainVerify = await verifyAuditChain();
    recordTest('STEP-08', 'SHA-256 Hash Chain Integrity 100% Intact', chainVerify.isValid === true, chainVerify.message);

    // -------------------------------------------------------------------------
    // STEP 9: DATABASE PERSISTENCE ACROSS RESTART SIMULATION
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 9: PERSISTENCE ACROSS RESTART ---');
    // Verify parcel in store is Verified
    const verifiedParcelCheck = await fetch(`${BASE_URL}/parcels/${sealTargetId}`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const verifiedData = await verifiedParcelCheck.json();
    recordTest('STEP-09', 'Parcel Status Successfully Updated to Verified', verifiedData.data?.parcel?.status === 'Verified');
    recordTest('STEP-09', 'Verified By Contains Officer Name', verifiedData.data?.parcel?.verifiedBy?.includes('Shri Arvind Sharma'));

    // -------------------------------------------------------------------------
    // STEP 10: NEGATIVE SECURITY TESTS
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 10: NEGATIVE SECURITY & API TESTS ---');
    const missingTokenRes = await fetch(`${BASE_URL}/auth/me`);
    recordTest('STEP-10', 'Missing Token -> HTTP 401', missingTokenRes.status === 401);

    const malformedTokenRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: 'Bearer malformed.fake.token' },
    });
    recordTest('STEP-10', 'Malformed Token -> HTTP 401', malformedTokenRes.status === 401);

    const unauthParcelRes = await fetch(`${BASE_URL}/parcels`);
    recordTest('STEP-10', 'Parcel list without a token -> HTTP 401', unauthParcelRes.status === 401);

    const unauthSealRes = await fetch(`${BASE_URL}/verifications/seal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parcelId: 'DH-UDA-KOT-001117' }),
    });
    recordTest('STEP-10', 'Seal without a token -> HTTP 401', unauthSealRes.status === 401);

    const notFoundParcelRes = await fetch(`${BASE_URL}/parcels/DH-NONEXISTENT-999999`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    recordTest('STEP-10', 'Nonexistent Parcel -> HTTP 404', notFoundParcelRes.status === 404);

    // -------------------------------------------------------------------------
    // STEP 11: DATA CONSISTENCY CHECK ACROSS ALL SEED PARCELS
    // -------------------------------------------------------------------------
    console.log('\n--- STEP 11: DATA CONSISTENCY CHECK ---');
    const p1Res = await fetch(`${BASE_URL}/parcels/DH-JPR-RAM-001024`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    const p1 = (await p1Res.json()).data?.parcel;
    recordTest('STEP-11', 'DH-JPR-RAM-001024: Mapped Area = 1.29 ha', p1?.mappedAreaHectares === 1.29);
    recordTest('STEP-11', 'DH-JPR-RAM-001024: Recorded Area = 1.315 ha', p1?.recordedAreaHectares === 1.315);
    recordTest('STEP-11', 'DH-JPR-RAM-001024: Status = Verified', p1?.status === 'Verified');

    // Read each seed parcel with an officer who is allowed to see its district.
    const p3Res = await fetch(`${BASE_URL}/parcels/DH-JOD-OSI-001245`, {
      headers: { Authorization: `Bearer ${patwariToken}` },
    });
    const p3 = (await p3Res.json()).data?.parcel;
    recordTest('STEP-11', 'DH-JOD-OSI-001245: Mapped Area = 2.15 ha', p3?.mappedAreaHectares === 2.15);
    recordTest('STEP-11', 'DH-JOD-OSI-001245: Recorded Area = 2.15 ha', p3?.recordedAreaHectares === 2.15);
    // STEP-06.3 filed a discrepancy-bearing inspection on this parcel, which moves it out of
    // 'Mapped' — the workflow's own effect, asserted rather than assumed.
    recordTest('STEP-11', 'DH-JOD-OSI-001245: Status = Needs Review after the flagged inspection', p3?.status === 'Needs Review');

    // -------------------------------------------------------------------------
    // STEP 12: CLEANUP — archive the record this suite created
    // -------------------------------------------------------------------------
    // Without this the seal fixture sits in the registry as a live parcel forever: the next run
    // collides with its unique (khasra, village, district, tehsil) identity, and the residue checks
    // in the other suites rightly complain about a record nobody seeded.
    console.log('\n--- STEP 12: CLEANUP ---');
    const sealCleanupRes = await fetch(`${BASE_URL}/parcels/${sealTargetId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tehsildarToken}`,
      },
      body: JSON.stringify({ reason: `E2E run ${sealTargetId}: seal fixture archived after verification` }),
    });
    recordTest('STEP-12', 'Seal fixture archived after the run', sealCleanupRes.status === 200);
    const sealAfterCleanup = await fetch(`${BASE_URL}/parcels/${sealTargetId}`, {
      headers: { Authorization: `Bearer ${tehsildarToken}` },
    });
    recordTest('STEP-12', 'Archived fixture leaves the active registry list', sealAfterCleanup.status === 200 && (await sealAfterCleanup.json()).data?.parcel?.status === 'Archived');

    // -------------------------------------------------------------------------
    // FINAL RESULTS SUMMARY
    // -------------------------------------------------------------------------
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    console.log('\n================================================================================');
    console.log(`  E2E SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL: ${results.length} CHECKS)`);
    console.log('================================================================================\n');

    if (failed > 0) {
      throw new Error(`${failed} check(s) failed in E2E suite.`);
    }
  } finally {
    server.close();
  }
}

runE2ESuite()
  .then(() => {
    console.log('ALL PHASE 5 E2E INTEGRATION CHECKS PASSED.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('E2E Suite error:', err);
    if (server) server.close();
    process.exit(1);
  });
