# DHAROHAR — Screenshot Evidence Pack

Genuine captures of the deployed DHAROHAR interface at <https://dharohar.urbantechx.in>. No mockups, generated product images or screenshots from another project are presented as live product evidence.

## Capture conditions

| Item | Value |
|---|---|
| Capture date | 2026-11-08 (UTC) |
| Target | `https://dharohar.urbantechx.in/` |
| Verified frontend build | private development commit `22721e8c`; served `index.html` sha256 `d3957c246c77b4ad2c7d39a3b799baae88ce4fb39cd30dbff4084cefde7e707c`, served bundle `assets/index-C9Jm-QpJ.js` sha256 `f0869b2f3c431f60e43b48c3d9016a5279f75bd3ee3c3d528b453f2669aaf44f`, stylesheet `assets/index-C_ReH-CW.css` sha256 `30a43b23768b63597ab8b89d1b53f2dc234335f7f275a4d0700fef4cfb5048d9` — each compared byte-for-byte against the local build after upload |
| Method | headless Chromium driven over the Chrome DevTools Protocol; viewport 1440×900 unless a taller frame was needed to include a panel; trusted mouse events for parcel selection |
| Data | synthetic demonstration records only (one seeded parcel, three synthetic documents) |
| Session | the shared demonstration officer preset; the sign-in capture was taken **before** any credential was entered, so no password, token or challenge answer appears in any image |
| Post-processing | none beyond PNG encoding; no application state was edited, retouched or composited |

## Index

| Filename | Screen | What it demonstrates |
|---|---|---|
| `01-login.png` | Sign-in | Bilingual presets, server-issued challenge placeholder, prototype notice, public star call-to-action |
| `02-dashboard.png` | Dashboard | District-scoped metrics and the explicit "SERVER RECORDS … not derivable" data-source admission |
| `03-spatial-registry.png` | Spatial registry | Esri basemap, the synthetic parcel boundary, attribution and the demo-boundary notice |
| `04-parcel-details.png` | Parcel detail | Co-sharer ownership ledger with fractions and per-sharer area, area reconciliation, computed integrity checklist |
| `05-boundary-edit.png` | Boundary editor | Draggable vertex handles and the live vertex/area/perimeter readout |
| `06-document-workflow.png` | Document ingestion | Drag-and-drop upload, jurisdiction metadata, labelled synthetic sample deeds |
| `07-extraction-results.png` | Extraction results | Local Tesseract bounding boxes, per-field confidence, explicit "confidence unavailable" |
| `08-validation.png` | Rule validation | Share-sum, unit-conversion and polygon-linkage checks; tariff check states it does not run in this build |
| `09-verification-queue.png` | Verification queue | Human review states, discrepancy flags and "not measured" confidence |
| `10-audit-trail.png` | Audit trail | Append-only Audit & State History (created / linked / sealed) beside the canonical document linkage |

## Known limits of this pack

- The hash-chain verification status is an API-level check (`GET /api/audit/chain`), recorded in [Validation and Evidence](../../VALIDATION_AND_EVIDENCE.md); the interface panel shown in `10-audit-trail.png` is the append-only lifecycle trail, not a chain verifier.
- Captures were taken with the shared demonstration officer because a dedicated least-privilege judge account could not be provisioned on the deployed engine (see the README's Judge demo access section). The officer preset is itself synthetic and published on the sign-in screen; no real identity appears.
- The seeded parcel's drawn ring encloses a different area than its stored mapped-area value; the discrepancy is a known, documented fixture inconsistency and is visible in the boundary readout rather than hidden.
- Frames were scrolled to include the relevant panel; scrolling is navigation, not alteration. Where a panel could not be reached it is listed here instead of being illustrated.
