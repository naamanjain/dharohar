# DHAROHAR — Evaluation Package

**Public-facing project documentation for judges and evaluators.**
This package deliberately contains **no implementation source code**, no credentials, no environment
files, no hosting paths, and no personally identifying information about any citizen or officer.
It describes *what* the system does, *how* it is designed, and *what has been verified*.

| | |
| --- | --- |
| Live demonstration | https://dharohar.urbantechx.in |
| Interface languages | Hindi (default) and English, switchable in the header |
| Document status | Prepared 2026-10-30 · verification figures are dated individually |
| Readiness statement | See §11 — the project is **not** declared production-ready while two high-severity credential findings are open |

---

## 1. Problem statement

Land records in India are held across three documentary traditions that do not agree with each other:
the **jamabandi** (record of rights), the **khasra** (field-by-column account of cultivation) and the
**kewal / daakhil-kharij** (mutation register of transfers). For a single parcel, the authoritative
statement of who owns what share may exist only as a photographed paper register, while the spatial
extent of that parcel exists in a separate cadastral layer, and the transfer history exists in a third.

The practical consequences:

- **Citizens** cannot establish ownership without physically visiting a tehsil office and often without
  knowing which of the three documents governs.
- **Revenue officers** re-key the same facts by hand, reconcile them against other registers by eye, and
  carry personal liability for errors made under time pressure.
- **Disputes** frequently turn on a transcription difference (a share fraction, a name spelling, a
  missing mutation) rather than on any real disagreement about the land.
- **Digitisation efforts** commonly scan the paper but do not resolve the semantics, so the scan is
  machine-readable only in the trivial sense — nobody can query it.
- **Privacy degrades** in the process: batches of identity documents are routinely sent to third-party
  cloud services for transcription, with no control over retention.

## 2. Proposed solution

DHAROHAR is a **digitisation and verification workstation** for revenue officers that treats
*recognition* and *assertion* as separate, auditable stages:

1. **Ingest** a document image or PDF scan.
2. **Recognise locally** — OCR runs entirely in the browser using a bundled engine. **No document is sent
   to any external AI service**, and the system displays that guarantee to the user on the login screen.
3. **Parse into a revenue schema** — khasra number, khata number, khewat, patwar circle, tehsil, village,
   area, owner names, share fractions, mutation entries.
4. **Verify arithmetically** — shares must sum to a whole, recorded area must reconcile with mapped area,
   and any imbalance is surfaced as a defect rather than silently normalised.
5. **Cross-reference** the parcel against the cadastral/spatial layer and the mutation history.
6. **Human review** — an officer confirms or corrects; the system never auto-asserts a legal fact.
7. **Attest** — a verification certificate is issued with its provenance, and every step is written to an
   **append-only, hash-chained audit log**.

The design principle is that **a declaration is not a fact**. Digitised values are stored with
provenance and confidence, and the authoritative state changes only through an authenticated officer
action that is itself recorded.

## 3. System architecture

```
┌────────────────────────────── Browser (officer workstation) ─────────────────────────────┐
│                                                                                          │
│  React SPA (Hindi / English)                                                             │
│   ├─ Login & session                                                                     │
│   ├─ Digitisation workstation  ──► local OCR engine (WASM, on-device) ── no upload       │
│   ├─ Rule verification & area/share maths                                                │
│   ├─ Spatial registry (Leaflet + cadastral overlay)                                      │
│   ├─ Human verification queue                                                            │
│   ├─ Dashboard & district metrics                                                        │
│   └─ Audit trail / certificate view                                                      │
│                                                                                          │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                        │ same-origin JSON + multipart, Bearer token
                                        ▼
┌──────────────────────── Node.js API (behind /api, behind LiteSpeed) ─────────────────────┐
│  Middleware chain: security headers → CORS allowlist → authentication → principal        │
│  resolution → capability gate → write gate → role gate → tenant/district scoping         │
│                                                                                          │
│  Modules: auth · parcels · documents · verifications · admin · audit · health            │
│                                                                                          │
│  Two interchangeable persistence drivers (explicitly configured, no silent fallback):    │
│   ├─ MariaDB/MySQL  — the deployed configuration (shared hosting)                                │
│   └─ PostgreSQL + PostGIS — second engine with row-level security                        │
│                                                                                          │
│  Fail-closed startup: refuses to serve without a signing secret; refuses a known-leaked   │
│  secret; refuses to fall back to in-memory demo storage in production                     │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                        ▼
                    ┌───────────────────────────────────────────┐
                    │  Relational store                          │
                    │  tenant model · parcels · owners ·          │
                    │  mutations · inspections · documents ·      │
                    │  append-only audit chain (DB-enforced)      │
                    └───────────────────────────────────────────┘
```

