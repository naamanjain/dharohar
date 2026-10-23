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

# ---- 5c. migration 0006: record ownership, distinct from district jurisdiction --
# This section proves the *mechanics*: the columns and constraints appear, the assignment lands where
# its stated basis puts it, quarantine is real, the file is idempotent, and the rollback refuses
# before erasing a human decision. It does NOT prove row-level security behaves — this harness
# connects as the cluster superuser, which is the table owner and is exempt from policies. The
# behaviour of those policies against the actual runtime role is measured by
# scripts/test-authorization-on-copy.sh, which applies scripts/roles.sql first.
say "== apply 0006 (tenant ownership + row-level security) =="
docker cp server/src/db-draft/0006_tenant_ownership.sql $SCRATCH:/tmp/0006.sql >/dev/null
docker cp server/src/db-draft/rollback-0006.sql $SCRATCH:/tmp/rollback-0006.sql >/dev/null
CANON_PARCELS="$(q "select count(*) from parcels p join districts d on d.code = p.district_code and d.kind = 'canonical'")"
FIXTURE_PARCELS="$(q "select count(*) from parcels p join districts d on d.code = p.district_code and d.kind = 'retired'")"
say "  basis: $CANON_PARCELS parcel(s) in canonical districts, $FIXTURE_PARCELS under retired fixtures"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0006.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -16)"
chk "0006 apply exits 0" "0" "$rc"
chk "documents gained an owner column" "1" "$(q "select count(*) from information_schema.columns where table_name='land_documents' and column_name='organization_id'")"
chk "the three record tables enforce attribution structurally" "3" "$(q "select count(*) from pg_constraint where conname in ('ck_parcels_ownership_is_attributed','ck_land_documents_ownership_is_attributed','ck_users_ownership_is_attributed')")"
chk "four policies on each of the two root tables" "8" "$(q "select count(*) from pg_policies where tablename in ('parcels','land_documents')")"
chk "SELECT/INSERT/UPDATE/DELETE each covered on parcels" "4" "$(q "select count(distinct cmd) from pg_policies where tablename='parcels'")"
chk "row-level security enabled on both root tables" "2" "$(q "select count(*) from pg_class where relname in ('parcels','land_documents') and relrowsecurity")"
# The assignment must be exactly what its stated basis produces — not "some rows got an owner".
chk "every parcel in a canonical district is owned, and attributed" "$CANON_PARCELS" \
    "$(q "select count(*) from parcels p join districts d on d.code=p.district_code and d.kind='canonical' where p.organization_id='ORG-DHAROHAR-DEMO' and p.organization_granted_by='migration:0006' and length(btrim(p.organization_grant_reason))>=5")"
chk "fixture parcels were NOT assigned (owner decision 2026-10-19: isolated history)" "0" \
    "$(q "select count(*) from parcels p join districts d on d.code=p.district_code where d.kind<>'canonical' and p.organization_id is not null")"
# Quarantine has to be populated or "unowned rows stay invisible" is untested. Asserted as a premise,
# not assumed from the demo data set.
chk "premise: some parcels really are quarantined on this copy" "1" "$([ "$FIXTURE_PARCELS" -gt 0 ] && echo 1 || echo 0)"
chk "quarantined parcels are exactly the non-canonical ones" "$FIXTURE_PARCELS" \
    "$(q "select count(*) from parcels where organization_id is null")"
chk "documents with no district and no parcel are quarantined, not invented into a tenant" "1" \
    "$(q "select case when count(*)>0 then 1 else 0 end from land_documents where organization_id is null and district_code is null and parcel_id is null")"

BEFORE_6_RECOUNT="$(q "select count(*) filter (where organization_id is not null) from parcels")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0006.sql 2>&1); rc=$?
chk "0006 re-apply exits 0 (idempotent)" "0" "$rc"
chk "0006 re-apply assigned nothing further" "$BEFORE_6_RECOUNT" "$(q "select count(*) filter (where organization_id is not null) from parcels")"

