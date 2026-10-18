# DHAROHAR — Security Posture, Controls and Known Gaps

Every "enforced" claim below was read out of the code and then exercised by a test in this
repository. Every "not enforced" claim is a gap that someone deploying this must close or accept
knowingly. Nothing here is aspirational.

---

## 1. Identity and authentication

| Control | Implementation | Proof |
|---|---|---|
| Token type | HMAC-SHA256 signed JWT, `Authorization: Bearer` | `server/src/utils/crypto.ts:65` |
| Signing secret | `JWT_SECRET` from the environment. Production **refuses to boot** without it, and rejects the secret that the prototype published in its README | `server/src/config/env.ts`, `test_api.ts` forged-token case |
| Claims | `userId, email, role, displayName, designation, badgeNumber, district, iat, exp` — all read from the token, never from the request body | `verify_api_suite.ts` "identity comes from the JWT" assertions |
| Password storage | PBKDF2-SHA512, per-user salt, hex digest | `crypto.ts:22` |
| Token lifetime | `JWT_EXPIRY_HOURS`, default 24 | `config/env.ts` |
| Login throttle | 10 **failed** attempts per identifier per 10 minutes → HTTP 429; successes are cleared, so an officer cannot be locked out by logging in | `routes/auth.ts:10-39`, `test_api.ts` |
| Session revocation | **None.** A stolen token is valid until it expires. Logout is client-side only. | gap — see §7 |

**Known weak parameter, deliberate:** `PBKDF2_ITERATIONS = 10000` (`crypto.ts:15`) is below current
OWASP guidance for SHA-512. Raising it invalidates every stored `password_hash`, because the
iteration count is not persisted next to the hash. Fixing it needs a rehash-on-login migration plus a
`users` column change, not a constant edit. Until that is done, the deployment must assume an
offline-crack of the `users` table is cheaper than it should be — which makes the "no default
passwords in production" item in §7 non-optional.

---

## 2. Authorization: role **and** jurisdiction

Two independent gates, applied on the server, in this order:

```
authenticateToken  →  denyReadOnly  →  requireRole(...)  →  requireParcelScope / assertParcelAccess
   401                  403               403                     404
```

* Role answers do not depend on which record you named; jurisdiction is checked afterwards.
* **Cross-district access is answered 404, not 403** — a 403 confirms the id exists, which is itself
  a leak across district boundaries. The wording is identical to the genuine not-found path.
* **Authorization state is read from the database on every request**, not from the token. The JWT
  carries identity (`userId`, `role`, `badgeNumber`, a display district); the live jurisdiction set
  comes from `user_jurisdictions` and capabilities from `user_capabilities`, both filtered on
  `revoked_at IS NULL`. A revoked assignment therefore stops working on the next request instead of
  whenever the token expires. A token whose officer no longer exists is refused with 401.
* **Read and write scope are different checks.** `assertParcelReadable` / `assertDocumentReadable`
  honour the `STATE_WIDE_READ` capability; `assertParcelWritable` / `assertDocumentWritable` never do.
  A state-wide reader therefore reads another district's record and is answered 404 the moment they
  try to change it — proven, not asserted, by `test:provisioning`.
* The `AUDITOR` **role** is district-scoped and read-only. Cross-district reading is the separately
  granted `STATE_WIDE_READ` capability, and using it writes a `STATE_WIDE_READ` entry into the audit
  chain (visible to state-wide readers and administrators, invisible to district officers).
* Administrative authority is the `USER_ADMIN` **capability**, not a role, and the roster endpoint
  never selects `password_hash` or `salt`.
* Writes into another district are refused at creation (`assertWritableDistrict`), and `district` is
  absent from `PATCHABLE_COLUMNS` entirely: PATCH answers 400
  `JURISDICTION_CHANGE_REQUIRES_REHOMING`. Re-districting goes through
  `POST /api/parcels/:id/jurisdiction`, which needs `PARCEL_REHOME`, an assignment over **both**
  districts, and a reason; it writes `parcel_mutations` provenance plus a `PARCEL_REDISTRICTED` audit
  entry and never rewrites earlier events.
