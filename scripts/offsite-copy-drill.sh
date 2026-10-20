#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — second-location backup drill
#
# Proves that a dump taken from the deployed database can be copied somewhere else, verified by
# checksum, and RESTORED FROM THAT COPY into a new database with its payload bytes intact. It exists
# because "the backup is on the same disk as the database" is not disaster recovery, and because the
# only way to know an archive is restorable is to restore it.
#
# WHAT THIS PROVES AND WHAT IT DOES NOT
#   Proved: the archive is portable, its checksum survives the copy, the copy restores into a separate
#           database, record counts and geometry validity match, and a document's bytes hash to the
#           same value in the restored copy as in the deployed one.
#   NOT proved: that <dest> is a different physical machine. Run it with --dest pointing at an
#           rclone mount, a second server, or a cloud-synced folder that leaves this box, and the
#           off-machine claim becomes true. On a laptop path it is a procedure test only, and this
#           script says so in its own output rather than letting a reader infer it.
#
# USAGE
#   ./scripts/offsite-copy-drill.sh --dest "D:/dharohar-backups" [--container dharohar-prod-db-1]
#
# Exit: 0 all checks passed, 1 a check failed, 2 the environment is missing something.
# Nothing here writes to the deployed database. The restore target is a new database on the scratch
# PostGIS container, dropped at the end.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

DEST=""
DB_CONTAINER=dharohar-prod-db-1
SCRATCH=dharohar-audit-pg
FAILED=0
DRILL_DB=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --container) DB_CONTAINER="$2"; shift 2 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done
[ -n "$DEST" ] || { echo "  ABORT: --dest is required (a location outside the repository directory)."; exit 2; }

say() { echo "  $1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; else echo "  FAIL  $1 (want $2, got $3)"; FAILED=$((FAILED+1)); fi; }
q()   { docker exec -i "$DB_CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\"" 2>&1 | tail -1; }
qq()  { docker exec -i $SCRATCH psql -U postgres -d "$DRILL_DB" -tA -c "$1" 2>&1 | tail -1; }

cleanup() {
  [ -n "$DRILL_DB" ] || return
  docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DRILL_DB'" >/dev/null 2>&1
  docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DRILL_DB" >/dev/null 2>&1 && say "dropped the drill database $DRILL_DB"
}
trap cleanup EXIT

# ---- 1. take the dump --------------------------------------------------------
echo "== take a fresh dump of the deployed database (read-only) =="
PGUSER=dharohar ./scripts/backup.sh --container "$DB_CONTAINER" --dbname dharohar --output backups >/tmp/drill-backup.log 2>&1 \
  || { say "ABORT: backup failed"; tail -6 /tmp/drill-backup.log; exit 2; }
DUMP="$(ls -t backups/*.dump | head -1)"
BASE="$(basename "$DUMP")"
chk "dump taken" "1" "$([ -s "$DUMP" ] && echo 1 || echo 0)"
say "  source: $BASE ($(wc -c < "$DUMP") bytes)"

# ---- 2. copy it somewhere else, and verify the copy -------------------------
echo ""
echo "== copy to the second location =="
mkdir -p "$DEST" || { say "ABORT: cannot create $DEST"; exit 2; }
cp "$DUMP" "$DEST/$BASE" && cp "backups/$BASE.sha256" "$DEST/$BASE.sha256"
chk "archive copied" "1" "$([ -s "$DEST/$BASE" ] && echo 1 || echo 0)"
SRC_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
DST_SHA="$(sha256sum "$DEST/$BASE" | cut -d' ' -f1)"
chk "the copy hashes to the same value as the original" "$SRC_SHA" "$DST_SHA"
( cd "$DEST" && sha256sum -c "$BASE.sha256" >/tmp/drill-verify.log 2>&1 )
chk "the sidecar verifies the copied archive" "0" "$?"
case "$DEST" in
  *[Dd]esktop*|*[Oo]ne[Dd]rive*|*backups) say "  note  --dest is on this machine's own storage. The procedure is proved; off-machine durability is NOT." ;;
  *) say "  note  --dest looks like a separate location: $DEST" ;;
esac

