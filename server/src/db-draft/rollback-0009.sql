-- =============================================================================
-- DHAROHAR — rollback of migration 0009 (child records inherit their parcel's tenant)
--
-- Drops the twelve policies 0009 created and disables row-level security on parcel_owners,
-- parcel_mutations and field_inspections. No row is deleted and no column is touched: this reverses
-- an enforcement decision, not data.
--
-- After this rollback those three tables are protected only by the application layer again — which is
-- the state 0009 was written to end, so treat this as a temporary measure and re-apply 0009 when the
-- reason for rolling it back is resolved.
--
-- Unlike rollback-0006/0007/0008 this file also removes its own row from schema_migrations. The
-- runner decides what to apply from the ledger alone, so a rollback that leaves the row behind marks a
-- database as migrated when the policies are gone — and the next `db:migrate` would be a silent no-op.
-- Deleting it makes "rollback, then re-run the runner" the documented recovery.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---- 1. Refuse to roll back a policy this file did not create ----------------
DO $do$
DECLARE
  foreign_policies text;
BEGIN
  SELECT string_agg(tablename || '/' || policyname, ', ') INTO foreign_policies
    FROM pg_policies
   WHERE tablename IN ('parcel_owners','parcel_mutations','field_inspections')
     AND policyname NOT LIKE 'tenant_%';
  IF foreign_policies IS NOT NULL THEN
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] policy(ies) on the child tables were not created by 0009: %.\n  Dropping 0009''s policies would leave someone else''s rule in charge of rows it was meant to protect. Nothing was changed.', foreign_policies;
  END IF;
END
$do$;

-- ---- 2. Drop the policies, then the switches --------------------------------
DO $do$
DECLARE
  t     text;
  cmd   text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parcel_owners','parcel_mutations','field_inspections'] LOOP
    FOREACH cmd IN ARRAY ARRAY['select','insert','update','delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS tenant_%s_%I ON %I', cmd, t, t);
    END LOOP;
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE '[rollback-0009] %: policies dropped, row-level security off', t;
  END LOOP;
END
$do$;

-- Guarded rather than unconditional: the migration drill rolls this file back on copies restored from
-- dumps taken before the runner existed, where there is no ledger to correct.
DO $do$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0009';
    RAISE NOTICE '[rollback-0009] ledger row for 0009 removed (re-running npm run db:migrate will re-apply it)';
  ELSE
    RAISE NOTICE '[rollback-0009] no schema_migrations ledger in this database — nothing to correct';
  END IF;
END
$do$;

DO $do$
BEGIN
  RAISE NOTICE '[rollback-0009] remaining policies on the child tables: %',
    (SELECT count(*) FROM pg_policies WHERE tablename IN ('parcel_owners','parcel_mutations','field_inspections'));
  RAISE NOTICE '[rollback-0009] rows left in place: parcel_owners=%, parcel_mutations=%, field_inspections=%',
    (SELECT count(*) FROM parcel_owners), (SELECT count(*) FROM parcel_mutations), (SELECT count(*) FROM field_inspections);
END
$do$;

COMMIT;