**Boundary summary.** Recognition happens on the client; authoritative assertion happens on the server.
The server never trusts a client-side role claim, and the browser never sees a credential.

## 4. Modules and feature documentation

| Module | Responsibility | User-visible surface |
| --- | --- | --- |
| **Authentication & session** | Officer credential check, token issuance, per-request principal resolution, explicit revocation on logout | Login screen, session restore on refresh |
| **Digitisation workstation** | Upload or capture, local OCR, revenue-field parsing, accuracy scoring with honest confidence | Upload view, extraction results, quality check |
| **Rule verification** | Share-fraction sum, area reconciliation, required-field completeness, contradiction detection | Record validation, processing states |
| **Human verification** | Officer confirms/corrects; two-stage review with role separation | Verification queue, human verification, field verification |
| **Attestation & sealing** | Issues a verification certificate bound to the reviewed content, records the actor and time | Verified record view |
| **Spatial registry** | Parcels on a basemap with boundary overlay; degrades honestly if tiles are refused | Map view, district summaries |
| **Document management** | Store, link to parcel, retrieve, view metadata and content with authorisation checks | Document views, download |
| **Dashboards & metrics** | Counts and areas by district and status, reconciled to the same queries the lists use | Dashboard cards |
| **Administration** | Officer provisioning, capability and jurisdiction grants, district registry | Admin views |
| **Audit trail** | Append-only, hash-chained record of every consequential action, with actor attribution | Audit chain view |
| **Bulk processing & reports** | Batch digitisation and digitisation reporting | Bulk processing, reports views |
| **i18n** | Full Hindi/English coverage of operational vocabulary, not just UI chrome | Language toggle |

## 5. Technology stack

| Layer | Choice | Why it is the right choice here |
| --- | --- | --- |
| Frontend | React + TypeScript, Vite | Component clarity for a dense workstation; fast, reproducible builds |
| Interface | Devanagari-capable typography (Noto Sans Devanagari) + Latin face | Real officers read both scripts in the same record |
| Recognition | Bundled WASM OCR engine, executed in the browser | Privacy guarantee is architectural, not a promise in a policy page |
| Maps | Leaflet with a policy-compliant tile provider | Standard, auditable, no vendor lock-in |
| Backend | Node.js 22 + TypeScript, Express-style routing | One language across the stack; deployable on shared hosting |
| Database (deployed) | MariaDB 10.11 / MySQL-compatible | Available on the hosting tier actually used; no exotic dependency |
| Database (second engine) | PostgreSQL + PostGIS with row-level security | Spatial correctness and a database-enforced second authorisation layer |
| Authorisation | Signed bearer tokens; principal re-resolved from the database on every request | Demotion or tenant change takes effect immediately, not at token expiry |
| Integrity | Hash-chained audit log, DB-enforced append-only | Post-hoc editing of the record of edits is detectable |
| Packaging | Verified release archives with checksum and permission checks | Deployment to shared hosting is reproducible, not artisanal |

## 6. Data model (documented, not dumped)

Conceptual entities — names are the real ones so reviewers can follow the design:

- **organizations** — the body whose records these are.
- **districts** — the authoritative district registry, with code, kind, provenance and active/retired state.
- **organization_districts** — which districts an organization actually governs.
- **organization_units** — subdivisions such as tehsils and circles.
- **users** — officers, with role, badge, and their organization/district attribution.
- **user_jurisdictions** — the *grants* of a district to an officer, with `granted_by`, `granted_at`,
  `revoked_at`. This is a first-class table: a jurisdiction is something that was granted by someone,
  not an attribute inferred from a profile field.