* `?district=` on the registry list **cannot widen** a caller's scope; `intersectReadScope` narrows it
  or returns nothing.
* Verification fields (`verifiedBy`, `verifiedAt`, `certificateNumber`, `sealSignature`) are not in
  `PATCHABLE_COLUMNS`; a seal happens only through `POST /:id/verify` after server-side preconditions.

| Surface | Where it is enforced |
|---|---|
| Registry list / search | `routes/parcels.ts` — SQL `parcelScopeClause` (`= ANY(districts[])`), scoped in the query, not after fetching |
| Registry detail | `requireParcelRead` on `GET /:id` |
| Create / patch / put / archive | role gate, then `assertWritableDistrict` (create) or `requireParcelWrite` (`/:id`) |
| Validation run | `denyReadOnly` + `requireParcelWrite` (it appends an audit entry, so it is treated as a write) |
| Documents attached to a parcel | `requireParcelRead` / `requireParcelWrite` on the parcel route |
| **Document list** | SQL join to `parcels` with `LOWER(TRIM(COALESCE(doc.district, p.district))) = ANY(scope)` |
| Single document read | `assertDocumentReadable`, district filed at write time so no row is orphaned |
| Document link / unlink to a parcel | `assertDocumentWritable` + `assertParcelWritable`, one transaction with its audit entry |
| Field inspections (read + submit) | role `PATWARI\|TEHSILDAR`, then read/write scope respectively |
| Seal | role `TEHSILDAR`, then `assertParcelWritable`, inside the transaction |
| Re-districting | `PARCEL_REHOME` + assignment over both districts + reason, all server-side |
| Audit trail per parcel | `requireParcelScope` → join through the parcel, because audit rows carry no district column |
| Audit trail unfiltered | `readScope`; `SYSTEM`/`OFFICER` rows (no parcel) additionally require `USER_ADMIN` |
| State-wide chain report | `requireRole('AUDITOR')` **and** `STATE_WIDE_READ` |
| Provisioning (`/api/admin/*`) | `USER_ADMIN` capability on every route, including the read |

Proved by `npm run test:jurisdiction` (46 assertions: id substitution, query parameters, alternate
endpoints, document references, audit reads, foreign-row snapshots before and after) and
`npm run test:provisioning` (57 assertions covering multi-district grants, immediate revocation,
state-wide read without mutation, the logging of it, the re-homing matrix and password rotation).
Both run against the containerised stack from `scripts/validate-stack.sh` (T8–T12), and both were also
run against an API connected as the **least-privilege** `dharohar_app` database role. **Frontend
filtering is not in this list on purpose** — it is presentation only and was never a security
boundary.

---

## 3. Tamper evidence

* **Append-only audit chain**: every entry stores `previous_hash` and `entry_hash` over a
  canonicalised payload (sorted keys, normalised timestamp) — that canonical form is why jsonb
  reordering no longer produces false "Tampered payload" reports.
* A **PostgreSQL trigger** (`append_only_audit_guard`, migration 0001) rejects `UPDATE` and `DELETE`
  on `append_only_audit_logs` at the database level, so even a compromised application cannot quietly
  rewrite history.
* Chain serialisation uses `pg_advisory_xact_lock`, so concurrent writes cannot fork the chain.
* **Seals are HMAC-signed** with `SEAL_SIGNING_KEY` (defaults to `JWT_SECRET`) over canonical
  material. The previous scheme — `sha256(id:officer:badge:random)` — was forgeable by anyone who
  could guess the input format, and the certificate number used `Math.random()`.
* The state change, its audit entry and the seal commit **in the same transaction**; a failure
  rolls back all of it and answers 503 with "No change was committed".

