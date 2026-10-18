# District and jurisdiction integrity report

**Date:** 2026-10-18 · **Scope:** every jurisdiction-bearing column in the DHAROHAR schema
**Tools:** [server/src/verify_district_integrity.ts](../server/src/verify_district_integrity.ts) (read-only checker, `npm run test:integrity`),
[server/src/test_integrity_gate.ts](../server/src/test_integrity_gate.ts) (negative control, `npm run test:integrity-gate`),
[server/src/test_district_registry_suite.ts](../server/src/test_district_registry_suite.ts) (migration 0003 proof, `npm run test:registry`)

This report was produced **before** the constraints in migration 0003 were added, as required, and it
records what was found, what was repaired, what the migration refused to decide, and what still needs
a person from the revenue department.

---

## 1. What was inspected

11 defect classes, each reported by primary key and each separately proven to be detectable:

| # | Check | Why it is a jurisdiction problem, not a formatting problem |
|---|---|---|
| 1 | Parcel with no district (NULL or whitespace) | Nobody can be authorised over the record; it is invisible to every officer including the one who created it |
| 2 | Parcel district absent from the registry | A typo silently creates a new jurisdiction that no officer holds |
| 3 | Two registry rows whose names normalise to one jurisdiction | Two codes for one district splits an officer's authority in half |
| 4 | Document with neither a district nor a parcel | Unreachable to everyone; uploaded, stored, and then invisible forever |
| 5 | Document whose `parcel_id` references nothing | A restore from an older dump can produce this; it looks like a link and is not |
| 6 | Document district ≠ its parcel's district | One officer reaches the record through the parcel, another through the document |
| 7 | Officer with no active jurisdiction and no capability | Authenticates successfully and can reach nothing — a dead account that looks staffed |
| 8 | Assignment naming an unregistered district | The grant is real, the authority is nil, and the audit trail says someone was posted there |
| 9 | `users.district` not among the officer's active assignments | The display value and the authority disagree; certificates print one, access enforces the other |
| 10 | Owner row whose parcel does not exist | Co-sharer history attached to nothing |
| 11 | Parcel whose `document_id` references nothing | A land record claiming a source document that is gone |

When migration 0003 is applied, three further checks run: parcel text/code disagreement, document
text/code disagreement, and an aggregate count of parcels whose district could not be resolved.

---

## 2. Findings on real data

### 2.1 Seeded / demo databases — clean, with one caveat that matters

Every metric reported zero on a freshly migrated and seeded database:

```
districts_rows = 4, organizations_rows = 0, parcels = 3, users = 4
parcels_blank_district = 0            parcels_district_not_in_registry = 0
documents_dangling_parcel_id = 0      documents_no_district_no_parcel = 0
documents_district_differs_from_parcel = 0
assignments_not_in_registry = 0       users_no_active_assignment = 0
owners_orphans = 0                    parcels_dangling_document_id = 0
registry normalisation collisions = 0
```

**The caveat, and it is the reason this section exists:** the `districts` registry was populated by
migration 0002 *from the values already stored on real rows*. Asking "is every parcel district in the
registry?" of a registry derived from parcel districts is a tautology. A clean report on such a
database proves internal consistency and nothing more — it cannot prove that any district name is one
the department recognises. The `provenance` column exists to make that visible: `derived` rows are
data's own words, `declared` rows are an administrator's decision. **Do not treat a `[PASS]` here as
authoritative until the registry carries `declared` rows for the districts actually being operated on.**

### 2.2 The deployed database at the time of inspection

The schema had foreign keys on `land_documents.parcel_id`, `parcel_owners.parcel_id`,
`parcel_mutations.parcel_id`, `field_inspections.parcel_id`, `user_jurisdictions.user_id`,
`user_capabilities.user_id`, `districts.organization_id` and `users.organization_id` —
and **on no jurisdiction column at all**. `districts.code` existed since 0002 and nothing referenced
it. That is the whole of the P0 problem in one line: the registry could be consulted but never
enforced, so a jurisdiction was whatever string whoever wrote the record typed.

`parcels.document_id` had no foreign key either, so a parcel could name a document that did not exist
through ordinary SQL, with nothing to stop it and nothing to report it.

### 2.3 Defects found while building the gate, in the order found

