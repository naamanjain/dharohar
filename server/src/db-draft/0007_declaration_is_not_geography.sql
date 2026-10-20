-- =============================================================================
-- DHAROHAR — DRAFT migration 0007: a declaration is not canonical geography
--
-- WHAT THIS FIXES, MEASURED
--   `districts.kind` defaulted to 'canonical'. Every INSERT that did not name a kind — which is what
--   the declare endpoint does, and what the test suites do on every run — arrived as canonical
--   geography. That is how `probe 790279` got into the registry: migration 0005 found it classified
--   canonical and had to retire it under the owner's standing decision. The gate re-applies that
--   retirement on every run (validate-stack T13b), which is a cleanup, not a fix. The fix is the
--   default.
--
-- THE CHANGE
--   New districts land as 'candidate': registered, assignable to officers, workable by the tenant that
--   declared it, and NOT presented as canonical geography until somebody with USER_ADMIN promotes it
--   with a recorded reason. Existing rows are left exactly as they are — promoting or demoting a
--   district that is already in use is a decision about that district, and this file makes none.
--
--   'canonical' therefore stops being the absence of a decision and becomes one.
--
-- Ordering: this file assumes 0005 (identifier as primary key) and 0006 (tenant ownership) are
-- applied, and refuses to run if they are not, because a half-ordered registry is the state in which
-- a name can be canonical in one table and unowned in another.
--
-- Drill copy: psql -v ON_ERROR_STOP=1 -f this file. The runner copy is derived by
-- scripts/build-tenant-migration.mjs, which strips \set, BEGIN; and COMMIT; only.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ---- 1. Guard: the migrations this one is stated against ---------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'districts_id_pkey') THEN
    RAISE EXCEPTION E'[REQUIREMENT_MISSING] 0005 has not been applied: the district registry is still keyed by its name.\n  Nothing was changed. Changing what a declaration MEANS while the identifier is not yet authoritative would leave the two files describing different databases.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'parcels' AND column_name = 'organization_granted_by') THEN
    RAISE EXCEPTION E'[REQUIREMENT_MISSING] 0006 has not been applied: records still have no ownership model.\n  Nothing was changed.';
  END IF;

  -- 0004's anonymous CHECK is the object being replaced. Either that constraint or the one this file
  -- installs has to be present: the first means the domain is still 0004's, the second means 0007 was
  -- already applied and this run must be the no-op the runner promises. Anything else means something
  -- outside this migration series has touched the domain, and replacing it blind would hide that.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'districts'::regclass
                    AND conname IN ('districts_kind_check', 'ck_districts_kind_domain')) THEN
    RAISE EXCEPTION E'[REQUIREMENT_MISSING] neither districts_kind_check (0004) nor ck_districts_kind_domain (0007) constrains districts.kind, so the domain has been changed by something outside this migration series.\n  Nothing was changed: read what owns that constraint before adding a value to the domain.';
  END IF;
END
$do$;

-- ---- 2. Add 'candidate' to the domain, then make it the default --------------
-- Written as one guarded block, because a migration the runner may re-run has to leave the same
-- state it found when that state is already correct. The first version of this file dropped
-- districts_kind_check unconditionally, which made a second apply abort on its own guard — a
-- migration that cannot be re-run contradicts the property docs/DEPLOYMENT.md states.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'districts_kind_check') THEN
    EXECUTE 'ALTER TABLE districts DROP CONSTRAINT districts_kind_check';
    RAISE NOTICE '[0007] dropped 0004''s districts_kind_check';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_districts_kind_domain') THEN
    EXECUTE $q$ALTER TABLE districts
                 ADD CONSTRAINT ck_districts_kind_domain
                 CHECK (kind IN ('candidate', 'canonical', 'test_fixture', 'retired'))$q$;
    RAISE NOTICE '[0007] installed ck_districts_kind_domain (candidate | canonical | test_fixture | retired)';
  ELSE
    RAISE NOTICE '[0007] ck_districts_kind_domain already present — domain step is a no-op on re-run';
  END IF;

  ALTER TABLE districts ALTER COLUMN kind SET DEFAULT 'candidate';
END
$do$;

DO $do$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM districts WHERE kind = 'canonical';
  RAISE NOTICE '[0007] canonical districts unchanged by this file: % (only a promotion decision changes that)', n;
  SELECT count(*) INTO n FROM districts WHERE kind = 'retired';
  RAISE NOTICE '[0007] retired fixtures still retired: %', n;
  SELECT count(*) INTO n FROM districts WHERE kind = 'candidate';
  RAISE NOTICE '[0007] districts currently candidate: %', n;
END
$do$;

-- The review queue, so a pending declaration is something an administrator can list rather than
-- something they have to remember the spelling of. Promotion itself is recorded in the audit chain by
-- the endpoint that performs it; no second provenance vocabulary is invented here, because 0002's
-- districts_provenance_check already states how a row came to exist and this file does not change it.
CREATE INDEX IF NOT EXISTS idx_districts_candidate
  ON districts (code) WHERE kind = 'candidate';

-- ---- 3. Report --------------------------------------------------------------
DO $do$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '[0007] ===== post-state =====';
  FOR r IN SELECT kind, count(*)::int AS rows_ FROM districts GROUP BY kind ORDER BY kind LOOP
    RAISE NOTICE '[0007] kind %: % row(s)', r.kind, r.rows_;
  END LOOP;
  RAISE NOTICE '[0007] default for a new declaration: %',
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = 'districts' AND column_name = 'kind');
  RAISE NOTICE '[0007] ===== end =====';
END
$do$;

COMMIT;
