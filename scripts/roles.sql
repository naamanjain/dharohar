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
    'users', 'parcels', 'parcel_owners', 'parcel_mutations',
    'land_documents', 'field_inspections',
    -- From migration 0002: the tenant, the jurisdiction registry, and the two assignment tables the
    -- authorization layer reads on every request. The API must be able to READ these to decide
    -- anything at all, and must be able to WRITE them only through the provisioning service, which
    -- is the same statement path — so they are granted like the operational tables.
    'organizations', 'districts', 'user_jurisdictions', 'user_capabilities'
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
                           'organizations', 'districts', 'user_jurisdictions', 'user_capabilities'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM dharohar_app', t);
    END IF;
  END LOOP;
END
$do$;
--
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