say "== rollback of 0006 =="
# A guard that has never been broken is not a guard: stamp one row as a human decision and require the
# refusal before testing the clean path.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<'HUMAN'
update parcels set organization_granted_by='registrar@department.example',
                   organization_grant_reason='Assigned by a named person after review.'
         where id='DH-JPR-RAM-001024';
HUMAN
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/rollback-0006.sql 2>&1); rc=$?
say "  rollback with a human assignment -> exit $rc"
say "$(echo "$out" | grep -E 'ROLLBACK_REFUSED' | head -1 | sed 's/^/    /')"
chk "rollback refused to erase a human ownership decision" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<'RESTORE'
update parcels set organization_granted_by='migration:0006' where id='DH-JPR-RAM-001024';
RESTORE
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0006.sql 2>&1); rc=$?
# Print the failure, not just its exit code: this rollback was red for a statement in its own report
# block, and a bare "want 0, got 3" gave no way to find that without re-running by hand.
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -8)"
chk "rollback-0006 exits 0 once the human row is accounted for" "0" "$rc"
chk "policies gone" "0" "$(q "select count(*) from pg_policies where tablename in ('parcels','land_documents')")"
chk "row-level security disabled again" "0" "$(q "select count(*) from pg_class where relname in ('parcels','land_documents') and relrowsecurity")"
chk "documents owner column removed" "0" "$(q "select count(*) from information_schema.columns where table_name='land_documents' and column_name='organization_id'")"
chk "attribution columns removed from all three tables" "0" "$(q "select count(*) from information_schema.columns where column_name='organization_granted_by'")"
# After a clean rollback nothing is owned — not just the rows 0006 assigned, but the fixtures that
# were already unowned too. The expected number is therefore the whole table, not CANON_PARCELS; the
# first version of this line asserted 25 and reported 37, which was the assertion being wrong.
chk "ownership released back to quarantine across the whole table" "$(q "select count(*) from parcels")" \
    "$(q "select count(*) from parcels where organization_id is null")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0006.sql 2>&1); rc=$?
chk "0006 re-applies after rollback" "0" "$rc"

# ---- 5d. migration 0007: a declaration is not canonical geography --------------
say "== apply 0007 (declaration workflow) =="
docker cp server/src/db-draft/0007_declaration_is_not_geography.sql $SCRATCH:/tmp/0007.sql >/dev/null
docker cp server/src/db-draft/rollback-0007.sql $SCRATCH:/tmp/rollback-0007.sql >/dev/null
CANON_BEFORE="$(q "select count(*) from districts where kind='canonical'")"
RETIRED_BEFORE="$(q "select count(*) from districts where kind='retired'")"
RJ_BEFORE="$(q "select count(*) from districts where state_code='RJ'")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0007.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -10)"
chk "0007 apply exits 0" "0" "$rc"
chk "a new declaration no longer defaults to canonical" "'candidate'::text" \
    "$(q "select column_default from information_schema.columns where table_name='districts' and column_name='kind'")"
chk "candidate is in the domain" "1" "$(q "select count(*) from pg_constraint where conname='ck_districts_kind_domain'")"
# Phase 2 says explicitly: preserve 0005 and the owner's RJ mapping. Asserted as unchanged counts,
# not as "the migration reported success".
chk "0007 promoted nothing on its own" "$CANON_BEFORE" "$(q "select count(*) from districts where kind='canonical'")"
chk "0007 un-retired nothing" "$RETIRED_BEFORE" "$(q "select count(*) from districts where kind='retired'")"
chk "the four RJ mappings survived 0007" "$RJ_BEFORE" "$(q "select count(*) from districts where state_code='RJ'")"
declare_res=$(docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -tA -f /dev/stdin 2>&1 <<'DECL'
insert into districts (code, name, provenance) values ('harness 07 declare', 'Harness 07 Declare', 'declared');
select 'kind=' || kind from districts where code = 'harness 07 declare';
delete from districts where code = 'harness 07 declare';
DECL
)
chk "the ordinary declare path lands as candidate, not geography" "kind=candidate" \
    "$(echo "$declare_res" | grep -o 'kind=[a-z_]*' | head -1)"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0007.sql 2>&1); rc=$?
