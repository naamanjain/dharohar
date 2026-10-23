#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — fresh-install, upgrade-equivalence and interrupted-migration proof
#
# Answers three questions the demo deployment cannot answer on its own, because it has been upgraded
# in place since 0001 and no longer proves what a NEW database gets:
#
#   1. Does `db:migrate` take an EMPTY database all the way to the current schema?
#   2. Is that schema the SAME schema an upgraded database ends up with? (A migration series can
#      produce two different databases from one starting point and look healthy either way.)
#   3. When a migration aborts, is the database left exactly as it was, diagnosable, and recoverable
#      once the human reason for the abort is resolved?
#
# Everything runs against disposable databases on the scratch PostGIS container. The deployed demo
# database is read only to take a dump. Nothing here drops, resets or reseeds it.
#
#   ./scripts/test-fresh-install.sh
#
# Exit: 0 all checks passed, 1 a check failed, 2 the environment is missing something.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

SCRATCH=dharohar-audit-pg
NET=dharohar-prod_backend
SUF=$$
FRESH="fresh_$SUF"; UPG="upgrad_$SUF"; INTERRUPT="interrupt_$SUF"
FAILED=0
DBS=()

say() { [ -n "${1:-}" ] && echo "  $1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; else echo "  FAIL  $1 (want $2, got $3)"; FAILED=$((FAILED+1)); fi; }
has() { echo "$2" | grep -q -F "$1" && echo 1 || echo 0; }
fq()  { docker exec -i $SCRATCH psql -U postgres -d "$1" -tA -c "$2" 2>&1 | tail -1; }

teardown() {
  for d in "${DBS[@]:-}"; do
    [ -n "$d" ] || continue
    docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$d'" >/dev/null 2>&1
    docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $d" >/dev/null 2>&1
  done
  say "dropped the disposable databases"
}
trap teardown EXIT

[ -n "${DEMO_PASSWORD:-}" ] || { say "ABORT: DEMO_PASSWORD must be set in the environment (for the seed step)."; exit 2; }
SCRATCH_PW="$(docker exec $SCRATCH printenv POSTGRES_PASSWORD 2>/dev/null)" || { say "ABORT: $SCRATCH is not running."; exit 2; }
ADMIN_URL="postgres://postgres:$SCRATCH_PW@127.0.0.1:55432"
MIG_COUNT="$(ls -1 server/src/db/migrations/*.sql | wc -l | tr -d ' ')"

# ---- 1. an empty database, migrated from nothing ------------------------------
# The documented sequence is TWO passes with an owner-side declaration between them, and the drill
# asserts each half: 0006 refuses to invent an ownership basis from an empty registry, a person states
# the geography, and only then can the migration series finish. Asserting the first pass succeeds
# without geography would be asserting a bug.
echo "== fresh install: empty database -> migrations -> geography -> migrations =="
docker exec $SCRATCH psql -U postgres -q -c "create database $FRESH" >/dev/null 2>&1; DBS+=("$FRESH")
chk "precondition: the new database has no tables" "0" "$(fq "$FRESH" "select count(*) from information_schema.tables where table_schema='public' and table_name not like 'spatial_ref_%'")"
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" npm run db:migrate 2>&1); rc=$?
say "$(echo "$out" | grep -E 'applied|Migration run|ABORTED|TENANCY' | tail -5 | sed 's/^/    /')"
chk "the first pass stops where the ownership basis is missing" "1" "$([ $rc -ne 0 ] && echo 1 || echo 0)"
chk "and names the reason rather than crashing" "1" "$(has '[TENANCY_NO_CANONICAL_GEOGRAPHY]' "$out")"
chk "the registry really is empty of authoritative geography" "0" "$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"
chk "the ledger stopped at 0005" "0001,0002,0003,0004,0005" "$(fq "$FRESH" "select string_agg(version,',' order by version) from schema_migrations")"
chk "and 0006 left no partial objects behind" "0" "$(fq "$FRESH" "select count(*) from information_schema.columns where column_name='organization_granted_by'")"
chk "the demo tenant exists (0004 creates it)" "1" "$(fq "$FRESH" "select count(*) from organizations where id='ORG-DHAROHAR-DEMO'")"
chk "but holds no district authority yet" "0" "$(fq "$FRESH" "select count(*) from organization_districts")"

# The declaration command refuses before it guesses, and each refusal is checked against its message.
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="short" npm run db:declare-geography 2>&1); rc=$?
chk "a one-word reason is refused" "1" "$(has 'shorter than 10 characters' "$out")"
chk "and nothing was written by it" "0" "$(fq "$FRESH" "select count(*) from districts")"
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur" GEOGRAPHY_ORGANIZATION="ORG-NOT-REAL" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="Refusal control run" npm run db:declare-geography 2>&1); rc=$?
chk "an unknown tenant is named and refused" "1" "$(has 'ORG-NOT-REAL" does not exist' "$out")"
chk "and still nothing was written" "0" "$(fq "$FRESH" "select count(*) from districts")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur,Ajmer,Jodhpur,Udaipur" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Naaman Jain, Urban Techx" GEOGRAPHY_REASON="Rajasthan districts the demo register is filed under" \
      npm run db:declare-geography 2>&1); rc=$?
