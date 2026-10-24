# DHAROHAR — Multi-Organization Tenant & Canonical District Model

Proposal date 2026-10-19. **Status: phases 1–3 are implemented as migration `0004` and applied to the
demo deployment; §4 phases 4 onward are not.** §7 records the tests that were executed before
integration and §9 records their results. Nothing here was verified against a public server, and no
real land record exists anywhere in scope — see §8 for the decisions that remain with a person and
"what is not claimed" for the boundary of this work.

## 1. The decision this implements

1. DHAROHAR is multi-organization. A deployment is not permanently one department or one district.
2. A **canonical geographic district registry** exists, keyed by a stable identifier. A district *name*
   is not the identity and is not globally unique.
3. Organization↔district is an explicit **many-to-many** relationship. Several organizations may be
   associated with the same canonical district where governance permits. An organization's own internal
   units are a separate concept from canonical geography.
4. Existing demo records are not given invented official ownership. One explicitly named
   **Dharohar Demo Organization** exists; fixtures map into it only where the mapping is unambiguous;
   ambiguous rows abort and are reported. History and relationships are preserved.
5. The demo tenant is never to be read as evidence about real-world jurisdiction ownership.

## 2. What is actually in the database today (measured, deployed instance, 2026-10-19)

| Measured | Value |
| --- | --- |
| `organizations` rows | **0** |
| `districts` rows | **15** — 4 with `provenance='derived'`, 11 with `provenance='declared'` |
| districts carrying an organization | 0 |
| `parcels` | 36 rows, all with `district_code`; jaipur 8, udaipur 16, jodhpur 1, and **11 in `probe NNNNNN` districts** |
| `land_documents` | 36 rows, 34 with `district_code`, **2 NULL** (the two unreachable `persist_probe.pdf` rows) |
| `users` | 56 rows, all with `district_code` |
| `user_jurisdictions` active | **5** |
| Officers with no active jurisdiction and no capability | 51 (retired test-suite fixtures) |

Two things in that table change the design, and both are worth saying plainly:

* **The registry is already polluted with test fixtures.** 11 of the 15 district rows are named
  `probe 016587`, `probe 381297`, … — created by the provisioning suite calling the declare endpoint,
  and 11 parcels now *reference* them as their district. A canonical geographic registry containing
  eleven invented districts is not a registry; before any tenancy work, these rows need a disposition,
  and promoting them into canonical geography would be exactly the invention decision 4 forbids.
* **Nothing has an organization.** So every mapping in §5 is a mapping into a *demo* tenant, decided by
  the fact that this database contains only synthetic data — not by any evidence about real
  administration. That distinction is the whole of decision 5.

## 3. Proposed schema

Three new shapes, one changed key, and children repointed from the name to the identifier.

### 3.1 `districts` — canonical geography, keyed by an identifier

```
id            uuid PRIMARY KEY                    -- stable identity; what children reference
canonical_name text NOT NULL                      -- display form, e.g. 'Jaipur'
name_key       text NOT NULL                      -- lower(btrim(canonical_name)) for matching
state_code     text                                -- NULL = not recorded. NEVER inferred
country_code   text NOT NULL DEFAULT 'IN'
legacy_code    text UNIQUE                         -- the old districts.code, kept so existing text
                                                  -- and the old API contract keep resolving
kind           text NOT NULL CHECK (kind IN ('canonical','test_fixture','retired'))
is_active      boolean NOT NULL DEFAULT true
provenance     text NOT NULL                      -- 'derived' | 'declared' | 'imported'
notes          text
created_at / retired_at  timestamptz
UNIQUE (name_key, coalesce(state_code,''))        -- two states may each have a Jaipur
```

`UNIQUE (canonical_name)` **disappears** (that is decision 2 — today's
`ux_districts_canonical_name` is the constraint that makes a shared name impossible), and identity moves
to `id`. `legacy_code` is retained so this is a *repudiation of the name-as-identity assumption*, not a
rename of every column, and so the HTTP contract can keep returning the district text it returns today.

`state_code` is nullable and stays NULL until a person supplies it. A `NULL` in a unique key means two
rows with the same name and no state still collide — deliberate: it forces the state question to be
answered rather than papered over.

### 3.2 `organization_districts` — the authorized relationship, many-to-many

```
organization_id  text NOT NULL REFERENCES organizations(id)
district_id      uuid NOT NULL REFERENCES districts(id)
relationship     text NOT NULL CHECK (relationship IN ('administers','audits','reads'))
granted_by       text NOT NULL                    -- officer id or 'migration:0004'
reason           text NOT NULL                    -- required, same rule as re-homing
granted_at       timestamptz NOT NULL DEFAULT now()
revoked_at       timestamptz
PRIMARY KEY (organization_id, district_id, relationship)
```

* Several organizations may point at one district — decision 3 — with different `reason` and
  `granted_by` per row, so an audit can say who granted what, when, and why.
* `revoked_at` rather than DELETE, matching the existing soft-revocation pattern in
  `user_jurisdictions` and `user_capabilities`. Removing an association is history, not editing.
* `relationship` distinguishes administering a district from merely reading it, so oversight (auditors)
  does not silently become mutation rights — the same separation the capability layer already enforces.

### 3.3 `organization_units` — an organization's internal units, separate from geography

```
id               uuid PRIMARY KEY
organization_id  text NOT NULL REFERENCES organizations(id)
parent_unit_id   uuid NULL REFERENCES organization_units(id)
district_id      uuid NULL REFERENCES districts(id)   -- where the unit sits within canonical geography
kind             text NOT NULL                      -- 'tehsil','circle','station','office',… org-defined
name             text NOT NULL
unit_code        text                               -- organization-internal code, unique only within org
is_active        boolean NOT NULL DEFAULT true
UNIQUE (organization_id, unit_code)
```

This exists because "an organization's own sub-divisions" and "a district of the state" are different
nouns. Nothing in the current schema expresses the first; the second is `districts`. Uniqueness of a
unit code is scoped to the organization, never global.

### 3.4 Children reference the identifier, not the name

`parcels`, `land_documents`, `users`, `user_jurisdictions` each gain `district_id uuid NULL REFERENCES
districts(id)`, backfilled from `district_code` → `districts.legacy_code`. The existing `district_code`
and the text `district` column stay during the transition so the running API and its 46-check
jurisdiction suite are not broken by the same commit that changes the key; the CHECK that keeps text
and code in agreement is extended to keep all three consistent once a row has an id.

`user_jurisdictions` keeps its `district` text primary key for now; a follow-up swaps it to
`(user_id, district_id)`. Doing both at once would change authorization semantics in one step, which is
the wrong size of bite.

