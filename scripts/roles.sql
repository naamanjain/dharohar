-- =============================================================================
-- DHAROHAR — scripts/roles.sql
--
-- Least-privilege database roles for the land-records API. ADDITIVE ONLY: it
-- creates a role if missing, grants privileges, and explicitly revokes the ones
-- the API must never hold. It never drops a role, table, grant of another role,
-- or any data.
--
-- HOW TO APPLY  (run it once per PostgreSQL *cluster* for the role, then once per
-- database for the grants — the same file does both, so run it in every database
-- the API uses, as a superuser or the owner of the schema objects):
--
--   export DHAROHAR_APP_PASSWORD="$(openssl rand -base64 32)"   # never commit it
--   psql "$DATABASE_URL_FOR_OWNER" \
--        --no-psqlrc -q -v ON_ERROR_STOP=1 \
--        -v app_password="$DHAROHAR_APP_PASSWORD" \
--        -f scripts/roles.sql
--
-- Dockerised PostGIS (password stays inside the container's environment):
--
--   docker cp scripts/roles.sql dharohar-pg:/tmp/roles.sql
--   docker exec -i -e PGPASSWORD dharohar-pg psql -U postgres -d dharohar_db \
--     --no-psqlrc -q -v ON_ERROR_STOP=1 -v app_password="$DHAROHAR_APP_PASSWORD" \
--     -f /tmp/roles.sql
--
-- If -v app_password is omitted psql stops with "no value found for parameter
-- app_password" instead of creating a password-less role. To rotate the password
-- later, re-run with a new value: the ALTER ROLE below applies it.
--
-- DO NOT run this against a shared database you do not own: CREATE ROLE is
-- cluster-wide, so the new login role becomes visible to every database in that
-- cluster (it can only connect where it is granted CONNECT and table privileges).
--
-- What this guarantees for dharohar_app:
--   * LOGIN, NOT superuser, NOCREATEROLE, NOCREATEDB, NOBYPASSRLS, NOREPLICATION.
--   * SELECT / INSERT / UPDATE on the operational tables (parcels, owners,
--     mutations, documents, inspections, users) + sequence usage for SERIAL ids.
--   * No CREATE anywhere, so it cannot ALTER/DROP any table — only the schema
--     owner (or a migrator role) can run DDL.
--   * append_only_audit_logs: SELECT + INSERT only. UPDATE and DELETE are
--     explicitly REVOKEd, which backs up (does not replace) the
--     append_only_audit_guard DB trigger created in migration 0001.
--   * schema_migrations: SELECT only — the API can read its own schema version
--     but can never mark a migration applied.
-- =============================================================================

\set ON_ERROR_STOP on

-- ---- 1. The application role (cluster level) --------------------------------
-- The password arrives as a psql variable and is written with psql's :'var' quoting so it is
-- escaped as a literal. It MUST stay at psql's top level: psql does not interpolate variables
-- inside dollar-quoted blocks, and the value is never echoed when the file is run with -q.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dharohar_app') AS role_already_exists \gset

\if :role_already_exists
  -- Idempotent re-run: re-assert the lockdown attributes and rotate the password.
  ALTER ROLE dharohar_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD :'app_password';
  \echo '[DHAROHAR ROLES] role dharohar_app already existed - attributes re-asserted, password rotated'
\else
  CREATE ROLE dharohar_app LOGIN
    PASSWORD :'app_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION
    CONNECTION LIMIT 50;
  \echo '[DHAROHAR ROLES] created role dharohar_app (non-superuser, no role/db creation, no bypassrls)'
\endif

-- ---- 2. Database-level lockdowns -------------------------------------------
-- The app role may use this database but owns nothing in it.
DO $do$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dharohar_app', current_database());
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM dharohar_app');
  EXECUTE format('GRANT USAGE ON SCHEMA public TO dharohar_app');
END
$do$;

-- ---- 3. Operational tables: SELECT / INSERT / UPDATE ------------------------
-- Enumerated on purpose: a missing table is reported instead of silently skipped,
-- and anything not in this list stays unreachable for the API role.
DO $do$
DECLARE
  t          text;
  ops        text[] := ARRAY[
    -- 'users' is deliberately NOT here. It is granted column-by-column in section 3c instead, because
    -- the two credential columns must not be readable by the runtime role. Granting table-level SELECT
    -- on it here would silently undo migration 0010 on every roleinit run — and roleinit runs on every
    -- `docker compose up`, so the mistake would be invisible until someone queried a hash.
    'parcels', 'parcel_owners', 'parcel_mutations',
    'land_documents', 'field_inspections',
    -- From migration 0002: the tenant, the jurisdiction registry, and the two assignment tables the
    -- authorization layer reads on every request. The API must be able to READ these to decide
    -- anything at all, and must be able to WRITE them only through the provisioning service, which
    -- is the same statement path — so they are granted like the operational tables.
    -- Since migration 0010 the four authorization tables are ALSO row-level-security scoped: these
    -- grants say which columns the role may touch, the policies say which rows.
    'organizations', 'districts', 'user_jurisdictions', 'user_capabilities',
    -- From migration 0004. loadPrincipal reads organization_districts on EVERY authenticated request,
    -- because a tenant's district authority has to take effect — and be revoked — immediately rather
    -- than at token expiry. Without SELECT here the authorization layer cannot decide anything and
    -- every request fails closed with AUTHORIZATION_UNAVAILABLE, which is what this grant was missing.
    -- organization_units is MEASURED to have no reader or writer anywhere in server/src or client/src,
    -- and zero rows in the deployed database: 0004 reserved the structure for internal units and nothing
    -- uses it yet. It is granted anyway so that a later feature does not fail closed on a missing
    -- privilege; because it carries organization_id, whoever gives it a query must add the tenant
    -- policy in the same change. Neither table is deletable: see 3b.
    'organization_districts', 'organization_units'
  ];
BEGIN
  FOREACH t IN ARRAY ops LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE WARNING 'table % not found in this database — skipped (run npm run db:migrate first)', t;
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO dharohar_app', t);
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM dharohar_app', t);
    END IF;
  END LOOP;
END
$do$;

-- ---- 3b. DELETE: parcel_owners only, and why --------------------------------
-- Replacing a parcel's co-sharer list is implemented as "delete this parcel's owner rows, insert the
-- new set" (server/src/routes/parcels.ts), so without DELETE on parcel_owners every owner edit the
-- API accepts would fail with permission denied. That is a deliberately narrow right:
--   * the previous owner set is written to parcel_mutations and the chained audit log first, and
--     neither of those is deletable by this role, so the history of a removal survives it;
--   * parcels themselves stay DELETE-free. A land record is archived
--     (is_archived / archived_at / archive_reason) and this role cannot do otherwise.
-- If departmental policy later forbids physical DELETE even on owner rows, the code has to move to
-- soft-replacement first and this grant goes away — not the other way round.
DO $do$
DECLARE
  t text;
BEGIN
  IF to_regclass('parcel_owners') IS NOT NULL THEN
    EXECUTE format('GRANT DELETE ON TABLE parcel_owners TO dharohar_app');
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE parcel_owners FROM dharohar_app');
  END IF;

  -- Explicitly withheld. Listed so that a future reader can see this was decided, not forgotten.
  FOREACH t IN ARRAY ARRAY['parcels', 'land_documents', 'field_inspections', 'parcel_mutations',
                           'organizations', 'districts', 'user_jurisdictions', 'user_capabilities',
                           'organization_districts', 'organization_units'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM dharohar_app', t);
    END IF;
  END LOOP;
END
$do$;
--
-- ---- 3c. users: every column EXCEPT the two credentials, plus the lookups ----
-- Migration 0010 installed the row-level-security policies and this column split. Re-stating the
-- column grant here is what keeps a `docker compose up` (which re-runs this file through `roleinit`)
-- from widening it back; re-asserting rather than trusting that the migration ran first is the point.
--
-- Why two controls instead of one: the policies decide WHICH officer rows this role can see (its own
-- organization), the column grant decides WHICH FIELDS of any visible row it can read. A future change
-- that loosens one still cannot reach password_hash through the other.
DO $do$
DECLARE
  cols     text;
  secret   text[] := ARRAY['password_hash', 'salt'];
  has_0010 boolean;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE '[DHAROHAR ROLES] users not present yet (run npm run db:migrate first) - skipped';
    RETURN;
  END IF;

  SELECT string_agg(c.column_name, ', ' ORDER BY c.ordinal_position) INTO cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'users'
     AND c.column_name <> ALL (secret);

  -- The narrow lookups exist only if 0010 has been applied. If it has not, the column split is still
  -- imposed (it is strictly safer) but a missing function is reported instead of assumed.
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'dharohar_officer_for_login') INTO has_0010;

  EXECUTE 'REVOKE SELECT ON public.users FROM dharohar_app';
  EXECUTE format('GRANT SELECT (%s) ON public.users TO dharohar_app', cols);
  EXECUTE 'GRANT INSERT, UPDATE ON public.users TO dharohar_app';
  -- Not DELETE: accounts are retired by revoking grants and resetting the password, never removed.
  EXECUTE 'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.users FROM dharohar_app';

  IF has_0010 THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.dharohar_officer_for_login(text) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.dharohar_officer_for_login(text) FROM dharohar_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.dharohar_officer_for_login(text) TO dharohar_app';
    EXECUTE 'REVOKE ALL ON FUNCTION public.dharohar_has_any_officer() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public.dharohar_has_any_officer() FROM dharohar_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.dharohar_has_any_officer() TO dharohar_app';

    -- The identity role that owns those functions. Re-asserted here because a restore-then-roleinit
    -- order can land it with less than it needs, and the login path fails closed if it does.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dharohar_identity') THEN
      EXECUTE 'ALTER ROLE dharohar_identity WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION CONNECTION LIMIT 0';
      EXECUTE 'GRANT USAGE ON SCHEMA public TO dharohar_identity';
      EXECUTE 'GRANT SELECT ON public.users TO dharohar_identity';
      RAISE NOTICE '[DHAROHAR ROLES] identity lookups and dharohar_identity attributes re-asserted';
    ELSE
      RAISE WARNING '[DHAROHAR ROLES] dharohar_identity is missing although the login lookup exists - run npm run db:migrate';
    END IF;
  ELSE
    RAISE WARNING '[DHAROHAR ROLES] migration 0010 has not been applied: no dharohar_officer_for_login function. Sign-in still needs it - run npm run db:migrate.';
  END IF;

  -- Refuse to finish claiming least privilege while the credential columns are still readable.
  IF has_column_privilege('dharohar_app', 'public.users', 'password_hash', 'SELECT')
     OR has_column_privilege('dharohar_app', 'public.users', 'salt', 'SELECT') THEN
    RAISE EXCEPTION '[ROLES_LOCKDOWN_FAILED] dharohar_app can read the users credential columns after this script ran';
  END IF;
  IF NOT has_column_privilege('dharohar_app', 'public.users', 'organization_id', 'SELECT') THEN
    RAISE EXCEPTION '[ROLES_LOCKDOWN_FAILED] dharohar_app lost a users column the authorization layer needs';
  END IF;
  RAISE NOTICE '[DHAROHAR ROLES] users: SELECT granted on % non-credential columns; password_hash and salt withheld',
    (SELECT count(*) FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'users' AND c.column_name <> ALL (secret));
END
$do$;

-- ---- 4. Append-only audit log: INSERT + SELECT, never UPDATE/DELETE ---------
-- The append_only_audit_guard trigger rejects UPDATE/DELETE at execution time;
-- these grants make the same rule true at authorisation time, so a role that
-- somehow bypasses the trigger (or a future trigger regression) still cannot
-- rewrite history.
DO $do$
BEGIN
  IF to_regclass('append_only_audit_logs') IS NULL THEN
    RAISE WARNING 'append_only_audit_logs not found — skipped (run npm run db:migrate first)';
  ELSE
    EXECUTE format('GRANT SELECT, INSERT ON TABLE append_only_audit_logs TO dharohar_app');
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE append_only_audit_logs FROM dharohar_app');
  END IF;
END
$do$;

-- ---- 5. Migration ledger: read-only ----------------------------------------
DO $do$
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RAISE WARNING 'schema_migrations not found — skipped (run npm run db:migrate first)';
  ELSE
    EXECUTE format('GRANT SELECT ON TABLE schema_migrations TO dharohar_app');
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM dharohar_app');
  END IF;
END
$do$;

-- ---- 6. Sequences behind SERIAL primary keys --------------------------------
-- parcel_mutations.id and append_only_audit_logs.id need nextval(), which is
-- USAGE+SELECT on the sequence — not ownership of the table.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dharohar_app;

-- ---- 7. PostGIS support objects --------------------------------------------
-- spatial_ref_sys and the metadata views are read by SRID-aware functions.
DO $do$
DECLARE
  obj text;
BEGIN
  FOREACH obj IN ARRAY ARRAY['spatial_ref_sys', 'geometry_columns', 'geography_columns'] LOOP
    IF to_regclass(obj) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO dharohar_app', obj);
    END IF;
  END LOOP;
END
$do$;

-- ---- 7b. The verification identity: read-only, sees through RLS --------------
-- Validating the audit chain means reading EVERY entry, in EVERY tenant, in order. Two identities can
-- do that: a role subject to row-level security (which sees zero rows and would report records it
-- cannot see as missing — this project measured exactly that, and invented 41 findings), or the schema
-- owner, which can also rewrite the chain, drop a table and truncate the register. Handing a routine
-- diagnostic the writable owner credential is the wrong trade: the diagnostic runs often, and it
-- should not be able to write anything.
--
-- So: SELECT-only, plus BYPASSRLS, plus no superuser. It is created only when a password is supplied
-- for it, because a deployment that does not want a second credential must not end up with one it did
-- not ask for:
--
--   psql -v app_password=... -v verifier_password=... -f scripts/roles.sql
\if :{?verifier_password}
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dharohar_verifier') AS verifier_already_exists \gset

\if :verifier_already_exists
  ALTER ROLE dharohar_verifier WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT BYPASSRLS NOREPLICATION CONNECTION LIMIT 5 PASSWORD :'verifier_password';
  \echo '[DHAROHAR ROLES] role dharohar_verifier already existed - attributes re-asserted, password rotated'
\else
  CREATE ROLE dharohar_verifier LOGIN
    PASSWORD :'verifier_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION
    CONNECTION LIMIT 5;
  \echo '[DHAROHAR ROLES] created role dharohar_verifier (read-only, exempt from row-level security)'
\endif

DO $do$
DECLARE
  t text;
  n integer := 0;
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dharohar_verifier', current_database());
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM dharohar_verifier');
  EXECUTE format('GRANT USAGE ON SCHEMA public TO dharohar_verifier');
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I TO dharohar_verifier', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM dharohar_verifier', t);
    n := n + 1;
  END LOOP;
  -- Future tables: read-only by default, so a migration cannot accidentally hand this identity a way
  -- to write. (The owner that runs migrations is the role these defaults are recorded for.)
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO dharohar_verifier', CURRENT_USER);
  RAISE NOTICE '[DHAROHAR ROLES] dharohar_verifier: SELECT granted on % table(s), every write privilege revoked', n;
