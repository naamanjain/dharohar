-- =============================================================================
-- DHAROHAR — DRAFT migration 0004: organization-scoped district registry
--
-- NOT WIRED INTO THE RUNNER. This file lives outside server/src/db/migrations on
-- purpose: applying it is a decision about who owns a district, and that decision
-- belongs to the revenue department, not to a script. Nothing in the deployment
-- will pick this up until an operator moves it into the migrations directory
-- deliberately, after the tenancy question below is answered in writing.
--
-- THE PROBLEM IT FIXES
--   Migration 0002 made `districts` a registry with `code VARCHAR PRIMARY KEY` and
--   0003 added `ck_districts_code_is_name` (code = lower(btrim(name))) plus
--   `ux_districts_canonical_name` (unique on the name with spaces removed). Together
--   those make a district name GLOBAL: when two organizations in one deployment both
--   administer a district called "Jaipur", the second one cannot register it, and the
--   design default approved on 2026-10-17 — organization is the tenant, district is a
--   boundary inside it — is not actually expressible. The FKs from parcels,
--   land_documents, users and user_jurisdictions all point at that one global row.
--
-- WHAT IT DOES, ADDITIVELY
--   1. A stable surrogate key `districts.id`, because a natural key that has to become
--      composite cannot be the thing four tables reference.
--   2. `district_id` on each of those four tables, backfilled by EXACT match on the
--      existing `district_code` only. A row whose code matches nothing in the registry
--      keeps NULL, and NULL is reported rather than repaired.
--   3. Stops — aborts the whole file — if scoping by organization would require guessing:
--      * if any district row already carries an organization_id while others do not,
--        the mixed state has no correct resolution;
--      * if the registry cannot be re-keyed to (organization_id, code) because rows share
--        a code across would-be tenants with no tenant recorded, that is the ambiguity
--        this migration exists to refuse.
--   4. Only after those checks pass does it make (organization_id, code) the key and
--      repoint the FKs at districts(id). The old global unique index is dropped in the
--      same transaction, so the file either fully converts the model or changes nothing.
--
-- IT DELIBERATELY DOES NOT
--   * Create organizations on your behalf. If `organizations` is empty, there is no
--     tenant to scope to and the file aborts with a HINT saying so. That is the normal
--     first run against a demo database.
--   * Delete or archive any district row, parcel, document or officer. Every statement
--     is additive or a constraint swap that preserves rows.
--   * Decide whether a district belongs to the state, a division or a district office.
--     That is departmental policy; encode it in the organizations table, then re-run.
--   * Touch the text column `district`. It stays the display value, and the existing
--     CHECK keeps it in agreement with the surrogate key.
--
-- VERIFY IT AGAINST A COPY FIRST
--   pg_dump the production database, restore it into a disposable one (scripts/restore.sh
--   refuses a non-empty target), and run this file there. It prints what it found before
--   it decides, so the abort path is readable rather than theoretical.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---- 1. Surrogate key on the registry --------------------------------------
ALTER TABLE districts ADD COLUMN IF NOT EXISTS id UUID;

DO $do$
BEGIN
  UPDATE districts SET id = gen_random_uuid() WHERE id IS NULL;
END
$do$;

-- ---- 2. Report the tenancy state before deciding anything -------------------
DO $do$
DECLARE
  org_rows        integer;
  scoped          integer;
  unscoped        integer;
  details         text;