### 3.5 What the read path means afterwards

An officer's effective districts today are `user_jurisdictions` rows. Under this model they are the
intersection: districts the officer is assigned **and** the officer's organization has an active
relationship with, for the relationship kind the operation needs (`administers` for writes, any of the
three for reads). `STATE_WIDE_READ` continues to widen reads only, never writes. An officer whose org
has no relationship for a district they are assigned sees nothing — and the API answers 404, not 403,
for a record outside scope, exactly as now.

## 4. Migration plan (additive, in the order that keeps every step reversible)

| Phase | Work | Runs in |
| --- | --- | --- |
| 0 | Verified dump + `sha256sum -c`; restore-drill into a disposable copy and repeat after each phase | operator |
| 1 | New tables `organization_districts`, `organization_units`; `districts` gains `id`, `kind`, `state_code`, `country_code`, `legacy_code` populated from `code`; **no constraint dropped yet** | 0004 |
| 2 | Map the demo tenant: insert `ORG-DHAROHAR-DEMO`; write `organization_districts` rows for **canonical** districts only; classify `probe %` rows `kind='test_fixture'` and map nothing | 0004 |
| 3 | Backfill `district_id` on the four children by exact `legacy_code` match; report every row left NULL rather than guessing | 0004 |
| 4 | Add the new uniqueness (`UNIQUE (name_key, state_code)`) and drop `ux_districts_canonical_name`; repoint the four FKs from `districts(code)` to `districts(id)` | 0005 |
| 5 | Application: read scope computed through `organization_districts`; API returns district id + name; jurisdiction tests extended to cross-organization cases | code |
| 6 | RLS policies — only after 4 and 5 are settled | 0006 |

Phase 4 is split out because dropping a unique constraint and repointing foreign keys is where a
half-applied schema would be dangerous; phases 1–3 are pure additions and can be re-run safely.

## 5. Existing-record mapping report — what maps, what does not, what aborts

Measured against the deployed database described in §2. "Maps" means *into the demo tenant*, which is
the only tenant that exists, and which asserts nothing about real administration (decision 5).

| Group | Count | Disposition | Why |
| --- | --- | --- | --- |
| Registry rows `ajmer, jaipur, jodhpur, udaipur` (`provenance='derived'`) | 4 | `kind='canonical'`, mapped to `ORG-DHAROHAR-DEMO` with `relationship='administers'`, `granted_by='migration:0004'`, reason naming the demo tenant | They are the only rows resembling real districts, they came from record text, and the records that used them are demo data |
| Registry rows matching `probe %` | 11 | `kind='test_fixture'`, **not** mapped to any organization | Invented by the test suite. Assigning them to the demo org would launder fixtures into canonical geography — precisely the invention decision 4 forbids |
| Parcels in the 4 canonical districts | 25 | `district_id` backfilled exactly | Unambiguous single match |
| Parcels in a `probe` district | 11 | `district_id` backfilled (the row exists), **no organization relationship**, so they are unreachable to every officer until a person decides | The record→district link is a fact; the district's canonical status is not. Backfilling the FK keeps history (decision 4); leaving it un-mapped keeps it honest |
| Documents with `district_code` | 34 | backfilled as above | same rule |
| Documents with NULL `district_code` | 2 | stay NULL, reported | These are the two known unreachable rows. Inventing a district for them is forbidden |
| Officers in canonical districts | 5 of 56 | `user_jurisdictions.district_id` backfilled, org derived from the district relationship | Active assignments only |
| Retired fixture officers | 51 | `district_id` backfilled where the code resolves, no organization relationship | They hold no active jurisdiction; promoting them would resurrect test identities |

**Abort conditions the migration enforces rather than guesses through:**

1. A `districts.code` resolving to more than one registry row → abort, list the codes.
2. A child row whose `district_code` is non-NULL but matches no registry row → abort, list the row
   keys. (Measured today: none — all 36 parcels and 34 coded documents resolve.)
3. An organization insert conflicting with an existing `ORG-DHAROHAR-DEMO` that has a *different* name
   → abort; the demo tenant's identity is a fact, not a preference.
4. The canonical name uniqueness check finding two rows with the same `name_key` and no `state_code` →
   abort, because choosing which is "the" Jaipur is a governance decision, not a `min(id)`.

## 6. Rollback strategy

* **Before integration, rollback is the dump.** Phases 1–3 are additive: every object created by 0004 is
  new (`organization_districts`, `organization_units`, `districts.id/kind/state_code/country_code/
  legacy_code`, `district_id` on four tables). No constraint is dropped and no row is deleted, so
  dropping those objects restores the previous state exactly. `scripts/rollback-0004.sql` is written
  alongside and executed in the same test run, so the reverse path is a tested artifact rather than a
  paragraph of intentions.
* **The application keeps reading `district_code` throughout phases 1–3**, which is what makes a
  mid-change rollback safe: a restored dump plus the old code still serves, because nothing the old code
  reads was removed.
* **Phase 4 is the point of no return without a restore.** It drops the global name uniqueness and
  repoints four foreign keys. It ships only with: a verified dump taken immediately before, the
  validation gate green on the restored copy, and the rollback script re-tested against that dump.
  If either check is not green, the phase is not applied — the alternative is an unusable schema.
* **No `--allow-non-empty` restores.** `scripts/restore.sh` refuses a non-empty target by default, and
  the drill procedure is documented in `docs/DEPLOYMENT.md` §8.
* The migration runner is forward-only and records a checksum per file; re-running an applied file
  aborts rather than double-applying. A rollback therefore means either the reverse script (phases 1–3)
  or a restore from a verified dump (any phase).

## 7. Test plan against a disposable copy (what has to be true before this touches the runner)

1. Restore the current deployment into a throwaway database (`scripts/restore.sh --create-db`).
2. Run 0004 → expect success, and assert the mapping report's numbers as the *output* of the run.
3. Re-run 0004 → expect a clean no-op (idempotence), not a duplicate-key failure.
4. Run the §5 aborts on purpose, one at a time, in the disposable copy: duplicate code, orphan
   `district_code`, pre-existing differently-named demo org. Each must abort with its named report and
   leave the schema unchanged — a guard that has never fired is not evidence.
5. Run `npm run test:registry`, `test:integrity-gate`, `test:jurisdiction`, `test:provisioning` against
   an API connected to the migrated copy.
6. Run `scripts/probe-role.mjs` — the new tables must be reachable by `dharohar_app` and not droppable.
7. Execute `rollback-0004.sql`, confirm the schema equals the pre-migration state, then re-apply.
8. Only then: move 0004 into `server/src/db/migrations/` and let the gate require it.

