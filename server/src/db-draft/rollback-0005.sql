-- =============================================================================
-- DHAROHAR — rollback of DRAFT migration 0005
--
-- Returns the schema to the state 0004 left behind: the identifier stops being the primary
-- key, the four children reference districts(code) again, retired fixtures become plain
-- test_fixture rows again, and migration 0003's trigger comes back verbatim.
--
-- Only safe before 0006, and only while nothing has written data that depends on the
-- identifier being the key. It refuses rather than guessing — see the guards.
--
-- The trigger body at step 5 is copied from server/src/db/migrations/0003_stable_district_-
-- identifiers.sql unchanged. If 0003 is ever edited, this file must be re-derived from it;
-- scripts/test-tenant-migration.sh asserts the restored function matches 0003 so a silent
-- divergence cannot survive the test run.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---- guards -----------------------------------------------------------------
DO $do$
DECLARE
  orphans integer;
BEGIN
  -- Every child row must still be reachable through its code, because that is the reference
  -- this rollback restores. A row with an identifier and no code would be stranded by the
  -- rollback, and a rollback that loses a reference is worse than no rollback.
  SELECT count(*) INTO orphans FROM (
    SELECT district_code AS c FROM parcels WHERE district_id IS NOT NULL AND district_code IS NULL
    UNION ALL SELECT district_code FROM land_documents WHERE district_id IS NOT NULL AND district_code IS NULL
    UNION ALL SELECT district_code FROM users WHERE district_id IS NOT NULL AND district_code IS NULL
    UNION ALL SELECT district_code FROM user_jurisdictions WHERE district_id IS NOT NULL AND district_code IS NULL
  ) s;
  IF orphans > 0 THEN
    RAISE EXCEPTION '[ROLLBACK_REFUSED] % row(s) hold a district_id with no district_code; restoring the code-based foreign key would strand them. Repair the reference first.', orphans;
  END IF;

  IF (SELECT count(*) FROM districts WHERE id IS NULL) > 0 THEN
    RAISE EXCEPTION '[ROLLBACK_REFUSED] some districts rows have no identifier; something wrote them outside the trigger.';
  END IF;
END
$do$;

-- ---- 1. children back onto the code ----------------------------------------
-- 0005 keeps fk_<table>_district_code in place (the code reference is a backstop, not the thing
-- being replaced), so this rollback removes only the identifier foreign keys and restores the
-- primary key. The code constraints are added back only if they are genuinely absent, because
-- "ADD CONSTRAINT" on an existing name aborts the whole rollback.
ALTER TABLE parcels            DROP CONSTRAINT IF EXISTS fk_parcels_district_id;
ALTER TABLE land_documents     DROP CONSTRAINT IF EXISTS fk_land_documents_district_id;
ALTER TABLE users              DROP CONSTRAINT IF EXISTS fk_users_district_id;
ALTER TABLE user_jurisdictions DROP CONSTRAINT IF EXISTS fk_user_jurisdictions_district_id;

ALTER TABLE districts DROP CONSTRAINT IF EXISTS districts_id_pkey;
-- ux_districts_code is deliberately KEPT. The four fk_<table>_district_code constraints reference
-- it, so dropping it fails with "other objects depend on it" (measured), and dropping those four
-- to remove a redundant constraint would weaken the very backstop 0005 preserved. After the
-- primary key returns to code it is one of two equivalent constraints on the same column —
-- redundant, and in the safe direction.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'districts_pkey' AND conrelid = 'districts'::regclass) THEN
    ALTER TABLE districts ADD CONSTRAINT districts_pkey PRIMARY KEY (code);
  END IF;
END
$do$;

DO $do$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
      ('parcels','fk_parcels_district_code'),
      ('land_documents','fk_land_documents_district_code'),
      ('users','fk_users_district_code'),
      ('user_jurisdictions','fk_user_jurisdictions_district_code')
  ) AS p(tbl, cname) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = pair.cname AND c.conrelid = pair.tbl::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (district_code) REFERENCES districts(code)',
                     pair.tbl, pair.cname);
    END IF;
  END LOOP;
