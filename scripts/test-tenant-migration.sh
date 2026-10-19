#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — tenant migration test harness (docs/DISTRICT-TENANCY-MODEL.md §7)
#
# Exercises server/src/db-draft/0004_canonical_districts_and_tenants.sql against
# disposable copies of the CURRENT deployed database. It never touches the deployed
# database: every write goes to a throwaway database created inside the scratch PostGIS
# container, and the only statement run against production is a read-only pg_dump.
#
#   ./scripts/test-tenant-migration.sh
#
# Exit codes: 0 all assertions passed, 2 environment missing, 1 an assertion failed.
#
# The abort cases are run on a SEPARATE copy, before anything has been applied. Testing a
# guard after the happy path has already run proves nothing, because the columns the guard
# is about to create already exist and the statement that should stop the file never gets
# reached.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

# Git Bash rewrites POSIX-looking arguments such as `-f /tmp/0004.sql` into a Windows temp path
# before docker ever sees them, and psql then reports "No such file or directory" for a file that
# exists inside the container. That failure looks exactly like a broken migration — it produced 13
# red assertions here before it was identified — so the conversion is disabled for the whole script.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

SCRATCH=dharohar-audit-pg
APP="server/src/db-draft/0004_canonical_districts_and_tenants.sql"
ROLLBACK="server/src/db-draft/rollback-0004.sql"
PASS=0; FAIL=0
say()  { printf '%s\n' "$*"; }
chk()  { local name="$1" want="$2" got="$3"
         if [ "$got" = "$want" ]; then say "  PASS  $name ($got)"; PASS=$((PASS+1));
         else say "  FAIL  $name (want $want, got $got)"; FAIL=$((FAIL+1)); fi; }

# ---- environment -------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then say "ABORT: docker daemon unreachable — nothing below could be measured."; exit 2; fi
docker start $SCRATCH >/dev/null 2>&1 || true
SPW="$(docker exec $SCRATCH printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$SPW" ] || { say "ABORT: cannot read the scratch container's password."; exit 2; }
maint() { docker exec -i $SCRATCH psql -U postgres -tA -f - <<<"$1" 2>&1; }

# ---- 1. snapshot the deployed database, read-only ----------------------------
say "== backup of the deployed database =="
PGUSER=dharohar ./scripts/backup.sh --container dharohar-prod-db-1 --dbname dharohar >/tmp/tenant-bak.log 2>&1
DUMP="$(ls -t backups/*.dump | head -1)"; say "  dump: $DUMP"
[ -s "$DUMP" ] || { say "ABORT: no dump produced"; exit 2; }

stamp=$$
DB_OK="tenant_ok_$stamp"; DB_ABORT="tenant_abort_$stamp"

# ---- 2. disposable copy, happy path ------------------------------------------
say "== restore into disposable copy $DB_OK =="
maint "create database $DB_OK;" >/dev/null
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$DB_OK" --create-db --input "$DUMP" >/tmp/tenant-res.log 2>&1
chk "restore completed" "0" "$?"

PRE_COLS="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from information_schema.columns where table_name='districts' and table_schema='public'")"
PRE_DIST="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c 'select count(*) from districts')"
PRE_PARCELS="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c 'select count(*) from parcels')"
say "  pre-migration: districts column count=$PRE_COLS rows=$PRE_DIST parcels=$PRE_PARCELS"

# ---- 3. apply ------------------------------------------------------------------
say "== apply 0004 =="
docker cp "$APP" $SCRATCH:/tmp/0004.sql >/dev/null
docker cp "$ROLLBACK" $SCRATCH:/tmp/rollback-0004.sql >/dev/null
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0004.sql 2>&1); rc=$?
say "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | head -20
chk "first apply exits 0" "0" "$rc"
chk "demo tenant created" "1" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organizations where id='ORG-DHAROHAR-DEMO'")"
chk "canonical districts associated (expected 4)" "4" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organization_districts od join districts d on d.id=od.district_id where d.kind='canonical'")"
chk "fixture districts NOT associated (expect 0 associated)" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organization_districts od join districts d on d.id=od.district_id where d.kind='test_fixture'")"
chk "probe rows classified as test_fixture" "11" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from districts where kind='test_fixture'")"
chk "every parcel with a code got district_id" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from parcels where district_code is not null and district_id is null")"
chk "documents still without any district stay NULL, not invented" "2" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from land_documents where district_code is null and district_id is null")"
chk "district ids all unique" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from (select id from districts group by id having count(*)>1) x")"
chk "history preserved: parcel count unchanged" "$PRE_PARCELS" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c 'select count(*) from parcels')"
chk "registry rows unchanged in number" "$PRE_DIST" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c 'select count(*) from districts')"

say "== re-apply must be a clean no-op =="
out2=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0004.sql 2>&1); rc2=$?
chk "second apply exits 0 (idempotent)" "0" "$rc2"
chk "no duplicate associations after re-apply" "4" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organization_districts")"
chk "no second demo organization" "1" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organizations")"

# ---- 4. integrity checker against the migrated copy ----------------------------
say "== district integrity checker on the migrated copy =="
DEMO="$(grep '^DEMO_PASSWORD=' .env | cut -d= -f2-)"
DATABASE_URL="postgresql://postgres:${SPW}@127.0.0.1:55432/$DB_OK" DEMO_PASSWORD="$DEMO" \
  ./node_modules/.bin/tsx server/src/verify_district_integrity.ts > /tmp/tenant-integ.log 2>&1