## 8. What needs a human governance decision — and what can proceed on synthetic data

**Needs a person (a department, or the owner acting for it). The code cannot decide these:**

1. ~~**The eleven `probe NNNNNN` districts and the eleven parcels under them.**~~ **DECIDED and applied
   2026-10-20.** The owner directed that all probe-pattern districts be retired while their parcels
   remain as isolated synthetic fixtures, preserving history and refusing new writes. Migration 0005
   implements that by pattern rather than by name list, so a fixture minted between runs is caught too
   — it retired 12 rows, including `probe 790279`, which had escaped into `kind='canonical'`.
2. ~~**Which state each canonical district belongs to** (`state_code`).~~ **DECIDED and applied
   2026-10-20.** Ajmer, Jaipur, Jodhpur and Udaipur are `RJ`, badged in `notes` as a mapping for the
   synthetic demo environment and explicitly not a certification of real land records. The remaining
   NULLs are honest: nothing in this database is real geography.
2b. **Which organization owns each existing record — the one that now blocks RLS.** No migration has
   ever written `parcels.organization_id` or `users.organization_id`; measured 2026-10-20, they are NULL
   on 39/39 parcels and 59/59 users, and `land_documents` has no such column. Two ways to answer:
   inherit the tenant that administers the record's district, or label by hand. Either is a decision;
   guessing is not available, and RLS cannot be written before one is made.
2c. **What a declaration means.** `districts.kind` defaults to `'canonical'`, so declaring a district —
   which the provisioning suite does through the API — creates canonical geography immediately. That
   default should probably become a candidate state requiring approval, but that is a governance choice
   about who may create registry rows, not a technical one.
3. **Whether more than one organization may administer the same district in the same state**, and under
   which relationship kind — the schema permits it; only governance says whether it is allowed.
4. **What the real organizations are** (names, hierarchy, who may grant an association) and the identity
   and key of the first real tenant, so the demo tenant can be separated from it structurally rather
   than by convention.
5. **Disposition of the 2 district-less, parcel-less documents** and the 51 retired test officers.
6. **Whether the demo tenant may ever coexist with a real tenant in one database**, or whether a real
   deployment must start from an empty registry. Recommendation: start real deployments empty and keep
   `ORG-DHAROHAR-DEMO` out of them; the schema should be able to say so, which is a policy, not a column.

**Safe to complete now with synthetic data only:** phases 1–3 of the migration and their tests;
the rollback script; the `organization_units` table and its API; extending the authorization read path
to intersect `user_jurisdictions` with `organization_districts`, exercised by new cross-organization
negative tests; the RLS policy design once §4 phase 4 has landed; and the documentation of all of it.
None of that requires a real organization, and none of it may be presented as production readiness.

## 9. What was executed on 2026-10-19 (`./scripts/test-tenant-migration.sh`, 31 assertions at the time — the file covers 0005 too now, see §10)

The harness restores the deployed database into **throwaway** databases on the scratch container. The
only statement it sends to the deployment is a read-only `pg_dump`.

| Step | Result |
| --- | --- |
| Restore → apply 0004 | exit 0. 1 org, 4 canonical associations, 11 rows classified `test_fixture` with **0** associations, `parcels.district_id` 36/36, `land_documents` 34 of 36 (the 2 district-less rows stay NULL), 101 historical `user_jurisdictions` rows backfilled, no id/code drift |
| Re-apply (idempotence) | exit 0; still 4 associations, still 1 organization |
| Rollback | exit 0; districts column count back to 6, `organization_districts` gone, 0 organizations, all 36 parcels intact, the 0003 CHECK still enforced |
| Re-apply after rollback | exit 0 |
| Abort: parcel with `district_code='ghostville'` | aborted, **named `ghostville`**, and left no `districts.id` column and no organization — the transaction rolled back completely |
| Abort: `ORG-DHAROHAR-DEMO` exists with a different name | aborted before writing |
| Rollback with a human-made grant present | **refused** rather than deleting a real association |
| Application against the migrated copy | `test:jurisdiction` 46/0 and `test:provisioning` 91/0, on both a psql-applied and a runner-applied database |
| Integrity checker | 53 findings, identical before and after — no new finding class, nothing repaired |

Two defects the harness caught that hand-reviewing would have missed: a `CHECK` containing a
subquery (PostgreSQL rejects it outright — `cannot use subquery in check constraint`), and a
`DROP CONSTRAINT` on the key that the new table references (which broke re-running the file at all).
Both are now written as a `DO` block guard and an add-if-missing, and both were re-tested.

**Then integrated.** `0004_canonical_districts_and_tenants.sql` is in `server/src/db/migrations/`
(derived from the drill copy by `scripts/build-tenant-migration.mjs`, which strips only `\set`,
`BEGIN;` and `COMMIT;` — the runner owns the transaction) and was applied to the demo deployment:
`ledger=0001,0002,0003,0004`, `organizations=1` (`Dharohar Demo Organization`), 4 associations,
11 unmapped fixtures, 36/36 parcels and 34/36 documents carrying `district_id`, API healthy, and the
full gate **43 checks green** with the migration assertion now requiring all four files. (That count is
the state of the gate on 2026-10-19; with 0005 and its object checks it is 52 passing plus the one
honest failure described in §10.1.)

**One operational trap found while doing it:** the `migrate` service reads the migrations directory
*baked into the image*, so adding a migration file does not take effect until the image is rebuilt.
`run --rm migrate` reported "No pending migrations. 4 applied" against an image that carried only
three files — and it also warned that 0004's file had vanished, which is the same fact seen from the
other side. Rebuilding is `docker compose -f docker-compose.prod.yml --profile tools build migrate
api`: it works from the local layer cache with no registry access, which the note written on 2026-10-19
got wrong. Both the build and the apply were re-run on 2026-10-20 for migration 0005 (§10), and the
file list was verified *inside* the image before the runner was trusted — `ls` in a running container
is the only proof that the artifact being executed is the artifact that was edited.

## 10. Migration 0005 executed (2026-10-20) — and the tenancy tests it unlocked

`0005_district_identifier_authority.sql` implements the owner's two decisions and then makes the
identifier authoritative. Verified first by `./scripts/test-tenant-migration.sh` on a disposable copy:
**65 assertions passed, 0 failed** (up from 31 for 0004; the file now also covers 0005, its rollback
and the guards). Then applied to the demo deployment by the runner.

Measured after the apply on `dharohar-prod-db-1`:

