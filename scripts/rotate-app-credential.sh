#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — rotate the runtime database credential (dharohar_app)
#
# Use this when the value of DHAROHAR_APP_PASSWORD has been exposed: printed in a terminal transcript,
# pasted into a chat, left in shell history, or handed to another machine. Rewriting history does not
# un-teach a password; the role has to stop accepting it.
#
# WHAT IT TOUCHES, AND ONLY THIS
#   .env                            the single DHAROHAR_APP_PASSWORD line
#   role dharohar_app in the database   via the existing roleinit one-shot → scripts/roles.sql ALTER ROLE
#   container dharohar-prod-api-*   recreated so its pool reconnects with the new value
#
# It does NOT touch POSTGRES_PASSWORD (the owner identity used by migrate/roleinit/maint),
# DHAROHAR_VERIFIER_PASSWORD (the read-only verification identity), DEMO_PASSWORD (officer logins),
# JWT_SECRET or SEAL_SIGNING_KEY. Their digests are captured before and after so "did not touch"
# is a measurement, not a promise.
#
# HOW THE SECRET IS HANDLED
#   The new value is generated with `openssl rand -hex 32` (hex, never base64: a `/` or `+` breaks the
#   DATABASE_URL that compose interpolates). Neither the old nor the new value is ever printed, written
#   to a file, passed on a command line, or placed in a URL. They travel as environment variables into
#   psql's stdin. Everything this script prints is a label, an exit code, or a short SHA-256 digest —
#   enough to prove a change happened, not enough to reconstruct a secret.
#
# USAGE
#   ./scripts/rotate-app-credential.sh            # rotate, verify, and revert itself on failure
#   ./scripts/rotate-app-credential.sh --check    # dry run: show the injection points, change nothing
#
# Exit: 0 the new credential authenticates and the old one is refused, 1 a step failed (the script
# re-applies the previous value), 2 the environment is not what the script requires.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env
COMPOSE=docker-compose.prod.yml
DB_CONTAINER=dharohar-prod-db-1
DB_OWNER=dharohar
DB_NAME=dharohar
APP_ROLE=dharohar_app

d() { printf '%s' "$1" | sha256sum | cut -c1-12; }           # short digest: proves change, not content
line() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
note() { echo "  $*"; }
bad()  { echo "  FAIL  $*"; FAILED=$((FAILED+1)); }
good() { echo "  PASS  $*"; }
FAILED=0

[ -f "$ENV_FILE" ] || { echo "  ABORT: $ENV_FILE not found next to this repository."; exit 2; }
for t in openssl docker node; do command -v $t >/dev/null 2>&1 || { echo "  ABORT: $t is required."; exit 2; } done
VALUE_LINES="$(grep -cE '^DHAROHAR_APP_PASSWORD=' "$ENV_FILE")"
[ "$VALUE_LINES" = "1" ] || { echo "  ABORT: expected exactly one DHAROHAR_APP_PASSWORD line in $ENV_FILE, found $VALUE_LINES."; exit 2; }

# ---- the map of where the secret lives, printed as names only ----------------
echo "== where DHAROHAR_APP_PASSWORD is injected =="
OLD="$(line DHAROHAR_APP_PASSWORD)"
[ "${#OLD}" -ge 16 ] || { echo "  ABORT: the current value is implausibly short (${#OLD} characters)."; exit 2; }
note "current value digest: $(d "$OLD")  (length ${#OLD}; the value itself is never printed)"
note "services that receive it (from the rendered compose file, names only):"
CFG="$(mktemp 2>/dev/null || echo ./.rotate-cfg.tmp)"
docker compose -f "$COMPOSE" config >"$CFG" 2>/dev/null
awk -v v="$OLD" 'index($0, v) { print "    " $1 }' "$CFG" | sort -u | sed 's/:$//' | head -12
rm -f "$CFG"
note "role attributes right now:"
docker exec "$DB_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -tAc \
  "select '    '||rolname||' login='||rolcanlogin||' super='||rolsuper||' bypassrls='||rolbypassrls from pg_roles where rolname in ('$APP_ROLE','dharohar','dharohar_verifier') order by 1" 2>&1
