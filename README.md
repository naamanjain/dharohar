# DHAROHAR — Spatial Land Record Registry

DHAROHAR keeps the existing land-record digitization, ownership, mutation, document and verification workflow, while making the **map + parcel** the primary product.

## Demo workflow

**MAP LAND → CREATE PARCEL → ENTER/EXTRACT RECORD → ATTACH ORIGINAL DOCUMENT → VERIFY → SEARCH/FILTER → ANALYSE LAND**

### What is implemented

- Real Leaflet + OpenStreetMap basemap with point-by-point parcel polygon creation
- Automatic mapped-area calculation
- Unique DHAROHAR Parcel IDs and colour-coded parcels
- Parcel-linked owner, Khasra/Survey, Khata, land type, inheritance and mutation data
- Direct original-document upload/linking from the parcel workflow, plus linking to existing document records
- Parcel detail view with discrepancy and incomplete-record warnings
- Explicit parcel lifecycle: Draft → Mapped → Needs Field Verification → Verified
- Multi-owner shares with proportional owner-area aggregation
- Structured “Ask the Registry” queries for common spatial questions
- Search/filter with map highlighting
- Owner-level mapped-area aggregation
- Existing OCR/extraction and human-verification screens retained as optional assistance workflow

### Prototype honesty

This is a demonstration using sample data. The OpenStreetMap basemap is real, but parcel geometry is a **provisional spatial representation** created by the user and is **not official cadastral boundary data**. A parcel must be field-verified before it is treated as verified within the prototype. OCR metrics, government integrations and external registry checks shown elsewhere in the original prototype are simulations/mock workflow elements, not measured production results.

AI/OCR is optional. The core parcel registry works through manual mapping and record entry; the demo does not require an external AI call for every document.

## Run it

Prerequisite: Node.js. Copy `.env.example` to `.env` and set `JWT_SECRET` (see below).

The frontend and the API server are two separate processes; there is no single one-command mode.

```bash
npm install

# Terminal 1: frontend dev server on :3000 (mock/localStorage data only;
# '/api' calls are proxied to the backend at http://localhost:3001 by default)
npm run dev

# Terminal 2: Express API server (falls back to an in-memory dev store if
# PostgreSQL is unreachable)
npm run server

# Optional: real PostgreSQL persistence
npm run db:migrate
npm run db:seed

# Assertion-based test gate (no database required; uses the in-memory fallback)
npm test
```

Running only `npm run dev` gives you the parcel registry UI with browser-local data; it does not exercise the authoritative backend, auth, or audit chain.

## Deploying it (Docker, HTTPS, backups)

| Document | What it answers |
|---|---|
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Host choice at ₹0, secrets, exact DNS records for `urbantechx.in`, TLS via the `docker-compose.tls.yml` Caddy overlay, deploy commands, backup/restore + restore drill, troubleshooting, rollback, free→paid path |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Every control that is actually enforced, with the test that proves it — and the 11 gaps that are still open |
| [`docs/DATA-MODEL-JURISDICTION.md`](docs/DATA-MODEL-JURISDICTION.md) | The tenant/isolation model, what is implemented, and the 5 decisions that need the owner before real records go public |
| [`docs/DOCUMENT-STORAGE.md`](docs/DOCUMENT-STORAGE.md) | Where scanned-document bytes live today and the staged plan to move them off base64 columns |

Container quick start (see the runbook for the required `.env` and the TLS overlay):

```bash
docker compose -f docker-compose.prod.yml up -d --build          # needs POSTGRES_PASSWORD + JWT_SECRET
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d   # adds HTTPS on 80/443
bash scripts/validate-stack.sh                                   # 29-assertion sweep, non-zero on any FAIL
```

What the production configuration refuses to do, on purpose: start without a reachable PostgreSQL
(no silent in-memory fallback), start without `JWT_SECRET` or with `ALLOWED_ORIGINS=*`, publish a
host port for the database, answer a cross-district request with anything but 404, report a
successful save whose transaction did not commit, or seed demo records into a production database
without `SEED_CONFIRM=demo`. **No public deployment has been performed from this repository**; the
checks §9 lists are what has been run, and only against the local container stack.

`JWT_SECRET` must be set in the environment. In production the server refuses to start without it; in development an unset value now generates a random secret for that process only, so sessions do not survive a restart. The previously hardcoded demo secret is rejected outright — tokens signed with it no longer authenticate.

No AI API key is required for the core spatial registry demo. Document extraction in the browser is Tesseract.js OCR plus a deterministic regex revenue parser — there is no external LLM extraction call at runtime. Direct parcel uploads use **prototype-local document storage** in the browser; this is not secure permanent production storage. Production architecture should use controlled object storage, access control and encryption.

### Known technical debt