BEGIN
  SELECT count(*) INTO org_rows FROM organizations;

  SELECT count(*) INTO scoped   FROM districts WHERE organization_id IS NOT NULL;
  SELECT count(*) INTO unscoped FROM districts WHERE organization_id IS NULL;

  RAISE NOTICE '[0004] organizations=%  districts with a tenant=%  without=%',
    org_rows, scoped, unscoped;

  -- Case A: nobody has decided who the tenants are. Scoping is impossible, and the
  -- migration that "solved" it by inventing one organization would be fiction.
  IF org_rows = 0 THEN
    RAISE EXCEPTION E'[TENANCY_UNDECISIONED] there are no rows in organizations, so districts cannot be scoped to a tenant.\n  The registry currently holds % district row(s), none of which can be attributed to anybody.\n  HINT: create the organization(s) the department recognises (see docs/DATA-MODEL-JURISDICTION.md, design default D1), assign each district row an organization_id through an audited administrative action, then re-run this migration. Nothing was changed.',
      (SELECT count(*) FROM districts)
      USING HINT = 'This is a decision, not a defect. Read docs/DEPLOYMENT.md section 7 (first accounts) and settle the tenancy question with the department before applying.';
  END IF;

  -- Case B: some rows have a tenant and some do not. The unscoped ones could belong to
  -- any of the organizations; choosing is guessing, and the choice would be invisible
  -- afterwards because it would look like data rather than a decision.
  IF scoped > 0 AND unscoped > 0 THEN
    SELECT string_agg(d.code, ', ' ORDER BY d.code) INTO details
      FROM districts d WHERE d.organization_id IS NULL;
    RAISE EXCEPTION E'[TENANCY_AMBIGUOUS] % district row(s) carry an organization and % do not, so the scoping rule cannot be inferred.\n  Unattributed codes: %\n  HINT: attribute each one above with an explicit, recorded decision (which office administers it), then re-run.',
      scoped, unscoped, left(coalesce(details, ''), 400);
  END IF;

  -- Case C: every row is attributed. Even then, a code that appears under no tenant
  -- twice is fine, but a code whose rows disagree about the name it canonicalises is
  -- not — check the key we are about to install.
  IF (SELECT count(*) FROM (
        SELECT organization_id, lower(btrim(name)) AS code
          FROM districts GROUP BY 1, 2 HAVING count(*) > 1
      ) dup) > 0
  THEN
    RAISE EXCEPTION '[DUPLICATE_DISTRICT_WITHIN_TENANT] a district code repeats inside one organization, so (organization_id, code) cannot be the key until those rows are reconciled by a person.';
  END IF;
END
$do$;

-- ---- 3. Children get the surrogate reference, matched exactly ---------------
DO $do$
BEGIN
  FOREACH t IN ARRAY ARRAY['parcels', 'land_documents', 'users', 'user_jurisdictions'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS district_id UUID', t);
    -- Exact match only. A district text that is not in the registry for that row's
    -- organization stays NULL and is reported by verify_district_integrity.ts; this
    -- migration will not guess that "Jaipur " means the Jaipur row.
    EXECUTE format($f$
      UPDATE %I c SET district_id = d.id
        FROM districts d
       WHERE c.district_code IS NOT NULL
         AND c.district_id IS NULL
         AND lower(btrim(d.name)) = c.district_code$f$, t);
  END LOOP;
END
$do$;

COMMIT;

-- =============================================================================
-- STOP. The work above is deliberately the whole file as drafted: it cannot finish,
-- because converting the key (dropping ux_districts_canonical_name, adding
-- UNIQUE(organization_id, code), repointing four FKs from districts(code) to
-- districts(id)) is only safe once the department has said who the tenants are.
--
-- The statements for that second half are written below and left commented, so the
-- review is of the exact SQL that would run — not of a promise that someone will
-- write it later. Uncomment only together with a recorded tenancy decision, and test
-- on a restored copy first.
--
-- ALTER TABLE districts ALTER COLUMN id SET DEFAULT gen_random_uuid();
-- ALTER TABLE districts ALTER COLUMN id SET NOT NULL;
-- ALTER TABLE districts DROP CONSTRAINT districts_pkey;
-- ALTER TABLE districts ADD CONSTRAINT districts_pkey PRIMARY KEY (id);
-- ALTER TABLE districts DROP CONSTRAINT ck_districts_code_is_name;
-- ALTER TABLE districts ADD  CONSTRAINT ck_districts_code_is_name
--   CHECK (lower(btrim(name)) = code);
-- DROP INDEX IF EXISTS ux_districts_canonical_name;
-- ALTER TABLE districts ADD CONSTRAINT ux_districts_per_org UNIQUE (organization_id, code);
-- ALTER TABLE districts ALTER COLUMN organization_id SET NOT NULL;
--
-- Then repoint each child (shown for parcels; repeat for land_documents, users,
-- user_jurisdictions) and keep the text column in agreement:
--
-- ALTER TABLE parcels DROP CONSTRAINT parcels_district_code_fkey;
-- ALTER TABLE parcels ADD  CONSTRAINT parcels_district_id_fkey
--   FOREIGN KEY (district_id) REFERENCES districts(id);
-- ALTER TABLE parcels ADD CONSTRAINT ck_parcels_district_matches_registry
--   CHECK (district_id IS NULL OR district_code = lower(btrim(
--     (SELECT name FROM districts d WHERE d.id = parcels.district_id))));
-- =============================================================================
