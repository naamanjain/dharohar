-- DHAROHAR — Migration 0003 — Stable district identifiers and enforced district references
--
-- Adds a surrogate jurisdiction key that survives a rename or a retyped spelling, backfills it only
-- where the existing text resolves unambiguously, and pins every jurisdiction reference to it.
-- Implements D2 (jurisdiction is server-side truth, never a client-supplied free-text value) and
-- P0's requirement to "introduce stable district identifiers and enforce valid district references
-- with foreign keys".
--
-- ADDITIVE ONLY. Creates a function, adds nullable columns, backfills from the registry, adds
-- FK/CHECK constraints and write-time triggers. It drops nothing, renames nothing, truncates nothing.
--
-- ── Why this exists at all ──────────────────────────────────────────────────────────────────────
-- Every jurisdiction decision in this application has been made by comparing a free-text district
-- string. "Jaipur", "JAIPUR " and "jaipur" are the same place to the comparison helpers, but
-- "Jodhpur " that someone retyped is silently a different jurisdiction: the officer loses records
-- and nobody is told. `districts.code` was created in 0002; until now nothing else referenced it, so
-- the registry could not protect anything. Verified against the live schema: foreign keys existed on
-- land_documents.parcel_id, parcel_owners.parcel_id, user_jurisdictions.user_id and both
-- organization_id columns — and on no district column at all.
--
-- ── Why unresolved rows stay NULL ───────────────────────────────────────────────────────────────
-- The backfill writes a code ONLY where the stored text names exactly one registry row. A parcel in
-- "Fakepur", which the registry has never heard of, gets NULL — not a guess, not the nearest match,
-- not the uploader's district. `verify_district_integrity.ts` reports those rows; only the revenue
-- department can say what they should be. NULL therefore has exactly one meaning in this schema:
-- *this jurisdiction value has not been resolved against the registry*. It never means "no district".

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Make the registry itself unambiguous before pinning anything to it.
--    Stops rather than choosing: two rows that normalize to one jurisdiction cannot be merged by
--    software, because deciding which spelling the department uses is the decision.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    groups   INTEGER;
    details  TEXT;
    broken   INTEGER;
BEGIN
    SELECT count(*) INTO groups
      FROM (SELECT 1 FROM districts GROUP BY lower(translate(name, ' ', '')) HAVING count(*) > 1) x;

    IF groups > 0 THEN
        SELECT string_agg('  ' || n || ' -> ' || which, E'\n') INTO details
          FROM (
            SELECT lower(translate(name, ' ', '')) AS n,
                   string_agg(code || ' = ' || quote_literal(name), ' | ' ORDER BY code) AS which
              FROM districts
             GROUP BY lower(translate(name, ' ', ''))
            HAVING count(*) > 1
          ) y;

        RAISE EXCEPTION
            E'the district registry has % group(s) of spellings that normalize to one jurisdiction:\n%', groups, details
            USING HINT = 'Nothing was changed — this transaction is rolling back. Run "npm run test:integrity" to list '
                         'every affected row, have the revenue department decide which spelling IS the district and '
                         'which rows are duplicates, merge or rename the districts rows, then re-run "npm run db:migrate". '
                         'This migration will not pick a district on the department''s behalf.';
    END IF;

    -- code must be the canonical form of name, so a lookup by either has one answer and the child
    -- CHECK below can be a plain comparison instead of a subquery.
    SELECT count(*) INTO broken FROM districts WHERE code <> lower(btrim(name));
    IF broken > 0 THEN
        SELECT string_agg('  ' || quote_literal(code) || ' vs name ' || quote_literal(name), E'\n') INTO details
          FROM (SELECT code, name FROM districts WHERE code <> lower(btrim(name)) LIMIT 10) bad;

        RAISE EXCEPTION E'% district(s) whose code is not the canonical lower-case form of their name:\n%', broken, details
            USING HINT = 'Nothing was changed — this transaction is rolling back. The application compares jurisdictions '
                         'by this key on every request, so a mismatch is an authorization defect, not a formatting one. '
                         'Repair the registry (code = lower(trim(name))) and re-run "npm run db:migrate".';
    END IF;
END $$;