- TypeScript `strict` is disabled in `tsconfig.json`; enabling it is deferred as a separate cleanup.
- `src/services/llm/` (unused mock "LLM provider" scaffolding) has been deleted; the runtime extraction path is `src/services/ocr` only.
- PBKDF2 stays at 10,000 iterations, below current OWASP guidance. Raising it invalidates every stored `password_hash`, because the iteration count is not persisted next to the hash; doing it properly needs a rehash-on-next-login migration.
- `npm test` needs no database and runs the in-memory fallback. The database-backed suites are separate:
  ```bash
  # requires a reachable PostgreSQL + PostGIS with `npm run db:migrate` and `npm run db:seed` applied
  DATABASE_URL=postgresql://USER:PASS@HOST:5432/dharohar_db \
  TEST_BASE_URL=http://127.0.0.1:3001/api \
  npm run test:db
  ```
  These assert against real rows — that a seal actually writes `parcels.status`, `verified_by`, `certificate_number` and `seal_signature`, that a refused re-seal changes nothing, and that the audit chain verifies. They refuse to run (non-zero exit) if the database is unreachable rather than passing in memory mode.

## Intended future extensions

- AR-assisted field boundary/measurement verification
- ULPIN/3D parcel identification integration
- Tribal/community land-record workflows
- Real cadastral/GIS data and controlled government integrations


## Parcel-first positioning

The primary digital unit is the **land parcel**, not the source document:

**Parcel → boundary → owners/shares → Khasra/Khata → area → inheritance → mutation → documents → verification**

### Verification semantics

- **Draft:** boundary is being created.
- **Mapped:** user-created provisional geometry has been saved.
- **Needs Field Verification:** geometry or record needs on-site review.
- **Verified:** field verification has been recorded in the prototype.

A mapped boundary is never presented as an official cadastral boundary.

### Structured registry queries

The prototype includes predefined “Ask the Registry” queries for:
- owner-based land lookup
- agricultural land above a chosen area
- area mismatch
- missing documents
- village-based lookup

These are deterministic filters over the registry, not an AI agent.

### Document storage limitation

Direct parcel uploads are converted to browser-local data URLs for the demo and persisted with the parcel in local browser storage when space permits. This is **prototype-local document storage**, not secure permanent production storage. Production architecture should use controlled object storage, access control and encryption.


## V8 polish
- Ask the Registry owner query preserves the selected owner filter.
- Parcel editing preserves co-owner percentage shares.
- Field verification is explicitly labelled as prototype verification; mapped boundaries remain provisional.


## V10 final polish

The audit addressed the full product checklist. This pass only addresses final polish and demo integrity; it does not add new product scope:
- Real Leaflet/OpenStreetMap mapping retained, with Street/Satellite basemap toggle.
- Boundary vertices are draggable; selected vertices can be deleted; polygons can be explicitly closed/reopened; clear/undo controls remain.
- Mapped area uses geographic coordinates with a geodesic spherical calculation; perimeter is also calculated in metres.
- Existing parcel boundaries can be edited and recalculated; edited geometry returns to Needs Field Verification.
- Search now includes parcel/document identifiers and document names; area filters support minimum and maximum.
- Newly created parcel IDs use a district/village-coded format and are persisted with the parcel; editing or reloading a parcel does not regenerate its ID.
- Parcel verification stores verifier, timestamp and prototype verification notes.
- Direct uploads expose a local demo document reference, type and upload time; production controlled object storage remains explicitly out of scope.
- Village-wise area analytics is included alongside owner-share analytics.
- The existing OCR/verification application remains intact and optional to the parcel-first workflow.


### Product roadmap
**Phase 1 — MVP:** 2D parcel mapping, linked land records, documents, verification and analytics.
**Phase 2:** AR-assisted field measurement and boundary verification.
**Phase 3:** ULPIN-linked parcel identity.
**Phase 4:** 3D/advanced spatial representation and specialized community/tribal workflows.


### V10 final polish
- Removed simulated AI performance figures from the main dashboard; headline metrics now use registry-derived values.
- Kept parcel IDs persisted with records so editing/reloading does not regenerate them.
- Clarified direct uploads as prototype-local document storage, not secure permanent storage.
- Promoted the selected parcel summary with owners, proportional mapped area, mutation/document counts and record-vs-map status.


## Final stability notes
- Authentication/session, active workflow view, selected parcel, parcel records, and prototype document metadata are persisted locally in the browser where feasible.
- Direct document uploads are **prototype-local document storage** (browser/localStorage). Production should use controlled object storage, access control, encryption, and audit logging.
- DHAROHAR Parcel IDs such as `DH-JPR-RAM-001024` are **prototype identifiers, not official ULPINs**.
- Map-drawn parcel boundaries are provisional until field verification; they are not asserted to be official cadastral boundaries.
- AI/OCR is optional assistance and is not required for parcel creation, storage, search, verification, or analytics.