1. **`verify_district_integrity.ts` reported a finding that did not exist.** The unresolved-code check
   is an aggregate query with no `HAVING`, so it emitted a row on every database — including a clean
   one — printing `unresolved parcel district_code: 0 row(s) -> -` and exiting 1. Found by the
   negative control, not by reading the code. Fixed with `HAVING count(*) > 0`; the clean-data
   assertion in the gate now fails loudly if a phantom finding ever returns.
2. **The checker's own header named the wrong database.** It printed `process.env.PGDATABASE`, which
   is a wish, not a fact: when the connection string pointed elsewhere the report was attributed to a
   database it had never read. Fixed to `SELECT current_database()`.
3. **One layer down, the same bug was a credential leak.** `getDbHealth().database` fell back to the
   whole `DATABASE_URL` — host, user **and password** — and `GET /api/health` is the one route that
   requires no token. Any deployment configured with `DATABASE_URL` (which `docs/DEPLOYMENT.md`
   tells operators they may use) would have published its database password on an unauthenticated
   endpoint. Fixed: the health report now carries only what PostgreSQL says the current database is
   called. This was a live defect in the code you were about to ship, found by a test that was written
   to be able to fail.
4. **The migration runner swallowed every operator instruction.** `RAISE EXCEPTION ... USING HINT`
   returns the hint as a separate driver field, and the runner printed only `err.message`. A migration
   designed to stop and explain itself stopped silently. Fixed: detail and hint are printed.
5. **The 0003 trigger overwrote a caller-supplied `district_code` instead of refusing it.** A caller
   that wrote the wrong jurisdiction key got it quietly corrected — which tolerates the bug rather
   than surfacing it. Fixed: `DISTRICT_CODE_CONFLICT`, raised whenever a supplied key disagrees with
   the district text that accompanies it.