END
$do$;

-- Refuse to report success if the identity is not what it claims to be. A read-only role that
-- somehow holds a write privilege would make "the verifier cannot damage the register" false.
DO $do$
DECLARE
  writable text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO writable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND (has_table_privilege('dharohar_verifier', c.oid, 'INSERT')
       OR has_table_privilege('dharohar_verifier', c.oid, 'UPDATE')
       OR has_table_privilege('dharohar_verifier', c.oid, 'DELETE')
       OR has_table_privilege('dharohar_verifier', c.oid, 'TRUNCATE'));
  IF writable IS NOT NULL THEN
    RAISE EXCEPTION '[ROLES_LOCKDOWN_FAILED] dharohar_verifier can write to: %. It is documented as read-only.', writable;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'dharohar_verifier') THEN
    RAISE EXCEPTION '[ROLES_LOCKDOWN_FAILED] dharohar_verifier is a superuser, which makes every other grant meaningless.';
  END IF;
  RAISE NOTICE '[DHAROHAR ROLES] dharohar_verifier verified read-only: no table grants INSERT/UPDATE/DELETE/TRUNCATE';
END
$do$;
\else
  \echo '[DHAROHAR ROLES] no verifier_password supplied - dharohar_verifier not created or updated'
  \echo '[DHAROHAR ROLES] integrity checks therefore still run as the schema owner via `maint`; supply DHAROHAR_VERIFIER_PASSWORD to use the read-only identity instead'