chk "integrity checker runs on the migrated schema (non-zero exit = findings, which is expected)" "0" "$([ -s /tmp/tenant-integ.log ] && echo 0 || echo 1)"
say "  $(grep -E 'finding|FINDING' /tmp/tenant-integ.log | tail -1)"
grep -E 'ERROR|Traceback|does not exist' /tmp/tenant-integ.log | head -3 | sed 's/^/  note  /'

# ---- 5. rollback, then compare with the pre-migration state --------------------
say "== rollback of 0004 =="
docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0004.sql >/tmp/tenant-rb.log 2>&1
chk "rollback exits 0" "0" "$?"
POST_COLS="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from information_schema.columns where table_name='districts' and table_schema='public'")"
chk "districts columns restored to pre-migration count" "$PRE_COLS" "$POST_COLS"
chk "organization_districts gone" "" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select coalesce(to_regclass('organization_districts')::text,'')")"
chk "organizations empty again" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from organizations")"
chk "parcels survived the rollback" "$PRE_PARCELS" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from parcels")"
chk "0003 CHECK still enforced after rollback" "1" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from pg_constraint where conname='ck_parcels_district_code_matches_text' or conname like 'ck_parcels_district%'")"

say "== re-apply after rollback =="
docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0004.sql >/dev/null 2>&1
chk "third apply exits 0" "0" "$?"

# ---- 6. the guards, on a copy where nothing has been applied yet ---------------
say "== abort cases (fresh copy, guards must fire) =="
maint "create database $DB_ABORT;" >/dev/null
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$DB_ABORT" --create-db --input "$DUMP" >/dev/null 2>&1

# 6a. a record whose district_code matches no registry row.
#
# The row is cloned from an existing parcel rather than written out column by column, because
# naming a column that does not exist made this INSERT fail silently and the guard was then
# never tested — the apply "passed" because there was nothing to abort on. Triggers are set to
# replica for the plant: 0003's sync trigger would otherwise reject an unregistered district
# before the migration could be observed rejecting it, which is the same technique
# test_integrity_gate.ts uses to plant defects the schema forbids.
docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<PLANT
set session_replication_role = replica;
create temp table ghost as select * from parcels where id = 'DH-JPR-RAM-001024';
update ghost set id = 'DH-XX-GHOST-1', district = 'ghostville', district_code = 'ghostville',
                 village = 'Ghostville', tehsil = 'Ghosttehsil', khasra_no = '999/1';
insert into parcels select * from ghost;
PLANT
PLANTED="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from parcels where district_code='ghostville'")"
chk "6a defect actually planted (guard has something to catch)" "1" "$PLANTED"

out=$(docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -f /tmp/0004.sql 2>&1); rc=$?
say "  6a unresolved district_code -> exit $rc"
say "$(echo "$out" | grep -E 'DISTRICT_UNRESOLVED|ghostville' | head -2 | sed 's/^/    /')"
chk "6a aborted rather than guessing" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "6a named the offending code in its report" "1" "$(echo "$out" | grep -c 'ghostville')"
chk "6a left the schema unchanged (no districts.id column)" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from information_schema.columns where table_name='districts' and column_name='id'")"
chk "6a left no demo tenant" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from organizations")"

# 6b. the demo tenant already exists under a different name (ghost row removed first, so the
#     abort reason can only be the identity conflict)
docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'CLEAN'
set session_replication_role = replica;
delete from parcels where id = 'DH-XX-GHOST-1';
insert into organizations (id,name) values ('ORG-DHAROHAR-DEMO','Some Other Name');
CLEAN
chk "6b conflicting tenant pre-seeded" "1" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from organizations where id='ORG-DHAROHAR-DEMO'")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -f /tmp/0004.sql 2>&1); rc=$?
say "  6b conflicting demo tenant identity -> exit $rc"
say "$(echo "$out" | grep -E 'DEMO_TENANT_IDENTITY_CONFLICT' | head -1 | sed 's/^/    /')"
chk "6b aborted" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "6b did not create association rows" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select coalesce(count(*),0) from organization_districts" 2>/dev/null || echo 0)"

# 6c. rollback refuses once a real association exists
docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -q -c "delete from organizations where id='ORG-DHAROHAR-DEMO';" >/dev/null 2>&1
docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -q -v ON_ERROR_STOP=1 -f /tmp/0004.sql >/dev/null 2>&1
docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -q -c "
  insert into organizations (id,name) values ('ORG-REAL-1','A Real Organization');
  insert into organization_districts (organization_id,district_id,relationship,granted_by,reason)
  select 'ORG-REAL-1', d.id, 'administers', 'someone@department', 'Granted by a person, not by a migration.'
    from districts d where d.code='jaipur';
" >/dev/null 2>&1
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -f /tmp/rollback-0004.sql 2>&1); rc=$?
say "  6c rollback with a human-made grant -> exit $rc"
say "$(echo "$out" | grep -E 'ROLLBACK_REFUSED' | head -1 | sed 's/^/    /')"
chk "6c rollback refused instead of deleting a real grant" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"

# ---- cleanup -------------------------------------------------------------------
say "== cleanup =="
docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('$DB_OK','$DB_ABORT')" >/dev/null 2>&1
docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DB_OK" -c "drop database if exists $DB_ABORT" >/dev/null 2>&1
say "  dropped $DB_OK and $DB_ABORT"

say ""
say "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
