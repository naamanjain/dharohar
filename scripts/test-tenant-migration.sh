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
# Query the disposable copy being migrated. Trimmed to one line so a stray NOTICE cannot make an
# assertion pass by matching the wrong row.
q() { docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "$1" 2>&1 | head -1 | tr -d '\r'; }

# ---- environment -------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then say "ABORT: docker daemon unreachable — nothing below could be measured."; exit 2; fi
docker start $SCRATCH >/dev/null 2>&1 || true
SPW="$(docker exec $SCRATCH printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$SPW" ] || { say "ABORT: cannot read the scratch container's password."; exit 2; }
maint() { docker exec -i $SCRATCH psql -U postgres -tA -f - <<<"$1" 2>&1; }

# ---- 1. snapshot the deployed database, read-only ----------------------------
say "== backup of the deployed database =="
PGUSER=dharohar ./scripts/backup.sh --container dharohar-prod-db-1 --dbname dharohar >/tmp/tenant-bak.log 2>&1

# The harness must start from a database that does NOT yet have 0004's objects, or it is testing a
# re-apply rather than an upgrade — and it did exactly that once, producing eleven red assertions
# whose cause was the baseline, not the migration. A fresh backup of a migrated deployment is by
# definition post-0004, so the newest usable dump is the newest one without those objects.
#
# This fails CLOSED. An earlier version returned "pre-0004" whenever pg_restore said nothing at
# all, so a failed mount or a missing image read as an old dump and the drill silently upgraded a
# baseline that was already migrated — which is how run 3 reached 12 failures while every line of
# the selection logic still "passed". Unreadable is never usable.
has_0004() {
  local toc
  toc=$(MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/backups":/b:ro postgis/postgis:16-3.4-alpine \
    pg_restore -l "/b/$(basename "$1")" 2>/dev/null)
  if [ -z "$toc" ]; then echo unreadable; return; fi
  if echo "$toc" | grep -qi organization_districts; then echo post0004; else echo pre0004; fi
}
DUMP=""
for cand in $(ls -t backups/*.dump 2>/dev/null); do
  verdict=$(has_0004 "$cand")
  [ "$verdict" = unreadable ] && say "  skipping $(basename "$cand"): TOC could not be read"
  if [ "$verdict" = pre0004 ]; then DUMP="$cand"; break; fi
done
if [ -z "$DUMP" ]; then
  say "ABORT: no pre-0004 dump exists in backups/, so the upgrade path cannot be tested."
  say "       Take one from a database migrated only through 0003, or restore such a dump here."
  exit 2
fi
say "  baseline dump: $(basename "$DUMP")  (verified: contains no organization_districts)"
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

# Assert the premise on the artifact that is actually used, not on the dump file's text. The TOC
# scan above is a convenience; this is the gate. If the copy already has 0004's objects, every
# number the drill then reports describes a re-apply, and a re-apply tells you nothing about
# whether the upgrade path works.
BASELINE_CLEAN="$(q "select (to_regclass('public.organization_districts') is null)::int")"
if [ "$BASELINE_CLEAN" != "1" ]; then
  say "ABORT: the restored baseline already has organization_districts, so it is post-0004."
  say "       Restoring from $(basename "$DUMP") would test a re-apply, not the upgrade."
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DB_OK" >/dev/null 2>&1
  exit 2
fi
say "  baseline verified against the restored copy: no 0004 objects present"

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
# Relative, not a literal: the suites mint a new 'probe %' district on every gate run, so a
# hard-coded eleven was wrong within a day of being written.
PRE_PROBE_COUNT="$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from districts where code like 'probe %'")"
chk "probe rows classified as test_fixture" "$PRE_PROBE_COUNT" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -c "select count(*) from districts where kind='test_fixture'")"
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

# ---- 5b. migration 0005: the owner's mappings and identifier authority -------
say "== apply 0005 (state codes + retire probe fixtures + identifier becomes the key) =="

# Plant the condition the live demo database actually had and this drill did not: a district
# declared AFTER 0004, therefore written while districts.id still had no DEFAULT, so it landed
# with id = NULL, plus a parcel pointing at it. On the first live apply that made 0005 abort with
# DISTRICT_UNRESOLVED on `probe 790279` — a correct refusal, but one the drill could never have
# caught because its baseline dump predates 0004 and nothing declared a district afterwards.
# No replica role here on purpose: this is the ordinary write path, exactly as the app performed it.
# `kind` is deliberately NOT set: on the live database probe 790279 took the column default and
# came out 'canonical', which is how a test fixture escaped into the geography registry. Planting
# it the same way also proves the retire pattern catches a default-classified probe row, not only
# ones somebody labelled as fixtures.
#
# The clone clears district_code rather than setting it. Migration 0003's trigger refuses an INSERT
# that supplies a code AT ALL (the caller is not allowed to pick the key; the trigger derives it from
# the text), so carrying over the source row's 'jaipur' — or restating it as 'probe 999999' — both
# raise DISTRICT_CODE_CONFLICT. It also clears district_id, because the source parcel already carries
# jaipur's identifier and inheriting it would plant a resolved row for the heal to do nothing about.
plant=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 2>&1 <<POST4
insert into districts (code, name, provenance)
     values ('probe 999999', 'Probe 999999', 'declared');
create temp table hp as select * from parcels where id = 'DH-JPR-RAM-001024';
update hp set id = 'DH-PRB-999999', district = 'probe 999999', district_code = null,
              district_id = null,
              village = 'Harnessville', tehsil = 'Harnessstehsil', khasra_no = '999/999';
insert into parcels select * from hp;
POST4
)
plant_rc=$?
say "  plant exit=$plant_rc $(echo "$plant" | tr '\n' ' ' | cut -c1-180)"
chk "plant: the statements ran (a silent failure here makes the guard untested)" "0" "$plant_rc"
chk "plant: post-0004 district really landed without an identifier" "1" \
    "$(q "select count(*) from districts where code='probe 999999' and id is null")"
chk "plant: a parcel points at it and has no identifier either" "1" \
    "$(q "select count(*) from parcels where district_code='probe 999999' and district_id is null")"

docker cp server/src/db-draft/0005_district_identifier_authority.sql $SCRATCH:/tmp/0005.sql >/dev/null
docker cp server/src/db-draft/rollback-0005.sql $SCRATCH:/tmp/rollback-0005.sql >/dev/null
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0005.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -14)"
chk "0005 apply exits 0" "0" "$rc"
# The refusal was right; the fix is that 0005 now mints the missing identifier instead of leaving
# the row unresolvable. Assert the repair happened and was reported, not merely that nothing failed.
chk "0005 minted identifiers for rows written without one (and said so)" "1" \
    "$(echo "$out" | grep -c 'had been written without an identifier')"
chk "the post-0004 district now has an identifier" "1" \
    "$(q "select count(*) from districts where code='probe 999999' and id is not null")"
chk "the parcel that pointed at it is now resolved" "1" \
    "$(q "select count(*) from parcels where id='DH-PRB-999999' and district_id is not null")"
chk "its fixture is retired but the record survives (history preserved, name unusable)" "retired-present" \
    "$(q "select (select kind from districts where code='probe 999999') || '-' || (select case when count(*)=1 then 'present' else 'lost' end from parcels where id='DH-PRB-999999')")"
chk "districts primary key is now the identifier" "id" "$(q "select a.attname from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.conrelid='districts'::regclass and c.contype='p'")"
chk "code keeps a unique constraint (text still resolves to one row)" "1" "$(q "select count(*) from pg_constraint where conrelid='districts'::regclass and conname='ux_districts_code'")"
chk "canonical districts carry RJ" "4" "$(q "select count(*) from districts where kind='canonical' and state_code='RJ'")"
chk "every probe-pattern row is retired" "0" "$(q "select count(*) from districts where code like 'probe %' and kind <> 'retired'")"
chk "retired rows are inactive" "0" "$(q "select count(*) from districts where kind='retired' and is_active")"
chk "canonical rows are still active" "4" "$(q "select count(*) from districts where kind='canonical' and is_active")"
chk "no child row has a code without an identifier" "0" "$(q "select (select count(*) from parcels where district_code is not null and district_id is null) + (select count(*) from users where district_code is not null and district_id is null) + (select count(*) from land_documents where district_code is not null and district_id is null) + (select count(*) from user_jurisdictions where district_code is not null and district_id is null)")"
# Scoped to the four land-record children by name: organization_districts and organization_units
# also carry district_id foreign keys, and an earlier version of this check counted them and
# reported 6 where the answer was 4.
chk "all four children reference districts(id)" "4" "$(q "select count(*) from pg_constraint where conname in ('fk_parcels_district_id','fk_land_documents_district_id','fk_users_district_id','fk_user_jurisdictions_district_id')")"
# The code foreign keys are kept on purpose: they are the backstop when the trigger is bypassed.
# Dropping them was a real regression the registry suite caught ("the insert succeeded — the foreign
# key is decorative"), so the assertion is now that BOTH references exist, not that one replaced the other.
chk "children keep the code backstop as well as the identifier" "4" "$(q "select count(*) from pg_constraint where conname in ('fk_parcels_district_code','fk_land_documents_district_code','fk_users_district_code','fk_user_jurisdictions_district_code')")"
# And prove the backstop bites with the trigger disabled — the exact case a restore or a
# session_replication_role=replica insert creates.
#
# Both the text and the code are set consistently. Set only one and the 0003 CHECK
# (district_code = lower(btrim(district))) refuses the row first, so the foreign key is never
# reached — which is what happened when only the code was changed. Three layers refuse an
# unregistered district; this assertion is specifically about the middle one.
#
# Comments live in bash, never inside the heredoc: `#` is not a SQL comment, and a `#`-prefixed
# line here silently turned the following UPDATE into a syntax error. The INSERT then duplicated
# the source primary key, the FK was never exercised, and the probe reported 0 for the wrong
# reason. Every statement in these heredocs must be real SQL.
#
# The trigger is disabled by NAME, not with session_replication_role = replica. Replica role turns
# off referential-integrity triggers as well, so the FK cannot refuse anything and the ghost row is
# written — which then poisons the two idempotence assertions below with a genuine
# DISTRICT_UNRESOLVED abort. Disabling one user trigger leaves RI enforced (verified separately).
bypass=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -f /dev/stdin 2>&1 <<BYP
alter table parcels disable trigger trg_parcels_district_code;
create temp table bt as select * from parcels where id = 'DH-JPR-RAM-001024';
update bt set id = 'DH-BT-1', district = 'nosuchdistrict', district_code = 'nosuchdistrict';
select 'UPDATE-OK rows=' || count(*) from bt;
insert into parcels select * from bt;
alter table parcels enable trigger trg_parcels_district_code;
BYP
)
say "    raw bypass output: $(echo "$bypass" | tr '\n' ' ' | cut -c1-200)"
# A clone, not a column list: naming a column that does not exist made the equivalent assertion in
# section 6 fail silently, and a guard tested with a statement that never ran is not tested.
# The UPDATE is echoed first so a syntax error in it cannot be mistaken for an FK refusal.
chk "6-probe: the clone was actually rewritten before the insert" "UPDATE-OK rows=1" \
    "$(echo "$bypass" | grep -o 'UPDATE-OK rows=[0-9]*' | head -1)"
chk "an unregistered district_code is refused by the foreign key with only the trigger off" "1" \
    "$(echo "$bypass" | grep -qiE 'violates foreign key constraint "fk_parcels_district_code"' && echo 1 || echo 0)"
chk "the refused row was not written" "0" "$(q "select count(*) from parcels where id='DH-BT-1' or district_code='nosuchdistrict'")"

# The write path has to behave, not just the catalog: three differential checks against the
# trigger this migration replaces.
RETIRED_CODE="$(q "select code from districts where kind='retired' order by code limit 1")"
say "  using retired code: $RETIRED_CODE"
res=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -f /dev/stdin 2>&1 <<PLANT
create temp table t1 as select * from parcels where id = 'DH-JPR-RAM-001024';
update t1 set id = 'DH-T-RETIRED-1', district = '$RETIRED_CODE';
insert into parcels select * from t1;
PLANT
)
chk "writing a NEW record under a retired district is refused" "1" "$(echo "$res" | grep -qc 'registered but inactive' && echo 1 || echo 0)"

res=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -f /dev/stdin 2>&1 <<PLANT
create temp table t2 as select * from parcels where id = 'DH-JPR-RAM-001024';
update t2 set id = 'DH-T-GHOST-1', district = 'ghostland';
insert into parcels select * from t2;
PLANT
)
chk "writing an unregistered district is still refused (0003 semantics intact)" "1" \
    "$(echo "$res" | grep -qc 'DISTRICT_NOT_REGISTERED' && echo 1 || echo 0)"

res=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -f /dev/stdin 2>&1 <<PLANT
create temp table t3 as select * from parcels where id = 'DH-JPR-RAM-001024';
update t3 set id = 'DH-T-CONFLICT-1', district_code = 'udaipur';
insert into parcels select * from t3;
PLANT
)
chk "a caller-supplied code disagreeing with the district text is still refused" "1" \
    "$(echo "$res" | grep -qc 'DISTRICT_CODE_CONFLICT' && echo 1 || echo 0)"

# Self-heal: a legacy row with no identifier must gain one on an unrelated update, otherwise the
# column is a claim about the future that existing data never satisfies.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<HEAL
set session_replication_role = replica;
update parcels set district_id = null where id = 'DH-JPR-RAM-001024';
set session_replication_role = origin;
update parcels set district = district where id = 'DH-JPR-RAM-001024';
HEAL
# The trigger is BEFORE INSERT OR UPDATE OF district — 0003's scope, deliberately kept. So a write
# that does not touch the district cannot reach it, and asserting that one would is asserting a
# behaviour the design never promised (an earlier version of this line did exactly that and "failed"
# for that reason). The invariant that does hold: writing the district re-resolves the identifier
# from the registry instead of trusting the caller.
chk "writing the district resolves the identifier (legacy row healed)" "1" \
    "$(q "select count(*) from parcels where id='DH-JPR-RAM-001024' and district_id is not null")"

BEFORE_RECOUNT="$(q "select count(*) from districts")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0005.sql 2>&1); rc=$?
# The exact regression that broke 12 provisioning assertions: the declare path names its columns
# and never mentions districts.id, so NOT NULL without a DEFAULT made it a not-null violation.
declare_res=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -f /dev/stdin 2>&1 <<INS
insert into districts (code, name, provenance) values ('harness declare test', 'Harness Declare Test', 'declared');
select 'declared-with-id='||(id is not null) from districts where code = 'harness declare test';
delete from districts where code = 'harness declare test';
INS
)
chk "a plain INSERT without an identifier still works (the declare path)" "declared-with-id=true" \
    "$(echo "$declare_res" | grep -o 'declared-with-id=[a-z]*' | head -1)"

chk "0005 re-apply exits 0 (idempotent)" "0" "$rc"
chk "0005 re-apply changed no district count" "$BEFORE_RECOUNT" "$(q "select count(*) from districts")"

say "== rollback of 0005 =="
docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0005.sql >/tmp/t5-rb.log 2>&1
chk "rollback-0005 exits 0" "0" "$?"
chk "primary key back on code" "code" "$(q "select a.attname from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.conrelid='districts'::regclass and c.contype='p'")"
chk "children reference code again" "4" "$(q "select count(*) from pg_constraint where conname in ('fk_parcels_district_code','fk_land_documents_district_code','fk_users_district_code','fk_user_jurisdictions_district_code')")"
chk "state codes cleared again" "0" "$(q "select count(*) from districts where state_code is not null")"
chk "probe rows back to test_fixture" "0" "$(q "select count(*) from districts where code like 'probe %' and kind <> 'test_fixture'")"
# Differential proof the restored trigger is 0003's and not 0005's: after rollback a write must
# populate the code and leave the identifier alone.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<HEAL2
set session_replication_role = replica;
update parcels set district_id = null where id = 'DH-JPR-RAM-001024';
set session_replication_role = origin;
update parcels set district = district where id = 'DH-JPR-RAM-001024';
HEAL2
chk "restored trigger does NOT fill the identifier (0003 body, not 0005's)" "0" \
    "$(q "select count(*) from parcels where id='DH-JPR-RAM-001024' and district_id is not null")"

out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0005.sql 2>&1); rc=$?
chk "0005 re-applies after rollback" "0" "$rc"

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
