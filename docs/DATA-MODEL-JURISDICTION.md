# Jurisdiction / Tenant Isolation — Data Model and Authorization Design

**Status: design defaults in §2 adopted by the owner on 2026-10-16, subject to future organisational
policy confirmation. This is not a formal government policy approval and must not be cited as one.**
Real land-record data still must not be exposed publicly until §5 is closed.
Nothing in this file is speculation about ownership: every "current state" claim below was read out of
the schema, the JWT payload and the route handlers, and every contradiction in §2 was verified against
the running stack or the source at the file:line given.

---

## 1. What the code does today (verified)

### 1.1 The identity carrier

`server/src/utils/crypto.ts` → `AuthTokenPayload`:

```ts
{ userId, email, role, displayName, designation?, badgeNumber, district, iat, exp }
```

`district` in the token is a **single string**, and it is now display-only: authorization uses
`user_jurisdictions`, re-read from the database on every authenticated request. An officer may hold
several districts by holding several assignment rows, and removing a row takes effect on the next
request rather than when the token expires.

Roles are `TEHSILDAR | PATWARI | DATA_ENTRY_OPERATOR | AUDITOR`, constrained by a `CHECK` in
`0001_initial_schema.sql`. Administrative and cross-district authority are **capabilities**
(`USER_ADMIN`, `STATE_WIDE_READ`, `PARCEL_REHOME`) in `user_capabilities`, deliberately not extra
roles — a capability can be granted and withdrawn per person without touching that constraint.

### 1.2 Which tables carry a jurisdiction column

| Table | Has `district`? | How isolation must be derived |
|---|---|---|
| `users` | yes | directly |
| `parcels` | yes | directly — this is the anchor table |
| `land_documents` | yes (nullable) | **directly, but nullable** — see §4.2 |
| `parcel_owners` | no | FK → `parcels.district` |
| `parcel_mutations` | no | FK → `parcels.district` |
| `field_inspections` | no | FK → `parcels.district` |
| `append_only_audit_logs` | **no** | `parcel_id` / `document_id`, both nullable — see §4.3 |

### 1.3 Enforcement implemented in this audit round (was: none)

Before this work, no query in `server/src/routes` or `server/src/services` filtered by the caller's
district: any authenticated officer could read, search, patch, archive, seal, attach documents to and
pull audit history for every parcel in the state. Role checks restricted *what* you could do; nothing
restricted *whose records* you could do it to.

That is now closed by `server/src/services/jurisdiction.ts`, applied on every surface listed in
`docs/SECURITY.md` §2, with the gate order
`authenticate → denyReadOnly → requireRole → jurisdiction (404)`. Two rules worth recording because
they are decisions, not accidents:

* A new document is **filed under a district at write time** — its own if supplied, else the linked
  parcel's (authoritative), else the uploader's. A row with neither a district nor a parcel is
  unreachable to *everyone including its uploader*, so writes must never create one.
* Cross-district attempts answer **404 with the same wording as a genuine miss**, never 403.

Proved by `npm run test:jurisdiction` (41 assertions) and `scripts/validate-stack.sh` (T8, T9).
**This is enforcement of the model proposed in §2 — the §2 decisions are still unapproved**, so if
you choose tehsil-as-tenant or multi-district officers, this layer is what has to change.

What remains unenforced: PostgreSQL Row-Level Security (§3.2) is designed and **not implemented**, so
the application layer is currently the only layer.

### 1.4 User administration — implemented 2026-10-17 (was: none)

There used to be no endpoint that created a user or assigned a jurisdiction; accounts existed only
because `seed.ts` inserted four demo personas. Provisioning is now a real, audited path (D4):

* `npm run db:bootstrap-admin` creates the first administrator at the shell. It requires
  `BOOTSTRAP_ADMIN_EMAIL/NAME/DISTRICT` (+ optional `BOOTSTRAP_ADMIN_PASSWORD`, otherwise one is
  generated and printed once), refuses to run when a `USER_ADMIN` holder already exists, and writes an
  `OFFICER_PROVISIONED` audit entry. Verified: second invocation exits 4 and touched nothing.
