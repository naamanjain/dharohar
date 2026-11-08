# DHAROHAR · धरोहर
## Land Record Digitisation & Verification Portal

**Live demonstration:** https://dharohar.urbantechx.in  
**Project status:** deployed prototype on synthetic data · Hindi and English

DHAROHAR is a revenue-officer workstation for digitising, checking and reviewing land-record information. It combines browser-based OCR, structured revenue data, arithmetic validation, parcel boundaries, human review and an auditable record of consequential actions.

> **Important:** DHAROHAR is a prototype using synthetic demonstration data. It is not an official government land-record system, does not establish legal ownership, and is not connected to an authoritative state land-records database.

## The problem

A parcel's information can be spread across paper records and separate spatial and mutation registers. Officers may need to transcribe and reconcile the same information repeatedly, while citizens face delays when records disagree. Scanning alone preserves an image but does not make its contents reliably searchable or comparable.

## The approach

DHAROHAR separates recognition from authoritative assertion:

1. Ingest a document image or PDF.
2. Run bundled OCR locally in the browser.
3. Parse recognised content into structured revenue fields.
4. Check share arithmetic, area values and required fields.
5. Compare parcel information with available spatial and mutation data.
6. Present discrepancies for human review.
7. Record authorised actions in an audit trail.

OCR output is a draft for review, not a legal determination. Officers must verify and approve information before it is treated as an application record.

## Main capabilities

- Hindi/English officer interface.
- Browser-based OCR using bundled WebAssembly assets.
- Structured parcel, ownership-share and document records.
- Arithmetic and completeness validation.
- Parcel registry with editable boundary geometry.
- District-scoped access and capability-based authorisation.
- Document management and verification workflows.
- Dashboard, metrics and audit-trail views.
- Session revocation on logout.

## Architecture

```
Browser application
  Hindi/English UI · local OCR · parcel map · review workflows
          │ same-origin authenticated API
          ▼
Node.js / TypeScript API
  authentication · capabilities · district scoping · validation
          │
          ▼
MariaDB (current hosted deployment)
  parcels · owners · documents · inspections · audit records
```

The implementation source is maintained separately in a private development repository. This public repository is intentionally documentation-only; it does not contain the application source code.

## Try the demonstration

Open **https://dharohar.urbantechx.in**.

The application is labelled as a prototype and uses synthetic data. **No production administrator credentials, database credentials, JWT secrets or shared internal passwords are published here.**

If a judge needs an interactive login, request a dedicated demo account from the project administrator. Any account shared for evaluation should be restricted, use synthetic data only, and be separate from administrator and operational accounts. Demo access may be time-limited or disabled after the evaluation.

Please do not run load tests, password spraying or authentication-rate tests against the shared-hosting demonstration.

## Verification snapshot

The following results are from the project’s recorded live and automated checks; they are not a claim of government certification or production readiness.

| Area | Recorded evidence |
|---|---|
| Authentication challenge | Server-side challenge, wrong-answer rejection, expiry and replay rejection verified against the deployed API (2026-11-05) |
| Session revocation | Logout invalidates the issued token on subsequent read and write requests |
| Authorisation | Capability checks and district scoping verified; out-of-scope parcel lookup returns 404 |
| Database | Read-only MariaDB checks confirmed migration state, document codes, session revocation and audit-chain integrity (2026-11-05) |
| Audit integrity | 7 entries checked; no null hashes or broken links in that recorded check |
| Map boundaries | Backend parcel response includes boundary geometry; polygon selection/edit handles were verified live (2026-11-07) |
| Automated tests | Recorded passing suites include TypeScript, crypto, CAPTCHA, DTO, tile, i18n, OCR, phase4 and E2E checks; see the dated completion reports in the development project |

### Current limitations and work in progress

- The hosting provider has shown intermittent high first-byte latency and connection failures. Client-side resilience improvements have been implemented in the development build but were still awaiting frontend deployment in the 2026-11-07 checkpoint.
- Polygon rendering and editing depend on valid boundary geometry. A seeded synthetic parcel has a known discrepancy between its polygon-derived area and its stored mapped-area value; it remains flagged rather than silently altered.
- A second restricted officer identity is still needed to complete the separate cross-role comparison.
- The recorded checks do not establish OCR accuracy across real district document formats.
- The prototype has not been reconciled with authoritative government land records and must not be used to make legal or ownership decisions.

## Repository contents

This repository contains public-facing project documentation only:

- [Evaluation package](./docs/EVALUATION_PACKAGE.md) — project description, architecture, data model, API overview, security design, testing methodology and limitations.

No application source, environment files, secrets, database dumps or operational credentials belong in this repository.

## Licence and third-party notices

Project documentation and original project materials are provided under the rights stated by the project author. Third-party libraries, OCR assets, map services and datasets remain subject to their respective licences and attribution requirements. Consult each provider’s current terms before redistribution or production use.