ALTER TABLE districts DROP CONSTRAINT IF EXISTS ck_districts_code_is_name;
ALTER TABLE districts ADD  CONSTRAINT ck_districts_code_is_name CHECK (code = lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS ux_districts_canonical_name ON districts (lower(translate(name, ' ', '')));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The stable identifier columns. Nullable everywhere: data that predates this migration is
--    allowed to stay unresolved rather than have a jurisdiction invented for it.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE parcels            ADD COLUMN IF NOT EXISTS district_code   VARCHAR(128);
ALTER TABLE land_documents     ADD COLUMN IF NOT EXISTS district_code   VARCHAR(128);
ALTER TABLE users              ADD COLUMN IF NOT EXISTS district_code   VARCHAR(128);
ALTER TABLE user_jurisdictions ADD COLUMN IF NOT EXISTS district_code   VARCHAR(128);
-- A parcel's tenant, so cross-organization reads become provable once organizations are declared.
-- Deliberately NOT backfilled: no organization exists yet, and choosing one is a policy decision.
ALTER TABLE parcels            ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill: exact registry matches only. No fuzzy, no nearest, no fallback to the uploader.
--    Inactive registry rows count here — a historical record naming a district that was later
--    retired still resolves to that district. New writes require an ACTIVE one (section 6).
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE parcels p
   SET district_code = d.code
  FROM districts d
 WHERE p.district_code IS NULL
   AND p.district IS NOT NULL
   AND lower(btrim(p.district)) = d.code;

UPDATE land_documents l
   SET district_code = d.code
  FROM districts d
 WHERE l.district_code IS NULL
   AND l.district IS NOT NULL
   AND lower(btrim(l.district)) = d.code;

UPDATE users u
   SET district_code = d.code
  FROM districts d
 WHERE u.district_code IS NULL
   AND u.district IS NOT NULL
   AND lower(btrim(u.district)) = d.code;

UPDATE user_jurisdictions j
   SET district_code = d.code
  FROM districts d
 WHERE j.district_code IS NULL
   AND j.district IS NOT NULL
   AND lower(btrim(j.district)) = d.code;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Foreign keys: a resolved jurisdiction must be a registered district. NULL passes, which is what
--    keeps this migration from destroying or inventing anything.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE parcels            DROP CONSTRAINT IF EXISTS fk_parcels_district_code;
ALTER TABLE parcels            ADD  CONSTRAINT fk_parcels_district_code
                                 FOREIGN KEY (district_code) REFERENCES districts(code);
ALTER TABLE land_documents     DROP CONSTRAINT IF EXISTS fk_land_documents_district_code;
ALTER TABLE land_documents     ADD  CONSTRAINT fk_land_documents_district_code
                                 FOREIGN KEY (district_code) REFERENCES districts(code);
ALTER TABLE users              DROP CONSTRAINT IF EXISTS fk_users_district_code;
ALTER TABLE users              ADD  CONSTRAINT fk_users_district_code
                                 FOREIGN KEY (district_code) REFERENCES districts(code);
ALTER TABLE user_jurisdictions DROP CONSTRAINT IF EXISTS fk_user_jurisdictions_district_code;
ALTER TABLE user_jurisdictions ADD  CONSTRAINT fk_user_jurisdictions_district_code
                                 FOREIGN KEY (district_code) REFERENCES districts(code);
ALTER TABLE parcels            DROP CONSTRAINT IF EXISTS fk_parcels_organization_id;
ALTER TABLE parcels            ADD  CONSTRAINT fk_parcels_organization_id
                                 FOREIGN KEY (organization_id) REFERENCES organizations(id);

-- PostgreSQL does not index the referencing side of an FK on its own, and the scoped queries in
-- server/src/services/jurisdiction.ts filter on this column for every request.
CREATE INDEX IF NOT EXISTS idx_parcels_district_code            ON parcels (district_code);
CREATE INDEX IF NOT EXISTS idx_land_documents_district_code     ON land_documents (district_code);
CREATE INDEX IF NOT EXISTS idx_users_district_code              ON users (district_code);
CREATE INDEX IF NOT EXISTS idx_user_jurisdictions_district_code ON user_jurisdictions (district_code);
CREATE INDEX IF NOT EXISTS idx_parcels_organization_id          ON parcels (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Text and key must never disagree, so a reader cannot be shown one jurisdiction while the
--    authorization layer scopes another.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE parcels            DROP CONSTRAINT IF EXISTS ck_parcels_district_code_matches;
ALTER TABLE parcels            ADD  CONSTRAINT ck_parcels_district_code_matches
                                 CHECK (district_code IS NULL OR district_code = lower(btrim(district)));
ALTER TABLE land_documents     DROP CONSTRAINT IF EXISTS ck_land_documents_district_code_matches;
ALTER TABLE land_documents     ADD  CONSTRAINT ck_land_documents_district_code_matches
                                 CHECK (district_code IS NULL OR district_code = lower(btrim(district)));
ALTER TABLE users              DROP CONSTRAINT IF EXISTS ck_users_district_code_matches;
ALTER TABLE users              ADD  CONSTRAINT ck_users_district_code_matches
                                 CHECK (district_code IS NULL OR district_code = lower(btrim(district)));
ALTER TABLE user_jurisdictions DROP CONSTRAINT IF EXISTS ck_user_jurisdictions_district_code_matches;
ALTER TABLE user_jurisdictions ADD  CONSTRAINT ck_user_jurisdictions_district_code_matches
                                 CHECK (district_code IS NULL OR district_code = lower(btrim(district)));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Write-time enforcement.
--
-- A foreign key alone is not enough: it accepts NULL, so a typo'd district would be stored with
-- district_code NULL and surface only later, in a report. This trigger closes that gap for NEW
-- writes while leaving history alone:
--   * INSERT, or UPDATE that actually changes the district text: the value must match exactly one
--     ACTIVE registry row, and the code is written for the caller — so a call site can no longer
--     forget to set it, which is the defect class this whole pass chases.
--   * An UPDATE that does not touch the district (sealing a record, correcting an owner) is not
--     re-validated, so one legacy invalid value can never lock a land record against unrelated work.
--   * Blank/NULL district is stored with a NULL code and reported by the checker. Refusing blank
--     outright is a draft-workflow policy decision, not a data-integrity one.
--   * A caller that supplies a district_code disagreeing with its own district text is REFUSED. The
--     first version of this trigger overwrote whatever the caller passed, which silently tolerated a
--     caller that had picked the wrong jurisdiction — the trigger writes the code, so a supplied one
--     is either redundant or a bug, and a bug deserves an error rather than a quiet correction.
-- It raises instead of guessing, and names the value and what to do about it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dharohar_sync_district_code() RETURNS trigger AS $fn$
DECLARE
    raw          TEXT := btrim(coalesce(NEW.district, ''));
    key          TEXT;
    active       BOOLEAN;
    -- On UPDATE OF district, NEW.district_code still holds the OLD value, so "a code was supplied"
    -- cannot mean merely "it is not null" — that reading turns every ordinary district change into a
    -- phantom conflict. Only a caller that writes the key itself is being contradicted.
    code_written BOOLEAN := (TG_OP = 'INSERT' AND NEW.district_code IS NOT NULL)
                            OR (TG_OP = 'UPDATE' AND NEW.district_code IS DISTINCT FROM OLD.district_code);
BEGIN
    IF TG_OP = 'UPDATE' AND raw = btrim(coalesce(OLD.district, '')) AND NOT code_written THEN
        RETURN NEW;                        -- jurisdiction not being changed: leave the row alone
    END IF;

    IF raw = '' THEN
        IF code_written THEN
            RAISE EXCEPTION 'DISTRICT_CODE_CONFLICT: % carries district_code % but no district text to resolve it from',
                TG_TABLE_NAME, quote_literal(NEW.district_code)
                USING HINT = 'Leave district_code NULL and let the trigger derive it from the district text, '
                          || 'or supply the district text the code is supposed to stand for. A key with no '
                          || 'jurisdiction behind it is an authorization hole, not a shortcut.';
        END IF;
        NEW.district_code := NULL;         -- unresolved, not absent; the integrity checker reports it
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

DROP TRIGGER IF EXISTS trg_parcels_district_code            ON parcels;
CREATE TRIGGER trg_parcels_district_code
    BEFORE INSERT OR UPDATE OF district ON parcels
    FOR EACH ROW EXECUTE FUNCTION dharohar_sync_district_code();

DROP TRIGGER IF EXISTS trg_land_documents_district_code     ON land_documents;
CREATE TRIGGER trg_land_documents_district_code
    BEFORE INSERT OR UPDATE OF district ON land_documents
    FOR EACH ROW EXECUTE FUNCTION dharohar_sync_district_code();

DROP TRIGGER IF EXISTS trg_users_district_code              ON users;
CREATE TRIGGER trg_users_district_code
    BEFORE INSERT OR UPDATE OF district ON users
    FOR EACH ROW EXECUTE FUNCTION dharohar_sync_district_code();

DROP TRIGGER IF EXISTS trg_user_jurisdictions_district_code ON user_jurisdictions;
CREATE TRIGGER trg_user_jurisdictions_district_code
    BEFORE INSERT OR UPDATE OF district ON user_jurisdictions
    FOR EACH ROW EXECUTE FUNCTION dharohar_sync_district_code();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. What this migration deliberately does NOT do.
--
--  * No foreign key on parcels.document_id. A parcel can still name a document that is gone; adding
--    the constraint now would fail on any database that already contains such a row, and the fix for
--    an existing offender is a decision about the document, not a constraint. The checker lists them.
--  * No district is assigned to any record, no organization is backfilled, no duplicate spelling is
--    merged. Those need the revenue department — see docs/DATA-MODEL-JURISDICTION.md §4.
--  * The application keeps comparing the district TEXT (server/src/services/jurisdiction.ts). Since
--    section 5 guarantees code = lower(trim(text)), switching the scope clauses to the code column is
--    now a free performance change rather than a semantic one, and it belongs with the RLS work that
--    must be tested query by query.
-- ─────────────────────────────────────────────────────────────────────────────