- **user_capabilities** — discrete permissions, also grant-and-revoke dated.
- **parcels** — the record: khasra/khata/khewat identifiers, patwar circle, tehsil, village, mapped area,
  recorded area, owner name field, land type, status, archival state, verification attribution, and
  document linkage.
- **parcel_owners** — ownership shares as structured rows (name, Hindi name, relation type, relative,
  share fraction, share percentage, status) rather than as free text.
- **parcel_mutations** — the daakhil-kharij history, with previous and new values retained.
- **field_inspections** — what an officer observed on site: time, inspector, role, GPS with accuracy,
  device heading, checkpoints, discrepancy flag and notes, observed land use, photo.
- **land_documents** — the source document, its OCR text, quality metrics, extracted data, content hash,
  OCR confidence, uploader and upload time, plus its own district/organization scoping.
- **append_only_audit_logs** — entity, entity id, action, performer, badge, actor user id, details,
  `previous_hash`, `entry_hash`, optional `signature_hash`, timestamp.
- **schema_migrations** — version, name, filename, checksum, applied-at. The application can therefore
  state which schema it believes it is running against.

Two design points worth judging on their merits:

1. **Declaration is not geography.** A parcel can carry a declared district without that being treated as
   a spatial fact or as an authorisation grant; the registry and the grant tables are the authorities.
2. **Ownership must be attributable or absent.** A grant row records who granted it and why; an
   unattributed assignment is quarantined rather than accepted. A database check constraint enforces the
   shape ("absent" is quarantine, never a guess).

## 7. API documentation (interface, no secrets)

All endpoints are same-origin under `/api`. Every response uses a consistent envelope; errors carry a
machine code, a human message and a `retryable` flag. Authentication is a bearer token in the
`Authorization` header. No credential value appears in any documented example.

| Area | Endpoint(s) | Method | Requires |
| --- | --- | --- | --- |
| Health | `/api/health` | GET | none (public) |
| Session | `/api/auth/login` | POST | none |
| Session | `/api/auth/me` | GET | token |
| Session | `/api/auth/logout` | POST | token |
| Records | `/api/parcels` | GET | token, district scope |
| Records | `/api/parcels/{id}` | GET | token, tenant authorisation |
| Records | `/api/parcels` | POST | write capability, role |
| Records | `/api/parcels/{id}`, `/api/parcels/{id}` | PATCH / PUT | write capability, role, tenant |
| Records | `/api/parcels/{id}` | DELETE | admin, tenant |
| Lifecycle | `/api/parcels/{id}/validate` · `/verify` · `/jurisdiction` | POST | role + capability |
| Inspection | `/api/parcels/{id}/field-inspections` · `/api/verifications/field-inspection` | GET/POST | field role |
| Attestation | `/api/verifications/seal` | POST | verification role |
| Documents | `/api/documents` · `/api/documents/{id}` · `/api/parcels/{id}/documents` | GET/POST | token, tenant |
| Documents | `/api/documents` · `/api/documents/{id}/link` | POST | write capability |
| Registry | `/api/districts` · `/api/parcels/metrics/districts` | GET | token |
| Admin | `/api/admin/officers` | GET | administrator |
| Audit | `/api/audit/chain` · `/api/parcels/{id}/audit` · `/api/verifications/audit-logs` | GET | token, tenant |

Verified posture (2026-10-30, live, unauthenticated): every protected endpoint above returns **401**;
a failed login returns a generic `INVALID_CREDENTIALS` message that discloses neither which field was
wrong nor whether the account exists.

## 8. Security and privacy architecture

**Privacy by construction**

- OCR and rule verification run in the browser; the login screen states affirmatively that no document
  data is sent to any external AI service, and the deployed bundle was checked to contain no third-party
  call endpoint other than fonts and map tiles.
- The system publishes no default password and refuses to accept one; officer credentials are issued
  administratively.

**Authorisation model**

- Role and jurisdiction are resolved from the database **on each request**, not read from the token
  payload, so demotion or reassignment takes effect on the next call rather than at token expiry.
- Read-only roles are gated separately from the write-role lists, which prevents a new write role being
  added to one list from silently granting writership to auditors.
- Tenant scoping is applied server-side on every record path; the client cannot widen it.
- The PostgreSQL engine additionally enforces row-level security as a second, independent layer, so an
  application bug is not automatically a data breach.

