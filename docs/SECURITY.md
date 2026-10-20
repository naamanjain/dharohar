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
  Caddy, if you use `docker-compose.tls.yml`) is reachable, and since 2026-10-19 the web binding
  defaults to `127.0.0.1` — `WEB_BIND=0.0.0.0` is what an operator sets when TLS is in place and the
  service is meant to be reached from outside. Before that change, `docker compose up` on a host with
  a routable interface published the SPA and its `/api` proxy over plain HTTP to that network as an
  unintended side effect of starting the stack.
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
* Migrations are applied by a one-shot `migrate` container running as the schema owner, forward-only,
  additive SQL with a checksum ledger (`schema_migrations`). The API itself runs as a role holding
  SELECT-only on that ledger, so it cannot apply or record a migration; `RUN_MIGRATIONS` defaults to
  false for exactly that reason. Re-running is a no-op; a changed applied file aborts with a non-zero
  exit; statements that cannot run inside a transaction are rejected before execution.
* Booting never seeds. Demo seeding requires `SEED_CONFIRM=demo` and is refused in production
  without it; demo personas are disabled at module load in production.
* Production never falls back to in-memory storage: an unreachable database at boot aborts startup,
  and a database that goes away mid-request yields `503` with `PARCEL_WRITE_FAILED` /
  `DOCUMENT_WRITE_FAILED` — never a `200` that is not durable. `503` is reserved for that case: a
  write refused by a data rule answers `400` (unregistered district) or `409`
  (`PARCEL_IDENTITY_TAKEN`, khasra+village+tehsil already used in that district), because a client
  that is told "unavailable" will retry the same doomed request forever.
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
7. **Tenant isolation is implemented in two layers, and both are tested.** As of 2026-10-21 the shipped
   stack connects as the least-privilege `dharohar_app` (`superuser=false`, `bypassrls=false`, DDL /
   TRUNCATE / DELETE / audit-UPDATE / ledger-INSERT refused by PostgreSQL itself —
   `scripts/probe-role.mjs`), and:
   * **Layer one, application.** `RequestPrincipal` now carries the officer's `organizationId` and the
     tenant's active `organization_districts` grants, re-read every request. A record is reachable only
     when it belongs to the caller's organization AND its district is in the caller's own postings
     intersected with what the tenant holds (`administers` for writes; `administers`, `audits` or `reads`
     for reads). `STATE_WIDE_READ` removes the dependence on the officer's own postings and never the
     dependence on tenancy. The predicate is applied in SQL for lists, searches, counts and the registry
     aggregates, and in `assertParcelReadable` / `assertParcelWritable` / `assertDocumentReadable` /
     `assertDocumentWritable` for every detail and nested path, so a route cannot omit it by forgetting
     to add it.
   * **Layer two, PostgreSQL row-level security.** `parcels` and `land_documents` carry four policies
     each (migration 0006), SELECT/INSERT/UPDATE/DELETE separately, requiring the session's organization
     to match the row **and** to match what `users` says about the session's user id. The GUCs are set
     with `set_config(..., true)` inside a transaction (`server/src/db/tenant.ts`), never at session
     scope, so a pooled connection cannot hand its predecessor's tenant to a later request. Unbound
     reads return zero rows: verified as the runtime role directly, not inferred.
   * **What a refusal looks like.** Another tenant's record and a record that does not exist produce the
     same bytes; an officer whose account has no organization gets `403 TENANT_CONTEXT_MISSING` because
     that is a configuration someone must be able to see.
   * **Not covered by the second layer, stated plainly.** `parcel_owners`, `parcel_mutations`,
     `field_inspections` and `user_jurisdictions` have no owner column of their own and no policies; they
     are scoped through the parcel they hang off, which is RLS-covered, plus the application checks.
     `users` has no policy because login must resolve the account before any tenant context exists.
     `append_only_audit_logs` has no policy because entries attached to a parcel are scoped through it
     (migration 0008 adds actor attribution for the rest) and because chain verification is inherently
     whole-table.
   Measured on a disposable copy with `./scripts/test-authorization-on-copy.sh`:
   `test:jurisdiction` 46/0, `test:provisioning` 91/0, `test_tenancy_isolation_suite.ts` 42/0 — including
   two tenants granted the same district each reading only their own parcel, listings, search, nested
   document and inspection routes, the officer roster, registry counts, cross-tenant document download,
   grant revocation, `audits` opening reads but never writes, and direct SQL as `dharohar_app` with no
   context, with a forged context, and attempting `SET ROLE` to the owner.