VERIFIER_BEFORE="$(docker exec "$DB_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -tAc "select coalesce(md5(rolpassword),'none') from pg_authid where rolname='$APP_ROLE'" 2>/dev/null)"
note "stored SCRAM verifier (md5 of the verifier, not the password): $VERIFIER_BEFORE"
OTHER_BEFORE="$(for k in POSTGRES_PASSWORD DHAROHAR_VERIFIER_PASSWORD DEMO_PASSWORD JWT_SECRET SEAL_SIGNING_KEY; do printf '%s=%s;' "$k" "$(line "$k")"; done | sha256sum | cut -c1-12)"
ENV_BYTES_BEFORE="$(wc -c < "$ENV_FILE" | tr -d ' ')"
note "digest of every OTHER secret in $ENV_FILE: $OTHER_BEFORE  (file is $ENV_BYTES_BEFORE bytes)"

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "== --check: nothing changed. Re-run without the flag to rotate. =="
  exit 0
fi

# ---- 1. generate the replacement, write exactly one line ----------------------
echo ""
echo "== 1. replace the value in $ENV_FILE (never committed: .env* is gitignored) =="
NEW="$(openssl rand -hex 32)"
[ "${#NEW}" = "64" ] && good "generated a 64-character hex replacement (digest $(d "$NEW"))" || bad "generation returned ${#NEW} characters"
# Both values reach node through its environment at execve time, never as argv — `ps` shows argv.
DHAROHAR_OLD_VALUE_FOR_ROTATION="$OLD" DHAROHAR_NEW_VALUE_FOR_ROTATION="$NEW" node -e '
const fs = require("fs");
const env = fs.readFileSync(".env", "utf8");
const oldVal = process.env.DHAROHAR_OLD_VALUE_FOR_ROTATION;
const newVal = process.env.DHAROHAR_NEW_VALUE_FOR_ROTATION;
const needle = "DHAROHAR_APP_PASSWORD=" + oldVal;
if (!env.includes(needle)) { console.error("PATTERN-MISSING"); process.exit(1); }
if (env.indexOf(needle) !== env.lastIndexOf(needle)) { console.error("PATTERN-AMBIGUOUS"); process.exit(1); }
// Exactly one contiguous span of bytes changes; every other byte, including line terminators, is
// preserved verbatim. A regex rewrite over the whole file would normalise CRLF and make the diff lie.
fs.writeFileSync(".env", env.replace(needle, "DHAROHAR_APP_PASSWORD=" + newVal));
console.log("REWRITTEN");
' 2>&1 | tail -1
NEW_CHECK="$(line DHAROHAR_APP_PASSWORD)"
[ "$(d "$NEW_CHECK")" = "$(d "$NEW")" ] && good "$ENV_FILE now holds the new value (digest $(d "$NEW_CHECK"))" || bad "$ENV_FILE did not take the new value"
OTHER_AFTER="$(for k in POSTGRES_PASSWORD DHAROHAR_VERIFIER_PASSWORD DEMO_PASSWORD JWT_SECRET SEAL_SIGNING_KEY; do printf '%s=%s;' "$k" "$(line "$k")"; done | sha256sum | cut -c1-12)"
[ "$OTHER_BEFORE" = "$OTHER_AFTER" ] && good "every other secret in $ENV_FILE is unchanged (digest $OTHER_AFTER)" || bad "another secret changed too — this script must touch exactly one line"

# ---- 2. re-assert the role, through the supported path -----------------------
echo ""
echo "== 2. rotate the database role through roleinit (scripts/roles.sql ALTER ROLE) =="
docker compose -f "$COMPOSE" up -d roleinit >./.rotate-roleinit.log 2>&1
RI_RC=$?
[ $RI_RC -eq 0 ] && good "roleinit exited 0" || bad "roleinit exited $RI_RC"
grep -qiE 'LOCKDOWN_FAILED|ERROR|FATAL' ./.rotate-roleinit.log && { note "roleinit output contained errors:"; grep -iE 'LOCKDOWN_FAILED|ERROR|FATAL' ./.rotate-roleinit.log | head -5 | sed 's/^/    /'; FAILED=$((FAILED+1)); }
VERIFIER_AFTER="$(docker exec "$DB_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -tAc "select coalesce(md5(rolpassword),'none') from pg_authid where rolname='$APP_ROLE'" 2>/dev/null)"
# This line proves roleinit RAN. It does NOT prove the password changed: ALTER ROLE … PASSWORD re-salts
# SCRAM every time, so a no-op re-apply with the same value moves this digest too — measured on
# 2026-10-24, ee2f310a… → 63a84458… → e9a25f43… across re-applications of one unchanged password.
# The proof of the rotation is step 3, which authenticates with the new value and is refused with the old.
[ "$VERIFIER_AFTER" != "$VERIFIER_BEFORE" ] && good "roleinit re-applied ALTER ROLE (SCRAM verifier digest $VERIFIER_BEFORE → $VERIFIER_AFTER; re-salted on every run, so this is evidence the step executed, not that the value changed)" || bad "the stored verifier is unchanged — ALTER ROLE almost certainly did not run"