| | result |
| --- | --- |
| `schema_migrations` | `0001,0002,0003,0004,0005` |
| `districts` primary key | `id` (the identifier), with `ux_districts_code` keeping the name resolvable |
| state code `RJ` | 4 canonical districts — Ajmer, Jaipur, Jodhpur, Udaipur — badge-noted as demo-environment mapping |
| probe-pattern rows | 12 retired, all inactive; their parcels untouched (39 → 39) |
| children referencing the identifier | `fk_parcels_district_id`, `fk_land_documents_district_id`, `fk_users_district_id`, `fk_user_jurisdictions_district_id` |
| children still referencing the code | the four `fk_*_district_code` constraints, kept deliberately as the backstop when triggers are bypassed |
| codes with no identifier | 0 across all four child tables |

Three findings came out of running it rather than reading it:

1. **A live-only condition the drill could not see.** `probe 790279` was declared at 16:19:54Z, after
   0004 had already run, and `districts.id` had no DEFAULT until 0005 — so it landed with a NULL
   identifier, and the parcel written against it could never be mapped. The first live apply aborted
   with `[DISTRICT_UNRESOLVED]`, correctly refusing to guess. 0005 now mints identifiers for registry
   rows that were written without one (section 2), which creates no district and re-homes no record.
   The drill was extended to plant that exact condition — a post-0004 declaration through the ordinary
   write path — and 0005 is asserted to heal it and say so.
2. **`session_replication_role = replica` disables referential-integrity triggers too**, so the probe
   that was supposed to prove the code backstop bites was actually proving nothing: with the role set,
   the FK is off along with the user trigger and the ghost row inserts. Disabling the sync trigger
   *by name* keeps RI enforced (verified separately), and that is what the assertion now does — after
   first echoing that its own `UPDATE` ran, because a `#`-prefixed comment inside a psql heredoc is a
   syntax error in SQL and had been silently skipping the statement for a whole run.
3. **The baseline check was not a check.** The harness picks a pre-0004 dump by reading its TOC, and
   treated "pg_restore printed nothing" as "no organization_districts", so a failed mount read as an
   old dump and the drill upgraded a baseline that was already migrated — 12 red assertions whose
   common cause was the premise. Selection now fails closed on an unreadable TOC, and the premise is
   re-asserted against the *restored database* (`to_regclass('organization_districts') is null`)
   before anything is applied.

### 10.1 Authorization on a disposable copy — `scripts/test-authorization-on-copy.sh`

The provisioning suite needs a `USER_ADMIN` login and the tenancy suite needs a second organization.
Neither belongs in the demo database, and the bootstrapped administrator's password is deliberately
not recoverable, so both run against a copy with the API connected as `dharohar_app`. Results,
2026-10-20:

| suite | result |
| --- | --- |
| `test:jurisdiction` | **46 passed, 0 failed** |
| `test:provisioning` | **91 passed, 0 failed** |
| `test_tenancy_isolation_suite.ts` | **17 passed, 4 failed** |
| harness checks (restore, roles, least-privilege, DDL denial, bootstrap) | all passed; the API's own identity read from `pg_stat_activity` was `dharohar_app` |

The tenancy suite is the pre-RLS measurement requested before designing any policy. Per-district
isolation, multi-district officers, immediate revocation and the state-wide read-only auditor all
hold. The four failures are the requirement, not flakiness:

| failure | measurement |
| --- | --- |
| An officer of one organization cannot read another organization's record in a district both are granted | **HTTP 200** — the request path never consults `organizations` or `organization_districts` |
| The district listing does not return another organization's records | the record appears in the list |
| Every parcel carries an organization | **39 of 39** parcels have `organization_id IS NULL` on the deployed demo database |
| Every officer carries an organization | **59 of 59** users have `organization_id IS NULL` |