* `server/src/routes/admin.ts` (`/api/admin/officers…`) creates officers, replaces their jurisdiction
  set, replaces their capability set, changes role and resets passwords. Every route is gated on the
  `USER_ADMIN` **capability** — not on a role — and every change is diffed into the audit chain. No
  password material is returned by the roster or recorded by the reset entry.
* There is still **no self-registration** and no admin UI. The web interface does not yet expose these
  endpoints; they are API/CLI only.
* Production identity no longer falls back to memory: `POST /auth/login` consults the in-memory
  personas only outside production, answers `503 AUTH_LOOKUP_UNAVAILABLE` when the registry cannot be
  read instead of "wrong password", and `GET /auth/me` reads the officer row from PostgreSQL.

---

## 2. Approved design defaults (owner instruction, 2026-10-16) and what contradicts them

**Status of these defaults: adopted as design defaults, subject to future organisational policy
confirmation.** They are *not* a formal government policy approval, and nothing in this project may
be described as having received one. Where a default is later overridden by departmental policy, the
override lands here first and the authorization layer changes with it.

Five defaults were given. Each is stated below with the code and schema facts that currently
contradict it, so the contradiction is a work item rather than a surprise.

### D1 — Tenant = organization/department, with district-level jurisdiction boundaries

Single-district operation is acceptable for the first deployment, but the schema must not prevent a
multi-district organization later.

**Contradicts today's model:** there is **no organization or department concept anywhere** — not a
table, not a column, not a token claim. Tenancy is expressed only as a free-text `district` string on
`users` (`0001_initial_schema.sql:31`) and `parcels` (`:58`). §2's earlier recommendation ("the
district *is* the tenant") is therefore **narrower than the approved default** and is superseded:
district becomes a boundary *inside* an organization tenant. Also open: §4.1 — no `districts`
reference table, so a district value cannot be validated at all.

### D2 — Multi-district officers only through explicit server-side assignment; deny by default

**Contradicts today's model — this is the biggest structural change:** the authority is a **single
string inside the signed token**. `AuthTokenPayload.district: string`
(`server/src/types/backend.ts:31`) is compared directly in
`jurisdiction.ts:45 / :88 / :106 / :124`. Consequences of keeping it:

* an officer cannot hold two districts, so a transferred or additionally-assigned posting is
  unrepresentable without re-issuing a token;
* a revocation does **not** take effect until the token expires (24 h default) — the opposite of
  deny-by-default;
* there is no assignment row, so there is nothing to audit, no grantor, and no validity period.

The fix is a per-request principal resolved from the database (`user_jurisdictions`, revoked-at aware),
with the token carrying identity only. Partially compatible already: `?district=` on the registry list
can only *narrow* a caller's scope, never widen it, and `POST /api/documents` validates a supplied
district against the caller instead of trusting it.

**Status 2026-10-18 — implemented, and now enforced below the application too.** Migration 0003 gave
every jurisdiction-bearing row a stable `district_code` with a foreign key to `districts(code)`, a CHECK
so the stored text and the key cannot disagree, and a `BEFORE` trigger that resolves the key on write and
**refuses a district the registry does not contain**. Two gaps in this layer were closed by the same pass,
both found by tests rather than by reading:

* `PATCH /api/parcels/:id` no longer accepts `district` at all, so a jurisdiction can only move through
  the audited re-homing route (D5);
* **the provisioning service used to register districts as a side effect of granting one.** An
  administrator typing `Nowhpur` created the jurisdiction `nowhpur` and posted an officer over it, with
  nothing recording that a new jurisdiction had come into existence. Assignments now require a declared
  district (`400 DISTRICT_NOT_REGISTERED`), and declaring one is its own capability-gated, audited
  operation (`POST /api/admin/districts`). Enforcement without a management path is an outage, so the
  path had to ship with the gate.

### D3 — District auditors stay district-scoped; state-wide read is a separate, explicitly granted, logged, read-only capability

**Contradicts today's model, directly:** `jurisdiction.ts:37-39` treats the **role** `AUDITOR` as
state-wide — `isCrossDistrictReader()` returns true for it unconditionally, so *any* auditor reads
every district, and `verifications.ts:69` hands that same role the whole-state chain report. §1.3's
table and the earlier "AUDITOR is state-wide read-only" proposal are **superseded**: the role must
become district-scoped and the cross-district power must move to an explicit, revocable capability
that is logged whenever it is exercised. Nothing logs state-wide reads today.

