-- =============================================================================
-- DHAROHAR — rollback of migration 0007 (declaration workflow)
--
-- Restores the pre-0007 domain and default: no 'candidate' value, and a new declaration is canonical
-- again. It refuses while any candidate district exists, because the old CHECK would reject those rows
-- and PostgreSQL's error would look like a broken constraint rather than like the decision it is.
--
--   psql -v ON_ERROR_STOP=1 -f server/src/db-draft/rollback-0007.sql
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DO $do$
DECLARE
  pending text;
  n       integer;
BEGIN
  SELECT count(*) INTO n FROM districts WHERE kind = 'candidate';
  IF n > 0 THEN
    SELECT string_agg(code, ', ' ORDER BY code) INTO pending
      FROM (SELECT code FROM districts WHERE kind = 'candidate' ORDER BY code LIMIT 12) s;
    RAISE EXCEPTION E'[ROLLBACK_REFUSED] % district(s) are still candidate geography: %\n  Nothing was changed. Resolve each one first — promote it with a reason, retire it, or let it stand as a fixture — because removing the value from the domain would fail on those rows and the database would report a constraint, not the decision that is missing.', n, coalesce(pending, '?')
      USING HINT = 'More than 12 may be listed by: SELECT code FROM districts WHERE kind = ''candidate'' ORDER BY code.';
  END IF;
END
$do$;

DROP INDEX IF EXISTS idx_districts_candidate;

ALTER TABLE districts DROP CONSTRAINT ck_districts_kind_domain;
-- The name 0004 created, restored verbatim, so a database rolled back to before 0007 is
-- indistinguishable from one that never had 0007.
ALTER TABLE districts
  ADD CONSTRAINT districts_kind_check
  CHECK (kind IN ('canonical', 'test_fixture', 'retired'));

ALTER TABLE districts ALTER COLUMN kind SET DEFAULT 'canonical';

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT kind, count(*)::int AS rows_ FROM districts GROUP BY kind ORDER BY kind LOOP
    RAISE NOTICE '[rollback-0007] kind %: % row(s)', r.kind, r.rows_;
  END LOOP;
  RAISE NOTICE '[rollback-0007] default for a new declaration restored to canonical';
END
$do$;

COMMIT;