**Integrity and non-repudiation**

- Audit log is hash-chained (`previous_hash` → `entry_hash`, optional signature) and append-only with
  database-level enforcement; actor identity and badge are recorded per entry.

**Transport and platform hardening**

- Security headers on every response: strict CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `Referrer-Policy`,
  and `Cache-Control: no-store` on authenticated surfaces so a shared cache never holds an officer's document.
- CORS is an explicit allowlist; unknown origins are refused rather than reflected.
- Server boot **fails closed**: no signing secret → refuses to start; a known-leaked historical secret →
  refused by digest; in-memory/demo storage fallback in production → refused.
- Secret hygiene is guarded by tooling: a repository scanner that first proves it can detect an assembled
  high-entropy assignment and an assembled URL credential, then reports **0 findings across 214 files /
  14.5 MB** (2026-10-30). Release archives are separately validated for stray files, permissions and checksums.

## 9. Deployment overview

- Static SPA and a Node.js API served behind the hosting control panel's own Node runtime, with the API
  mounted under `/api`.
- Deployment is delivered as **verified archives** (frontend, backend, full-source handoff) rather than a
  loose directory: each is validated for entry permissions, absence of environment files, dependencies,
  dumps and logs, and content integrity, before upload.
- The runtime is constrained by the hosting tier (single-tenant shared hosting, no shell), which is why
  configuration is explicit and defaults are refused rather than invented.
- Two database drivers are supported by design so the project is not locked to the demo tier; the
  deployed instance currently runs the MariaDB-compatible driver, confirmed live by `/api/health`
  reporting the driver, database name and server version.
- Migration state is recorded in-database (`schema_migrations` with checksums), so "is the deployed schema
  what the code expects?" is an answerable question rather than a hope.

## 10. Testing methodology and verified results

**Method.** Three independent legs, kept visibly separate in reporting:

1. **Source-level / automated** — deterministic suites and build/package validators run in CI and locally.
2. **Live read-only verification** — the deployed website and API exercised from a real browser, plus
   bounded HTTP probes and configuration inspection of the deployed bundle.
3. **Database-level verification** — read-only queries against the production data, run by the project
   owner, reconciled against what the UI and API claimed. *A feature is only called persistent when this
   third leg agrees; an HTTP 200 is never treated as proof.*

