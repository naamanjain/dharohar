# Tenant data access review — every table the runtime role can reach

Measured on the deployed synthetic demo database on 2026-10-23, after migrations 0001–**0010**.
Reproduce any line of it with the queries at the bottom; nothing here is inferred from the code.
Row counts move every time a gate runs against this database — the suites create officers, parcels and
documents and cannot delete them (`users` has no delete path and records are archived, not removed) — so
treat the counts as a snapshot of this date and the privileges and policies as the invariant.

The question this file answers, for each table: **what stops one tenant from reading or writing
another tenant's rows through it — the database, the application, or nothing?**

Two layers exist, and they are not the same layer:

* **Layer 1 — application authorization** (`server/src/services/jurisdiction.ts`, `server/src/db/tenant.ts`).
  Every record route resolves a live principal from the database (never from the token's claims),
  requires the caller's tenant to own the record, and intersects the caller's own postings with the
  tenant's district grants. Queries that read records run through `tenantQuery` /
  `beginTenantTransaction`, which bind `app.organization_id` and `app.user_id` for the duration of one
  transaction.
* **Layer 2 — PostgreSQL row-level security.** Applies to the nine tables below, and only to
  `dharohar_app`, the identity the API connects as. It is the layer that still holds if the application
  is bypassed entirely and SQL is issued with the runtime credential.
  **It is not a defence against that credential's owner.** The policies read `app.organization_id` and
  `app.user_id`, which any session may set for itself: measured 2026-10-23, `select count(*) from users`
  returns 0 unbound and 59 after the same connection calls `set_config('app.organization_id',
  'ORG-DHAROHAR-DEMO', false)` — the tenant it asserted, no other tenant's rows, and still 0 parcels,
  because a record policy also requires the session user to resolve in `users`. Layer 2 stops a query
  that forgot its predicate; it does not stop the identity that runs the application.

A table with "no RLS" is not automatically unprotected, and a table with RLS is not automatically
safe: the columns say which, and the last column says what the gap is if there is one.

## 1. The measured inventory

| table | rows | app-role privileges | RLS | policies | what stands between tenants |
|---|---|---|---|---|---|
| `parcels` | 45 | SELECT, INSERT, UPDATE | **yes** | 4 (`tenant_select/insert/update/delete_parcels`) | Row: `organization_id` must equal `app.organization_id` **and** the organization of the user named by `app.user_id` (0006). Column: the app role cannot DELETE at all — records are archived instead. |
| `land_documents` | 51 | SELECT, INSERT, UPDATE | **yes** | 4 | Same predicate as `parcels`, on the document's own `organization_id` — inherited from the parcel it is filed against, not from the uploader. |
| `parcel_owners` | 46 | SELECT, INSERT, UPDATE, DELETE | **yes** | 4 | Row: the parent parcel must be visible (0009). Co-sharer names are the most personal data in the register and are reachable only through the parcel's own tenant test. DELETE is granted deliberately — replacing a co-sharer list is delete-then-insert — and the previous set survives in `parcel_mutations` and the chained audit log, which this role cannot delete. |
| `parcel_mutations` | 16 | SELECT, INSERT, UPDATE | **yes** | 4 | Parent parcel (0009). No DELETE: history is not removable by the runtime role. |
| `field_inspections` | 0 | SELECT, INSERT, UPDATE | **yes** | 4 | Parent parcel (0009). Survey evidence — observer, photo URI, digest — cannot be read or attached without seeing the land. |
| `users` | 59 | INSERT, UPDATE at table level; SELECT on **17 of 19 columns** — `password_hash` and `salt` are not among them | **yes** | 4 | **This row is what migration 0010 changed.** Before it the runtime role held plain `SELECT` on the whole table and read all 59 officers of every tenant on every request. Now: the row must be the session's own user **or** belong to the session's organization; the credential columns are unreadable (`select password_hash from users` → `permission denied for table users`, measured); and login no longer touches the table — it calls `dharohar_officer_for_login(text)`, a `SECURITY DEFINER` function owned by the NOLOGIN role `dharohar_identity`. The gap that remains is that function: for **one exact identifier already known** it returns that officer's row including the credential columns. §4b. |
| `user_jurisdictions` | 107 | SELECT, INSERT, UPDATE | **yes** | 4 | Own row's `user_id` must be the session user or an officer of the session's organization (0010). Revocation is still honoured by `revoked_at IS NULL` on every read; the policy means a revoked posting is also invisible to a database query that forgot to ask. |
| `user_capabilities` | 38 | SELECT, INSERT, UPDATE | **yes** | 4 | Same predicate as the postings. `USER_ADMIN` and `STATE_WIDE_READ` are no longer readable across tenants by the runtime role at all — before 0010 they were, which is how a bug in the roster query could hand one tenant another tenant's capability set. |
| `organization_districts` | 4 | SELECT, INSERT, UPDATE | **yes** | 4 | `organization_id` must equal the session's organization (0010). The tenant's district authority is no longer a shared read: one tenant cannot enumerate which districts another holds. |
| `organization_units` | 0 | SELECT, INSERT, UPDATE | no | 0 | **Nothing, and nothing needs it yet.** Measured: no query anywhere in `server/src` or `client/src` reads or writes it. If it gains a query, that change must add the tenant policy in the same commit — the table carries `organization_id` and would otherwise be a cross-tenant read. |
| `organizations` | 1 | SELECT, INSERT, UPDATE | no | 0 | The tenant directory, not tenant data. A prospective officer's login has to be able to find their own organization. |
| `districts` | 16 | SELECT, INSERT, UPDATE | no | 0 | Shared geography by design: two tenants may hold grants on the same district, so a district row is not anyone's record. Its `kind` and `is_active` are guarded by triggers and by the promotion workflow, not by tenancy. |
| `append_only_audit_logs` | 2874 | SELECT, INSERT | no | 0 | Append-only, not tenant-filtered — see §4. INSERT/SELECT only: the role cannot UPDATE, DELETE or TRUNCATE, and the 0001 trigger refuses the same thing at execution time. |
| `schema_migrations` | 10 | SELECT | no | 0 | Read-only ledger for the runtime role; only the one-shot identities can write it. |
| `spatial_ref_sys` | ~4k | SELECT | no | 0 | PostGIS reference data, not application data. |

## 2. The role itself

```
rolname        rolsuper  rolbypassrls  rolinherit  rolcreaterole  rolcreatedb  rolcanlogin
dharohar_app       f          f            f            f             f            t
dharohar           t          t            t            t             t            t
```

`dharohar_app` is not a member of `dharohar` (`pg_has_role` = false), cannot `SET ROLE` to it (the
tenancy suite measures `permission denied to set role`), cannot alter a table it is scoped to
(`must be owner of table parcels`), and every policy names it explicitly — no policy applies to
`PUBLIC`, so a future role cannot inherit a permissive rule by accident. `dharohar` is the schema
owner and is used only by the one-shot services (`migrate`, `roleinit`, `maint`, `seed`), never by the
long-running API.

## 3. Permissive composition, checked rather than assumed

PostgreSQL combines multiple PERMISSIVE policies on the same command with **OR**, so a second
"narrowing" policy silently widens access. The measured state:

* 20 policies, all `PERMISSIVE`, all `TO dharohar_app`, on exactly the five tables above.
* For each table and each command there is exactly one policy — `GROUP BY tablename, cmd HAVING
  count(*) > 1` returns **0 rows**. Permissive OR-composition therefore has nothing to widen: a single
  policy per command is the only way to make PERMISSIVE behave like a restriction.
* Every `SELECT`/`DELETE` policy has a `USING` clause and no `WITH CHECK`; every `INSERT` policy has a
  `WITH CHECK` and no `USING`; `UPDATE` has both, so a row cannot be moved into a parcel the caller
  cannot see. That distribution is asserted inside migration 0009 itself, which aborts with
  `[TENANCY_POLICY_SHAPE_UNEXPECTED]` if the policies it just created are not exactly that shape.
  The same distribution is measured on 0006's two tables in the inventory query below.

## 4. Deliberate non-policies, and why

**There were four, and 0010 removed them.** `users`, `user_jurisdictions`, `user_capabilities` and
`organization_districts` used to have no policy for a reason that was real: a tenant policy needs the
tenant, and the tenant is *derived* from those very tables, so keying them on `app.organization_id`
looked like a closed loop. The loop is broken by splitting **identity discovery** from **tenant
authorization**: `dharohar_officer_for_login(text)` resolves a person from an identifier before any
context exists, and only then does `loadPrincipal` bind `app.user_id` / `app.organization_id` and read
the postings, capabilities and grants under them. The policy predicate is deliberately *own row or own
organization*, never *the context this row is used to compute*. What the file said before this change —
"with the runtime credential alone, an officer list of another tenant is readable by direct SQL" — is no
longer true, and the measurement in §6 is what replaced the sentence.

### 4b. What 0010 does not close, named exactly

1. **The login lookup is a credential oracle for an identifier you already have.** The function is
   `SECURITY DEFINER` because it must see past RLS to find a person, and it returns the officer's row —
   so `select password_hash from dharohar_officer_for_login('someone@exact.address')` reaches a hash the
   role cannot read from the table (128 hex characters of PBKDF2-SHA512 verifier, measured, and asserted
   in `test_tenancy_isolation_suite.ts` §9 so a future change is visible). It matches **exactly one** of
   `email`, `id` or `badge_number` with `LIMIT 1`, so it cannot be used to enumerate: `%` returns 0 rows.
   What an attacker gains is the ability to test a password offline against one *named* account, not to
   list the estate. Closing this properly is a role change, not a policy: an authentication identity that
   alone may read a credential column, and the runtime identity that serves every other query reading
   none. That is not built, so tenant isolation is not complete, and no document in this repository may
   say otherwise.
2. **`app.*` is set by the session, so layer 2 constrains the application, not the operator of the
   credential.** See the layer-2 bullet at the top of this file for the measurement.
3. **`organizations` and `districts` stay readable** by design: a prospective officer's login has to find
   their own organization, and geography is shared between tenants. Neither holds a record.

**`append_only_audit_logs` — no policy.** Validating a hash chain requires reading **every** entry in
order, in all tenants. A tenant-filtered read produces gaps, and gaps look exactly like tampering:
the first time this project measured the chain under a tenant-scoped identity, it invented 41
orphan findings that did not exist. Chain verification therefore runs as an identity that is *exempt*
and says so: `dharohar_verifier` (read-only, `bypassrls=true`) when `DHAROHAR_VERIFIER_PASSWORD` was
supplied to `roles.sql`, otherwise the schema owner through the `maint` one-shot. Both
`verify_audit_chain.ts` and `verify_district_integrity.ts` print the identity they ran as and refuse to
report when it cannot see the whole table; tenant audit *views* stay tenant-filtered in
`auditService.getAuditLogs`, which runs under the caller's context.

**`organization_units` — no policy.** Measured zero rows and zero queries. A policy protecting a table
no code reads is decoration; the requirement is recorded in §1 so the query and the policy arrive
together.

## 5. How the application reaches the child tables

Every query that touches `parcel_owners`, `parcel_mutations` or `field_inspections` runs inside the
caller's tenant context — `tenantQuery`, `withTenant`, or a client from `beginTenantTransaction`:

| site | how it is bound |
|---|---|
| `server/src/routes/parcels.ts` — owners in the detail read, owner delete+insert in the update path | `tenantQuery` / tenant transaction client |
| `server/src/routes/documents.ts` — owners of a linked parcel | joined through `parcels` inside `tenantQuery` |
| `server/src/services/parcelService.ts` — inspections, mutations | `beginTenantTransaction`, and `fetchFieldInspections` now takes the principal |
| `server/src/services/validationService.ts` — owners, inspections, documents | one `withTenant` block, so a validation report cannot mix tenants |
| `server/src/db/seed.ts` | one-shot, schema-owner identity, refuses with `[SEED_TENANT_AMBIGUOUS]` when more than one tenant exists |

`fetchFieldInspections` was the exception when this review was run: it read
`field_inspections` through the pool with no context. It is fixed here, and the fresh-install drill
plus `scripts/test-authorization-on-copy.sh` are what proves the fix rather than this sentence.

## 6. Reproduce these numbers

```bash
# RLS flag, policy count and the runtime role's exact privileges, per table
docker exec dharohar-prod-db-1 psql -U dharohar -d dharohar -c "
select c.relname, c.relrowsecurity,
  (select count(*) from pg_policies p where p.tablename = c.relname) as policies,
  (select string_agg(g.privilege_type, '/' order by g.privilege_type)
     from information_schema.role_table_grants g
    where g.table_name = c.relname and g.grantee = 'dharohar_app') as app_privs
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;"

# nothing at all may TRUNCATE, reference or trigger as the runtime role — expected: 0 rows
docker exec dharohar-prod-db-1 psql -U dharohar -d dharohar -c "
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relkind='r'
  and (has_table_privilege('dharohar_app', c.oid, 'TRUNCATE')
    or has_table_privilege('dharohar_app', c.oid, 'REFERENCES')
    or has_table_privilege('dharohar_app', c.oid, 'TRIGGER'));"

# permissive composition: a second policy on the same command would widen access by OR
docker exec dharohar-prod-db-1 psql -U dharohar -d dharohar -c "
select tablename, cmd, count(*) from pg_policies group by 1,2 having count(*) > 1;"

# the runtime identity, and what it is not
docker exec dharohar-prod-db-1 psql -U dharohar -d dharohar -c "
select rolname, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcanlogin
  from pg_roles where rolname in ('dharohar','dharohar_app') order by 1;"

# the child tables fail closed with no context, measured AS the runtime role.
# Never paste the password into the command line: let the shell read it from .env.
# (The variable is DHAROHAR_APP_PASSWORD. This block previously named a POSTGRES_APP_PASSWORD that does
# not exist, which is why "it did not run" and "it ran and returned nothing" had to be separated.)
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Windows Git Bash only: native docker.exe cannot see /tmp
printf '%s\n' "$DHAROHAR_APP_PASSWORD" | docker compose -f docker-compose.prod.yml run --rm --no-deps -T db \
  psql -h db -U dharohar_app -d dharohar -W -c "
select (select current_user) as who,
       (select count(*) from parcels)           as parcels_visible,
       (select count(*) from parcel_owners)     as owners_visible,
       (select count(*) from parcel_mutations)  as mutations_visible,
       (select count(*) from field_inspections) as inspections_visible,
       (select count(*) from users)             as officers_visible;"

# 0010, the three parts, in the order this file states them:
#   (a) the credential columns are not readable at all
printf '%s\n' "$DHAROHAR_APP_PASSWORD" | docker compose -f docker-compose.prod.yml run --rm --no-deps -T db \
  psql -h db -U dharohar_app -d dharohar -W -c "select password_hash from users limit 1"
#       → ERROR:  permission denied for table users
#   (b) which 17 of 19 columns the role may read, from the owner's point of view
docker exec dharohar-prod-db-1 psql -U dharohar -d dharohar -c "
select count(*) filter (where has_column_privilege('dharohar_app','public.users',attname,'SELECT')) as readable,
       count(*) as total,
       string_agg(case when not has_column_privilege('dharohar_app','public.users',attname,'SELECT')
                        then attname end, ', ') as not_readable
  from pg_attribute a where a.attrelid='public.users'::regclass and a.attnum>0 and not a.attisdropped;"
#       → 17 | 19 | password_hash, salt
#       Do NOT reach for information_schema.column_privileges here: on 2026-10-23 it reported 1 of 19
#       for the same state that has_column_privilege reports 17 of 19. The predicate is the authority;
#       a view that under-reports a grant is worse than no view, because it reads as a tighter lockdown.
#   (c) the residual: one named officer, credential included, and no enumeration
printf '%s\n' "$DHAROHAR_APP_PASSWORD" | docker compose -f docker-compose.prod.yml run --rm --no-deps -T db \
  psql -h db -U dharohar_app -d dharohar -W -c "
select count(*) as by_wildcard from dharohar_officer_for_login('%');
select count(*) as by_exact_identifier, length(max(password_hash)) as hash_len
  from dharohar_officer_for_login('rj-audit-2015-0012');"
#       → 0, then 1 and 128: it cannot search, but for a name you already know it hands back the verifier.

# and the limit of layer 2, in one session: the runtime role may set its own context
printf '%s\n' "$DHAROHAR_APP_PASSWORD" | docker compose -f docker-compose.prod.yml run --rm --no-deps -T db \
  psql -h db -U dharohar_app -d dharohar -W -tA \
  -c "select 'unbound officers = '||count(*) from users" \
  -c "select set_config('app.organization_id','ORG-DHAROHAR-DEMO',false)" \
  -c "select 'after self-asserting a tenant, officers = '||count(*) from users" \
  -c "select 'parcels still = '||count(*) from parcels"
#       → 0, then 59, then 0. Measured 2026-10-23. The policies bind the *rows to the asserted tenant*,
#       so forging one cannot reach another tenant's rows or any land record — but it is not a wall
#       against whoever holds the runtime credential, and this file does not claim that it is.
```

The unbound probe is the one that matters for §3. Re-run on the deployed demo database on 2026-10-23 it
returns `dharohar_app | 0 | 0 | 0 | 0 | 0`, while the same tables hold 45 parcels, 46 co-sharer rows, 16
mutations, 0 inspections and 59 officers to the owner. `officers_visible` is the column 0010 added: it
read **59** on the same database the day before, which is the whole of the difference between "the
runtime role can list every account in the system" and "the runtime role can see none of them".

Behaviour beyond those counts is proved by `./scripts/test-authorization-on-copy.sh`, which restores a
disposable copy, boots a throwaway API against it and runs the jurisdiction, provisioning and tenancy
suites as `dharohar_app` with no application in the path — including the child-table probes added with
0009, the principal-data checks added with 0010 (§9 of the tenancy suite: two tenants, what each can and
cannot see in `users`, postings, capabilities and grants, the credential columns, the identity role, the
residual oracle and the forged-context limit), and the pooled-connection test, which checks that a
committed transaction's tenant does not survive into the next borrower.