## Phase 4: Authoritative Backend, Security & GIS Integration

DHAROHAR Phase 4 converts the prototype foundation into an authoritative, secure, full-stack land registry architecture.

### Architecture Overview
- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS + Leaflet
- **Backend:** Express + TypeScript + Node.js
- **Database:** PostgreSQL + PostGIS (with resilient dev-fallback in-memory store)
- **Security:** Signed JWT Access Tokens (HMAC-SHA256), Salted PBKDF2 Password Hashing, Server-Side RBAC
- **Audit Engine:** Append-only cryptographic hash chaining (`entry_hash = SHA256(previous_hash + payload)`)
- **Document Intelligence:** Tesseract.js Indic OCR + Deterministic Cadastral Revenue Extraction

---

### Environment Variables (.env)
See `.env.example` for the full, current list of variables actually read by the code. The backend requires `JWT_SECRET` to be set to a private random value — never reuse the demo placeholder from older documentation. Example shape:
```env
PORT=3001
NODE_ENV=development
JWT_SECRET=<generate-your-own-random-secret>
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=<your-local-password>
PGDATABASE=dharohar_db
# DATABASE_URL optional; composed from PG* values when absent
```

---

### Database Setup & Migrations
To run migrations and seed the PostgreSQL database with PostGIS spatial tables:
```bash
# Apply PostGIS schema migrations
npm run db:migrate

# Seed demo users, authoritative parcels, owners and documents
# (note: seeding the Postgres audit-log table with genesis entries is NOT implemented;
# only the in-memory dev-fallback store seeds its audit chain)
npm run db:seed

# Start the Express backend server
npm run server
```

---

### Demo Personas

| Role | Display Name | Designation | Email Identifier |
|---|---|---|---|
| **TEHSILDAR** | Shri Arvind Sharma, RAS | Revenue Officer / Tehsildar | `tehsildar@dharohar.local` |
| **PATWARI** | Smt. Sunita Choudhary | Senior Verification Officer / Patwari | `patwari@dharohar.local` |
| **DATA_ENTRY_OPERATOR** | Vikram Singh Rathore | Verification Operator | `operator@dharohar.local` |
| **AUDITOR** | Dr. Meenakshi Sundaram, IAS | State Land Records Auditor | `auditor@dharohar.local` |

**There is no shared demo password in this repository.** `npm run db:seed` takes the password from
`DEMO_PASSWORD` in the environment, or generates one and prints it once, and the four personas are
seeded with that. The test suites and `scripts/validate-stack.sh` must be given the same
`DEMO_PASSWORD` they seeded with; they fail with that instruction rather than trying a default.

The reason is not ceremony: this table used to carry a literal password, which meant anyone who could
read the code had a working credential for a Tehsildar, a Patwari, an operator and an auditor — and
GitGuardian was right to alert on it. These accounts are demo fixtures. Never seed them onto an
instance that is reachable, and never treat a seeded persona as a real officer (see
`docs/DEPLOYMENT.md` §7 for provisioning real accounts).

---

### Server-Side Role-Based Access Control (RBAC) Matrix
| Action | DATA_ENTRY_OPERATOR | PATWARI | TEHSILDAR | AUDITOR |
|---|:---:|:---:|:---:|:---:|
| **Login & View Parcels** | Allowed | Allowed | Allowed | Allowed |
| **Register Documents / OCR** | Allowed | Allowed | Allowed | Read-only |
| **Submit Field Inspections** | Denied (403) | Allowed | Allowed | Read-only |
| **Run Authoritative Validation** | Allowed | Allowed | Allowed | Allowed |
| **Apply Final Digital Seal** | Denied (403) | Denied (403) | **Allowed** | Read-only |
| **View Audit Trail & Verify Chain**| Allowed | Allowed | Allowed | Allowed |

---