chk "0007 re-apply exits 0 (idempotent)" "0" "$rc"

say "== rollback of 0007 =="
# Guard first, deliberately: while a candidate exists the old domain would reject the row, and the
# operator must be told that as a decision rather than as a constraint error.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<'CAND'
insert into districts (code, name, provenance) values ('harness 07 pending', 'Harness 07 Pending', 'declared');
CAND
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/rollback-0007.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ROLLBACK_REFUSED' | head -1 | sed 's/^/    /')"
chk "rollback refused while a candidate is unresolved" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "the refusal named the pending district" "1" "$(echo "$out" | grep -c 'harness 07 pending')"
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q >/dev/null 2>&1 <<'CLEAR'
delete from districts where code = 'harness 07 pending';
CLEAR
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0007.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ERROR' | head -3 | sed 's/^/    /')"
chk "rollback-0007 exits 0 once the queue is clear" "0" "$rc"
chk "default restored to canonical" "'canonical'::text" \
    "$(q "select column_default from information_schema.columns where table_name='districts' and column_name='kind'")"
chk "0004's own constraint name restored" "1" "$(q "select count(*) from pg_constraint where conname='districts_kind_check'")"
chk "candidate no longer in the domain" "0" "$(q "select count(*) from pg_constraint where conname='ck_districts_kind_domain'")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0007.sql 2>&1); rc=$?
chk "0007 re-applies after rollback" "0" "$rc"

# ---- 5e. migration 0008: audit actor attribution ------------------------------
say "== apply 0008 (audit actor attribution) =="
AUDIT_BEFORE="$(q "select count(*) from append_only_audit_logs")"
docker cp server/src/db-draft/0008_audit_actor_attribution.sql $SCRATCH:/tmp/0008.sql >/dev/null
docker cp server/src/db-draft/rollback-0008.sql $SCRATCH:/tmp/rollback-0008.sql >/dev/null
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0008.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -4)"
chk "0008 apply exits 0" "0" "$rc"
chk "the two attribution columns exist" "2" "$(q "select count(*) from information_schema.columns where table_name='append_only_audit_logs' and column_name in ('actor_user_id','actor_organization_id')")"
# Additive means the chain is untouched: same row count, same hashes. Asserting the count alone would
# not catch a rewrite, so the hash sum is compared too.
HASH_BEFORE="$(q "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs")"
AUDIT_AFTER="$(q "select count(*) from append_only_audit_logs")"
chk "0008 wrote no audit rows and deleted none" "$AUDIT_BEFORE" "$AUDIT_AFTER"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0008.sql 2>&1); rc=$?
chk "0008 re-apply exits 0 (idempotent)" "0" "$rc"
chk "the chain still hashes to the same value after a re-apply" "$HASH_BEFORE" \
    "$(q "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0008.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ERROR' | head -2 | sed 's/^/    /')"
chk "rollback-0008 exits 0" "0" "$rc"
chk "columns removed again" "0" "$(q "select count(*) from information_schema.columns where table_name='append_only_audit_logs' and column_name in ('actor_user_id','actor_organization_id')")"
chk "the audit table itself was not emptied by the rollback" "$AUDIT_BEFORE" "$(q "select count(*) from append_only_audit_logs")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0008.sql 2>&1); rc=$?
chk "0008 re-applies after rollback" "0" "$rc"

# ---- 5f. migration 0009: a child record inherits its parcel's tenant -----------
say "== apply 0009 (child tables inherit the parent policy) =="
docker cp server/src/db-draft/0009_child_records_inherit_tenant_scope.sql $SCRATCH:/tmp/0009.sql >/dev/null
docker cp server/src/db-draft/rollback-0009.sql $SCRATCH:/tmp/rollback-0009.sql >/dev/null
CHILD_BEFORE="$(q "select (select count(*) from parcel_owners)||'/'||(select count(*) from parcel_mutations)")"
ORPHANS="$(q "select (select count(*) from parcel_owners o where not exists (select 1 from parcels p where p.id=o.parcel_id))
                 + (select count(*) from parcel_mutations m where not exists (select 1 from parcels p where p.id=m.parcel_id))
                 + (select count(*) from field_inspections i where not exists (select 1 from parcels p where p.id=i.parcel_id))")"