7b. **Document bytes are stored, retrieved and now round-trip verified.** Re-measured on 2026-10-21: a
   2,000,000-byte payload written through `POST /api/documents` was read back and hashed to the same
   digest at rest, and the same payload survived `pg_dump` → second-location copy → restore → compare
   (`./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups`, all checks green). The register still
   holds no *scanned* record images beyond those written by the drills, so "the documents are archived"
   remains false about the demo content even though the storage path works — that is an intake gap, and
   the audit trail of a seal over an absent image is still unverifiable.
7b. **The deployed register contains no document images at all.** Measured on 2026-10-19: every
   `land_documents` row in the deployment has an empty `image_uri` — OCR text and metadata, no source
   bytes. The one exception is the 1.5 MB payload written deliberately as a backup-drill fixture, and
   it is synthetic.
   Nothing is broken in the storage path (a 1.5 MB payload written through the API round-tripped
   through backup and restore with an identical digest), but a record set without its source images is
   not digitized land records, and any "documents are preserved" statement about the current data is
   false by vacuity. This is an operational gap in how the demo data was created, not a defect — and
   it must be closed with real uploads before the first pilot, because the audit trail of a seal over
   an absent image is unverifiable.
7c. **Production UI now fails closed when the API is unavailable.** Measured with the API stopped and
   the built bundle served by nginx: sign-in is refused, the session flag stays false, and a
   persistent `role=status` panel says the server is unreachable rather than letting the officer
   discover it later. Previously a connection refusal authenticated into a *demo* workstation whose
   seals and edits were saved to nothing, and the only evidence was a toast that expired in six
   seconds — which itself was invisible, because the notification stack was mounted only inside the
   authenticated layout. `import.meta.env.PROD` is what separates that behaviour from `npm run dev`,
   which keeps the offline demo session deliberately.
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
16. **The gate and the suites create officers and parcels they cannot delete.** They must run against
    a real stack to test real authorization, so each run adds accounts in a fabricated domain
    (`@dharohar.test`) — 39 of them had accumulated on the deployed database by 2026-10-19, 16 with
    read access to Jaipur or Udaipur records and 8 holding `PARCEL_REHOME`. Nothing deletes rows by
    design, and `users` has no retirement state (gap 12), so retirement is done by
    `npm run db:retire-residue` (dry run by default; `RESIDUE_APPLY=true` to act): it revokes every
    jurisdiction and capability and replaces the password with a random value that is never printed,
    through the same audited service the admin API uses. `scripts/validate-stack.sh` now runs it as
    its last step, so the gate retires what the gate creates. Rows survive — as does the reachability
    problem they were a symptom of: the fixture *documents* with neither a district nor a parcel are
    still there, and removing those needs the same authorized decision as gap 15.

---

## 8. Incident record — a working credential was published in git history

**What shipped.** The prototype's twelve-character demo password was a literal in `server/src/db/db.ts`, `seed.ts` and eleven suites,
so the repository carried a password that authenticated four officer accounts in any database seeded
the documented way. It is **not reproduced here on purpose**: any database seeded before 2026-10-19
still accepts that string, including deployments this repository does not control, so spelling it in a
public document keeps the credential alive and re-raises the same scanner incident. Retrieve it from
`git show archive/exposed-history:server/src/db/db.ts` if it is genuinely needed to identify an old
database. Commit `a9e5fcc` and two of my own later commits (`fa515b1`, `d3c4006`) repeated
it; GitGuardian reported it as two *Generic Password* incidents on 2026-10-18. The exposure was
introduced by the agent's commits, not by the original prototype, which is worth stating because the
usual assumption — "the new code is the safe code" — was the wrong one here.

**Also flagged, not a credential.** The two *Generic High Entropy Secret* incidents (`014b2bf`,
`6cd3a40`) are five SHA-256 digests recorded in `public/tesseract/PROVENANCE.md` and
`sha256sum.txt` — integrity checksums for vendored OCR binaries that are fetched from upstream and
verified against them. They are public artefacts' digests, not secrets, and cannot unlock anything.

**What was done, with the measurement rather than the intention.**

| Change | Evidence |
| --- | --- |
| The literal no longer exists in the source. | Fixed-string `grep -rl` for the retired password over the working tree, excluding `node_modules` and `.git`: **0 files**. |
| No commit reachable from `origin/main` contains it. | Per-commit `git grep` over `git rev-list origin/main` (6 commits): clean.    History was replaced with six phase commits and force-pushed with `--force-with-lease`; the previous
   8-commit line is reachable from no pushed ref (kept locally as `archive/exposed-history` only). |
