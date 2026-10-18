-- DHAROHAR — Migration 0002 — Organization tenancy, explicit jurisdiction assignments, capabilities
--
-- Implements the design defaults recorded in docs/DATA-MODEL-JURISDICTION.md §2 (D1, D2, D3).
-- ADDITIVE ONLY: creates tables, adds one nullable column, and backfills assignment rows from values
-- that already exist authoritatively in this database. It drops nothing, truncates nothing, rewrites
-- no existing column, and touches no land record.
--
-- The backfills below are DERIVATIONS, not invented ownership. `users.district` is the column the
-- application has been treating as an officer's jurisdiction, so promoting it to an assignment row
-- changes representation, not fact. Nothing here assigns a *parcel* to a district: parcel districts
-- stay exactly as they were, because the correct district for a real record can only come from the
-- revenue department (docs/DATA-MODEL-JURISDICTION.md §4.4).
--
-- Deny-by-default depends on the assignment tables being the authority; the application must stop
-- reading the single district string out of the JWT as its source of truth. That code change ships
-- with this migration, not after it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Organization / department tenant (D1)
--    District is a boundary INSIDE a tenant, so a future multi-district or departmental tenant does
--    not require re-keying anything. Nullable on users for now: a single-tenant deployment keeps
--    working with organization_id unset, and the value is assigned when an organization is created.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
    id          VARCHAR(64) PRIMARY KEY,
    name        VARCHAR(256) NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS districts (
    code            VARCHAR(128) PRIMARY KEY,   -- canonical lower-case key, compared TRIM/LOWER
    name            VARCHAR(256) NOT NULL,      -- display name as the department spells it
    organization_id VARCHAR(64) REFERENCES organizations(id),
    -- How this row came to exist. 'derived' = registered from a value already stored on real rows
    -- by this migration; 'declared' = added deliberately by an administrator.
    provenance      VARCHAR(32) NOT NULL DEFAULT 'declared'
                    CHECK (provenance IN ('derived', 'declared')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id VARCHAR(64) REFERENCES organizations(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Explicit jurisdiction assignments (D2)
--    One row per officer per district, with grantor and validity, so a grant can be revoked and take
--    effect on the next request instead of whenever the officer's token happens to expire.
--    Revoked rows are kept (revoked_at set) rather than deleted: they are the history of who was
--    authorized where.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_jurisdictions (
    user_id    VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    district   VARCHAR(128) NOT NULL,
    granted_by VARCHAR(128),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, district)
);

CREATE INDEX IF NOT EXISTS idx_user_jurisdictions_user ON user_jurisdictions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_jurisdictions_district ON user_jurisdictions(district);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Capabilities (D3, D4, D5)
--    Deliberately NOT roles: a capability is an explicit, individually granted, revocable and
--    auditable authority, and adding one never requires widening the CHECK constraint on
--    users.role. Administrative authority comes from a capability, so it can be granted and removed
--    without changing what kind of revenue officer someone is.
--
--      STATE_WIDE_READ  read across every district; grants NO mutation rights anywhere
--      USER_ADMIN       provision officers, assign roles / jurisdictions / capabilities
--      PARCEL_REHOME    move a record between districts (needs assignment over BOTH districts)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_capabilities (
    user_id    VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability VARCHAR(64) NOT NULL
               CHECK (capability IN ('STATE_WIDE_READ', 'USER_ADMIN', 'PARCEL_REHOME')),
    granted_by VARCHAR(128),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_user_capabilities_user ON user_capabilities(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Derive the jurisdiction registry and the officer assignments from existing data
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO districts (code, name, provenance)
SELECT LOWER(TRIM(d)), MAX(d), 'derived'
FROM (
    SELECT district AS d FROM users WHERE district IS NOT NULL AND BTRIM(district) <> ''
    UNION ALL
    SELECT district AS d FROM parcels WHERE district IS NOT NULL AND BTRIM(district) <> ''
) existing
GROUP BY LOWER(TRIM(d))
ON CONFLICT (code) DO NOTHING;

INSERT INTO user_jurisdictions (user_id, district, granted_by)
SELECT id, district, 'migration:0002_derived_from_users_district'
FROM users
WHERE district IS NOT NULL AND BTRIM(district) <> ''
ON CONFLICT (user_id, district) DO NOTHING;

-- A district-scoped AUDITOR is the intended steady state (D3), so no STATE_WIDE_READ is granted to
-- anybody by this migration — not even to the existing audit personas. A deployment grants it
-- explicitly, per person, once the provisioning path exists. Until then an auditor reads only their
-- own district, which is the stricter of the two behaviours and therefore safe to ship first.