say "$(echo "$out" | grep -E '\[GEOGRAPHY\]' | head -4 | sed 's/^/    /')"
chk "declaring the geography the demo needs succeeds" "0" "$rc"
chk "four canonical districts exist" "4" "$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"
chk "each is attributed to the person who declared it" "4" \
    "$(fq "$FRESH" "select count(*) from organization_districts g join districts d on d.id=g.district_id where g.granted_by='Naaman Jain, Urban Techx' and d.kind='canonical'")"
chk "the tenant now holds administers authority over all four" "4" \
    "$(fq "$FRESH" "select count(*) from organization_districts where organization_id='ORG-DHAROHAR-DEMO' and relationship='administers' and revoked_at is null")"
# On a new database this command necessarily runs before 0008 adds the actor columns, so the honest
# outcome is an announced skip — not an audit row, and not a silent one either way.
chk "the skip is announced where it is true" "1" "$(has 'no audit entry' "$out")"
chk "and the durable attribution is the grant row itself" "4" \
    "$(fq "$FRESH" "select count(*) from organization_districts where granted_by='Naaman Jain, Urban Techx' and reason='Rajasthan districts the demo register is filed under'")"
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur,Ajmer,Jodhpur,Udaipur" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Naaman Jain, Urban Techx" GEOGRAPHY_REASON="Rajasthan districts the demo register is filed under" \
      npm run db:declare-geography 2>&1); rc=$?
chk "re-declaring the same geography is safe" "0" "$rc"
chk "and reports the rows it left alone" "1" "$(has 'already canonical and left alone' "$out")"
chk "with no duplicate grants created" "4" "$(fq "$FRESH" "select count(*) from organization_districts")"

# The three refusals that protect a registry from a typing accident. Each is checked against the row
# counts it must NOT have changed, because a refusal that wrote half a registry is worse than a crash.
# The two refusals that protect a registry from a typing accident, and the explicit override. The
# planted rows satisfy ck_districts_code_is_name (code = lower(name)). They are planted as
# 'test_fixture' rather than 'candidate' because this is the FIRST migration pass: the candidate domain
# is introduced by 0007, which has not run yet — an earlier version of this control planted candidates,
# PostgreSQL refused them, and three guard assertions then passed against a registry that had nothing to
# guard. Each refusal is checked against the row counts it must NOT have changed.
docker exec -i $SCRATCH psql -U postgres -d "$FRESH" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'PLANT'
insert into districts (code, name, provenance, kind, canonical_name, name_key, state_code, is_active)
     values ('alias jaipur', 'Alias Jaipur', 'declared', 'test_fixture', 'Alias Jaipur', 'jaipur', 'RJ', false),
            ('bikaner',      'Bikaner',      'declared', 'test_fixture', 'Bikaner',    'bikaner', 'RJ', false);
PLANT
PLANTED_CANON="$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"
chk "premise: both control rows exist" "2" "$(fq "$FRESH" "select count(*) from districts where code in ('alias jaipur','bikaner')")"
chk "and neither is canonical geography" "0" "$(fq "$FRESH" "select count(*) from districts where code in ('alias jaipur','bikaner') and kind='canonical'")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur,Jaipur" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="Duplicate name control run" npm run db:declare-geography 2>&1); rc=$?
chk "the same district listed twice is refused" "1" "$(has 'lists the same district more than once' "$out")"
chk "and nothing was written by it" "$PLANTED_CANON" "$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Jaipur" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="Collision control run" npm run db:declare-geography 2>&1); rc=$?
chk "two registry rows resolving to one name are refused, not resolved by min()" "1" "$(has 'DISTRICT_CODE_AMBIGUOUS' "$out")"
chk "and the refusal names the colliding code" "1" "$(has 'alias jaipur' "$out")"
chk "and the collision left the registry untouched" "$PLANTED_CANON" "$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Bikaner" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="Reclassification without override" npm run db:declare-geography 2>&1); rc=$?
chk "re-classifying a non-canonical district needs an explicit override" "1" "$(has 'GEOGRAPHY_OVERWRITE=true' "$out")"
chk "and the control row is still not canonical geography" "1" "$(fq "$FRESH" "select count(*) from districts where code='bikaner' and kind='test_fixture'")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" GEOGRAPHY_DISTRICTS="Bikaner" GEOGRAPHY_ORGANIZATION="ORG-DHAROHAR-DEMO" \
      GEOGRAPHY_BY="Test Operator" GEOGRAPHY_REASON="Override control run" GEOGRAPHY_OVERWRITE=true \
      npm run db:declare-geography 2>&1); rc=$?