\endif

-- ---- 8. Tables created by FUTURE migrations ---------------------------------
-- Without this, a new table would silently be invisible to the API until someone
-- re-runs this script. ADDITIVE: it changes no existing object.
-- Run as the role that actually performs migrations (normally the schema owner);
-- DEFAULT PRIVILEGES are recorded for the role that executes this statement.
DO $do$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO dharohar_app', CURRENT_USER);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dharohar_app', CURRENT_USER);
END
$do$;
-- The audit ledger and the migration ledger are NOT covered by the defaults above:
-- append-only and forward-only stay enforced by explicit grants per table.

-- ---- 9. Report what the role actually holds (read-only verification) --------
-- PostgreSQL has no information_schema.schema_privileges view, so privileges are probed
-- with the has_*_privilege functions, which reflect the effective authorisation.
SELECT 'role' AS object,
       'login=' || rolcanlogin || ' superuser=' || rolsuper || ' createrole=' || rolcreaterole ||
       ' createdb=' || rolcreatedb || ' bypassrls=' || rolbypassrls || ' replication=' || rolreplication
       AS attributes
  FROM pg_roles WHERE rolname = 'dharohar_app'
UNION ALL
SELECT 'schema public',
       'USAGE=' || has_schema_privilege('dharohar_app', 'public', 'USAGE') ||
       ' CREATE=' || has_schema_privilege('dharohar_app', 'public', 'CREATE')