# ---- 3. the two directions that make this a rotation -------------------------
echo ""
echo "== 3. prove both directions (piped through stdin; never a command-line argument) =="
try_auth() {  # $1 = password; prints the last two lines of psql's own verdict
  printf '%s\n' "$1" | docker compose -f "$COMPOSE" run --rm --no-deps -T db \
    psql -h db -U "$APP_ROLE" -d "$DB_NAME" -W -tAc 'select current_user' 2>&1 | tr -d '\r' | tail -2 | paste -sd' ' -
}
OLD_OUT="$(try_auth "$OLD")"
NEW_OUT="$(try_auth "$NEW_CHECK")"
case "$OLD_OUT" in *"password authentication failed"*) good "the OLD credential is refused" ; note "  server said: $OLD_OUT" ;;
                    *) bad "the OLD credential did NOT behave as expected: $OLD_OUT" ;; esac
case "$NEW_OUT" in *"$APP_ROLE"*) good "the NEW credential authenticates" ; note "  server said: $NEW_OUT" ;;
                   *) bad "the NEW credential did NOT authenticate: $NEW_OUT" ;; esac

# ---- 4. restart the dependent service ---------------------------------------
echo ""
echo "== 4. recreate the API so its pool reconnects =="
docker compose -f "$COMPOSE" up -d --force-recreate api >./.rotate-api.log 2>&1
[ $? -eq 0 ] && good "api recreated" || bad "api recreation failed"
for i in $(seq 1 40); do
  S="$(docker inspect -f '{{.State.Health.Status}}' dharohar-prod-api-1 2>/dev/null)"
  [ "$S" = healthy ] && break; sleep 2
done
note "api health: $S after $i checks"
READY="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${WEB_PORT:-8088}/api/health/ready 2>/dev/null)"
[ "$READY" = "200" ] && good "/api/health/ready 200 — the running service authenticates to the database with the new value" || bad "/api/health/ready returned $READY"

# ---- 5. on any failure, put the old value back -------------------------------
if [ $FAILED -gt 0 ]; then
  echo ""
  echo "== a check failed — reverting $ENV_FILE to the previous value =="
  DHAROHAR_OLD_VALUE_FOR_ROTATION="$NEW_CHECK" DHAROHAR_NEW_VALUE_FOR_ROTATION="$OLD" node -e '
const fs=require("fs");const env=fs.readFileSync(".env","utf8");
const needle="DHAROHAR_APP_PASSWORD="+process.env.DHAROHAR_OLD_VALUE_FOR_ROTATION;
if(!env.includes(needle)){console.error("REVERT-PATTERN-MISSING  — the file no longer holds what this script wrote; fix .env by hand before restarting anything");process.exit(1);}
fs.writeFileSync(".env",env.replace(needle,"DHAROHAR_APP_PASSWORD="+process.env.DHAROHAR_NEW_VALUE_FOR_ROTATION));console.log("REVERTED");' 2>&1 | tail -1
  docker compose -f "$COMPOSE" up -d roleinit >./.rotate-revert.log 2>&1
  RV="$(docker exec "$DB_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -tAc "select coalesce(md5(rolpassword),'none') from pg_authid where rolname='$APP_ROLE'" 2>/dev/null)"
  docker compose -f "$COMPOSE" up -d --force-recreate api >/dev/null 2>&1
  note "stored verifier is now $RV; it was $VERIFIER_BEFORE before this run"
  [ "$RV" = "$VERIFIER_BEFORE" ] && note "the role is back to the original credential" || bad "the verifier does NOT match the pre-run value — check this by hand before trusting either password"
  echo "=== RESULT: rotation NOT completed ($FAILED check(s) failed); the previous value was restored where possible. ==="
  rm -f ./.rotate-roleinit.log ./.rotate-api.log ./.rotate-revert.log
  exit 1
fi

echo ""
echo "=== RESULT: $APP_ROLE rotated; the new credential authenticates and the old one is refused. ==="
note "  confirm nothing was committed:  git status --porcelain $ENV_FILE   (must print nothing — .env is ignored)"
note "  anyone holding a connection string with the old value now fails closed: the API, cron jobs, and"
note "  any local DATABASE_URL you typed elsewhere. Re-point them from .env, never by pasting the value."
note "  JWT_SECRET and DEMO_PASSWORD were not touched; a rotation of the database role does not log users out."
rm -f ./.rotate-roleinit.log ./.rotate-api.log
exit 0
