#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — authorization suites against a disposable copy (the pre-RLS measurement)
#
# WHY THIS EXISTS
#   The provisioning suite needs a USER_ADMIN login and the tenancy suite needs to plant a second
#   organization and re-parent an officer. Neither belongs in the demo deployment: the demo database
#   is the only copy of the working data, and the bootstrapped administrator's password is not
#   recoverable by design — bootstrapAdmin refuses to run a second time precisely so it cannot be
#   used to reset a live password. So the suites run here, against a copy, with the API connected as
#   the least-privilege runtime role, which is also the only way to prove that role's grants are
#   actually sufficient for provisioning and re-homing.
#
#   The only statement this script sends to dharohar-prod-db-1 is a read-only pg_dump.
#
# USAGE
#   ./scripts/test-authorization-on-copy.sh
#
#   Exit: 0 every harness check passed, 1 a check failed, 2 the environment is missing something.
#   Expect a red run until organization scoping exists: test_tenancy_isolation_suite.ts asserts the
#   requirement (one tenant must not read another tenant's records in a shared district) and the
#   request path does not consult organizations at all yet. That failure is the finding.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

# Git Bash rewrites POSIX-looking arguments such as `-f /tmp/roles.sql` into a Windows temp path
# before docker ever sees them, and psql then reports "No such file or directory" for a file that
# exists inside the container. That failure looks exactly like a broken role setup.
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

SCRATCH=dharohar-audit-pg
NET=dharohar-prod_backend
COPY_DB="auth_copy_$$"
API_NAME=dharohar-auth-api
API_PORT=8099
APP_USER="${DHAROHAR_APP_USER:-dharohar_app}"
# Not /tmp: Git Bash writes /tmp to %LOCALAPPDATA%\Temp while native docker.exe resolves /tmp to
# C:\tmp, so `docker compose -f /tmp/...` fails with "the system cannot find the file specified"
# even though the file exists. A path relative to the repo is unambiguous for both. Defined here
# because the EXIT trap references it and an abort before it existed would be an unbound variable.
OVERRIDE_FILE=".auth-override.$$"
FAILED=0
CLEANED=0
CONNECTED=0

say() { [ -n "${1:-}" ] && echo "  $1"; }
note() { echo "  note  $1"; }
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; else echo "  FAIL  $1 (want $2, got $3)"; FAILED=$((FAILED+1)); fi
}

run_suite() { # run_suite <label> <script> — the suite prints its own counts; this records the exit
  local label="$1" script="$2" rc=0
  echo ""
  echo "== suite: $label =="
  npx tsx "$script" > "/tmp/auth-$label.log" 2>&1 || rc=$?
  grep -E '\[FAIL\]' "/tmp/auth-$label.log" | head -14 | sed 's/^/    /'
  local counts; counts="$(grep -oE '[0-9]+ passed, [0-9]+ failed' "/tmp/auth-$label.log" | tail -1)"
  [ -n "$counts" ] || counts="$(grep -oE '[0-9]+ PASSED, [0-9]+ FAILED' "/tmp/auth-$label.log" | tail -1)"
  if [ -z "$counts" ]; then
    # A suite that aborts before reporting is the most misleading kind of red: silence looks like a
    # pass to whoever skims the summary. Print why it stopped.
    say "  $label -> exit $rc; ABORTED before reporting any count:"
    tail -6 "/tmp/auth-$label.log" | sed 's/^/    /'
    FAILED=$((FAILED+1))
    return 0
  fi
  say "  $label -> exit $rc; $counts"
  [ "$rc" -ne 0 ] && FAILED=$((FAILED+1))
  return 0
}

teardown() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  say ""
  say "== teardown =="
  docker rm -f "$API_NAME" >/dev/null 2>&1 && say "  removed and stopped $API_NAME"
  docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$COPY_DB'" >/dev/null 2>&1
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $COPY_DB" >/dev/null 2>&1 && say "  dropped $COPY_DB"
  [ "$CONNECTED" = 1 ] && docker network disconnect "$NET" "$SCRATCH" >/dev/null 2>&1 && say "  disconnected $SCRATCH from $NET"
  rm -f "$OVERRIDE_FILE" && say "  removed the compose override (no secret was ever written into it)"
}
trap teardown EXIT

# ---- 0. the operator's own env, read but never printed -----------------------
[ -f .env ] || { say "ABORT: .env is missing — DEMO_PASSWORD and JWT_SECRET come from it."; exit 2; }
set -a; . ./.env; set +a
[ -n "${DEMO_PASSWORD:-}" ] || { say "ABORT: DEMO_PASSWORD is not set in .env."; exit 2; }
[ -n "${JWT_SECRET:-}" ] || { say "ABORT: JWT_SECRET is not set — the production API refuses to boot without it."; exit 2; }
SCRATCH_PW="$(docker exec $SCRATCH printenv POSTGRES_PASSWORD 2>/dev/null)" || true
[ -n "$SCRATCH_PW" ] || { say "ABORT: $SCRATCH is not running, so there is nowhere to put a copy."; exit 2; }
APP_PW="$(openssl rand -hex 24)"
ADMIN_PW="$(openssl rand -hex 24)"
# A NEW address rather than the deployed sysadmin: revoking the capability is enough to satisfy
# bootstrapAdmin's guard, and the existing account row is left alone even on a copy. Reusing the
# address would collide with that row ("an officer with that email already exists").
COPY_ADMIN_EMAIL="copy-sysadmin@dharohar.local"