UNION ALL
SELECT c.relname,
       'SELECT='  || has_table_privilege('dharohar_app', c.oid, 'SELECT')  ||
       ' INSERT='  || has_table_privilege('dharohar_app', c.oid, 'INSERT')  ||
       ' UPDATE='  || has_table_privilege('dharohar_app', c.oid, 'UPDATE')  ||
       ' DELETE='  || has_table_privilege('dharohar_app', c.oid, 'DELETE')  ||
       ' TRUNCATE='|| has_table_privilege('dharohar_app', c.oid, 'TRUNCATE')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1;

-- Expect: append_only_audit_logs with UPDATE=false DELETE=false, schema_migrations with
-- INSERT/UPDATE/DELETE false, `schema public` CREATE=false, superuser=false. Spot-check by
-- connecting as the app role:
--   psql "$DATABASE_URL_AS_APP" -c "UPDATE append_only_audit_logs SET details='{}'"
--     -> ERROR: permission denied for table append_only_audit_logs
--   psql "$DATABASE_URL_AS_APP" -c "ALTER TABLE parcels DROP COLUMN geom"
--     -> ERROR: must be owner of table parcels
-- Optional extra hardening (NOT applied here because it also affects every other
-- role in the database): REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- Consider a dedicated `dharohar_migrator` role that owns the schema and is the
-- only role allowed to run npm run db:migrate; `dharohar_app` must never be it.