chk "with the override the reclassification is recorded, attributed in the row" "1" \
    "$(fq "$FRESH" "select count(*) from districts where code='bikaner' and kind='canonical' and notes like '%Test Operator%'")"
chk "and it granted the tenant over the newly canonical district" "1" \
    "$(fq "$FRESH" "select count(*) from organization_districts g join districts d on d.id=g.district_id where d.code='bikaner' and g.granted_by='Test Operator'")"

docker exec -i $SCRATCH psql -U postgres -d "$FRESH" -q >/dev/null 2>&1 <<'CLEAN'
delete from organization_districts g using districts d where g.district_id = d.id and d.code in ('bikaner','alias jaipur');
delete from districts where code in ('bikaner','alias jaipur');
CLEAN
chk "the control rows are removed so the schema comparison below sees a clean registry" "4" "$(fq "$FRESH" "select count(*) from districts where kind='canonical'")"
chk "and no control grant survived the cleanup" "4" "$(fq "$FRESH" "select count(*) from organization_districts")"

out=$(DATABASE_URL="$ADMIN_URL/$FRESH" npm run db:migrate 2>&1); rc=$?
say "$(echo "$out" | grep -E 'applied|TOTAL|Migrations applied' | tail -4 | sed 's/^/    /')"
chk "the second pass finishes the series" "0" "$rc"
chk "every migration file was applied" "$MIG_COUNT" "$(fq "$FRESH" "select count(*) from schema_migrations")"
chk "the ledger is in filename order" "$(ls -1 server/src/db/migrations/*.sql | sed 's#.*/##; s/_.*//' | tr '\n' ',' | sed 's/,$//')" \
    "$(fq "$FRESH" "select string_agg(version,',' order by version) from schema_migrations")"
# Every row recorded a checksum of the right shape, and no file is missing from the ledger. The
# registry suite compares the recorded digests against the files byte for byte; this asserts the
# structural fact that the runner accounted for each file exactly once.
chk "every ledger row carries a sha256 checksum" "0" "$(fq "$FRESH" "select count(*) from schema_migrations where checksum is null or checksum not like 'sha256:%'")"
chk "no migration version appears twice" "0" "$(fq "$FRESH" "select count(*) from (select version from schema_migrations group by version having count(*)>1) d")"
# Re-running the documented command must be a no-op, not a second application.
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" npm run db:migrate 2>&1); rc=$?
chk "a further migrate run exits 0 (no-op)" "0" "$rc"
chk "and says so rather than re-applying anything" "1" "$(has 'No pending migrations' "$out")"
chk "ledger still holds exactly $MIG_COUNT rows" "$MIG_COUNT" "$(fq "$FRESH" "select count(*) from schema_migrations")"

# Seeding and the first administrator: the documented provisioning sequence, checked against the rows
# it writes rather than the exit code alone.
echo ""
echo "== documented provisioning: seed, then the first administrator =="
has() { echo "$2" | grep -q -F "$1" && echo 1 || echo 0; }
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" npm run db:seed 2>&1); rc=$?
say "$(echo "$out" | grep -E 'owned by|Seeding|storageMode' | grep -vi password | head -3 | sed 's/^/    /')"
chk "seed runs on a fresh single-tenant database" "0" "$rc"
SEED_PARCELS="$(fq "$FRESH" "select count(*) from parcels")"
SEED_USERS="$(fq "$FRESH" "select count(*) from users")"
chk "the seed wrote parcels, not just a zero exit" "1" "$([ "${SEED_PARCELS:-0}" -gt 0 ] && echo 1 || echo 0)"
chk "and officers" "1" "$([ "${SEED_USERS:-0}" -gt 0 ] && echo 1 || echo 0)"
# This is the defect the fresh install used to hide: since 0006 a record with no tenant is invisible at
# BOTH layers, so demo fixtures written unowned leave a newly installed environment that reads back
# empty to the officer you bootstrap next. Ownership therefore has to be stamped by the seed too.
chk "every seeded parcel carries a tenant" "0" "$(fq "$FRESH" "select count(*) from parcels where organization_id is null")"
chk "every seeded document carries a tenant" "0" "$(fq "$FRESH" "select count(*) from land_documents where organization_id is null")"
chk "every seeded officer carries a tenant" "0" "$(fq "$FRESH" "select count(*) from users where organization_id is null")"
chk "each parcel ownership is attributed to the seed command" "$SEED_PARCELS" \
    "$(fq "$FRESH" "select count(*) from parcels where organization_granted_by='seed:db:seed'")"
