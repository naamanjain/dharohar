#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — the chain certifier must be able to refuse
#
# verifyAuditChain() walks the entries it is handed. A caller that cannot see the ledger is handed
# nothing, and nothing has no broken links — so an unguarded validator reports a healthy chain from an
# empty read. This project has already paid for the mirror image of that bug once: an integrity check
# run as an RLS-blind identity invented 41 findings that did not exist.
#
# So this script does not check "the chain is intact". It checks that the certifier says NO when it
# cannot see the chain, by building a disposable database, giving a real (non-exempt) role a real
# policy that filters the audit table to zero rows, and running the actual command against it.
#
#   ./scripts/test-rls-blind-certifier.sh
#
# Exit: 0 the certifier refused as designed, 1 it certified something it could not see, 2 environment.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

SCRATCH=dharohar-audit-pg
DB="rlsproof_$$"
FAILED=0

say() { [ -n "${1:-}" ] && echo "  $1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; else echo "  FAIL  $1 (want $2, got $3)"; FAILED=$((FAILED+1)); fi; }
q()   { docker exec -i $SCRATCH psql -U postgres -d "$DB" -tA -c "$1" 2>&1 | tail -1; }

cleanup() {
  docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB'" >/dev/null 2>&1
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DB" >/dev/null 2>&1
  say "dropped $DB"
}
trap cleanup EXIT

[ -n "${DEMO_PASSWORD:-}" ] || true
SPW="$(docker exec $SCRATCH printenv POSTGRES_PASSWORD 2>/dev/null)" || { say "ABORT: $SCRATCH is not running."; exit 2; }
DUMP="$(ls -t backups/*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { say "ABORT: no dump to restore a disposable database from."; exit 2; }

echo "== a disposable copy, one real role, one restrictive policy =="
docker exec $SCRATCH psql -U postgres -q -c "create database $DB" >/dev/null 2>&1
docker cp "$DUMP" $SCRATCH:/tmp/proof.dump >/dev/null 2>&1
docker exec $SCRATCH pg_restore -U postgres -d "$DB" --no-owner --no-privileges /tmp/proof.dump >/dev/null 2>&1
# A password generated here, used only for this throwaway role on a throwaway database, and never
# printed. Nothing in this file, its output, or git sees it.
APP_PW="$(openssl rand -hex 16)"
docker cp scripts/roles.sql $SCRATCH:/tmp/roles.sql >/dev/null 2>&1
docker exec -i $SCRATCH psql -U postgres -d "$DB" --no-psqlrc -q -v ON_ERROR_STOP=1 \
  -v app_password="$APP_PW" -f /tmp/roles.sql >/dev/null 2>&1
chk "the least-privilege runtime role exists in this copy" "t" "$(q "select rolname='dharohar_app' from pg_roles where rolname='dharohar_app'")"
chk "and it is not exempt from row-level security" "f" "$(q "select rolbypassrls from pg_roles where rolname='dharohar_app'")"

OWNER_ROWS="$(q "select count(*) from append_only_audit_logs")"
say "  entries the owner can see: $OWNER_ROWS"
[ "${OWNER_ROWS:-0}" -gt 0 ] || { say "ABORT: the restored copy has no audit entries, so the refusal would prove nothing."; exit 2; }

docker exec -i $SCRATCH psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'POLICY'
alter table append_only_audit_logs enable row level security;
create policy tenant_only_audit on append_only_audit_logs
  for select to dharohar_app using (false);
POLICY
chk "a policy that filters the audit table was installed" "1" "$(q "select count(*) from pg_policies where tablename='append_only_audit_logs'")"

HIDDEN="$(docker exec -i -e PGPASSWORD="$APP_PW" $SCRATCH psql -U dharohar_app -d "$DB" -tA -c "select count(*) from append_only_audit_logs" 2>&1 | tail -1)"
chk "premise: that role really can see zero of those entries" "0" "$HIDDEN"

echo ""
echo "== run the certifier as the identity that cannot see the chain =="
out=$(DATABASE_URL="postgresql://dharohar_app:$APP_PW@127.0.0.1:55432/$DB" timeout 200 npx tsx server/src/verify_audit_chain.ts 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOT CERTIFIED|verdict|entries visible|coverage|identity' | head -5 | sed 's/^/    /')"
chk "it exits 2 rather than reporting health" "2" "$rc"
NOCERT="$(echo "$out" | grep -c 'NOT CERTIFIED')"
PARTIAL="$(echo "$out" | grep -c 'are not visible to')"
INTACT="$(echo "$out" | grep -c 'INTACT')"
chk "it says NOT CERTIFIED" "1" "$([ "$NOCERT" -ge 1 ] && echo 1 || echo 0)"
chk "and explains which entries its view was missing" "1" "$([ "$PARTIAL" -ge 1 ] && echo 1 || echo 0)"
chk "and it never prints a verdict of INTACT" "0" "$INTACT"

echo ""
echo "== control: the exempt identity still certifies the same ledger =="
out=$(DATABASE_URL="postgres://postgres:$SPW@127.0.0.1:55432/$DB" timeout 200 npx tsx server/src/verify_audit_chain.ts 2>&1); rc=$?
say "$(echo "$out" | grep -E 'verdict|entries walked|verified as' | head -3 | sed 's/^/    /')"
chk "it exits 0 for an identity that sees everything" "0" "$rc"
chk "and reports INTACT" "1" "$(echo "$out" | grep -c 'INTACT')"

echo ""
if [ $FAILED -eq 0 ]; then echo "=== RESULT: the certifier refuses a view it cannot certify ==="; exit 0; fi
echo "=== RESULT: $FAILED check(s) failed — a validator that reports health from a blind read is the worst kind of green ==="
exit 1