The first two are one defect seen twice: tenant scoping is unenforced. The last two are the reason
RLS cannot be written yet — a policy has nothing to filter on. `land_documents` has no
`organization_id` column at all. Converting these NULLs is a mapping decision (inherit the tenant
that administers the parcel's district, or label by hand), not a migration an agent may choose.

Full-stack gate after 0005: `./scripts/validate-stack.sh` **52 passed, 1 failed** — the failure is
`ADMIN_PASSWORD not exported`, i.e. provisioning was not run *against the live stack*, which is the
correct outcome for a stack whose administrator password the operator has not supplied; it ran green
(91/0) against the copy. `npm test` is 53/0 and `npm run lint` is clean.

### 10.2 A standing decision that needs re-applying, and one that needs making

`districts.kind` defaults to `'canonical'`. Every suite run therefore mints a probe district that
arrives as canonical geography — that is how `probe 790279` got there. `validate-stack.sh` now
re-applies the owner's existing retirement decision at the end of each run (T13b) so the gate stays
repeatable; changing the **default** so that a declaration is not automatically canonical geography was
listed in §8 as a governance decision, and the owner authorised it on 2026-10-21: migration 0007 makes
that change, described in §12 below.

## 11. Record ownership versus district jurisdiction — the contract as implemented

Two different questions, two different tables, applied independently. Conflating them is the defect this
section exists to prevent: `organization_districts` answers *where may this tenant work*, and nothing
else. It has never answered *whose record is this*, and no code path treats it as if it did.

| | Record ownership | District jurisdiction |
| --- | --- | --- |
| Question | Which organization is responsible for this record? | Which districts may this tenant work in, and how? |
| Lives in | `parcels.organization_id`, `land_documents.organization_id`, `users.organization_id` | `organization_districts` (`administers` \| `audits` \| `reads`), plus the officer's own `user_jurisdictions` |
| Written by | migration 0006 (stated basis only), the API on create (from the server-side principal), `server/src/db/assignOwnership.ts` (owner-side disposition) | the registry declaration (grants the declaring tenant), a governance decision, or an administrator |
| Refuses | a value with no `organization_granted_by` / `organization_grant_reason` (CHECK constraints, 0006) | an unknown relationship kind (`INVALID_RELATIONSHIP`) |
| Revocation | re-stamping an owner is an owner-side act, always attributed | `revoked_at`, read live on every request — effective on the next request, not at token expiry |

**The access rule, in both layers.** A record is reachable when BOTH hold:
`record.organization_id = caller.organization_id` **and** the record's district is in
`caller.user_jurisdictions ∩ caller_organization's grants` (reads also accept `audits` and `reads`;
writes require `administers`). `STATE_WIDE_READ` removes the second condition's dependence on the
officer's own postings — it is a statement about districts inside one tenant, and it never widens
tenancy.

**Fail-closed cases, each with its own answer.**

| Condition | Result |
| --- | --- |
| Caller has no organization | `403 TENANT_CONTEXT_MISSING`, explained. Not a silent empty list: an operator has to be able to see that the account is unassigned. |
| Record has no owner (quarantine) | `404`, byte-identical to "does not exist". Unowned rows are preserved and remain reachable only through owner-side tooling. |
| Record owned by another tenant | `404`, same bytes — a distinct 403 would let anyone enumerate other tenants' ids. |
| Officer posted to a district the tenant is not granted | `404` (the intersection is empty). A personal posting is not a tenant authority. |
| Session carries an organization but no matching user | zero rows: the row-level policy requires both halves to agree. |
| No tenant context bound at all | zero rows, from PostgreSQL rather than from application code. |

**What quarantine is not.** It is not deletion, not a placeholder tenant, and not an inference. 0006
assigned owners only where a basis is stated in the migration text and aborts if a second organization
exists; the parcels under retired test fixtures were left unowned because the owner's decision of
2026-10-19 says that history stays isolated. `server/src/db/assignOwnership.ts` is the only way out, and
it requires an organization, a named grantor and a reason, refuses unknown ids before writing anything,
and refuses to move a record that already has an owner unless `ASSIGN_TAKEOVER=true` is passed
explicitly.

## 12. Migration 0007 — a declaration is no longer canonical geography

`districts.kind` used to default to `'canonical'`, so every declaration — including the ones the test
suites mint — arrived as canonical geography. That is how `probe 790279` entered the registry. 0007 adds
`'candidate'` to the domain, makes it the default, and requires an explicit act to promote:

* `POST /api/admin/districts` creates a **candidate** district and grants the declaring tenant the
  stated relationship (`administers` by default, validated against `audits`/`reads`). The tenant granted
  is the actor's own, never a body field.
* `POST /api/admin/districts/:code/promote` is the only path to `canonical`. It requires `USER_ADMIN`, a
  reason of at least 10 characters, and writes an audit entry. It refuses rows that are
  `retired`/`test_fixture` — retiring was itself a decision, and an endpoint that could promote test
  residue back into geography would undo it with a plausible reason attached.
* The four synthetic canonical districts keep `state_code = 'RJ'`; nothing in 0007 touches existing
  rows. `validate-stack.sh` asserts that the counts of canonical and retired rows are unchanged by the
  migration.




## 13. What was executed on 2026-10-21 (migrations 0006–0008, and the tests that forced the fixes)

Applied to the demo deployment; ledger is now `0001…0008`.

| Check | Measured |
| --- | --- |
| `./scripts/test-tenant-migration.sh` | **117 assertions passed, 0 failed** — 0006/0007/0008 apply, idempotence, rollback, rollback *guards* (broken on purpose first), quarantine premise, ambiguous-tenant abort, requirement-ordering abort |
| `./scripts/test-authorization-on-copy.sh` | jurisdiction **46/0**, provisioning **91/0**, tenancy **42/0**; API confirmed running as `dharohar_app`; unbound read as that role returns **0 rows** |
| `./scripts/validate-stack.sh` | **66 passed, 1 failed** — the failure is `ADMIN_PASSWORD not exported`, i.e. provisioning was not run against the live stack; it ran green against the copy |
| `npm test` / `npm run lint` | exit 0 — phase 4 47/0, E2E 53/0, tsc clean |
| Ownership after 0006, measured at the end of this phase | 29 parcels + 41 documents + 59 officers owned by `ORG-DHAROHAR-DEMO`; **12 parcels and 2 documents quarantined** — every one of them a retired test fixture or a row with neither a district nor a parcel. Counts move between runs because the gate itself creates synthetic records. |
| `./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups` | all checks passed: a 2,000,000-byte payload hashes identically after dump → second volume → restore; the audit chain (2,164 entries, 167 carrying an actor organization since 0008) hashes to the same value on both sides |

Things this phase found by running, not by reading:

1. **`dharohar_app` had no SELECT on `organization_districts`.** The tenant grants are read on every
   authenticated request, so every request failed closed with `AUTHORIZATION_UNAVAILABLE` — 46 checks in
   an unrelated suite went red before the cause was named. `scripts/roles.sql` predates migration 0004's
   tables and simply did not list them.
2. **`parcelScopeClause` emitted a placeholder it never supplied.** A state-wide reader contributes no
   district parameter, so the organization predicate referenced `$2` with one parameter bound; PostgreSQL
   refused and the endpoint answered 503 with an empty list. Parameters are now numbered by what is
   actually emitted.
3. **Attributing an audit entry by badge or display name is not attribution.** The bootstrapped
   administrator's officer row has `badge_number = NULL` while its entries carry `BOOTSTRAP`, so three
   freshly written entries looked missing. Migration 0008 stores `actor_user_id` /
   `actor_organization_id` outside the entry hash — the chain covers
   `previousHash:entityId:actionType:performedBy:timestamp:detailsHash`, so attribution cannot rewrite
   history — and the older matchers stay as fallbacks so pre-0008 entries are never hidden.
4. **The integrity checker became an RLS casualty.** Run as the runtime role it "found" 41 orphaned owner
   rows that exist perfectly well; it just could not see the parcels. It now refuses that identity and
   prints which identity it ran as; the documented invocation moved to the `maint` one-shot. A diagnostic
   that cannot tell *absent* from *hidden from me* is worse than none, because someone signs off on it.
5. **`maint` is its own image.** `--profile tools build migrate api` left `assignOwnership.js` out of the
   `maint` bundle; the module-not-found error looked like a broken script. `--profile tools build` is now
   the documented form.
6. Two of my own assertions were wrong while the code was right: a JavaScript `===` between a `bigint`
   string and a number, and a rollback expectation that compared against the assigned count instead of
   the whole table.

## 14. What was executed on 2026-10-23 (release-blocker verification: 0009, a fresh install, and a read-only verifier)

Ledger is now `0001…0009`. Nothing was pushed; `c351624` and `df48712` remain local, plus this phase's
work. The environment is still synthetic-only and still private: no public port, no real record.

| Check | Measured |
| --- | --- |
| `./scripts/test-tenant-migration.sh` | **141 assertions passed, 0 failed** (was 117). The new §5f block applies 0009, asserts all twelve policies by predicate text, role, permissive type and USING/WITH CHECK presence, fires its guard by dropping 0006's parent policy, refuses the rollback while a policy it did not create exists, then rolls back and re-applies |
| `./scripts/test-fresh-install.sh` (new) | **105 assertions passed, 0 failed, exit 0** — empty database → full schema; the same schema as an upgraded database compared object-for-object; documented provisioning checked against the rows it writes; and a migration aborted on purpose, diagnosed and recovered |
| `./scripts/test-authorization-on-copy.sh` | jurisdiction **46/0**, provisioning **91/0**, tenancy **68/0** (was 42). The additions are the child tables read and written directly as `dharohar_app`, a role changed in the database while its token stayed valid, and a pooled connection tested for tenant carry-over |
| `./scripts/test-rls-blind-certifier.sh` (new) | all checks passed — the certifier exits 2 with `NOT CERTIFIED` when its identity sees 0 of 2,164 entries, and exits 0 with `INTACT` for an exempt identity over the same rows |
| `./scripts/validate-stack.sh` | **67 passed, 1 failed** — still `ADMIN_PASSWORD not exported`; see "still open" |
| `npm test`, `npm run lint` | exit 0 — phase 4 **47/0**, E2E **53/0**, tsc clean |
| `./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups` | all checks passed: payload digest identical after dump → second volume → restore; chain digest identical on both sides (2,341 entries); geometries valid; ownership and RLS present in the restored copy. It prints its own limit: the destination is a different **volume**, not a different **machine** |
| Chain and integrity as `dharohar_verifier` | `verify_audit_chain.js` exit 0: 2,341 entries, ids contiguous 1..2,341, INTACT. `verify_district_integrity.js`: 58 findings, same substance as before |

### What this phase found by running rather than reading

1. **A fresh install could not reach the current schema at all.** `npm run db:migrate` on an empty
   database stopped at 0006 with `[TENANCY_NO_CANONICAL_GEOGRAPHY]`. Structural, not incidental: 0004
   does not create districts, it classifies the rows already present, so a new database has no canonical
   geography and 0006 rightly refuses to invent an ownership basis. The demo deployment could never show
   this because it was upgraded in place from 0001. Fixed by adding the missing step instead of
   weakening the guard — `npm run db:declare-geography`, an owner-side command in which a named person
   states which districts are authoritative and which tenant holds which relationship, with a reason.
   The install is now two passes with an attributable human decision between them.
2. **Seeding a fresh database produced an environment that read back empty.** `db:seed` wrote parcels,
   documents and officers with no `organization_id`, which since 0006 means *quarantined*: invisible to
   every tenant at both layers. A new deployment looked installed and was unusable. The seed now stamps
   its own rows with attribution (`seed:db:seed` plus a stated reason) and refuses with
   `[SEED_TENANT_AMBIGUOUS]` when more than one organization exists, because that is the case where
   "which tenant owns this fixture" has no answer.
3. **An administrator bootstrapped without a tenant could not open one record.** Correct behaviour,
   previously silent. The command now lists the tenants in the database and names the flag that would
   have attached the account to one.
4. **`fetchFieldInspections` read survey evidence with no tenant bound.** Every other child-table path
   was already inside a tenant transaction; this one went straight to the pool — and it is the table
   holding the observer, the photo URI and the evidence digest. It takes the principal now.
5. **The child tables were the unprotected payload.** 0009 puts `parcel_owners`, `parcel_mutations` and
   `field_inspections` under row-level security by *inheriting* the parent parcel's policy rather than
   restating tenancy, so there is still exactly one definition of a tenant in the database. Measured
   before applying: no child row in any of the three tables has a missing or NULL parent, so nothing
   became unreachable except rows whose parcel is itself already quarantined (12 of 43 co-sharer rows).
6. **`pool.end()` while a client is still checked out is a deadlock, not a shutdown.** Two owner-side
   commands called it from their error path, so a failed run hung forever instead of exiting with a
   message. It appeared as a fresh-install drill producing no output for eight minutes; the database
   showed an idle connection and the process was simply never returning. Both call sites now release the
   client before ending the pool.
7. **Chain verification needed its own identity.** The requirement was a *privileged read-only* identity
   that does not produce misleading findings under RLS. The schema owner is privileged but can rewrite
   history; the runtime role is least-privilege but blind. `dharohar_verifier` is a third thing:
   `BYPASSRLS`, no superuser, SELECT on all fifteen tables, every write privilege explicitly revoked,
   and `roles.sql` refuses to finish if that is not literally true (`[ROLES_LOCKDOWN_FAILED]`). The
   certifier now compares what it can see against what PostgreSQL says was ever inserted, and refuses
   rather than reporting health — proved by a script that installs a policy to hide the ledger.
8. **`requireRole` was reading the token.** It checked `req.user.role`, the claim signed at login, while
   `req.principal.role` — read from the database on that same request — was sitting unused. A demoted
   officer kept exercising the old role until the token expired. It reads the principal now, and the
   suite proves it from the direction that cannot be faked: demote in the database, keep using the same
   token, and the 403 names a role the token never claimed (`READ_ONLY_ROLE`).
9. **Two documentation defects surfaced while writing the report.** `SECURITY.md` numbered two different
   open items `7b`; and `roles.sql` justified its `organization_units` grant by claiming the registry
   listing reads that table, which nothing in `server/src` or `client/src` does. Both are corrected, and
   the second now states the measured fact plus the obligation on whoever changes it.
10. **Assertions I had to fix because they were wrong while the code was right:** a `bigint` compared with
    `===` to a number; a `grep -c` that legitimately returned 2 where the assertion demanded 1; a
    policy-set comparison that looked at only the two root tables while a third migration doubled the
    count; a "baseline predates the tenant tables" check that looked for `organizations` *or*
    `organization_districts` — `organizations` predates 0004, so it failed on a correct baseline; and
    control rows planted into `districts` with a code that `ck_districts_code_is_name` rejects, which
    meant three guard assertions were being tested against a registry that had nothing to guard.

### Still open at the end of this phase

* **The live-stack provisioning gate cannot be run by me.** `sysadmin@dharohar.local` holds `USER_ADMIN`,
  its password is not `DEMO_PASSWORD` (measured: HTTP 401), and `db:bootstrap-admin` refuses to mint a
  second administrator by design. Supplying `ADMIN_PASSWORD` is an owner action. The suite itself runs
  green against a restored copy where the harness bootstraps its own administrator (91/0), so the code
  path is verified — it is the *live stack* invocation that is not.
* **The 58 findings remain findings.** 56 distinct records: 54 suite-residue officers on the
  `@dharohar.test` fixture domain — each with a revoked grant row *and* an `OFFICER_PASSWORD_RESET` audit
  entry, none owning any record, 256 audit entries between them — plus 2 persistence-probe documents with
  neither a district nor a parcel. Kept, not deleted; the checker now prints that evidence per row
  instead of leaving the account's login state as an open question.
* **No real record images in the register.** 2 of 45 documents carry any payload, both written by drills.
* **The archive leaves the database container but not the machine.** A second volume is not a second
  server, and there is no encryption at rest for the dump, so "production-grade disaster recovery" is
  still not a claim to be made.
* **Two tenant-less tables by design.** `users` and the assignment tables are readable by the runtime
  credential without a tenant bound, because login must resolve them first. The residual exposure is
  named in `docs/TENANT-DATA-ACCESS.md` rather than argued away; narrowing it means a second identity for
  authentication reads, which is a role-design change and a decision for the owner.
  *(Superseded on 2026-10-23 by migration 0010 — see §15. The last clause is still true: what 0010 needed
  was a narrow definer function, and what would close the remainder is a separate authentication identity.)*

---

## 15. What was executed on 2026-10-23/24 (0010 principal isolation, a credential rotation, and the encrypted archive)

Four tasks, and two of them produced defects in my own earlier work rather than in the product.

### 15a. Migration 0010 — the officer tables stopped being the exception

The bullet above was the largest remaining cross-tenant read: `select count(*) from users` as
`dharohar_app` returned **59** rows on the deployed demo database, every account of every tenant, on
every request, before any authorization ran. 0010 closes it three ways, and each way is measured:

| change | measured effect |
| --- | --- |
| RLS on `users`, `user_jurisdictions`, `user_capabilities`, `organization_districts` — 4 policies each, predicate *own row or own organization* | `select count(*) from users` as the runtime role: **59 → 0**; with a context bound, only that tenant's officers, and 0 rows of any other tenant |
| `REVOKE SELECT ON public.users`, then `GRANT SELECT` on the 17 non-credential columns | `select password_hash from users` → `permission denied for table users`; `has_column_privilege` false for `password_hash` and `salt`, true for the other 17 — and `information_schema.column_privileges` under-reports this as 1 of 19, which is why the predicate, not the view, is the authority |
| `dharohar_officer_for_login(text)` / `dharohar_has_any_officer()`, `SECURITY DEFINER`, owned by a **NOLOGIN** `dharohar_identity`, `search_path` pinned, EXECUTE granted to exactly one role | login still resolves an officer by email, id or badge; `%` as an identifier returns 0 rows, so the function is not a search |

`listOfficers` also lost its two pre-0010 behaviours, both of which were cross-tenant reads wearing an
application-layer excuse: a tenant-less administrator used to be shown **every account in the system**,
and unowned accounts used to be appended to every tenant's roster as a "disposition queue". Both are
owner-side now (`scripts/assignOwnership.ts`), and the roster is scoped to `organization_id = $1`.
`PUT /admin/officers/:id/jurisdictions` for a foreign officer now answers `404 OFFICER_NOT_FOUND` —
indistinguishable from a row that does not exist — which is the point of the change, and the suite
asserts it as a security property with a control that the same officer's own parcel is still readable.

Two things the write path needed that the first pass missed: every provisioning and registry transaction
now begins with `beginTenantTransaction(actor)` instead of a raw `BEGIN`, because 0010's `WITH CHECK`
clauses refuse an insert whose organization is not the bound one; and `listDistricts` without a principal
no longer publishes zero counts — it checks whether the connected identity is exempt from RLS
(`rolsuper`/`rolbypassrls` against `relrowsecurity`) and otherwise raises `PRINCIPAL_REQUIRED`, because
an RLS-blind aggregate is the same lie as an RLS-blind integrity checker.

### 15b. Two defects 0010's self-check had, both found by running a gate that used to pass

1. **It asserted privileges that `roles.sql` had not granted yet.** The supported order is
   `migrate` → `roleinit`, so on any new database `dharohar_app` holds nothing when 0010 runs — and the
   abort `[PRINCIPAL_ISOLATION_INCOMPLETE] provisioning can no longer UPDATE users at all` broke
   `npm run test:registry` (40 passed, 14 failed) and the documented fresh install. The privilege half is
   now taken only when the lockdown is actually in place, and `roles.sql` §3c remains the hard enforcer
   (`[ROLES_LOCKDOWN_FAILED]` if a credential column stays readable), applied on every `up`.
2. **The first fix used a predicate the migration satisfies itself.** `has_any_column_privilege(… users
   …)` became true because section 4 of 0010 grants those column privileges minutes earlier in the same
   file — so the branch still ran the assertions and the same abort reappeared. The discriminator is now
   `has_table_privilege('dharohar_app','public.parcels','SELECT')`, which only `roles.sql` can set. A
   check whose precondition is produced by the code it guards is not a check; `has_table_privilege` on
   `users` would have been wrong in the other direction too, because after the column split it answers
   *false on a correctly locked-down database*.

Applying the corrected file to the live demo database meant `rollback-0010` → rebuild → re-apply, with
the API stopped for the window (the rollback prints a `WARNING:` that the credential columns become
readable again — it refuses outright if any policy on those tables was not created by 0010). Ledger is
`0001…0010`, checksum `sha256:e36ccec9d3…`, and `run --rm migrate` afterwards says
"No pending migrations. 10 applied, schema up to date (no-op)", which is what proves the recorded
checksum matches the file rather than merely that a run exited 0.

### 15c. The exposed application credential was rotated, in both directions

`DHAROHAR_APP_PASSWORD` had been printed twice — once by a `docker inspect`, once by a "names only"
filter over the rendered compose file that failed because YAML renders `DATABASE_URL: value`, not
`KEY=value`. `scripts/rotate-app-credential.sh` now does the rotation with rails on, and this is what it
measured: the injection map (one source in `.env`, three live holders, and the API container holding the
value in `DATABASE_URL` and `PGPASSWORD` but **not** in `DHAROHAR_APP_PASSWORD` — its digest there was the
empty string), the `roleinit` exit code, every
*other* secret's digest unchanged before and after (`88b98d72b991` both sides, and the file grew by
exactly the length difference, 574 → 606 bytes), the old credential refused with
`FATAL: password authentication failed for user "dharohar_app"`, the new one authenticating, then the
API recreated and `/api/health/ready` returning 200 — the endpoint that probes the database live, unlike
`/api/health`, which reports the boot mode. Neither value was ever printed, passed as an argument, or
written to a file; the tests piped them through `psql -W` on stdin. (`-w` is the opposite of `-W`: it
means never prompt, and every attempt then fails with `fe_sendauth: no password supplied`.)
`md5(rolpassword)` was first recorded here as proof the credential changed. Re-tested on 2026-10-24 it is
**no proof at all**: `ALTER ROLE … PASSWORD` re-salts SCRAM, so the digest moves on a no-op re-apply of an
unchanged password — `ee2f310a… → 63a84458… → e9a25f43…` across three runs of one value, each followed by
the same successful authentication. Authenticating in both directions is the only proof, and the script
now prints the digest with that caveat attached.

