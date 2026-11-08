# DHAROHAR — Solution Overview

## Operating principle

**Recognition is not assertion.** DHAROHAR treats extracted text as candidate information. The system can help check it, but an authorised human remains responsible for review and any consequential action.

## End-to-end workflow

1. **Document intake** — an officer selects or captures a document image or PDF.
2. **Local recognition** — the bundled OCR engine runs in the browser. The intended processing path does not send document content to an external AI transcription service.
3. **Field extraction** — recognised content is organised into revenue-oriented fields such as parcel identifiers, location, area, owner names, shares and mutation details.
4. **Quality and rule checks** — the workstation can surface missing fields, share totals and area inconsistencies for review.
5. **Parcel matching** — the record is connected with available parcel and spatial information.
6. **Human review** — an officer inspects the source, corrects extracted values and records the appropriate workflow action.
7. **Verification and attestation** — authorised actions are recorded with actor and time context.
8. **Auditability** — consequential actions contribute to a hash-linked audit history.

## What the system should never infer

- OCR text does not prove ownership.
- A matching name does not prove identity.
- A drawn polygon does not prove a legal boundary.
- A declared district does not itself grant jurisdiction.
- A missing field is not a value to be guessed.
- A metric unavailable from the underlying records must be reported as unavailable, not fabricated.

## Access model

The API resolves an authenticated principal and checks role, capabilities and district grants server-side. The browser is not the authority for access decisions. The public demonstration should remain synthetic and should use separate, restricted judge accounts rather than production administrator credentials.

## Human workflow

The product is designed to support a sequence of capture, validation, review, field inspection where needed, verification and audit. It should not automatically convert OCR output into an asserted legal fact or replace the officer's judgement.

## Deployment shape

The current hosted demonstration uses a React/TypeScript frontend, a Node.js/TypeScript API mounted under `/api`, and MariaDB on the cPanel hosting environment. A PostgreSQL/PostGIS path exists as a separate supported engineering path; it is not the currently deployed database.

See [Architecture Overview](ARCHITECTURE_OVERVIEW.md) for the component view and [Features](FEATURES.md) for the verification status of individual surfaces.