### Authoritative API Endpoints Reference
| Method | Endpoint | Access Level | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Authenticates officer and issues signed JWT access token |
| `GET` | `/api/auth/me` | Authenticated | Retrieves current authenticated officer profile |
| `GET` | `/api/parcels` | Authenticated (district-scoped) | Lists parcels the caller's district owns, with search and GIS filters |
| `GET` | `/api/parcels/:id` | Authenticated (district-scoped) | Single parcel details with owners, inspections & audit |
| `POST` | `/api/parcels` | Authenticated | Registers new parcel polygon with geodesic area calculation |
| `PATCH` | `/api/parcels/:id` | Authenticated | Updates parcel attributes (khasra, khata, owners, etc.) |
| `POST` | `/api/parcels/:id/validate` | Authenticated | Server-side validation of area delta, ownership 100%, and fields |
| `GET` | `/api/parcels/:id/documents` | Authenticated | Retrieves documents linked to a parcel |
| `POST` | `/api/parcels/:id/documents` | Authenticated | Links land document to parcel |
| `GET` | `/api/parcels/:id/field-inspections` | Authenticated | Retrieves assisted GPS/camera inspection records |
| `POST` | `/api/parcels/:id/field-inspections` | PATWARI, TEHSILDAR | Submits field inspection with SHA-256 evidence hash |
| `POST` | `/api/parcels/:id/verify` | TEHSILDAR | Digitally seals parcel and records tamper-evident audit entry |
| `GET` | `/api/parcels/:id/audit` | Authenticated | Retrieves chronological chained audit log for parcel |
| `DELETE` | `/api/parcels/:id` | Authenticated | Soft-deletes (archives) parcel with reason logged in audit |
| `GET` | `/api/documents` | Authenticated (district-scoped) | Lists only the documents in the caller's districts |
| `GET` | `/api/documents/:id` | Authenticated (district-scoped) | Retrieves single document metadata with OCR text and hash |
| `POST` | `/api/documents` | Authenticated | Registers document metadata, raw OCR text, and SHA-256 hash |
| `POST` | `/api/documents/:id/link` | Authenticated (both districts) | Attaches an existing document to a parcel, or detaches it with `parcelId: null` |
| `POST` | `/api/parcels/:id/jurisdiction` | TEHSILDAR + `PARCEL_REHOME` | Controlled re-districting: needs authority over both districts and a stated reason |
| `GET` | `/api/verifications/audit-logs` | Authenticated (district-scoped) | Audit trail for the caller's districts; unattributable entries need `USER_ADMIN` |
| `GET` | `/api/verifications/audit-logs/verify-chain` | AUDITOR + `STATE_WIDE_READ` | Verifies cryptographic integrity of the SHA-256 audit chain |
| `POST` | `/api/verifications/field-inspection` | PATWARI, TEHSILDAR | Records assisted field inspection |
| `POST` | `/api/verifications/seal` | TEHSILDAR | Applies official revenue digital seal |
| `GET` | `/api/admin/officers` | `USER_ADMIN` capability | Officer roster with live assignments (never password material) |
| `POST` | `/api/admin/officers` | `USER_ADMIN` capability | Provision an officer with role, districts and capabilities, audited |
| `PUT` | `/api/admin/officers/:id/jurisdictions` | `USER_ADMIN` capability | Replace district assignments; revocation is effective immediately |
| `PUT` | `/api/admin/officers/:id/capabilities` | `USER_ADMIN` capability | Replace `STATE_WIDE_READ` / `USER_ADMIN` / `PARCEL_REHOME` grants |
| `PATCH` | `/api/admin/officers/:id/role` | `USER_ADMIN` capability | Change role with a stated reason |
| `POST` | `/api/admin/officers/:id/password-reset` | `USER_ADMIN` capability | Replace a password; the value is never logged or audit-recorded |
| `GET` | `/api/health` | Public | Detailed health status, PostGIS detection, and uptime |

---

### Authoritative Validation Rules
1. **Area Discrepancy Detection:** Computes geodesic polygon mapped area vs recorded revenue Rakba. For parcel `DH-UDA-KOT-001117`, 0.82 ha mapped vs 0.96 ha recorded flags a 0.14 ha mismatch (14.58%) triggering `AREA_MISMATCH_REQUIRES_FIELD_INSPECTION`.
2. **Co-Sharer Mathematical Sum:** Enforces that `sum(share_percentage) === 100.00%`.
3. **Mandatory Cadastral Identifiers:** Validates presence of Khasra No, Khata No, Khewat No, Mauza/Village, Tehsil, District, Area, and closed Polygon geometry.
4. **9-Point Record Integrity Checklist:** Complete evaluation across Geometry, Area, Document, Mandatory Fields, Ownership, Area Consistency, Field Verification, Officer Verification, and Audit Trail.

---

### Cryptographic Append-Only Audit Trail
Audit entries are chained sequentially using SHA-256:
$$\text{entry\_hash} = \text{SHA-256}(\text{previous\_hash} : \text{entity\_id} : \text{action\_type} : \text{performed\_by} : \text{timestamp} : \text{SHA-256}(\text{details}))$$
- Root genesis hash: `0000000000000000000000000000000000000000000000000000000000000000`
- Zero DELETE or UPDATE queries exist on `append_only_audit_logs`.
- Verified at runtime via `/api/verifications/audit-logs/verify-chain`.

---

### Technical Limitations & Prototype Honesty
- Map boundaries remain provisional until verified by an authorized field officer.
- ULPINs are displayed with honest status `"Pending Government Linkage"`; no fabricated government identifiers are generated.
- Assisted AR/GPS camera checkpoints are prototype decision-support tools, not survey-grade cadastral total station instruments.
- Verified records generate a prototype digital seal and certificate, not an official government gazette.