The value is not in the working tree, not in any commit, and not in the session logs — checked by
matching each live value against every file and every blob of the last four commits, with a control that
plants a real value in memory to prove the matcher can see one and a placeholder of the same shape to
prove it does not cry wolf.

### 15d. The encrypted archive leg, and the sync surprise underneath it

`scripts/encrypted-backup-drill.sh` runs green (38 checks, exit 0) and its two script defects were the
interesting part: `openssl enc -salt 16` is invalid in OpenSSL 3.5 (`-salt` is a flag; the length option
is `-saltlen`), and the script's own `MSYS_NO_PATHCONV=1` made native `openssl.exe` and `docker.exe`
unable to see a `mktemp -d` path under `/tmp`. Both produced a **failing** run rather than a false pass,
which is the point — but the check that consumed them (`digest` of a missing file, `grep -c` of a missing
file) would have passed vacuously, so the file-existence and size premises are now asserted before
anything is compared.

The drill proves the encryption is real functionally, not by pattern-matching: `pg_restore --list` reads
the **plaintext** archive's manifest with no key and lists `TABLE DATA public parcels`, and fails on the
ciphertext with *"input file does not appear to be a valid archive"*. Then decrypt → restore → compare:
ledger `0001…0010` identical, 43 parcels / 47 documents / 59 officers / 4 grants / 2,520 audit entries /
44 co-sharers all matching, 31 owner-tagged parcels, 43/43 valid geometries, RLS still enabled on the
restored `parcels`, the largest document payload md5 equal on both sides, and the whole audit chain
folding to the same md5 (`a5e9148a…`).