### D4 — No self-registration; bootstrap the first administrator securely, then provision by organization with role, jurisdiction and audit; production must not depend on undocumented in-memory users

**Partly satisfied, partly contradicted:**

* No public registration endpoint exists, and privileged routes are role- plus jurisdiction-gated —
  compatible.
* **Contradiction:** production identity still falls back to memory. `routes/auth.ts:103-112` searches
  `memoryStore.users` when the database lookup returns nothing, and `routes/auth.ts:191-196`
  (`GET /auth/me`) reads `memoryStore.users` then the hardcoded `INITIAL_USERS` array. In production
  that map is empty (`DEMO_PERSONAS_ENABLED`), so it fails harmlessly today — but the *code path* is a
  documented-in-code in-memory user list, exactly what this default forbids.
* **Contradiction:** §1.4 still holds — there is no user-creation, role-change, jurisdiction-assignment
  or revocation endpoint, and no bootstrap procedure. The only rows that exist are the four fabricated
  personas `seed.ts` inserts.

### D5 — Re-districting must be controlled, authorized, auditable, and preserve historical provenance; never bulk-auto-reassign

**Contradicted by a live hole, verified on the running stack before this document was written:**
`district` is in `PATCHABLE_COLUMNS` (`routes/parcels.ts:82`) and the PATCH/PUT handler never calls
`assertWritableDistrict` (that guard exists only on create, `routes/parcels.ts:411`). A Jaipur
Tehsildar was therefore able to move a Jaipur parcel into a district that does not exist:

```
PATCH /api/parcels/DH-JPR-RAM-001024  {"district":"Fakepur"}   ->  200 OK
psql: DH-JPR-RAM-001024 -> Fakepur
```

The record immediately became invisible to its own owner (district no longer matches) — an
authorization escape *and* a self-inflicted data-loss event, reachable with one ordinary field edit.
It was reverted by direct SQL; the audit chain kept the entry for the bad edit, which is the trail
behaving correctly. Fix: remove `district` from the patchable set and replace it with an explicit,
reason-bearing re-homing operation that writes `parcel_mutations` provenance plus its own audit entry,
leaving earlier events untouched. No bulk reassignment and no inferred ownership — the destination
district must be supplied by someone authorized to say it.

### Net effect on the earlier proposal

| Earlier §2 claim | Now |
|---|---|
| "the district is the tenant" | Superseded by D1: organization is the tenant, district is a boundary inside it |
| "`AUDITOR` = state-wide read-only" | Superseded by D3: role is district-scoped; state-wide read is a separate logged capability |
| "can one officer hold multiple districts? (unknown)" | Answered by D2: yes, via explicit server-side assignment only |
| "who provisions users? (no mechanism)" | Answered by D4: bootstrap + authorized organization-level provisioning, audited |
| "can a parcel's district change? (unknown)" | Answered by D5: only through a controlled, audited operation |


---

## 3. Enforcement design (two layers, deliberately redundant)

### 3.1 Layer 1 — application authorization (primary)

A single server-side helper, used by **every** read, write, update, delete, search, export,
document-access and background-processing path:

```
assertJurisdiction(user, parcelDistrict, action)
  → AUDITOR: allow read only, any district
  → others: allow only when parcelDistrict === user.district
```

Applied at the route boundary, not in the frontend, and not by trusting a client-supplied `district`
query parameter. A mismatch returns **404, not 403** — a 403 confirms the record exists, which is
itself a leak across district boundaries.

### 3.2 Layer 2 — PostgreSQL Row-Level Security (defence in depth) — NOT IMPLEMENTED; prerequisite now proven satisfiable

RLS is viable here because the API uses a single connection pool; the district is passed per
transaction with `set_config('dharohar.district', $1, true)` (transaction-local, so it cannot leak
between pooled connections) plus an `is_auditor` flag.

**Known compatibility cost, stated honestly:** the current code opens transactions manually in
`parcels.ts`, `parcelService.ts`, `documents.ts` and `auditService.ts`. Every one of those sites must
set the GUC inside the transaction *before* any read, and any future code path that forgets will
silently see zero rows. That is why RLS is proposed as the second layer and the application check is
the primary one — not as a substitute for it.