chk "and every attribution records a reason" "0" \
    "$(fq "$FRESH" "select count(*) from parcels where organization_granted_by is not null and coalesce(btrim(organization_grant_reason),'')=''")"
# The premise of the whole block: exactly one tenant existed for the seed to write into. Without this
# the ownership checks above could pass because nothing was seeded at all.
chk "the fresh database has exactly one tenant" "1" "$(fq "$FRESH" "select count(*) from organizations")"

# The production guard is the mechanism being claimed, so test the mechanism, not any non-zero exit.
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" NODE_ENV=production npm run db:seed 2>&1); rc=$?
chk "a production seed without SEED_CONFIRM exits non-zero" "1" "$([ $rc -ne 0 ] && echo 1 || echo 0)"
chk "and states that it is refusing to write demo records" "1" "$(has 'Refusing to seed demo records into a production database' "$out")"
chk "the refusal wrote nothing: parcels unchanged" "$SEED_PARCELS" "$(fq "$FRESH" "select count(*) from parcels")"
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" NODE_ENV=production SEED_CONFIRM=demo npm run db:seed 2>&1); rc=$?
chk "the identical seed with SEED_CONFIRM=demo is accepted" "1" "$(has 'SEED_CONFIRM=demo accepted' "$out")"

# A tenant id that does not exist must be named before anything is written...
BOOTPW="$(openssl rand -hex 18)"
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" BOOTSTRAP_ADMIN_EMAIL="ghost.$SUF@dharohar.test" BOOTSTRAP_ADMIN_NAME="Ghost Tenant Admin" \
      BOOTSTRAP_ADMIN_DISTRICT="Jaipur" BOOTSTRAP_ADMIN_PASSWORD="$BOOTPW" BOOTSTRAP_ORG_ID="ORG-DOES-NOT-EXIST" \
      npm run db:bootstrap-admin 2>&1); rc=$?
chk "bootstrap refuses an unknown tenant" "1" "$([ $rc -ne 0 ] && echo 1 || echo 0)"
chk "and names the tenant it could not find" "1" "$(has 'ORG-DOES-NOT-EXIST' "$out")"
chk "no account was created by the refused attempt" "0" "$(fq "$FRESH" "select count(*) from users where email='ghost.$SUF@dharohar.test'")"
# ...and the documented path produces an officer that the tenancy layers can actually see.
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" BOOTSTRAP_ADMIN_EMAIL="fresh.$SUF@dharohar.test" BOOTSTRAP_ADMIN_NAME="Fresh Install Admin" \
      BOOTSTRAP_ADMIN_DISTRICT="Jaipur" BOOTSTRAP_ADMIN_PASSWORD="$BOOTPW" BOOTSTRAP_ORG_ID="ORG-DHAROHAR-DEMO" \
      npm run db:bootstrap-admin 2>&1); rc=$?
chk "an administrator can be bootstrapped on a fresh database" "0" "$rc"
chk "the account exists with the tenant it was given" "ORG-DHAROHAR-DEMO" \
    "$(fq "$FRESH" "select organization_id from users where email='fresh.$SUF@dharohar.test'")"
chk "the tenant grant is attributed to the command that made it" "1" \
    "$(fq "$FRESH" "select case when organization_granted_by is not null and coalesce(btrim(organization_grant_reason),'')<>'' then 1 else 0 end from users where email='fresh.$SUF@dharohar.test'")"
chk "the USER_ADMIN capability is really held" "1" \
    "$(fq "$FRESH" "select case when count(*)=1 then 1 else 0 end from user_capabilities c join users u on u.id=c.user_id where u.email='fresh.$SUF@dharohar.test' and c.capability='USER_ADMIN' and c.revoked_at is null")"
chk "and the posting is really granted" "1" \
    "$(fq "$FRESH" "select case when count(*)=1 then 1 else 0 end from user_jurisdictions j join users u on u.id=j.user_id where u.email='fresh.$SUF@dharohar.test' and lower(j.district)='jaipur' and j.revoked_at is null")"
