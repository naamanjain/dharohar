-- =============================================================================
-- DHAROHAR — rollback of DRAFT migration 0004 (phases 1-3 only)
--
-- Companion to 0004_canonical_districts_and_tenants.sql. It exists because that file is
-- purely additive, which is exactly the property that makes an in-place reverse script
-- honest: undoing an addition is arithmetic, whereas undoing a repointed foreign key is a
-- restore from a verified dump and no script can substitute for one.
--
-- DO NOT use this after 0005. 0005 drops the global name-uniqueness index and moves the
-- four foreign keys onto districts(id); at that point the previous schema no longer
-- describes the data and the only correct rollback is scripts/restore.sh into an empty
-- database from the dump taken immediately before 0005.
--
-- Refuses to run if anything other than this migration has started depending on the demo
-- tenant. A rollback that quietly discards real associations would be worse than no
-- rollback at all, so it checks first and stops.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---- 1. Guard: is it still safe to remove what 0004 created? ---------------
DO $do$
DECLARE
  foreign_rows   integer;
  unit_rows      integer;
  other_org_rows integer;
BEGIN
  SELECT count(*) INTO foreign_rows FROM organization_districts
   WHERE granted_by <> 'migration:0004';
  IF foreign_rows > 0 THEN
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] % organization<->district association(s) were granted by somebody other than migration:0004.\n  Deleting the tenant would erase a real grant. Revoke them explicitly, with a reason, then roll back.',
    foreign_rows;
  END IF;

  SELECT count(*) INTO unit_rows FROM organization_units;
  IF unit_rows > 0 THEN
    RAISE EXCEPTION '[ROLLBACK_REFUSED] % organization unit row(s) exist. Internal units are data somebody created; this rollback will not delete them. Move them to another organization first.',
      unit_rows;
  END IF;

  SELECT count(*) INTO other_org_rows FROM organizations WHERE id <> 'ORG-DHAROHAR-DEMO';
  IF other_org_rows > 0 THEN
    RAISE EXCEPTION '[ROLLBACK_REFUSED] % organization(s) other than the demo tenant exist. Dropping shared columns while a real tenant depends on them is not a rollback.',
      other_org_rows;
  END IF;
END
$do$;

-- ---- 2. Undo phase 3: the id columns and the CHECKs that bind them ---------
ALTER TABLE parcels         DROP CONSTRAINT IF EXISTS ck_parcels_district_id_matches;
ALTER TABLE land_documents  DROP CONSTRAINT IF EXISTS ck_documents_district_id_matches;
ALTER TABLE users           DROP CONSTRAINT IF EXISTS ck_users_district_id_matches;

ALTER TABLE parcels            DROP COLUMN IF EXISTS district_id;
ALTER TABLE land_documents     DROP COLUMN IF EXISTS district_id;
ALTER TABLE users              DROP COLUMN IF EXISTS district_id;
ALTER TABLE user_jurisdictions DROP COLUMN IF EXISTS district_id;

-- ---- 3. Undo phase 2: the demo tenant and its associations -----------------
DELETE FROM organization_districts WHERE organization_id = 'ORG-DHAROHAR-DEMO';
DELETE FROM organizations          WHERE id = 'ORG-DHAROHAR-DEMO';

-- ---- 4. Undo phase 1: the new tables and the added registry columns --------
DROP TABLE IF EXISTS organization_units;
DROP TABLE IF EXISTS organization_districts;

ALTER TABLE districts DROP CONSTRAINT IF EXISTS ux_districts_id;
ALTER TABLE districts DROP COLUMN IF EXISTS id;
ALTER TABLE districts DROP COLUMN IF EXISTS kind;
ALTER TABLE districts DROP COLUMN IF EXISTS state_code;
ALTER TABLE districts DROP COLUMN IF EXISTS country_code;
ALTER TABLE districts DROP COLUMN IF EXISTS canonical_name;
ALTER TABLE districts DROP COLUMN IF EXISTS name_key;
ALTER TABLE districts DROP COLUMN IF EXISTS retired_at;
ALTER TABLE districts DROP COLUMN IF EXISTS notes;

COMMIT;

-- =============================================================================
-- What the state should be afterwards — verify all four, do not assume any:
--   1. select count(*) from districts;                    same number as before 0004
--   2. select count(*) from information_schema.columns
--        where table_name = 'districts';                   equals the pre-0004 count (7)
--   3. to_regclass('organization_districts') is NULL and
--      to_regclass('organization_units')     is NULL
--   4. parcels/land_documents/users/user_jurisdictions have no district_id column, and
--      the 0003 CHECK (district_code = lower(btrim(district))) still fires on a bad write
--
-- If district rows were reclassified by 0004 (kind='test_fixture'), the notes text it
-- appended is removed with the column, but the underlying rows are untouched: 0004 never
-- deleted or repointed a record, so undoing it has nothing to restore.
-- =============================================================================