# ---- 1. a read-only snapshot of the demo deployment ---------------------------
echo "== snapshot the deployed demo database (read-only) =="
PGUSER=dharohar ./scripts/backup.sh --container dharohar-prod-db-1 --dbname dharohar --output backups >/tmp/auth-backup.log 2>&1 \
  || { say "ABORT: backup failed"; tail -6 /tmp/auth-backup.log | sed 's/^/    /'; exit 2; }
DUMP="$(ls -t backups/*.dump | head -1)"
chk "snapshot taken" "1" "$([ -s "$DUMP" ] && echo 1 || echo 0)"
say "  source: $(basename "$DUMP")"

# ---- 2. restore it as a separate database -------------------------------------
echo ""
echo "== restore into a disposable copy =="
docker exec $SCRATCH psql -U postgres -q -c "create database $COPY_DB" >/dev/null 2>&1
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$COPY_DB" --create-db --input "$DUMP" >/tmp/auth-restore.log 2>&1
chk "restore completed" "0" "$?"
# Asserted, not trusted: the flag that would make this a destructive restore is one keystroke away.
SEPARATE="$(docker exec $SCRATCH psql -U postgres -tA -c "select (select count(*) from pg_database where datname='$COPY_DB') = 1 and '$COPY_DB' <> 'dharohar'")"
chk "the copy is its own database, not the deployed one" "t" "$SEPARATE"

# ---- 3. the least-privilege role, measured rather than assumed ----------------
echo ""
echo "== apply scripts/roles.sql to the copy =="
docker cp scripts/roles.sql $SCRATCH:/tmp/roles.sql >/dev/null
docker exec -i $SCRATCH psql -U postgres -d "$COPY_DB" --no-psqlrc -q -v ON_ERROR_STOP=1 \
  -v app_password="$APP_PW" -f /tmp/roles.sql >/tmp/auth-roles.log 2>&1
chk "roles.sql applied" "0" "$?"
ROLE_ATTRS="$(docker exec -i $SCRATCH psql -U postgres -tA -c "select rolname||'/su='||rolsuper||'/bypassrls='||rolbypassrls||'/createrole='||rolcreaterole||'/createdb='||rolcreatedb from pg_roles where rolname='$APP_USER'")"
chk "the runtime role is least-privilege on this cluster" "$APP_USER/su=false/bypassrls=false/createrole=false/createdb=false" "$ROLE_ATTRS"
DDL="$(docker exec -i -e PGPASSWORD="$APP_PW" $SCRATCH psql -U "$APP_USER" -d "$COPY_DB" -tA -c "create table dharohar_ddl_probe(x int)" 2>&1 | grep -c 'permission denied for schema' || true)"
chk "the runtime role cannot run DDL here" "1" "$([ "$DDL" -ge 1 ] && echo 1 || echo 0)"

# ---- 4. make room for a throwaway administrator, on the copy only -------------
echo ""
echo "== revoke the deployed administrator inside the copy =="
# A soft revoke, not a delete: bootstrapAdmin's guard is `revoked_at IS NULL`, so this is the
# minimum change that lets the copy have an administrator whose password this script knows.
docker exec -i $SCRATCH psql -U postgres -d "$COPY_DB" -q -v ON_ERROR_STOP=1 \
  -c "update user_capabilities set revoked_at = now() where capability='USER_ADMIN' and revoked_at is null" >/dev/null 2>&1
chk "no active USER_ADMIN left in the copy" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$COPY_DB" -tA -c "select count(*) from user_capabilities where capability='USER_ADMIN' and revoked_at is null")"

# ---- 5. a temporary API container pointed at the copy -------------------------
echo ""
echo "== start a temporary API against the copy =="
docker network connect "$NET" "$SCRATCH" 2>/dev/null && CONNECTED=1
say "  $SCRATCH joined $NET for the duration of the run"

cat > "$OVERRIDE_FILE" <<OVR
# Generated by scripts/test-authorization-on-copy.sh and removed by its EXIT trap. No credential is
# stored here — the DRILL_APP_USER / DRILL_APP_PW placeholders are interpolated by compose from this
# script's own environment. (Do not write a dollar-brace sample in this comment: compose interpolates
# inside comments too, so an undefined name there is a hard parse error.)
services:
  api:
    environment:
      PGHOST: $SCRATCH
      PGPORT: 5432
      PGDATABASE: $COPY_DB
      PGUSER: \${DRILL_APP_USER}
      PGPASSWORD: \${DRILL_APP_PW}
      DATABASE_URL: postgresql://\${DRILL_APP_USER}:\${DRILL_APP_PW}@$SCRATCH:5432/$COPY_DB
      RUN_MIGRATIONS: "false"