say "  child rows before (owners/mutations): $CHILD_BEFORE"
chk "premise: the copy holds child rows for the policy to cover" "1" "$([ "${CHILD_BEFORE%%/*}" -gt 0 ] && echo 1 || echo 0)"
# Rows with no parent would silently vanish from every tenant's view the moment the parent-exists
# predicate goes in. Measured rather than assumed, on this copy, before the change.
chk "no child row is orphaned (nothing becomes unreachable by accident)" "0" "$ORPHANS"

out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0009.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'NOTICE|ERROR' | sed 's/^/    /' | tail -8)"
chk "0009 apply exits 0" "0" "$rc"
chk "the three child tables are under row-level security" "3" \
    "$(q "select count(*) from pg_class where relname in ('parcel_owners','parcel_mutations','field_inspections') and relrowsecurity")"
chk "twelve policies were created" "12" \
    "$(q "select count(*) from pg_policies where tablename in ('parcel_owners','parcel_mutations','field_inspections')")"
# Every policy names the parent test rather than a tenant comparison of its own — that is the whole
# design: one definition of tenancy, inherited. Asserted from the stored expression, not from prose.
chk "every child policy filters through parcels" "12" \
    "$(q "select count(*) from pg_policies where tablename in ('parcel_owners','parcel_mutations','field_inspections') and (qual like '%parcels p%' or with_check like '%parcels p%')")"
chk "all of them apply to the runtime role only" "12" \
    "$(q "select count(*) from pg_policies where tablename in ('parcel_owners','parcel_mutations','field_inspections') and roles = ARRAY['dharohar_app']::name[]")"
chk "no command carries two policies (permissive OR would widen it)" "0" \
    "$(q "select count(*) from (select tablename, cmd from pg_policies where tablename in ('parcel_owners','parcel_mutations','field_inspections') group by 1,2 having count(*)>1) d")"
chk "0009 deleted no child row" "$CHILD_BEFORE" \
    "$(q "select (select count(*) from parcel_owners)||'/'||(select count(*) from parcel_mutations)")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0009.sql 2>&1); rc=$?
chk "0009 re-apply exits 0 (idempotent)" "0" "$rc"

say "== 0009's guard, broken on purpose =="
# Remove the parent policy and re-apply: 0009 must refuse rather than install a child policy that
# inherits from nothing — which would look like protection and filter on an unenforced rule.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q -c "drop policy tenant_select_land_documents on land_documents" >/dev/null 2>&1
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/0009.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'TENANCY_PARENT_POLICY_MISSING' | head -1 | sed 's/^/    /')"
chk "0006 removed means 0009 refuses" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "and names the table it could not inherit from" "1" "$(echo "$out" | grep -c 'land_documents')"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/rollback-0009.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ERROR' | head -2 | sed 's/^/    /')"
chk "the aborted apply left nothing to roll back, so rollback is still clean" "0" "$rc"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0006.sql 2>&1); rc=$?
chk "0006 re-applied to restore the parent policy" "0" "$rc"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0009.sql 2>&1); rc=$?
chk "0009 then applies again" "0" "$rc"

say "== rollback of 0009 =="
# A policy 0009 did not create must stop the rollback: dropping "the 0009 policies" while someone
# else's rule guards the same rows would quietly leave that rule in charge.
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q -c "create policy hand_written on parcel_owners for select to dharohar_app using (true)" >/dev/null 2>&1
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -f /tmp/rollback-0009.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ROLLBACK_REFUSED' | head -1 | sed 's/^/    /')"
chk "rollback refused while a foreign policy exists" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "and it named the policy" "1" "$(echo "$out" | grep -c 'hand_written')"
chk "nothing was dropped by the refused rollback" "5" \
    "$(q "select count(*) from pg_policies where tablename='parcel_owners'")"
docker exec -i $SCRATCH psql -U postgres -d "$DB_OK" -q -c "drop policy hand_written on parcel_owners" >/dev/null 2>&1
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/rollback-0009.sql 2>&1); rc=$?
say "$(echo "$out" | grep -E 'ERROR' | head -2 | sed 's/^/    /')"
chk "rollback-0009 exits 0 once the foreign policy is gone" "0" "$rc"
chk "no policies remain on the child tables" "0" \
    "$(q "select count(*) from pg_policies where tablename in ('parcel_owners','parcel_mutations','field_inspections')")"
chk "row-level security is off again on all three" "0" \
    "$(q "select count(*) from pg_class where relname in ('parcel_owners','parcel_mutations','field_inspections') and relrowsecurity")"
chk "the rollback deleted no rows" "$CHILD_BEFORE" \
    "$(q "select (select count(*) from parcel_owners)||'/'||(select count(*) from parcel_mutations)")"
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_OK" -q -v ON_ERROR_STOP=1 -f /tmp/0009.sql 2>&1); rc=$?
chk "0009 re-applies after rollback" "0" "$rc"
chk "and the parent policies survived the whole cycle" "8" \
    "$(q "select count(*) from pg_policies where tablename in ('parcels','land_documents')")"

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

# 6d. 0006's assignment basis is "this environment has exactly one tenant". Once a second
#     organization exists — which is precisely the situation a real deployment creates — that basis is
#     gone, and the file must stop rather than guess which tenant owns each record. DB_ABORT already
#     holds ORG-REAL-1 from 6c, so the condition is real data, not a mocked premise.
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -f /tmp/0006.sql 2>&1); rc=$?
say "  6d a second tenant present -> exit $rc"
say "$(echo "$out" | grep -E 'TENANCY_AMBIGUOUS_TENANT|ORG-REAL-1' | head -2 | sed 's/^/    /')"
chk "6d aborted rather than guessing an owner" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "6d named the competing organization" "1" "$(echo "$out" | grep -c 'ORG-REAL-1')"
chk "6d left the documents table untouched (no organization_id column)" "0" \
    "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from information_schema.columns where table_name='land_documents' and column_name='organization_id'")"
chk "6d left every record unowned" "0" "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select count(*) from parcels where organization_id is not null")"

# 6e. 0007 states which migrations it is built on. On this copy neither 0005 nor 0006 has been applied,
#     so it must refuse rather than half-apply — a registry whose kind domain changed underneath an
#     un-migrated key would be the exact half-state this ordering guard exists to prevent.
docker cp server/src/db-draft/0007_declaration_is_not_geography.sql $SCRATCH:/tmp/0007.sql >/dev/null
out=$(docker exec $SCRATCH psql -U postgres -d "$DB_ABORT" -f /tmp/0007.sql 2>&1); rc=$?
say "  6e 0007 ahead of its requirements -> exit $rc"
say "$(echo "$out" | grep -E 'REQUIREMENT_MISSING' | head -1 | sed 's/^/    /')"
chk "6e aborted because 0005/0006 are missing" "3" "$([ $rc -ne 0 ] && echo 3 || echo 0)"
chk "6e named the missing requirement" "1" "$(echo "$out" | grep -c 'REQUIREMENT_MISSING')"
chk "6e left the kind default alone" "'canonical'::text" \
    "$(docker exec -i $SCRATCH psql -U postgres -d "$DB_ABORT" -tA -c "select column_default from information_schema.columns where table_name='districts' and column_name='kind'")"

# ---- cleanup -------------------------------------------------------------------
say "== cleanup =="
docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('$DB_OK','$DB_ABORT')" >/dev/null 2>&1
docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DB_OK" -c "drop database if exists $DB_ABORT" >/dev/null 2>&1
say "  dropped $DB_OK and $DB_ABORT"

say ""
say "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