---

## 4. Transport, network and headers

* PostgreSQL publishes **no host port**; the API publishes none either. Only the web container (and
  Caddy, if you use `docker-compose.tls.yml`) is reachable.
* TLS: terminate at Caddy (`docs/DEPLOYMENT.md` §6). Without it the bearer token and the password
  cross the network in clear text.
* nginx sets CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` on **every** location (nginx's `add_header` does not inherit, hence the
  snippet-per-location include). CSP keeps `script-src 'self' 'wasm-unsafe-eval'` and
  `worker-src 'self'` — no remote script and no `blob:` worker, because OCR is self-hosted.
* CORS: `ALLOWED_ORIGINS` is a comma list; `*` is **rejected in production**; an empty list is
  correct when the SPA and API share one origin through the nginx `/api` proxy.
* `TRUST_PROXY=true` makes Express read `X-Forwarded-*`, so the login throttle sees the real client
  IP rather than the proxy's.
* Request bodies capped at 15 MB in Express (25 MB at nginx) — the API limit is authoritative.
* Production error responses do not leak stack traces or internal messages.

### External browser dependencies that remain

The **server** makes no outbound calls and the **OCR path is fully self-hosted**
(`public/tesseract/`, licences and checksums in `PROVENANCE.md`). The **browser** still reaches:

* `fonts.googleapis.com` / `fonts.gstatic.com` (stylesheet + fonts),
* `*.tile.openstreetmap.org` and `server.arcgisonline.com` (map imagery).

Those are allow-listed in the CSP and are the only third-party origins left. An air-gapped or
intranet-only deployment must vendor them too (self-host the two font families, serve tiles from a
planetiler/GeoServer instance) or the map and typography fail. This is a deployment decision, not a
defect — but it is a real dependency for a government network.

---

## 5. Data-integrity rules the code enforces

* No hard delete anywhere: parcels archive; audit rows are trigger-protected.
* `RUN_MIGRATIONS` applies forward-only, additive SQL with a checksum ledger
  (`schema_migrations`). Re-running is a no-op; a changed applied file aborts with a non-zero exit;
  statements that cannot run inside a transaction are rejected before execution.
* Booting never seeds. Demo seeding requires `SEED_CONFIRM=demo` and is refused in production
  without it; demo personas are disabled at module load in production.
* Production never falls back to in-memory storage: an unreachable database at boot aborts startup,
  and a database that goes away mid-request yields `503` with `PARCEL_WRITE_FAILED` /
  `DOCUMENT_WRITE_FAILED` — never a `200` that is not durable.
* OCR cannot invent: the parser reports `—` / `Not recorded` / `Under Review` where the text does not
  say something, and a clause-level negation test (`NO`, `NOT`, `NIL`, `N/A`, `नहीं`, `शून्य`) stops
  "No active court stay order" from being read as an injunction. OCR confidence and line counts come
  from Tesseract, and bounding boxes are requested explicitly (`blocks: true`) instead of silently
  empty.
* `documentHash` is computed by the server over the bytes/text it actually stored, not over whatever
  the caller asserted.

---

## 6. Secrets hygiene observed

* No credential literal in `Dockerfile*`, `docker-compose*.yml`, `deploy/**` or `scripts/**`.
* Compose fails closed on `POSTGRES_PASSWORD` and `JWT_SECRET` (`${VAR:?…}`).
* `backup.sh` / `restore.sh` never print the password; connection details are logged masked.
* `.env` is gitignored; `.dockerignore` keeps it out of images.
* The README no longer publishes a signing secret and now labels the demo accounts as demo-only.

---

## 7. Gaps to close before real records (unranked, all currently true)

1. **No administrative interface.** Provisioning is a CLI bootstrap plus `/api/admin/*` endpoints —
   working, audited and tested, but nobody can click it. A department will not hand out accounts by
   `curl`, so an admin screen is the remaining work, not the mechanism.
2. **No token revocation list.** An officer's *authorizations* are re-read per request, so deleting
   their account or revoking a district takes effect immediately. A leaked bearer token for an
   account that still exists keeps that account's access until it expires; short
   `JWT_EXPIRY_HOURS` is the mitigation, not a fix.
3. **Password hashing cost is low** (10,000 PBKDF2 iterations) and the seeded demo password is
   shared across personas — real deployments must set unique strong passwords; the demo personas do
   not exist in production, but the pattern must not be carried over.
4. **No password policy beyond a 10-character minimum, no lockout notification, no MFA.**
5. **Rate limiting covers login only** — registry and document reads are unthrottled per caller.
6. **Document bytes live in PostgreSQL TEXT columns** (base64) — see `docs/DOCUMENT-STORAGE.md`;
   confidentiality depends on the database backup chain, and the "checksum" is over the stored text
   plus the data URI, not over independently verifiable file bytes.
7. **Row-Level Security is still not implemented.** The blocker is gone — `scripts/roles.sql` now
   yields a role measured as `superuser=false`, `bypassrls=false`, and the full suite passes through
   it (`docs/DATA-MODEL-JURISDICTION.md` §3.2) — but the shipped compose stack still connects as the
   PostGIS image's superuser `POSTGRES_USER`, and no policies exist. Until both change, application
   authorization is the only layer.
8. **Districts are referenced by a stable key now; the registry itself has no authoritative rows.**
   Migration 0003 added `district_code` to `parcels`, `land_documents`, `users` and
   `user_jurisdictions`, with foreign keys to `districts(code)`, CHECKs so the text and the key cannot
   disagree, and a write-time trigger that refuses an unregistered or inactive district
   (`docs/DISTRICT-INTEGRITY-REPORT.md` §3). What remains is not a schema gap: every registry row was
   *derived* from values already stored, so a clean integrity report proves the rows agree with each
   other — not that any of them is a district the department recognises. Declare them
   (`POST /api/admin/districts`) before reading `[PASS]` as authority.
9. **No immutable off-site backup is enforced** by the software — it is a cron job you must install
   and a restore drill you must run (`docs/DEPLOYMENT.md` §8).
10. **Reads are logged only when they are cross-district.** Every ordinary in-district read is
    invisible to the audit trail, so "who looked at this record" is not answerable for a routine
    access — only for a state-wide one, which is where the oversight risk was judged to be.
11. **`tsconfig` `strict` is off**, so a class of null/undefined defects is not caught at compile
    time.
12. **Revocation removes authority, not the account.** An officer whose districts and capabilities are
    all revoked can still authenticate successfully and reach nothing. `users` has no `is_active` or
    "left service" state and no admin action sets one, so a departed officer stays a live login whose
    emptiness is visible only in a report. The integrity checker lists such accounts
    (`officer holds no active jurisdiction and no capability`); nothing retires them.
13. **`parcels.document_id` has no foreign key.** A land record can still name a document that does not
    exist. Migration 0003 deliberately did not add the constraint: it would abort on any database that
    already holds such a row, and the repair is a decision about the document, not a DDL statement. The
    checker lists them — read that list before an import, not after.
14. **One unauthenticated endpoint previously published the database password.** `GET /api/health`
    echoed `getDbHealth().database`, which fell back to the entire `DATABASE_URL` — host, user and
    password included — so a deployment configured the way `docs/DEPLOYMENT.md` permits would have
    exposed its credential with no token required. Fixed 2026-10-18: the health report now carries only
    what `current_database()` returns. Recorded here because it was live in the code about to ship, and
    because "a report prints a connection string" is not something an endpoint test catches unless that
    test is able to fail.
15. **A document with neither a district nor a parcel is unreachable rather than repaired.** The write
    path now files every document under a district, so no new row can be created that way; a restore
    containing one would be reported by the checker and needs an explicit, authorized decision.