# ---- 3. restore FROM THE COPY into a new database ----------------------------
echo ""
echo "== restore from the second-location copy =="
DRILL_DB="drill_copy_$$"
docker exec $SCRATCH psql -U postgres -q -c "create database $DRILL_DB" >/dev/null 2>&1
# The copy path is converted to a container-visible one: /tmp on Git Bash is not /tmp for docker.
docker cp "$DEST/$BASE" $SCRATCH:/tmp/drill.dump >/dev/null 2>&1
# cygpath converts /d/... to D:/... because docker.exe is a native Windows binary and cannot read a
# MSYS mount path — the failure otherwise looks like a corrupt archive ("docker cp in failed").
HOST_DUMP="$DEST/$BASE"
command -v cygpath >/dev/null 2>&1 && HOST_DUMP="$(cygpath -w "$DEST/$BASE")"
PGUSER=postgres ./scripts/restore.sh --container $SCRATCH --dbname "$DRILL_DB" --create-db --input "$HOST_DUMP" >/tmp/drill-restore.log 2>&1
chk "restore from the copy completed" "0" "$?"

echo ""
echo "== compare the deployed database with the restored copy =="
for t in parcels users land_documents districts organization_districts; do
  chk "$t row count matches" "$(q "select count(*) from $t")" "$(qq "select count(*) from $t")"
done
# The payload, not just the row: a dump that restores empty text columns would pass a count check.
chk "document bytes are present in the restored copy" "$(q "select count(*) from land_documents where length(coalesce(image_uri,'')) > 100000")" \
                                          "$(qq "select count(*) from land_documents where length(coalesce(image_uri,'')) > 100000")"
BIG="$(q "select id from land_documents where length(coalesce(image_uri,'')) > 100000 order by uploaded_at desc limit 1" | tr -d '[:space:]')"
if [ -n "$BIG" ]; then
  # Compare the digests as values and print them. The first version of this line passed while both
  # sides were an empty-ish fragment of psql's output — a vacuous comparison, not a proof that the
  # payload survived. A digest that is not 32 hex characters is now reported as a failure.
  SRC_HASH="$(q "select md5(image_uri) from land_documents where id='$BIG'" | tr -d '[:space:]')"
  DST_HASH="$(qq "select md5(image_uri) from land_documents where id='$BIG'" | tr -d '[:space:]')"
  say "  payload $BIG: source=$SRC_HASH restored=$DST_HASH"
  chk "the source digest is a real md5 before anything is compared" "32" "${#SRC_HASH}"
  chk "the largest payload hashes identically after the round trip" "$SRC_HASH" "$DST_HASH"
else
  echo "  FAIL  no document with real bytes exists to compare — the payload claim cannot be made (say so rather than skipping it)"; FAILED=$((FAILED+1))
fi
chk "geometries restored as valid" "$(q "select count(*) from parcels where geom is not null and ST_IsValid(geom)")" \
                                   "$(qq "select count(*) from parcels where geom is not null and ST_IsValid(geom)")"
chk "tenant ownership survived the copy" "$(q "select count(*) from parcels where organization_id is not null")" \
                                         "$(qq "select count(*) from parcels where organization_id is not null")"
chk "row-level security is defined in the restored copy too" "$(q "select count(*) from pg_class where relname in ('parcels','land_documents') and relrowsecurity")" \
                                                              "$(qq "select count(*) from pg_class where relname in ('parcels','land_documents') and relrowsecurity")"
# The chain is compared by hashing every entry hash in order, on both sides. The line this replaces
# reported "BROKEN" whenever rows existed, because it asked whether the table was empty — a check that
# can only fail is as useless as one that can only pass.
SRC_CHAIN="$(q "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs" | tr -d '[:space:]')"
DST_CHAIN="$(qq "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs" | tr -d '[:space:]')"
say "  audit chain digest: source=$SRC_CHAIN restored=$DST_CHAIN"
chk "the audit chain is identical in the restored copy" "32" "${#SRC_CHAIN}"
chk "and the restored chain hashes to the same value" "$SRC_CHAIN" "$DST_CHAIN"

echo ""
echo "=== RESULT: $([ $FAILED -eq 0 ] && echo 'all checks passed' || echo "$FAILED check(s) failed") ==="
say "Archive in the second location: $DEST/$BASE"
[ $FAILED -eq 0 ] && exit 0
exit 1