**Prerequisite discovered while verifying this (measured on the running stack, not assumed):** a
policy would currently do nothing at all. Three independent reasons, all true today:

```
current_user      = dharohar            -- also the OWNER of `parcels`
rolsuper          = true                -- the postgis/postgis image makes POSTGRES_USER a superuser
rolbypassrls      = true
relrowsecurity / relforcerowsecurity = f / f
```

A superuser, a `BYPASSRLS` role, and a table owner each skip row security; `FORCE ROW LEVEL
SECURITY` only helps for the owner case. So RLS requires the API to connect as the
**least-privilege role created by `scripts/roles.sql`**, with the schema owned by a different role —
a deployment change, not a migration alone. Until that switch happens, adding policies would produce
the worst kind of false assurance: a checkbox in the docs and zero enforcement in the database.

Order of work, if you want layer 2: (1) apply `scripts/roles.sql` and point `PGUSER`/`DATABASE_URL` at
the app role, confirming `rolsuper=false, rolbypassrls=false`; (2) add the policies in migration
`0002` with `FORCE ROW LEVEL SECURITY` where the API is also the owner; (3) set the GUC in every
transaction site; (4) extend `npm run test:jurisdiction` so a policy violation fails the build.
Steps (1)–(4) are each independently shippable; skipping (1) makes (2) decorative.

**Step (1) was carried out and measured on 2026-10-17, so the blocker is now a configuration switch
rather than an unknown.** `scripts/roles.sql` was extended to cover the migration-0002 tables
(`organizations`, `districts`, `user_jurisdictions`, `user_capabilities`) and applied to a fresh
database. PostgreSQL reported the role as:

```
login=true superuser=false createrole=false createdb=false bypassrls=false replication=false
schema public             USAGE=true CREATE=false
append_only_audit_logs    SELECT=true INSERT=true UPDATE=false DELETE=false TRUNCATE=false
schema_migrations         SELECT=true INSERT=false UPDATE=false DELETE=false
parcels / land_documents / field_inspections / parcel_mutations / users /
organizations / districts / user_jurisdictions / user_capabilities   DELETE=false
parcel_owners                                                    DELETE=true  (see below)
```

Direct probes as that role confirmed the boundaries: `UPDATE append_only_audit_logs`,
`DELETE FROM parcels` and `INSERT INTO schema_migrations` each returned `permission denied`, while
`SELECT` worked. The API was then started with `DATABASE_URL` pointing at `dharohar_app` and both
`npm run test:jurisdiction` (46/46) and `npm run test:provisioning` (57/57) passed against it — so the
application is genuinely workable at least privilege, including provisioning, jurisdiction changes,
re-homing and password rotation.

One deliberate widening, documented in `scripts/roles.sql` §3b: replacing a parcel's co-sharer list is
implemented as delete-then-insert on `parcel_owners`, so that single table carries `DELETE`. The
previous owner set is written to `parcel_mutations` and the chained audit log first, neither of which
this role can delete, so the history of a removal survives it. Every record table that a land record
could be lost from — `parcels`, `land_documents`, `field_inspections`, `parcel_mutations` and the four
0002 tables — has `DELETE` and `TRUNCATE` explicitly revoked rather than merely absent.

Policies themselves are still **not written**: with no policy on a table, a non-owner role sees
nothing at all, so enabling row security before the policies and the GUC plumbing exist would switch
the application off rather than protect it.

### 3.3 Why not "just filter in the UI"

The frontend already filters lists by district in places. That is presentation only: the API returns
everything, so the data is reachable by editing a URL or calling the endpoint directly. Frontend
filtering is not, and will never be, a security boundary.

---

## 4. Open data-integrity problems this exposes

### 4.1 Reference data vs owned data
There is no separation today. Everything is in one schema with no shared-reference tables. Districts
like `Kota`, `Bikaner` appear in `DISTRICT_METRICS` (frontend mock) but have no server-side reference
row, so there is nothing to validate a parcel's `district` against. A typo (`"Japur"`) silently
creates an unreachable jurisdiction. Needs a `districts` reference table + FK.