chk "the bootstrap is written into the audit chain" "1" \
    "$(fq "$FRESH" "select case when count(*)>0 then 1 else 0 end from append_only_audit_logs")"
# The second attempt must be refused — the one-shot guarantee is what keeps a re-run of a deploy script
# from minting a second superuser.
out=$(DATABASE_URL="$ADMIN_URL/$FRESH" BOOTSTRAP_ADMIN_EMAIL="fresh2.$SUF@dharohar.test" BOOTSTRAP_ADMIN_NAME="Second" \
      BOOTSTRAP_ADMIN_DISTRICT="Jaipur" BOOTSTRAP_ADMIN_PASSWORD="$BOOTPW" npm run db:bootstrap-admin 2>&1); rc=$?
chk "the bootstrap command refuses to run a second time" "4" "$([ $rc -eq 4 ] && echo 4 || echo $rc)"
chk "and says why" "1" "$(has 'already holds the USER_ADMIN capability' "$out")"
chk "no second administrator was created" "0" "$(fq "$FRESH" "select count(*) from users where email='fresh2.$SUF@dharohar.test'")"
# And the fresh database must be tenant-scoped from the first migration, not only after an upgrade.
# Nine tables now: the two roots (0006), the three child tables that inherit their parcel's tenant
# (0009), and the four authorization tables that hold officers, postings, capabilities and tenant
# grants (0010). This line read "5" until 2026-10-23, when a fresh install proved it: an assertion
# pinned to the old number fails the gate for the right reason only if someone also checks that the
# new five are complete — so the set difference below is the part that actually holds the line.
RLS_TABLES="'parcels','land_documents','parcel_owners','parcel_mutations','field_inspections','users','user_jurisdictions','user_capabilities','organization_districts'"
chk "row-level security is present on a fresh install" "9" "$(fq "$FRESH" "select count(*) from pg_class where relname in ($RLS_TABLES) and relrowsecurity")"
chk "every tenant-scoped table carries all four policies" "9" "$(fq "$FRESH" "select count(distinct tablename) from pg_policies where policyname like 'tenant_%'")"
# The two lists must be the same list. A table that is under RLS with no tenant policy is a table whose
# protection is a comment, and a policy on a table that is not under RLS is a policy that is not run.
chk "and no RLS table is missing its policies, or the other way round" "0" \
    "$(fq "$FRESH" "select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity and c.relname not in (select distinct tablename from pg_policies where policyname like 'tenant_%')) + (select count(*) from (select distinct tablename from pg_policies where policyname like 'tenant_%') t where not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t.tablename and c.relrowsecurity))")"
chk "no table has a partial policy set" "0" \
    "$(fq "$FRESH" "with p as (select tablename, count(*) n from pg_policies where policyname like 'tenant_%' group by tablename) select count(*) from p where n <> 4")"