| The running artifact was stale and still carried it. | `grep -rl` inside `dharohar-prod-api-1` found 4 bundled files. The stack had been built from a directory that no longer existed. Rebuilt from the repository: **0 files**. |
| The published credential stopped working **in the deployed database**. | Login for `operator`, `tehsildar`, `patwari`, `auditor` @`dharohar.local`: old literal **401**, rotated password **200** — measured before and after the rebuild, and again after the validation gate re-seeded. |
| The signing secret was rotated. | New `JWT_SECRET` in the untracked `.env`; every token minted before 2026-10-19 is rejected. Anyone already signed in had to sign in again. |
| The gate went from 33/34 to **37 passed, 0 failed**. | `scripts/validate-stack.sh`, run against the rebuilt stack: the db-outage sequence (503 while down, `AUTHORIZATION_UNAVAILABLE` on writes, 200 on recovery, a real write proven after recovery), both authorization suites over HTTP, and the retirement of the accounts those suites create. The 34th check had been failing because no `ADMIN_PASSWORD` was available; the credential kept in `.env.local-credentials-preserve-me` turned out to be the live `sysadmin@dharohar.local` officer holding `USER_ADMIN` (HTTP 200), which is what that check needs. Three more checks were added on 2026-10-19 — see the next section. |
| The deployment is private again. | `netstat` shows `127.0.0.1:8088` only (was `0.0.0.0:8088`); compose default for `WEB_BIND` changed to loopback so a fresh `up` cannot repeat it. |
| A verified backup exists before all of the above. | `backups/dharohar_dharohar_20261018_191018.dump` (13 relations), `sha256sum -c` → **OK**; after the recreate, 10 parcels / 19 documents / 274 audit entries / 10 valid geometries / 3 applied migrations were counted again. |

### Four defects the rebuilt gate produced

Re-running the gate against the rebuilt stack was not a formality: each of these was found because a
check failed, and two of them were failures of the *checking*, not of the product.

1. **The gate proved recovery with a health endpoint.** `ready → 200` needs one working connection; a
   write needs one from the pool. After the outage test the suite's first write answered
   `503 PARCEL_WRITE_FAILED` while the gate had already reported the database recovered. There is now a
   post-recovery write probe (up to 6 attempts, reporting which attempt succeeded), and it uses the
   **same** parcel identity the outage step was refused, so the pair proves the write path came back
   rather than that some other payload happened to be free.
2. **That 503 was not the pool.** `docker logs` said `duplicate key value violates unique constraint
   "uq_parcels_identity"`: the suite's re-home fixture used `run.slice(-2)` — 100 possible khasra
   numbers — so a run collided with an earlier run's leftover, which nothing can delete. The comment
   that the first explanation was wrong is recorded in the suite: a plausible mechanism plus one
   supporting log line (`Idle pool client error`) is not a diagnosis.
3. **A constraint violation was reported as an outage.** Any `23505` on that constraint answered
   `503 PARCEL_WRITE_FAILED`, which instructs the client to retry forever. It answers `409
   PARCEL_IDENTITY_TAKEN` now, and the assertion was proven to be load-bearing: disabling the mapping
   turns the suite to `89 PASSED, 2 FAILED`, restoring it returns `91 PASSED, 0 FAILED`.
4. **The retirement tool reported "nothing to retire" while 24 matching accounts existed**, because
   its default suffix was `.dharohar.test` and the addresses end in `@dharohar.test`. The dry run is
   what caught it. A pattern that matches nothing in the whole table now exits non-zero, so a typo in a
   filter cannot read as a clean result — the same class of hole as the two gates that once compared
   Docker error strings against each other and passed.

**Still the operator's to close — none of it is a code change:**

1. In GitGuardian, mark the two *Generic High Entropy Secret* incidents **not a secret** (they are
   checksums) and the two *Generic Password* incidents **resolved / regenerated**. Rewriting history
   does not retract a scan: the alerted commits remain in GitHub's own records and in GitGuardian's.
2. The repository is **public** (GitHub answers `200` for the anonymous API read). A public repository
   whose history was just rewritten is still public; making it private is one setting, and it is the
   only change that stops further history from being readable.
3. `DEMO_PASSWORD` and the `sysadmin` password now live only in the untracked `.env` and
   `.env.local-credentials-preserve-me`. Anything that can read this working tree can read them, which
   is exactly why the personas must never be seeded anywhere reachable by real records.
4. Anyone who learned the old literal must not be able to reach the deployment. It no longer
   authenticates — that was the point of the rotation — but any *documented* copy of it (README
   history, screenshots, pitch notes, chat logs) should be retired rather than trusted.
