-- =============================================================================
-- DHAROHAR — rollback of migration 0008 (audit actor attribution)
--
-- Drops only the two attribution columns. It touches no audit row and cannot: this role and this file
-- have no UPDATE or DELETE path on append_only_audit_logs, and the append-only trigger would refuse it
-- anyway. Entries written while 0008 was applied lose their actor columns and fall back to the
-- record/entity/name matchers in getAuditLogs — the history is not hidden by rolling this back.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

DO $do$
DECLARE
  attributed integer;
BEGIN
  SELECT count(*) INTO attributed FROM append_only_audit_logs WHERE actor_organization_id IS NOT NULL;
  IF attributed > 0 THEN
    RAISE NOTICE '[rollback-0008] % entry(ies) carry an actor attribution that this rollback removes. They stay readable through the fallback matchers; nothing is deleted.', attributed;
  END IF;
END
$do$;

DROP INDEX IF EXISTS idx_audit_actor_org;
DROP INDEX IF EXISTS idx_audit_actor_user;
ALTER TABLE append_only_audit_logs DROP COLUMN IF EXISTS actor_user_id;
ALTER TABLE append_only_audit_logs DROP COLUMN IF EXISTS actor_organization_id;

DO $do$
BEGIN
  RAISE NOTICE '[rollback-0008] audit rows remaining: % (unchanged in content), entry hashes intact on %',
    (SELECT count(*) FROM append_only_audit_logs),
    (SELECT count(*) FROM append_only_audit_logs WHERE entry_hash IS NOT NULL);
END
$do$;

COMMIT;
