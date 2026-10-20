-- =============================================================================
-- DHAROHAR — rollback of migration 0006 (tenant ownership + row-level security)
--
-- Drill tool, never shipped to server/src/db/migrations (scripts/build-tenant-migration.mjs excludes
-- rollback-*.sql from the runner on purpose). Removes exactly what 0006 added and refuses to do it
-- silently when a person has since made an ownership decision this file cannot represent.
--
--   psql -v ON_ERROR_STOP=1 -f server/src/db-draft/rollback-0006.sql
--
-- Order matters: the policies reference the GUCs and the organization column, so they go first; the
-- CHECK constraints reference the attribution columns, so they go before the columns.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---- 1. Guards --------------------------------------------------------------
DO $do$
DECLARE
  human        integer;
  human_detail text;
BEGIN
  -- Ownership assigned by a person (through the disposition command) is a decision, not a default.
  -- Rolling 0006 back would erase it with no way to reconstruct who decided what.
  SELECT count(*) FILTER (WHERE organization_granted_by IS NOT NULL
                            AND organization_granted_by <> 'migration:0006'),
         string_agg(DISTINCT organization_granted_by, ', ')
           FILTER (WHERE organization_granted_by IS NOT NULL
                     AND organization_granted_by <> 'migration:0006')
    INTO human, human_detail
    FROM (SELECT organization_granted_by FROM parcels
          UNION ALL SELECT organization_granted_by FROM land_documents
          UNION ALL SELECT organization_granted_by FROM users) a;
  IF human > 0 THEN
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] % row(s) carry an ownership grant from % rather than migration:0006.\n  Nothing was removed: those assignments are a person''s decision and this rollback cannot put them back.', human, coalesce(human_detail, '?')
      USING HINT = 'Re-assign them through migration:0006''s basis, or export the assignments before rolling back.';
  END IF;

  -- An active policy that is not one of the four 0006 creates means something else is relying on row
  -- level security here. Turning it off would quietly change what the runtime role can read.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE tablename IN ('parcels','land_documents')
                AND policyname NOT LIKE 'tenant_%') THEN
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] a policy outside the tenant_* naming exists on parcels or land_documents:\n  %',
      (SELECT string_agg(policyname, ', ') FROM pg_policies
        WHERE tablename IN ('parcels','land_documents') AND policyname NOT LIKE 'tenant_%');
  END IF;
END
$do$;

-- ---- 2. Policies and row-level security -------------------------------------
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parcels','land_documents'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_select_%I ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_insert_%I ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_update_%I ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_delete_%I ON %I', t, t);
    -- Reversible state, not a claim: the tables were not under RLS before 0006.
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE '[rollback-0006] policies dropped and row-level security disabled on %', t;
  END LOOP;
END
$do$;

-- ---- 3. Undo the assignment, then the columns --------------------------------
-- Every table is handled the same way, in one place, so there is no half-rolled-back state where the
-- column still carries a claim while its attribution is gone.
DO $do$
DECLARE
  t   text;
  n   integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['parcels','land_documents','users'] LOOP
    EXECUTE format('UPDATE %I SET organization_id = NULL, organization_granted_by = NULL, '
                || 'organization_grant_reason = NULL, organization_granted_at = NULL '
                || 'WHERE organization_granted_by = %L', t, 'migration:0006');
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '[rollback-0006] % ownership released on % row(s) (quarantine, as before 0006)', n, t;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS ck_%I_ownership_is_attributed', t, t);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS organization_granted_by', t);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS organization_grant_reason', t);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS organization_granted_at', t);
  END LOOP;

  -- The documents column and its reference did not exist before 0006.
  DROP INDEX IF EXISTS idx_land_documents_organization_id;
  ALTER TABLE land_documents DROP CONSTRAINT IF EXISTS fk_land_documents_organization_id;
  ALTER TABLE land_documents DROP COLUMN IF EXISTS organization_id;
  RAISE NOTICE '[rollback-0006] land_documents.organization_id removed (parcels/users keep theirs, they came from 0002/0003)';
END
$do$;

-- ---- 4. Report --------------------------------------------------------------
DO $do$
DECLARE
  r record;
BEGIN
  -- Both branches cast: an uncast bigint beside a text is `UNION types text and bigint cannot be
  -- matched`, which aborts the rollback on its last statement and undoes the work it already did.
  FOR r IN SELECT 'parcels' AS t, count(*)::text rows_,
                   count(*) FILTER (WHERE organization_id IS NULL)::text unowned
            FROM parcels
         UNION ALL SELECT 'users', count(*)::text, count(*) FILTER (WHERE organization_id IS NULL)::text FROM users
  LOOP
    RAISE NOTICE '[rollback-0006] %: rows=% unowned=%', r.t, r.rows_, r.unowned;
  END LOOP;
  RAISE NOTICE '[rollback-0006] row-level security now active on: %',
    coalesce((SELECT string_agg(c.relname, ', ') FROM pg_class c
               WHERE c.relrowsecurity AND c.relnamespace = 'public'::regnamespace), '(none)');
END
$do$;

COMMIT;