OVR
export DRILL_APP_USER="$APP_USER" DRILL_APP_PW="$APP_PW"

docker compose -f docker-compose.prod.yml -f "$OVERRIDE_FILE" run -d \
  --name "$API_NAME" --no-deps --publish "127.0.0.1:${API_PORT}:3001" api >/tmp/auth-api.log 2>&1
chk "the temporary API started" "0" "$?"

READY=""
for _ in $(seq 1 45); do
  READY="$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/health/ready" 2>/dev/null)"
  [ "$READY" = "200" ] && break
  sleep 2
done
chk "the temporary API reports ready against the copy" "200" "$READY"
if [ "$READY" != "200" ]; then
  say "  API container logs:"; docker logs --tail 30 "$API_NAME" 2>&1 | sed 's/^/    /'
  echo ""; echo "=== RESULT: environment did not come up ($FAILED check(s) failed so far) ==="; exit 2
fi

# The identity the API actually connected as — read out of pg_stat_activity, not off the compose file.
WHO="$(docker exec $SCRATCH psql -U postgres -tA -c "select string_agg(distinct usename, ',') from pg_stat_activity where datname='$COPY_DB' and usename is not null")"
chk "the temporary API runs as the least-privilege role" "$APP_USER" "$WHO"

echo "  bootstrapping the copy's administrator through the API container"
# BOOTSTRAP_ORG_ID attaches the new administrator to the tenant 0004 created and 0006 recorded.
# Without it the account holds USER_ADMIN but no organization — which is the correct fail-closed state
# for a tenant-less identity, and useless for exercising reads.
docker exec -e BOOTSTRAP_ADMIN_EMAIL="$COPY_ADMIN_EMAIL" -e BOOTSTRAP_ADMIN_NAME="Copy Suite Sysadmin" \
  -e BOOTSTRAP_ADMIN_DISTRICT="Jaipur" -e BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PW" \
  -e BOOTSTRAP_ORG_ID="ORG-DHAROHAR-DEMO" \
  "$API_NAME" node dist-server/db/bootstrapAdmin.js >/tmp/auth-bootstrap.log 2>&1
chk "bootstrap created an administrator on the copy" "0" "$?"
grep -iE 'officer|role|district|created' /tmp/auth-bootstrap.log | grep -viE 'password|secret|hash' | head -5 | sed 's/^/    /'

# ---- 6. the suites ------------------------------------------------------------
export TEST_BASE_URL="http://127.0.0.1:${API_PORT}/api"
export ADMIN_EMAIL="$COPY_ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PW"
export REGISTRY_ADMIN_URL="postgres://postgres:$SCRATCH_PW@127.0.0.1:55432/postgres"
export TENANCY_DB_URL="postgres://postgres:$SCRATCH_PW@127.0.0.1:55432/$COPY_DB"
# The application role's own connection string. The tenancy suite must probe row-level security through
# the identity the API really uses, not through the superuser that owns the copy — a policy verified
# as postgres is a policy that has not been tested.
export TENANCY_APP_URL="postgres://$APP_USER:$APP_PW@127.0.0.1:55432/$COPY_DB"

echo ""
echo "== row-level security on the copy =="
chk "policies exist on both root record tables" "8" "$(docker exec -i $SCRATCH psql -U postgres -d "$COPY_DB" -tA -c "select count(*) from pg_policies where tablename in ('parcels','land_documents')")"
chk "both root tables are under row-level security" "2" "$(docker exec -i $SCRATCH psql -U postgres -d "$COPY_DB" -tA -c "select count(*) from pg_class where relname in ('parcels','land_documents') and relrowsecurity")"
BARE_ROWS="$(docker exec -i -e PGPASSWORD="$APP_PW" $SCRATCH psql -U "$APP_USER" -d "$COPY_DB" -tA -c "select count(*) from parcels" 2>&1 | tail -1)"
# The whole point of the second layer: a query that never bound a tenant sees nothing, rather than
# seeing everything because some application code forgot a predicate.
chk "the runtime role with no tenant context reads zero parcels" "0" "$BARE_ROWS"

run_suite "jurisdiction" server/src/test_jurisdiction_suite.ts
run_suite "provisioning" server/src/test_provisioning_suite.ts
run_suite "tenancy"      server/src/test_tenancy_isolation_suite.ts

echo ""
echo "=== RESULT: $([ $FAILED -eq 0 ] && echo 'all checks passed' || echo "$FAILED suite(s)/check(s) not green") ==="
echo "    Per-suite pass/fail counts are above. Which failures are unimplemented requirements rather"
echo "    than regressions is recorded in docs/DISTRICT-TENANCY-MODEL.md."
[ $FAILED -eq 0 ] && exit 0
exit 1
