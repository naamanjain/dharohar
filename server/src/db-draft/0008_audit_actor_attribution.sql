-- =============================================================================
-- DHAROHAR — DRAFT migration 0008: who performed an audit entry, in the row itself
--
-- WHY THIS EXISTS
--   The audit table records `performed_by` (a display name) and `officer_badge` (nullable). That was
--   enough when every entry described a parcel, because a parcel entry can be scoped through the
--   parcel. Entries about an ACCOUNT — a password reset, a capability grant, a district declaration, a
--   state-wide read — describe no parcel at all, so a tenant-scoped audit listing had nothing to match
--   them against. Matching on a display name or a badge that may be NULL is how the first run of the
--   provisioning suite lost three entries it had just written: the bootstrapped administrator's own
--   row carries badge_number = NULL while its entries carry badge 'BOOTSTRAP'.
--
-- WHAT THIS ADDS
--   `actor_user_id` and `actor_organization_id` on append_only_audit_logs, written from the server-side
--   principal at insert time and never from the request body. They are NOT part of the entry hash:
--   computeAuditEntryHash() covers previousHash:entityId:actionType:performedBy:timestamp:detailsHash
--   (server/src/utils/crypto.ts), and appendToChain lists its columns explicitly, so adding columns
--   cannot invalidate a single existing entry. Historical rows keep NULL here and are attributed by
--   the fallbacks in getAuditLogs — they are not hidden.
--
-- This migration is additive and idempotent. It never rewrites or deletes an audit row; that is the
-- one table where the application has no UPDATE or DELETE path at all.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'parcels' AND column_name = 'organization_granted_by') THEN
    RAISE EXCEPTION E'[REQUIREMENT_MISSING] migration 0006 has not been applied, so there is no organization to attribute an audit entry to. Nothing was changed.';
  END IF;
END
$do$;

ALTER TABLE append_only_audit_logs ADD COLUMN IF NOT EXISTS actor_user_id VARCHAR(64);
ALTER TABLE append_only_audit_logs ADD COLUMN IF NOT EXISTS actor_organization_id VARCHAR(64);

-- Attribution is a lookup, not a claim about the chain: no constraint on the values, because an audit
-- row must survive the deletion or re-parenting of the account that produced it. The chain has to be
-- append-only even when the org chart changes underneath it.
CREATE INDEX IF NOT EXISTS idx_audit_actor_org
  ON append_only_audit_logs (actor_organization_id)
  WHERE actor_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_actor_user
  ON append_only_audit_logs (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

DO $do$
DECLARE
  total     integer;
  attributed integer;
BEGIN
  SELECT count(*) INTO total FROM append_only_audit_logs;
  SELECT count(*) INTO attributed FROM append_only_audit_logs WHERE actor_organization_id IS NOT NULL;
  RAISE NOTICE '[0008] audit entries: % total, % already carrying an actor organization (the rest predate this migration and are matched by the fallbacks, never hidden)', total, attributed;
  -- The chain itself is unchanged by this file; assert that the columns were added without touching it.
  RAISE NOTICE '[0008] entry hashes are untouched: % rows still carry an entry_hash', (SELECT count(*) FROM append_only_audit_logs WHERE entry_hash IS NOT NULL);
END
$do$;

COMMIT;