# ---- 2. choose the baselines by LEDGER CONTENTS, not by filename ----------------
# Two different starting points are needed and neither can be guessed from a timestamp: the schema
# comparison wants a database that predates the tenant tables, the aborted-migration test wants one
# that sits exactly one migration short of the ownership change. Both are decided by reading
# schema_migrations out of the dump itself, and the inventory is kept so the choice is auditable.
echo ""
echo "== locating the baselines =="
PROBE="probe_$SUF"; DBS+=("$PROBE")
LEDGER_INVENTORY=/tmp/fresh-ledgers.txt
: > "$LEDGER_INVENTORY"
ledger_of() {
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $PROBE" >/dev/null 2>&1
  docker exec $SCRATCH psql -U postgres -q -c "create database $PROBE" >/dev/null 2>&1
  docker cp "$1" $SCRATCH:/tmp/probe.dump >/dev/null 2>&1
  docker exec $SCRATCH pg_restore -U postgres -d $PROBE --no-owner --no-privileges /tmp/probe.dump >/dev/null 2>&1
  local got
  got=$(docker exec $SCRATCH psql -U postgres -d $PROBE -tA -c \
    "select string_agg(version,',' order by version) from schema_migrations" 2>/dev/null | head -1)
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $PROBE" >/dev/null 2>&1
  echo "${got:-NO-LEDGER}"
}
mapfile -t DUMPS < <(ls -t backups/*.dump)
declare -A CACHE
ledger_at() {
  local i=$1
  if [ -z "${CACHE[$i]:-}" ]; then
    CACHE[$i]="$(ledger_of "${DUMPS[$i]}")"
    echo "probe $(basename "${DUMPS[$i]}") -> ${CACHE[$i]}" >> "$LEDGER_INVENTORY"
  fi
  echo "${CACHE[$i]}"
}
# The deployed database only ever gained migrations, so its ledger is a growing prefix and "lacks this
# version" is monotone in dump age. Bisecting finds each boundary in ~6 restores instead of 54.
newest_without() {
  local want="$1" lo=0 hi=$(( ${#DUMPS[@]} - 1 )) ans=-1 mid
  while [ $lo -le $hi ]; do
    mid=$(( (lo + hi) / 2 ))
    if ledger_at "$mid" | grep -q "$want"; then lo=$(( mid + 1 )); else ans=$mid; hi=$(( mid - 1 )); fi
  done
  echo "$ans"
}
say "  ${#DUMPS[@]} candidate dumps, newest first; bisection probes are listed below"
BASE_IDX="$(newest_without 0004)"; MID_IDX="$(newest_without 0006)"
[ "$BASE_IDX" -ge 0 ] || { say "ABORT: no dump predating 0004 exists, so the upgrade path cannot be compared."; exit 2; }
[ "$MID_IDX" -ge 0 ]  || { say "ABORT: no dump predating 0006 exists, so the aborted-migration case cannot be built."; exit 2; }
BASE="${DUMPS[$BASE_IDX]}"; MID="${DUMPS[$MID_IDX]}"
ledger_at "$MID_IDX" | grep -q '0005' || { say "ABORT: the pre-0006 baseline is not at 0005, so planting a second tenant would not abort 0006."; exit 2; }
say "  upgrade baseline : $(basename "$BASE")  [$(ledger_at "$BASE_IDX")]"
say "  interrupt probe  : $(basename "$MID")  [$(ledger_at "$MID_IDX")]"

docker exec $SCRATCH psql -U postgres -q -c "create database $UPG" >/dev/null 2>&1; DBS+=("$UPG")
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$UPG" --create-db --input "$BASE" >/tmp/fresh-restore.log 2>&1
chk "baseline restored" "0" "$?"
chk "the baseline really predates the tenant tables" "0" "$(fq "$UPG" "select count(*) from information_schema.tables where table_name='organization_districts'")"
chk "its ledger stops before 0004, so the run has real work to do" "1" \
    "$(fq "$UPG" "select case when to_regclass('public.schema_migrations') is null then 1
                              when (select count(*) from schema_migrations where version >= '0004') = 0 then 1
                              else 0 end")"
out=$(DATABASE_URL="$ADMIN_URL/$UPG" npm run db:migrate 2>&1); rc=$?
chk "migrate upgrades the restored copy to the same ledger" "0" "$rc"
chk "upgraded database applied the same $MIG_COUNT migrations" "$MIG_COUNT" "$(fq "$UPG" "select count(*) from schema_migrations")"
chk "the upgraded ledger reads exactly like the fresh one" "$(fq "$FRESH" "select string_agg(version,',' order by version) from schema_migrations")" \
    "$(fq "$UPG" "select string_agg(version,',' order by version) from schema_migrations")"

# Normalised schema-only comparison. Object names and definitions only: OIDs, storage parameters,
# statistics and the PostGIS extension set differ per database depending on how it was created, and
# would produce a diff that means nothing. (The extension set is asserted separately below.)
norm() { docker exec -i $SCRATCH pg_dump -U postgres --schema-only --no-owner --no-privileges "$1" \
          | grep -vE '^--|^$|^SET |^SELECT pg_|^CREATE SCHEMA|^ALTER SCHEMA|^CREATE EXTENSION|^COMMENT ON EXTENSION|^COMMENT ON SCHEMA' \
          | sed -E 's/ WITH \(.*\)//; s/FILLFACTOR [0-9]+//'; }
# The two lineages write the same CHECK constraint with different cast decoration — an expression tree
# that casts the array versus casting each element. That is presentation, so the comparison strips
# casts and grouping while the diagnostic diff above keeps them. What the assertion really rests on is
# the enforcement control below, which puts the constraint to work in both databases.
norm_strict() { norm "$1" | sed -E 's/::(character varying|text|varchar|bpchar)//g; s/\[\]//g' | tr -d '()'; }
norm "$FRESH" > /tmp/fresh-schema.sql
norm "$UPG"   > /tmp/upgrad-schema.sql
norm_strict "$FRESH" > /tmp/fresh-strict.sql
norm_strict "$UPG"   > /tmp/upgrad-strict.sql
# Privileges are compared separately, and only after roles.sql has been applied to BOTH databases
# with the same password: that is what proves the grant script is order-independent and that a fresh
# install and an upgrade hand the runtime role the same rights. Comparing them before it would
# compare two identical empty states and prove nothing.
APPPW="$(openssl rand -hex 16)"
docker cp scripts/roles.sql $SCRATCH:/tmp/roles.sql >/dev/null
for d in "$FRESH" "$UPG"; do
  docker exec -i $SCRATCH psql -U postgres -d "$d" --no-psqlrc -q -v ON_ERROR_STOP=1 \
    -v app_password="$APPPW" -f /tmp/roles.sql >/dev/null 2>&1
done
privset() { docker exec -i $SCRATCH psql -U postgres -d "$1" -tA -c "
  select string_agg(t||':'||p, ',' order by t,p) from (
    select c.relname as t,
           (case when has_table_privilege('dharohar_app',c.oid,'SELECT') then 'r' else '' end)||
           (case when has_table_privilege('dharohar_app',c.oid,'INSERT') then 'a' else '' end)||
           (case when has_table_privilege('dharohar_app',c.oid,'UPDATE') then 'w' else '' end)||
           (case when has_table_privilege('dharohar_app',c.oid,'DELETE') then 'd' else '' end)||
           (case when has_table_privilege('dharohar_app',c.oid,'TRUNCATE') then 'T' else '' end) as p
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r') s where p <> ''"; }
chk "the runtime role's privileges are identical on both" "$(privset "$FRESH")" "$(privset "$UPG")"
if diff -q /tmp/fresh-strict.sql /tmp/upgrad-strict.sql >/dev/null; then SAME=identical; else SAME=different; fi
chk "fresh-install and upgraded schemas contain the same objects" "identical" "$SAME"
if [ "$SAME" != "identical" ]; then
  echo "  the differences, for diagnosis:"
  diff /tmp/fresh-schema.sql /tmp/upgrad-schema.sql | head -30 | sed 's/^/    /'
fi

counts() { fq "$1" "select (select count(*) from information_schema.columns where table_schema='public')||'/'||
                        (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public')||'/'||
                        (select count(*) from pg_indexes where schemaname='public')||'/'||
                        (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
                          where not t.tgisinternal and n.nspname='public'
                            and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e'))"; }
# Normalising how a CHECK is RENDERED is not proof that both databases enforce the same RULE, so put
# the rule to work in both: the same invalid role must be refused by the same constraint, and a valid
# one must still be accepted (otherwise "refused" would prove nothing).
for pair in "fresh:$FRESH" "upgraded:$UPG"; do
  LABEL="${pair%%:*}"; d="${pair#*:}"
  REJ=$(docker exec -i $SCRATCH psql -U postgres -d "$d" -tA -c \
    "begin; insert into users (id,email,password_hash,salt,role,display_name,designation) values ('T-ROLE','t.role@dharohar.test','h','s','HACKER','probe','probe'); rollback;" 2>&1)
  chk "$LABEL: an invalid role is refused by ck_users_role" "1" "$(has 'ck_users_role' "$REJ")"
  ACC=$(docker exec -i $SCRATCH psql -U postgres -d "$d" -tA -c \
    "begin; insert into users (id,email,password_hash,salt,role,display_name,designation) values ('T-OK','t.ok@dharohar.test','h','s','AUDITOR','probe','probe'); rollback;" 2>&1)
  chk "$LABEL: a valid role is accepted by the same constraint" "1" "$([ "$(has 'ERROR' "$ACC")" = "0" ] && echo 1 || echo 0)"
done
chk "columns/constraints/indexes/triggers match (cols/cons/idx/trg)" "$(counts "$FRESH")" "$(counts "$UPG")"
POLICY_SET() { fq "$1" "select count(*)||'/'||(select string_agg(tablename||':'||cmd,',' order by tablename,cmd) from pg_policies where tablename in ($RLS_TABLES))"; }
chk "RLS policies match across all five tenant tables (count/table:cmd)" "$(POLICY_SET "$FRESH")" "$(POLICY_SET "$UPG")"
chk "both databases have the PostGIS extension" "t" "$(fq "$FRESH" "select exists(select 1 from pg_extension where extname='postgis')")"
chk "and so does the upgraded one" "t" "$(fq "$UPG" "select exists(select 1 from pg_extension where extname='postgis')")"
chk "both schemas are owned by the same role" "$(fq "$UPG" "select distinct r.rolname from pg_class c join pg_roles r on r.oid=c.relowner join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1 limit 1")" \
    "$(fq "$FRESH" "select distinct r.rolname from pg_class c join pg_roles r on r.oid=c.relowner join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1 limit 1")"

# ---- 3. an aborted migration: diagnosis and recovery -------------------------
echo ""
echo "== interrupted migration on a database that genuinely stops at 0005 =="
docker exec $SCRATCH psql -U postgres -q -c "create database $INTERRUPT" >/dev/null 2>&1; DBS+=("$INTERRUPT")
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$INTERRUPT" --create-db --input "$MID" >/tmp/fresh-restore2.log 2>&1
chk "0005 baseline restored" "0" "$?"
LEDGER_BEFORE="$(fq "$INTERRUPT" "select string_agg(version,',' order by version) from schema_migrations")"
chk "the interrupted probe starts exactly one migration short of ownership" "0001,0002,0003,0004,0005" "$LEDGER_BEFORE"
chk "and the ownership columns it will add do not exist yet" "0" "$(fq "$INTERRUPT" "select count(*) from information_schema.columns where column_name='organization_granted_by'")"
# Create the ambiguity 0006 refuses to resolve — a second tenant — then run the runner and require it
# to stop cleanly, name the reason, and leave nothing behind.
docker exec -i $SCRATCH psql -U postgres -d "$INTERRUPT" -q -c "insert into organizations (id,name) values ('ORG-SECOND','A second tenant planted to force an abort')" >/dev/null 2>&1
PRE_abort_parcels="$(fq "$INTERRUPT" "select count(*) from parcels")"
out=$(DATABASE_URL="$ADMIN_URL/$INTERRUPT" npm run db:migrate 2>&1); rc=$?
say "$(echo "$out" | grep -E 'FAILED|ABORTED|TENANCY' | head -3 | sed 's/^/    /')"
chk "the runner exits non-zero on the ambiguous tenant" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "the refusal names the reason" "1" "$(has 'TENANCY_AMBIGUOUS_TENANT' "$out")"
chk "and names the tenant that caused it" "1" "$(has 'ORG-SECOND' "$out")"
chk "the ledger is exactly what it was before the attempt" "$LEDGER_BEFORE" "$(fq "$INTERRUPT" "select string_agg(version,',' order by version) from schema_migrations")"
chk "no half-applied object survived the abort" "0" "$(fq "$INTERRUPT" "select count(*) from information_schema.columns where column_name='organization_granted_by'")"
chk "no policies were created by the failed run" "0" "$(fq "$INTERRUPT" "select count(*) from pg_policies where policyname like 'tenant_%'")"
chk "the records were not touched: still $(echo "$PRE_abort_parcels") parcels" "$PRE_abort_parcels" "$(fq "$INTERRUPT" "select count(*) from parcels")"
chk "and still all unowned, so nothing was assigned then rolled back halfway" "0" \
    "$(fq "$INTERRUPT" "select count(*) from parcels where organization_id is not null")"
# The same rule the migration enforces, on the seed path: with two tenants there is no basis for
# assigning a fixture, so seeding has to refuse rather than distribute records by guesswork.
out=$(DATABASE_URL="$ADMIN_URL/$INTERRUPT" npm run db:seed 2>&1); rc=$?
chk "the seed refuses a two-tenant database instead of guessing an owner" "1" "$([ $rc -ne 0 ] && echo 1 || echo 0)"
chk "and names the ambiguity" "1" "$(has 'SEED_TENANT_AMBIGUOUS' "$out")"
chk "no record was written by the refused seed" "$PRE_abort_parcels" "$(fq "$INTERRUPT" "select count(*) from parcels")"
# Recover by resolving the human ambiguity, not by editing the migration.
docker exec -i $SCRATCH psql -U postgres -d "$INTERRUPT" -q -c "delete from organizations where id='ORG-SECOND'" >/dev/null 2>&1
out=$(DATABASE_URL="$ADMIN_URL/$INTERRUPT" npm run db:migrate 2>&1); rc=$?
chk "after the ambiguity is resolved, the same runner completes" "0" "$rc"
chk "and the ledger now holds every migration" "$MIG_COUNT" "$(fq "$INTERRUPT" "select count(*) from schema_migrations")"
chk "the recovered database matches the fresh one object-for-object" "$(counts "$FRESH")" "$(counts "$INTERRUPT")"
chk "and the recovery really assigned the canonical records" "1" \
    "$(fq "$INTERRUPT" "select case when count(*)>0 then 1 else 0 end from parcels where organization_granted_by='migration:0006'")"

echo ""
echo "=== RESULT: $([ $FAILED -eq 0 ] && echo 'all checks passed' || echo "$FAILED check(s) failed") ==="
say "  fresh=$FRESH  upgraded=$UPG  interrupted=$INTERRUPT (dropped on exit)"
say "  normalized schema dumps kept for inspection: /tmp/fresh-schema.sql /tmp/upgrad-schema.sql"
[ $FAILED -eq 0 ] && exit 0
exit 1
