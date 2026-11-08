# DHAROHAR — Limitations and Future Scope

## Current status

DHAROHAR is a working prototype and evaluation deployment on synthetic demonstration records. It is not an authoritative land-record system, is not an official government service and must not be used to determine legal ownership or rights.

## Known limitations

### 1. No authoritative land-record integration

The prototype has not been reconciled with an official state land-record registry or an authoritative cadastral source. A parcel shown in the application is not thereby a legally certified parcel.

### 2. OCR generalisation is unproven

Automated OCR and parsing tests pass, but this does not establish accuracy across handwritten registers, degraded scans, languages, layouts, abbreviations and district-specific conventions. Real-world validation requires appropriately authorised and privacy-protected samples.

### 3. Synthetic geometry discrepancy

A seeded synthetic parcel was recorded with a polygon-derived area of 38.061 ha and a stored `mapped_area_ha` of 1.29 ha. The values disagree. The record was not silently changed; an authorised synthetic-data correction and subsequent verification remain necessary.

### 4. Multi-account role coverage

A second restricted officer identity is needed to complete the separate cross-role and multi-account comparison. Existing role and district checks provide useful evidence but do not replace this test.

### 5. Hosting latency

The shared hosting environment has exhibited intermittent connection failures and high first-byte latency, including slow responses for small static resources. Application-side retries can improve resilience but cannot remove the hosting provider's underlying latency.

### 6. Frontend deployment checkpoint

The 2026-11-07 investigation recorded health-probe retry and polygon-layer memoization changes as implemented in the development build but not yet confirmed on the live frontend. Recheck the served bundle before stating that these improvements are deployed.

### 7. Integration gates

The latest supplied report recorded MySQL integration, stack validation and Docker gates as not executed in that environment. They remain unverified until run.

### 8. Operational readiness

A real deployment would require approved identity and account provisioning, operational data governance, documented retention and deletion policies, tested backup and recovery procedures, independent security review, support ownership and formal acceptance by the relevant authority.

## Future scope

1. Complete deployment and live verification of frontend resilience and map interaction improvements.
2. Correct the synthetic parcel geometry/area discrepancy under an authorised, traceable data change.
3. Provision a separate, restricted test officer for multi-account and cross-role verification.
4. Execute the remaining database and container integration gates.
5. Validate OCR and parsing against representative, authorised district documents.
6. Reconcile parcel geometry and identifiers with authoritative geospatial and land-record sources under an approved data agreement.
7. Complete security, privacy, backup/recovery, operational and human-factors reviews before any real-data pilot.

## Responsible-use statement

Until the above work and the required institutional approvals are complete, DHAROHAR should be presented only as a synthetic-data prototype for evaluation. Human review remains essential, and no automated output should be represented as a legal determination.