**What the measurement turned up that nobody had asked about:** the repository lives at
`C:\Users\allin\OneDrive\Desktop\AI\DHAROHAR`, the Desktop known folder is redirected into OneDrive, and
the OneDrive sync-root marker is present — so `backups/`, holding **69 unencrypted dumps**, sits inside a
sync root. The client was not running and had no account configured when I checked, so nothing is proven
to have left the machine and nothing can be proven not to have. `scripts/backup.sh` now prints a
`WARNING:` when its resolved output directory is under a cloud-sync path (proved in both directions: it
fires here, silent under `C:\temp-dh-backup`), and the retention/destination/credential rules are written
into `docs/DEPLOYMENT.md` §8. **The transfer leg is NOT EXECUTED:** `rclone`, `restic` and the AWS CLI
are all absent, no network share is mapped, and there are no credentials for any destination — so real
off-machine recovery is still an owner action, and this phase does not claim it is done.

### 15e. The fourth script 0010 made blind, and it was a maintenance script

`validate-stack.sh` went from "66 passed, 1 failed" to **66 passed, 3 failed** after 0010 landed, and two
of the three were one new defect: `server/src/retireSuiteResidue.ts` — the step that retires the officers
the gate itself creates — stopped finding any administrator at all (`exit 4`, "no usable USER_ADMIN officer
found") and then, once that was fixed, reported "no row in `users` matches `%@dharohar.test`".

Neither was true. The live table holds one active `USER_ADMIN` (`USR-SYSADM-01`) and **54**
suite-created officers, all owned by `ORG-DHAROHAR-DEMO`. The script ran inside the API container, as
`dharohar_app`, with an **unbound** `pool.query` — and unbound is exactly what 0010 made return zero
rows. This is the fourth time in this project that a check asked a question of an identity that could not
see the answer (after the integrity checker's 41 invented orphans, the registry's zero counts, and the
audit-chain view). Two fixes, both in the shape the application already uses:

* a named administrator is resolved through `loadPrincipal`, which since this phase falls back to
  `dharohar_officer_for_login(email)` — the one sanctioned pre-context read — instead of enumerating;
* the candidate scan runs through `tenantQuery(actor, …)`, so the actor's own organization is bound and
  its tenant's residue becomes visible.

Where the scan still returns nothing, the script now says it *cannot distinguish* "there is nothing to
retire" from "the residue belongs to a tenant I am not allowed to read", and names the identity that can
settle it (the schema owner through `maint`). The measured difference: dry run **0 candidates → 54
candidates**, then `RESIDUE_APPLY=true` → "54 account(s) revoked and locked", nothing deleted, every
change written into the audit chain attributed to the officer who ran it.

One consequence worth stating for a multi-tenant deployment: **retiring another tenant's residue is not
something this script can or should do from inside one tenant's identity.** Either each tenant's
administrator retires their own fixtures, or the owner-role runs it through `maint`.

### 15f. Gates re-run after all of the above

Every row is this phase's own run, with the exit code recorded. Two of them went red *because of* 0010
and are described in §15b and §15e; the rest were green before and are green now.

| gate | result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | exit 0 |
| `npm test` — i18n, ocr, phase 4, E2E | phase 4 **47 passed / 0 failed**, E2E **53 / 0**, exit 0 |
| `scripts/test-authorization-on-copy.sh` on a restored copy | jurisdiction **46 / 0**, provisioning **91 / 0**, tenancy **101 / 0** (was 94; §9 grew by the seven principal-isolation assertions), exit 0 |
| `scripts/test-tenant-migration.sh` | **141 passed / 0 failed**, exit 0 — 0010 apply, idempotence, rollback, rollback guards |
| `scripts/test-fresh-install.sh` | **all checks passed** (106 assertions), exit 0 — including 0010 on a database built from nothing, and the new RLS-coverage set difference |
| `npm run test:registry` | **56 / 0**, exit 0 — after its phase A was corrected to the documented two-pass install |
| `scripts/encrypted-backup-drill.sh` | **38 checks**, exit 0 |
| `scripts/rotate-app-credential.sh` | exit 0 — old credential refused, new one authenticates, every other secret's digest unchanged |
| live demo database, re-measured | 16 policies across 9 RLS tables, ledger `0001…0010`, `select count(*) from users` as `dharohar_app` = **0**, `select password_hash from users` = `permission denied`, `dharohar_officer_for_login('rj-audit-2015-0012')` = 1 row, `/api/health/ready` = 200 |
| `./scripts/validate-stack.sh` | **68 passed, 1 failed** of 69 checks — the one failure is the `ADMIN_PASSWORD` skip (§6 of `docs/OWNER-HANDOFF.md`); the two retirement failures this phase introduced are fixed in §15e above |
| `verify dist-server/verify_audit_chain.js` as `dharohar_verifier` | exit 0 — **2,874 entries** walked, ids contiguous, verdict **INTACT** |
| the register after all of it | 45 parcels (33 owned, 12 quarantined), 51 documents (2 with payload), 59 accounts (all owned), 46 co-sharers, 16 mutations, 4 tenant grants, 16 districts |
