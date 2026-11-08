# DHAROHAR — Feature Matrix

This matrix separates intended capability from the evidence available in the recorded prototype audits. A feature is not marked live-verified merely because a component or route exists in source.

| Area | What it is intended to do | Evidence / status |
|---|---|---|
| Bilingual interface | Hindi and English UI | Implemented; language suite recorded passing |
| Authentication | Officer sign-in and authenticated session | Live sign-in tested against MariaDB |
| Server-issued CAPTCHA | Short-lived, single-use challenge | Live wrong-code, missing, replay and expiry cases verified (2026-11-05) |
| Session revocation | Invalidate a session on logout | Live token-reuse check verified |
| Principal and capabilities | Resolve identity and permissions server-side | Capability-based access tested with contrasting identities |
| District scoping | Restrict records to granted jurisdiction | Live cross-district reads tested; foreign record lookup returned 404 |
| Dashboard | Show records and available metrics | Live UI/API comparison recorded |
| Parcel registry | View parcel records | API/UI path tested |
| Parcel geometry | Return and render parcel boundaries | Backend geometry fix and polygon handles tested live (2026-11-07) |
| Boundary editing | Select and edit a parcel boundary | Live browser interaction recorded |
| Document management | Create, link and retrieve document records | API creation and read paths tested; DB checks previously confirmed document codes on all five records |
| OCR | Extract candidate text locally | Automated OCR tests passed; accuracy on real district formats not established |
| Validation | Check required fields and arithmetic | Automated and live validation paths tested |
| Human verification | Review and approve/correct extracted content | Workflow surfaces exist; coverage depends on role credentials |
| Field inspection | Capture on-ground verification details | Needs a separate field-role account for full role-perspective testing |
| Audit trail | Hash-linked record of consequential actions | Live chain integrity query recorded with seven entries and no broken links (2026-11-05) |
| Basemap | Render parcel context | Esri street map selected after OSM placeholder responses from host egress; attribution retained |
| Host resilience | Recover from sleeping API / transient probe failures | Frontend retry and explicit API-unreachable handling changes were pending deployment at the 2026-11-07 checkpoint |
| Map rendering performance | Avoid clearing/rebuilding parcel geometry on every provider render | Memoization changes were pending deployment at the 2026-11-07 checkpoint |
| Real government data integration | Reconcile against authoritative land records | Not implemented / not verified |

## Status vocabulary

- **Live verified:** exercised on the hosted deployment with recorded evidence.
- **Automated verified:** a local automated suite passed; this does not by itself prove the live deployment behaves the same.
- **Partial:** some paths were checked, but role, data or workflow coverage is incomplete.
- **Pending deployment:** a change exists in the development build but was not yet confirmed on the live frontend at the cited checkpoint.
- **Not tested:** no evidence is available; do not infer success.

## Known data-quality exception

A seeded synthetic parcel was reported with a polygon-derived area of 38.061 ha while its stored `mapped_area_ha` is 1.29 ha. This discrepancy was deliberately left unchanged pending an authorised synthetic-data correction. It must not be hidden or described as reconciled.