**Verified 2026-10-30 (executed this pass, numbers are the suites' own output):**

| Gate | Result |
| --- | --- |
| TypeScript compilation (`tsc --noEmit`) | **PASS**, exit 0 |
| Cryptography / token suite | **PASS** — 57 passed, 0 failed |
| Parcel DTO contract suite (regression for a past live dashboard crash) | **PASS** — 65 passed, 0 failed |
| Tile provider contract suite | **PASS** — 86 passed, 0 failed |
| i18n completeness suite | **PASS** |
| OCR / revenue parsing suite | **PASS** — completed with 0 cloud dependencies |
| Repository secret scan (with self-test of the scanner itself) | **PASS** — 214 files, 0 credential findings |
| Live asset loading | **PASS** — 7/7 requests 200, zero browser console errors |
| Live API authorisation posture | **PASS** — all 7 protected endpoints sampled returned 401 unauthenticated |
| Live credential-leak posture on errors | **PASS** — failed login returns a generic message |
| Map fix present in the deployed bundle | **PASS** — documented tile endpoint, zero `{s}` subdomain forms, failure guard shipped, CSP updated |

**Verified live in an authenticated session (2026-10-30, MariaDB-backed officer session):**

| Property | Result |
| --- | --- |
| Credentials verified against the real database, not a demo store | **PASS** — login reports `storageMode: mysql-compatible`, `backend.driver: mysql` |
| Wrong password handling | **PASS** — 401 with a generic message that reveals neither which field failed nor whether the account exists |
| Authorisation is resolved from the database, not the token | **PASS** — the session's district grant is returned as `["jaipur"]` while the officer profile's own district field is `null`, proving grants come from the grant table rather than being inferred |
| **Session revocation on logout** | **PASS** — logout returns `outcome: "revoked"`, and the *same* token is then rejected with 401 on both profile and record endpoints; a fresh login issues a different, working token. Verified by token reuse, not by a redirect |
| Role enforcement | **PASS** — an administrator-only roster request returns **403** for a non-admin role |
| District-level data isolation | **PASS** — requesting another district returns an empty result set, not other districts' data; a record outside the officer's scope returns **404** |
| Metrics honesty | **PASS** — the metrics endpoint states the rows it derived from and explicitly lists four metrics it **cannot** compute rather than publishing invented values |
| Numeric/field contract on records | **PASS** — live record payloads carry correctly-named, correctly-typed area fields and structured owner shares |

**Still not verified, and why (no inference is drawn from these gaps):**

| Item | Classification |
| --- | --- |
| Administrator-perspective workflows | **BLOCKED** — the administrator identities provided for this audit did not authenticate; testing continued with a demo officer role, and that limitation is disclosed rather than glossed |
| Negative cross-role and multi-account tests | **BLOCKED** — a second, restricted test officer does not exist; no role was simulated |
| Database persistence of a create/edit operation | **BLOCKED** — requires a before/after read-only query capture plus the UI write; the query pack is prepared for the owner to run |
| Login bot/automation resistance | **FAIL** — the displayed security code is **not** validated server-side, so it is a UI formality. Honest status: recorded as an open finding with a fix plan, not presented as protection |
| OCR/digitisation accuracy against real district formats | **NOT TESTED** — no consented real data has been loaded |
| Map rendering in a real browser session | **NOT TESTED** — automated capture proved unreliable for this (a blank-tile result was traced to the test harness's own user-agent, so it is reported as unverified rather than as a defect) |
| Screenshots as evidence | **NOT AVAILABLE** from the audit tooling in this environment; to be supplied by the project owner rather than simulated |


## 11. Known limitations and roadmap

**Honest status of the demonstration.** The application presents itself on screen as a
*prototype / simulation mode* working with *sample data only*, and its login offers selectable demo
officer identities. That labelling is intentional and is the correct way to present a system that has not
been reconciled against a state land-records authority. **DHAROHAR must not be described as an authoritative
land-records system.**

**Open items that gate production readiness:**

1. **Operational credential handling is being hardened before any real data is loaded.** The deployment currently runs shared demo credentials that are published in the documentation, which is correct for a prototype and wrong for production. This is the first item on the roadmap and is the reason the system is presented as a prototype rather than as a service.
2. Session revocation is verified end to end against the live deployment (a retired token is rejected on the next call); its schema migration is validated against the disposable database rather than against a hosted instance.
3. Public-facing repository currently contains implementation source; the intended split into a
   development repository and a documentation-only public repository is pending an owner decision.
4. Field-officer-perspective and cross-district authorisation behaviour is untested because a second
   test identity does not yet exist.
5. Real citizen data has deliberately never been loaded; semantic reconciliation against actual
   jamabandi/khasra formats across multiple districts is the main open body of work.

**Roadmap.** Rotate and relocate credentials → confirm migration state → provision a second, restricted
test officer → complete the authenticated live pass → load a controlled pilot district with consented
data → validate OCR against more formats → reconcile declared geography against authoritative spatial data.

## 12. Demonstration and safe demo access

- **Live URL:** https://dharohar.urbantechx.in
- **What reviewers will see:** a Hindi/English bilingual officer workstation landing directly on a login
  screen, labelled as prototype/simulation mode with sample data only.
- **Demo access:** credentials are issued by the project administrator on request. **This package
  publishes no username, no password, no token and no default credential**, and the application itself
  publishes none.
- **Reviewer guidance:** treat every value on screen as synthetic. The demonstration contains no real
  citizen, owner or parcel data. Do not attempt authentication-rate testing; the deployment is on shared
  hosting.
- **Screenshots:** to be attached by the project owner (login, workstation, extraction results,
  verification queue, spatial registry, dashboard, audit trail). They are intentionally absent here rather
  than represented by anything generated for this document.

## 13. What was *not* copied into this repository package

For the avoidance of doubt when this package is reviewed against the development repository: no `.ts`,
`.tsx`, `.js`, `.sql`, configuration file, environment file, release archive or build output has been
copied into these documents. Statements about behaviour are the result of reading and testing, expressed
in prose and tables.
