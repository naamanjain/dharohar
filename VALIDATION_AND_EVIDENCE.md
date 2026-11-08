# DHAROHAR — Validation and Evidence

## Evidence rules

The project distinguishes four kinds of verification:

1. **Source and automated tests** — what the development code and test suites prove.
2. **Live API checks** — what the deployed endpoints returned.
3. **Browser checks** — what an authenticated user could see and do in the real interface.
4. **Database checks** — what persisted in MariaDB when independently inspected.

An HTTP success response is not, by itself, proof of database persistence. A local test is not, by itself, proof that the hosted bundle contains the same code.

## Recorded hosted verification — 2026-11-05

The completion report recorded 30/30 live checks for the deployed CAPTCHA/session/document behaviour, including:

- server-issued challenge;
- missing, incorrect, expired, replayed and never-issued challenge rejection;
- successful login with a correct challenge;
- logout revocation, with the old token rejected on subsequent read and write requests;
- fresh login following logout;
- document code present in all three read paths and visible in the dashboard.

The same checkpoint recorded MariaDB read-only checks for migration versions 0001–0003, persisted session revocation, district-scoped parcels, populated document codes and audit-chain integrity.

The audit chain check reported seven rows, no null hashes and no broken links. These figures describe that dated check, not a permanent property of future database state.

## Recorded hosted verification — 2026-11-07

The later performance and map investigation recorded:

- the backend parcel read path returning boundary geometry;
- a five-vertex polygon rendered and selectable in the map;
- five draggable handles in the boundary-edit interaction;
- cross-district parcel lookup returning 404 and granted-parcel lookup returning 200;
- logout followed by `401 SESSION_REVOKED` on read and write paths;
- a valid audit chain with 12 entries at that later check;
- a CAPTCHA state matrix including correct, wrong, missing, replayed and expired cases.

The reported suite result was 27/28. The single failure was attributed by the audit to a harness query for a district the signed-in officer was not granted; it was not treated as a product defect. This is recorded as a test-scope limitation, not rounded up to 28/28.

## Automated checks

The 2026-11-07 report recorded clean TypeScript compilation and build, plus passing suites for cryptography, CAPTCHA, DTO contracts, tile-provider contracts, health-probe behaviour, i18n, OCR, phase4 and E2E. The report cited suite counts of 57, 41, 84, 106, 35, 47 and 53 for the respective counted suites.

The same report stated that local MySQL integration, stack validation and Docker gates were not executed in that environment. Do not describe those gates as passing.

## Outstanding evidence

- Verify the latest frontend resilience and map memoization changes against the currently served production bundle.
- Complete a separate restricted officer comparison for cross-role / multi-account testing.
- Verify OCR accuracy using appropriately authorised, representative document samples before making accuracy claims.
- Reconcile the known synthetic polygon-area discrepancy through an authorised data correction and rerun the relevant checks.
- Repeat live performance measurements after the pending frontend deployment.

## Evidence hygiene

Screenshots used in public materials must be genuine captures of the deployed interface, with account identifiers, personal data, tokens and internal host details removed. Never fabricate screenshots or publish production credentials.
