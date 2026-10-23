# Tenant data access review — every table the runtime role can reach

Measured on the deployed synthetic demo database on 2026-10-23, after migrations 0001–0009.
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
* **Layer 2 — PostgreSQL row-level security.** Applies to the five tables below, and only to
  `dharohar_app`, the identity the API connects as. It is the layer that still holds if the application
  is bypassed entirely and SQL is issued with the runtime credential.

A table with "no RLS" is not automatically unprotected, and a table with RLS is not automatically
safe: the columns say which, and the last column says what the gap is if there is one.

## 1. The measured inventory

| table | rows | app-role privileges | RLS | policies | what stands between tenants |
|---|---|---|---|---|---|
| `parcels` | 42 | SELECT, INSERT, UPDATE | **yes** | 4 (`tenant_select/insert/update/delete_parcels`) | Row: `organization_id` must equal `app.organization_id` **and** the organization of the user named by `app.user_id` (0006). Column: the app role cannot DELETE at all — records are archived instead. |
| `land_documents` | 45 | SELECT, INSERT, UPDATE | **yes** | 4 | Same predicate as `parcels`, on the document's own `organization_id` — inherited from the parcel it is filed against, not from the uploader. |
| `parcel_owners` | 43 | SELECT, INSERT, UPDATE, DELETE | **yes** | 4 | Row: the parent parcel must be visible (0009). Co-sharer names are the most personal data in the register and are reachable only through the parcel's own tenant test. DELETE is granted deliberately — replacing a co-sharer list is delete-then-insert — and the previous set survives in `parcel_mutations` and the chained audit log, which this role cannot delete. |
| `parcel_mutations` | 16 | SELECT, INSERT, UPDATE | **yes** | 4 | Parent parcel (0009). No DELETE: history is not removable by the runtime role. |
| `field_inspections` | 0 | SELECT, INSERT, UPDATE | **yes** | 4 | Parent parcel (0009). Survey evidence — observer, photo URI, digest — cannot be read or attached without seeing the land. |
| `users` | 59 | SELECT, INSERT, UPDATE | no | 0 | **Application only, and it has to be.** `loadPrincipal` reads this table to discover who the caller is *before* any tenant context exists; a policy keyed on `app.organization_id` could never be satisfied at that moment. Reads are scoped in SQL by `organizationScopeClause`, which emits `AND (1 = 0)` when the caller has no tenant. |
| `user_jurisdictions` | 61 | SELECT, INSERT, UPDATE | no | 0 | Same reason — it is part of the evidence used to build the principal. Revocation is honoured by `revoked_at IS NULL` on every read. |
| `user_capabilities` | 6 | SELECT, INSERT, UPDATE | no | 0 | Same reason. Capability checks run against the live row, not against a token claim. |
| `organization_districts` | 4 | SELECT, INSERT, UPDATE | no | 0 | Same reason: the tenant's district authority is resolved during authorization. Deliberately readable so that a grant revoked by an owner takes effect on the next request. |
| `organization_units` | 0 | SELECT, INSERT, UPDATE | no | 0 | **Nothing, and nothing needs it yet.** Measured: no query anywhere in `server/src` or `client/src` reads or writes it. If it gains a query, that change must add the tenant policy in the same commit — the table carries `organization_id` and would otherwise be a cross-tenant read. |
| `organizations` | 1 | SELECT, INSERT, UPDATE | no | 0 | The tenant directory, not tenant data. A prospective officer's login has to be able to find their own organization. |
| `districts` | 16 | SELECT, INSERT, UPDATE | no | 0 | Shared geography by design: two tenants may hold grants on the same district, so a district row is not anyone's record. Its `kind` and `is_active` are guarded by triggers and by the promotion workflow, not by tenancy. |
| `append_only_audit_logs` | 2341 | SELECT, INSERT | no | 0 | Append-only, not tenant-filtered — see §4. INSERT/SELECT only: the role cannot UPDATE, DELETE or TRUNCATE, and the 0001 trigger refuses the same thing at execution time. |
| `schema_migrations` | 9 | SELECT | no | 0 | Read-only ledger for the runtime role; only the one-shot identities can write it. |
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

**`users`, `user_jurisdictions`, `user_capabilities`, `organization_districts` — no policy.** A tenant
policy needs the tenant, and the tenant is *derived* from these tables. Putting them behind
`app.organization_id` would be a closed loop: no request could ever bind a context, so every request
would fail closed. Scoping therefore lives in the query (`organizationScopeClause`,
`readScope`/`writeScope`), and it emits `1 = 0` rather than an unfiltered query when the principal has
no tenant. The residual exposure is honest and named: with the runtime credential alone, an officer
list of another tenant is readable by direct SQL. It contains no land record, and every record route
remains double-filtered. Narrowing it further needs a second, more privileged identity for
authentication reads — a change to the role design, not a policy to add blindly.

**`append_only_audit_logs` — no policy.** Validating a hash chain requires reading **every** entry in
order, in all tenants. A tenant-filtered read produces gaps, and gaps look exactly like tampering:
the first time this project measured the chain under a tenant-scoped identity, it invented 41
orphan findings that did not exist. Chain verification runs as the owner identity through `maint`
(`server/src/verify_district_integrity.ts` carries a hard identity guard and exits 2 when the caller
cannot see the whole table), while tenant audit *views* stay tenant-filtered in
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
set -a; . ./.env; set +a
docker exec -e PGPASSWORD="$POSTGRES_APP_PASSWORD" dharohar-prod-db-1 psql -U dharohar_app -d dharohar -c "
select (select current_user) as who,
       (select count(*) from parcels)           as parcels_visible,
       (select count(*) from parcel_owners)     as owners_visible,
       (select count(*) from parcel_mutations)  as mutations_visible,
       (select count(*) from field_inspections) as inspections_visible;"
```

The last query is the one that matters for §3: measured on the deployed demo database on 2026-10-22 it
returns `dharohar_app | 0 | 0 | 0 | 0`, while the same tables hold 41, 42, 16 and 0 rows to the owner.
Behaviour beyond that count is proved by `./scripts/test-authorization-on-copy.sh`, which restores a
disposable copy, boots a throwaway API against it and runs the tenancy suite as `dharohar_app` with no
application in the path — including the child-table probes added with 0009 and the pooled-connection
test, which checks that a committed transaction's tenant does not survive into the next borrower.