END
$do$;

-- ---- 2. undo the owner mappings this file applied ---------------------------
-- The state codes and retirements are decisions, so undoing the migration that recorded them
-- must say so out loud rather than quietly delete the evidence of a decision.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM districts WHERE state_code IS NOT NULL) THEN
    RAISE NOTICE '[rollback-0005] clearing state_code on % district(s) that 0005 set from the owner''s demo mapping',
      (SELECT count(*) FROM districts WHERE state_code = 'RJ');
  END IF;
END
$do$;
UPDATE districts SET state_code = NULL, retired_at = NULL, is_active = true, kind = 'test_fixture'
 WHERE code LIKE 'probe %' AND kind = 'retired';
UPDATE districts SET state_code = NULL WHERE kind = 'canonical' AND code IN ('ajmer','jaipur','jodhpur','udaipur');

-- ---- 3. restore migration 0003's trigger unchanged --------------------------
CREATE OR REPLACE FUNCTION dharohar_sync_district_code() RETURNS trigger AS $fn$
DECLARE
    raw          TEXT := btrim(coalesce(NEW.district, ''));
    key          TEXT;
    active       BOOLEAN;
    code_written BOOLEAN := (TG_OP = 'INSERT' AND NEW.district_code IS NOT NULL)
                            OR (TG_OP = 'UPDATE' AND NEW.district_code IS DISTINCT FROM OLD.district_code);
BEGIN
    IF TG_OP = 'UPDATE' AND raw = btrim(coalesce(OLD.district, '')) AND NOT code_written THEN
        RETURN NEW;
    END IF;

    IF raw = '' THEN
        IF code_written THEN
            RAISE EXCEPTION 'DISTRICT_CODE_CONFLICT: % carries district_code % but no district text to resolve it from',
                TG_TABLE_NAME, quote_literal(NEW.district_code)
                USING HINT = 'Leave district_code NULL and let the trigger derive it from the district text, '
                          || 'or supply the district text the code is supposed to stand for. A key with no '
                          || 'jurisdiction behind it is an authorization hole, not a shortcut.';
        END IF;
        NEW.district_code := NULL;
        RETURN NEW;
    END IF;

    key := lower(raw);
    SELECT is_active INTO active FROM districts WHERE code = key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'DISTRICT_NOT_REGISTERED: % matches no row in districts (looked up code %)',
            quote_literal(NEW.district), quote_literal(key)
            USING HINT = 'Register it first: INSERT INTO districts (code, name, provenance) VALUES ('
                         || quote_literal(key) || ', ' || quote_literal(NEW.district) || ', ''declared''). '
                         || 'This server will not invent a jurisdiction for a land record.';
    END IF;

    IF NOT active THEN
        RAISE EXCEPTION 'DISTRICT_NOT_REGISTERED: % is registered but inactive, so nothing new may be filed under it',
            quote_literal(NEW.district)
            USING HINT = 'Re-activate districts where code = ' || quote_literal(key)
                      || ', or file the record under an active district.';
    END IF;

    IF code_written THEN
        RAISE EXCEPTION 'DISTRICT_CODE_CONFLICT: % names district_code % while its district text resolves to %',
            TG_TABLE_NAME, quote_literal(NEW.district_code), quote_literal(key)
            USING HINT = 'The caller must not pick a jurisdiction key that disagrees with the jurisdiction it '
                      || 'writes. Either is right, both together is a record that two layers would read differently.';
    END IF;

    NEW.district_code := key;
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

COMMIT;

-- After this, districts(id) and the four district_id columns still exist (0004's work) but are
-- no longer authoritative, and the primary key is back on code. To remove them entirely, run
-- rollback-0004.sql afterwards.