6. **Provisioning was inventing jurisdictions.** `createOfficer` and `setOfficerJurisdictions` each ran
   `INSERT INTO districts ... ON CONFLICT (code) DO NOTHING` before granting an assignment. An
   administrator typing "Nowhpur" therefore *created* the jurisdiction "nowhpur" and posted an officer
   over it, with nothing anywhere recording that a new jurisdiction had come into existence. This is
   the exact behaviour the P0 instruction forbids ("do not guess how invalid records should be
   assigned"), implemented in the API layer. Fixed: assignments now require a declared district
   (`DISTRICT_NOT_REGISTERED`, 400), and declaring a district is its own audited operation
   (`POST /api/admin/districts`).
7. **Four test officers were left with no jurisdiction and no capability** by the revocation test,
   which asserts the withdrawal and stopped there. The checker reported them correctly. Fixed by
   completing the round trip — the suite now re-grants and asserts that the grant takes effect on the
   next request, which is the mirror of the property it was already testing.
8. **Two suites were not re-runnable against a persistent database.** Parcels carry a unique
   `(khasra_no, village, district, tehsil)` identity and an **archived** row still occupies it, so the
   second run of the Phase 4 suite collided with its own archived fixture, and the API suite's fixture
   collided with Phase 4's. Their cleanup also asserted "the registry holds exactly 3 parcels", which
   measured the whole database's history instead of the run's own residue. Fixed: fixture cadastral
   identities are run-scoped, fixtures are archived at the end, and the residue check now counts
   *unarchived* parcels and names any offender by id.
9. **One audit-scope assertion was comparing history against the live list**, so records that had been
   legitimately archived or deleted looked like cross-district leaks. Fixed: each unexpected id is
   probed as the other districts' officers — the assertion now fails only if another district can
   actually read the parcel.

None of 1–4 or 6 was visible by reading the code alone. Each was caught because a gate was required to
be able to fail, and then broken on purpose.

---

## 3. What migration 0003 changes

[server/src/db/migrations/0003_stable_district_identifiers.sql](../server/src/db/migrations/0003_stable_district_identifiers.sql)
— additive, forward-only, one transaction.

- `districts.code` becomes the canonical lower-case form of `districts.name`, enforced, and a unique
  index forbids two registry rows whose names differ only by an internal space.
- `district_code` added to `parcels`, `land_documents`, `users`, `user_jurisdictions`;
  `organization_id` added to `parcels`. All nullable.
- Backfilled **only** where the stored text names exactly one registry row. No nearest match, no
  uploader fallback, no fuzzy merge.
- Foreign keys from each new column to `districts(code)`; CHECKs so text and key can never disagree;
  indexes on the referencing columns.
- A `BEFORE` trigger resolves and writes the key on every new write, refuses an unregistered or
  inactive district (`DISTRICT_NOT_REGISTERED`), refuses a key that contradicts its own text
  (`DISTRICT_CODE_CONFLICT`), and **does not re-validate a row whose district is not being changed** —
  so one legacy typo can never lock a land record against unrelated editing.

### What it deliberately does not do

| It does not | Because |
|---|---|
| assign a district to any record | Ownership of a parcel is a departmental fact. Unresolvable rows keep `district_code = NULL` and are reported |
| create or merge a registry row to make the numbers clean | Proven by `test:registry`: a parcel in "Fakepur" migrates with NULL and **no `fakepur` district is invented** |
| proceed when the registry is ambiguous | Two spellings of one jurisdiction abort the migration with both named, the transaction rolled back, the ledger unchanged, and a hint pointing at `npm run test:integrity`. Proven by test |
| add a foreign key on `parcels.document_id` | The fix for an existing offender is a decision about the document, not a constraint. The checker lists them instead |
| backfill `parcels.organization_id` | No organization exists yet. Choosing a tenant is decision D1, which has not been made |
| enable row-level security | The API still connects as the superuser owner. See §3.2 of `DATA-MODEL-JURISDICTION.md` |

`NULL` now has exactly one meaning everywhere in this schema: **this jurisdiction value has not been
resolved against the registry.** It never means "no district".

---

## 4. Verification — every number below is from an actual run on 2026-10-18

| Gate | Result |
|---|---|
| `test:integrity-gate` — negative control for the checker | **34 passed, 0 failed** (exit 0). Current schema: clean data `[PASS]`, and the two now-impossible defect classes are refused at write time. 0002 schema: all 11 planted defects detected, each named by primary key, exit 1. Unreachable database ≠ clean report |
| `test:registry` — migration 0003 proof | **53 passed, 0 failed** (exit 0). Includes: ambiguous registry stops the migration with a complete rollback; unresolved records migrate as NULL with no invented registry row; a legacy unresolved row can still be edited for unrelated fields |
| `test:integrity` on the migrated, seeded database | **0 findings**, exit 0 |
| `test:jurisdiction` | 46 passed, 0 failed |
| `test:provisioning` | 88 passed, 0 failed (includes the new registry section) |
| `test:api` / `test:integration` / `test:api-suite` | 70 / 66 / 67 passed, 0 failed |
| `test:phase4` / `test:e2e` | 46 / 52 passed, 0 failed |
| `test:i18n` / `test:ocr` | pass |
| `tsc --noEmit` over `src/` and `server/src/` | clean |

Two of these gates have a control case that must produce the *negative* result, which is what makes
the positive ones worth reading.

---

## 5. Open, and only a person can close it

1. **The registry has no authoritative rows.** Every district in it was derived from data. Someone must
   declare the districts actually in scope (`POST /api/admin/districts`, or
   `INSERT INTO districts (code, name, provenance) VALUES (lower(trim(name)), name, 'declared')`), and
   until they do, this report cannot say whether any district name is correct — only whether the rows
   agree with each other.
2. **No organization exists**, so every district and officer is tenant-less and cross-tenant isolation
   is untested. That is decision D1.
3. **Legacy rows that could not be resolve are listed, not repaired.** Run `npm run test:integrity`
   against the real database; anything it reports needs a departmental answer before the row can be
   scoped by key.
4. **`parcels.document_id` is still unconstrained.** Until a decision is made about the records it
   currently mis-points at (if any), the checker is the control.
5. **District is still free text at the API boundary.** 0003 makes an unresolved value impossible to
   store on a *new or changed* record, but the application still authorises on the text. Switching the
   scope clauses to `district_code` is now a performance change rather than a semantic one — it belongs
   with the RLS work, where every query can be tested.
6. **An officer with no jurisdiction and no capability can still sign in.** Nothing marks a person as
   having left; revocation removes authority, not the account.
