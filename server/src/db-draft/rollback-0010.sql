-- =============================================================================
-- DHAROHAR — rollback of migration 0010 (officer row isolation)
--
-- Reverses an enforcement decision, not data: no row is deleted and no column is dropped. The twelve
-- ... sixteen tenant policies on the authorization tables are removed, row-level security is disabled
-- on them again, the credential columns of `users` become readable by the runtime role again, and the
-- identity lookup functions plus their owning role are dropped.
--
-- READ THIS BEFORE RUNNING IT. Rolling 0010 back does not fail closed. It restores the state where
-- `SELECT * FROM users` as `dharohar_app` returns every organization's officers, their district
-- postings, their capabilities and their password hashes. Do not run it against a database that any
-- real record or any tenant outside your own control lives in, and do not leave it rolled back.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---- 1. Refuse to roll back policies this migration did not create ----------
DO $do$
DECLARE
  foreign_policies text;
BEGIN
  SELECT string_agg(tablename || '/' || policyname, ', ') INTO foreign_policies
    FROM pg_policies
   WHERE tablename IN ('users','user_jurisdictions','user_capabilities','organization_districts')
     AND policyname NOT LIKE 'tenant_%';
  IF foreign_policies IS NOT NULL THEN
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] policy(ies) on the authorization tables were not created by 0010: %.\n  Dropping 0010''s policies would leave someone else''s rule in charge of who may read officer rows. Nothing was changed.', foreign_policies;
  END IF;
END
$do$;

-- ---- 2. Drop the policies, then the switches --------------------------------
DO $do$
DECLARE
  t     text;
  cmd   text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','user_jurisdictions','user_capabilities','organization_districts'] LOOP
    FOREACH cmd IN ARRAY ARRAY['select','insert','update','delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS tenant_%s_%I ON %I', cmd, t, t);
    END LOOP;
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE '[rollback-0010] %: policies dropped, row-level security off', t;
  END LOOP;
END
$do$;

-- ---- 3. Hand the credential columns back, and say so loudly ----------------
-- The column grant is revoked first so the resulting ACL is the plain pre-0010 one rather than a
-- column grant and a table grant stacked on top of each other.
DO $do$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(c.column_name, ', ' ORDER BY c.ordinal_position) INTO cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'users';
  EXECUTE format('REVOKE SELECT (%s) ON public.users FROM dharohar_app', cols);
  EXECUTE 'GRANT SELECT ON public.users TO dharohar_app';
  RAISE WARNING '[rollback-0010] dharohar_app can read users.password_hash and users.salt again.';
END
$do$;

-- ---- 4. Remove the identity role and its functions --------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('dharohar_officer_for_login','dharohar_has_any_officer')) THEN
    EXECUTE 'DROP FUNCTION IF EXISTS public.dharohar_officer_for_login(text)';
    EXECUTE 'DROP FUNCTION IF EXISTS public.dharohar_has_any_officer()';
    RAISE NOTICE '[rollback-0010] identity lookup functions dropped';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dharohar_identity') THEN
    -- Anything else still owned by it would be dropped by accident, so refuse instead of cascading.
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                WHERE r.rolname = 'dharohar_identity')
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                   WHERE r.rolname = 'dharohar_identity') THEN
      RAISE EXCEPTION E'[ROLLBACK_REFUSED] dharohar_identity still owns an object this rollback did not create. Nothing was changed.';
    END IF;
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM dharohar_identity';
    EXECUTE 'REVOKE ALL ON TABLE users FROM dharohar_identity';
    DROP ROLE dharohar_identity;
    RAISE NOTICE '[rollback-0010] role dharohar_identity dropped';
  END IF;
END
$do$;

-- ---- 5. Ledger row, guarded the same way rollback-0009 does ----------------
DO $do$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0010';
    RAISE NOTICE '[rollback-0010] ledger row for 0010 removed (re-running npm run db:migrate will re-apply it)';
  ELSE
    RAISE NOTICE '[rollback-0010] no schema_migrations ledger in this database - nothing to correct';
  END IF;
END
$do$;

DO $do$
BEGIN
  RAISE NOTICE '[rollback-0010] policies left on the authorization tables: %',
    (SELECT count(*) FROM pg_policies
      WHERE tablename IN ('users','user_jurisdictions','user_capabilities','organization_districts'));
  RAISE NOTICE '[rollback-0010] officer rows still present (nothing was deleted): %',
    (SELECT count(*) FROM users);
END
$do$;

COMMIT;