### 4.2 `land_documents.district` is nullable
A document with a null district cannot be scoped by its own column. It must be scoped through
`parcel_id`, but `land_documents.parcel_id` is nullable too. A document with **both** null is
unassignable. Existing demo rows happen to set them; real ingested data may not.

### 4.3 Audit logs have no district
`append_only_audit_logs` has nullable `parcel_id` and `document_id`. An entry with neither (e.g.
`OFFICER_LOGGED_IN`, `SYSTEM`) is not district-scoped at all. Scoping audit reads therefore requires
a join through parcels, and a policy decision on whether system-level entries are visible to all
authenticated officers or to nobody.

### 4.4 Existing record assignment — **BLOCKER**
For the demo dataset the `district` values are already populated, so scoping can be applied without
guessing. **For any real land records you intend to load, I cannot determine the correct district
assignment from the repository** — it depends on the source data, which is not here. I will not
invent those assignments. Real data must arrive with an authoritative district, or be assigned by
someone with the actual revenue records.

---

## 5. Release gate status

Do **not** expose real land-record data publicly until all of these are true:

1. The §2 defaults are implemented as written. — **IN PROGRESS.** Adopted as design defaults on
   2026-10-16; **formal organisational policy confirmation is still outstanding** and this project
   must not claim it.
2. Application-layer authorization exists on every listed operation type. — **DONE** (§1.3), and
   being re-verified under D2/D3 once the principal is resolved from assignments rather than the
   token string.
3. Automated negative tests pass: an officer of District A is denied District B data via ID change,
   query parameter, alternate endpoint, document reference, export request, and audit-log read. —
   **DONE** (`npm run test:jurisdiction`, 46 assertions, `scripts/validate-stack.sh` T8/T9). Extended as
   required and covered: an officer with **no** assignment (deny), a **revoked** assignment (deny on the
   next request, without waiting for token expiry), a district-scoped auditor attempting state-wide
   **writes**, and D5's re-homing route (`npm run test:provisioning`, 88 assertions).
4. A backup has been restored into a scratch database and verified. — **DONE on throwaway data**
   (`scripts/backup.sh` → `scripts/restore.sh` + count/chain comparison). Must be re-run against a
   copy of real data before that data goes public.
5. A user-provisioning path exists (D4): bootstrap administrator, then authorized role /
   jurisdiction / capability assignment, each audited, with **no** production dependency on in-memory
   users. — **DONE** (§1.4), proved by `npm run test:provisioning` (88 assertions). Remaining: no admin
   *interface*, and someone must actually run the bootstrap command per deployment.
6. The PATCH-reassignment hole in D5 is closed and covered by a test. — **DONE.** `district` is out of
   `PATCHABLE_COLUMNS` (PATCH answers 400 `JURISDICTION_CHANGE_REQUIRES_REHOMING`), and re-homing goes
   through `POST /api/parcels/:id/jurisdiction`, which needs the `PARCEL_REHOME` capability plus an
   assignment over both districts, records the reason in `parcel_mutations` and its own
   `PARCEL_REDISTRICTED` audit entry, and leaves earlier entries untouched.
7. The API connects as a least-privilege database role (§3.2) before RLS is claimed as a control. —
   **NOT DONE.** The role and its measurements exist; the shipped compose stack still uses the superuser.
8. Jurisdiction references are valid, or explicitly reported as unresolved. — **DONE as of migration
   0003**, with the inspection report, the checker, its negative control and the migration's own refusal
   to guess documented in `docs/DISTRICT-INTEGRITY-REPORT.md`. Outstanding there: the registry still has
   no `declared` rows, so no `[PASS]` proves any district name is the department's — only that the rows
   agree with each other.
   — **MEASURED, NOT YET THE DEFAULT.** The role exists, is non-superuser and `NOBYPASSRLS`, and the
   whole suite passes through it; the shipped compose file still uses the container's
   `POSTGRES_USER`, which is a superuser. Switching it is a deployment step, and until it happens no
   row-level-security claim is true.

Until 5, 6 and 7 are closed, this deployment is a **demo instance with fabricated records only**, and
the demo personas, demo parcels and `SEED_CONFIRM=demo` guard all reflect that.
