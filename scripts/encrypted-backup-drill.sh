#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — encrypted archive drill
#
# `offsite-copy-drill.sh` proves a dump can be copied, verified by checksum and restored from that
# copy. It does not prove the archive is safe to *store anywhere*, because a pg_dump custom archive is
# plaintext: anyone holding the file holds every officer name, every parcel, every base64 document and
# the whole audit chain. This drill closes the half of that it can close on this machine:
#
#   1. encrypt the archive with a passphrase taken from the environment (AES-256-CBC, PBKDF2-SHA256)
#   2. PROVE the encryption happened — the plaintext's own magic header and a recognisable internal
#      string must both be absent from the ciphertext, which must be a real file of a real size
#   3. require the wrong passphrase to fail, and require the right one to reproduce the original bytes
#   4. restore the DECRYPTED copy into a disposable database and compare the register against the
#      deployed one: row counts, a document payload digest, the migration ledger, the audit chain hash
#   5. leave the encrypted archive on disk as the thing to transfer, delete the decrypted working copy,
#      and report how many plaintext archives are still sitting in backups/
#
# WHAT REMAINS UNPROVED HERE, AND LOUDLY SO: every byte stays on this machine. Encryption at rest
# without a copy that leaves the machine is confidentiality without durability; a copy that leaves the
# machine without encryption is durability with a leak. Both legs are required and this script does
# one of them. See docs/DEPLOYMENT.md §8 for the owner-side transfer step.
#
# USAGE
#   BACKUP_PASSPHRASE='the long passphrase, from the environment not the command line' \
#     ./scripts/encrypted-backup-drill.sh [--container dharohar-prod-db-1] [--dbname dharohar]
#
#   BACKUP_PASSPHRASE is read from the environment on purpose: as a command-line argument it would sit
#   in the shell history and in the process list for the length of the run.
#
# Exit: 0 encrypted archive verified end to end, 1 a check failed, 2 environment/passphrase missing.
# Nothing here writes to the deployed database. The restore target is a new database on the scratch
# PostGIS container, dropped on exit.
#
# Windows notes, both learned by being wrong here once:
#   * this script exports MSYS_NO_PATHCONV=1, so a /tmp path is NOT translated for the native
#     openssl.exe and docker.exe — they cannot see Git Bash's /tmp and the failure looks like a corrupt
#     archive. The working directory is repo-relative, and docker cp gets a cygpath-converted path.
#   * `openssl enc ... -salt <n>` is invalid in OpenSSL 3.x (-salt is a flag; the length option is
#     -saltlen). Salting is on by default when a passphrase is used, so the flag is simply omitted
#     rather than given an argument it does not accept.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

DB_CONTAINER=dharohar-prod-db-1
DB_NAME=dharohar
SCRATCH=dharohar-audit-pg
OUT_DIR=backups/encrypted
FAILED=0
WORK=./.enc-drill-tmp
DRILL_DB=""

say()  { [ -n "${1:-}" ] && echo "  $1"; }
chk()  { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; else echo "  FAIL  $1 (want $2, got $3)"; FAILED=$((FAILED+1)); fi; }
digest() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
# docker.exe and openssl.exe are native Windows binaries: they cannot see Git Bash's /tmp, and with
# MSYS_NO_PATHCONV=1 exported they do not even get /c/... translated. Every path handed to docker is
# converted here.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
# q() reads the role and database out of the container's own environment. It used to interpolate
# ${PGUSER:-dharohar}, and the repository .env exports PGUSER=postgres — a role that does not exist in
# this container — so every source-side check answered "role \"postgres\" does not exist" and the
# comparisons passed vacuously against identical error text.
q()    { docker exec -i "$DB_CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\"" 2>&1 | tail -1; }
qq()   { docker exec -i $SCRATCH psql -U postgres -d "$DRILL_DB" -tA -c "$1" 2>&1 | tail -1; }

cleanup() {
  if [ -n "$DRILL_DB" ]; then
    docker exec $SCRATCH psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DRILL_DB'" >/dev/null 2>&1
    docker exec $SCRATCH psql -U postgres -q -c "drop database if exists $DRILL_DB" >/dev/null 2>&1
  fi
  # Only the decrypted working copies are removed. On a normal Windows volume this unlinks them; it
  # does not overwrite the clusters, and it does not reach the plaintext archive in backups/ or the
  # copy inside the container. Erasing a file is not destroying a sector — that is what volume-level
  # encryption is for, and it is an owner action.
  if [ -d "$WORK" ]; then
    find "$WORK" -type f >/dev/null 2>&1 && rm -f "$WORK"/* 2>/dev/null
    rmdir "$WORK" 2>/dev/null
  fi
  say "removed the decrypted working copy and dropped $DRILL_DB; the encrypted archive is kept in $OUT_DIR"
}
trap cleanup EXIT

[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "  ABORT: BACKUP_PASSPHRASE must be set in the environment (never as an argument)."; exit 2; }
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || { echo "  ABORT: BACKUP_PASSPHRASE is shorter than 20 characters. A passphrase guarding land records is not a Wi-Fi key."; exit 2; }
docker inspect -f '{{.State.Running}}' $SCRATCH 2>/dev/null | grep -q true || { echo "  ABORT: $SCRATCH is not running."; exit 2; }
# Prove the source-side helper can see the database before any comparison depends on it. Without this
# the whole register comparison silently compares two identical error strings.
PREMISE="$(q 'select 1')"
[ "$PREMISE" = "1" ] || { echo "  ABORT: cannot query $DB_CONTAINER as its own owner role (got: $PREMISE)."; exit 2; }
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT_DIR" || { echo "  ABORT: cannot create $WORK / $OUT_DIR"; exit 2; }

ITER=200000
OPENSSL_ENC=(openssl enc -e -aes-256-cbc -pbkdf2 -iter "$ITER" -pass env:BACKUP_PASSPHRASE)
OPENSSL_DEC=(openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -pass env:BACKUP_PASSPHRASE)

echo "== encrypted archive drill =="

# ---- 1. take a fresh dump through the supported path --------------------------
BEFORE_COUNT="$(ls -1 backups/*.dump 2>/dev/null | wc -l | tr -d ' ')"
PGUSER=dharohar ./scripts/backup.sh --container "$DB_CONTAINER" --dbname "$DB_NAME" --output backups >"$WORK/backup.log" 2>&1
BACKUP_RC=$?
chk "backup taken" "0" "$BACKUP_RC"
[ $BACKUP_RC -eq 0 ] || { tail -8 "$WORK/backup.log"; exit 2; }
AFTER_COUNT="$(ls -1 backups/*.dump 2>/dev/null | wc -l | tr -d ' ')"
chk "a new archive appeared" "1" "$([ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ] && echo 1 || echo 0)"
PLAIN="$(ls -t backups/*.dump | head -1)"
PLAIN_DIGEST="$(digest "$PLAIN")"
PLAIN_BYTES="$(wc -c < "$PLAIN" | tr -d ' ')"
say "  archive: $(basename "$PLAIN") ($PLAIN_BYTES bytes)"
chk "the archive itself is readable and non-empty" "1" "$([ "$PLAIN_BYTES" -gt 10000 ] 2>/dev/null && echo 1 || echo 0)"
chk "the archive digest is 64 hex characters" "64" "${#PLAIN_DIGEST}"
chk "the sidecar verifies its own archive" "0" "$(cd backups && sha256sum -c "$(basename "$PLAIN").sha256" >/dev/null 2>&1; echo $?)"

# ---- 2. encrypt, and prove the encryption actually did something -------------
ENC="$OUT_DIR/$(basename "$PLAIN").enc"
"${OPENSSL_ENC[@]}" -in "$PLAIN" -out "$ENC" 2>"$WORK/enc.err"
chk "encryption exited 0" "0" "$?"
ENC_BYTES="$(wc -c < "$ENC" 2>/dev/null | tr -d ' ')"
chk "the encrypted file exists and is a real archive size" "1" "$([ "${ENC_BYTES:-0}" -gt 10000 ] 2>/dev/null && echo 1 || echo 0)"
chk "the encrypted digest differs from the plaintext digest" "1" "$([ "$(digest "$ENC")" != "$PLAIN_DIGEST" ] && echo 1 || echo 0)"
# pg_dump's custom format starts with the literal magic 'PGDMP'. If those five bytes survive, the
# archive is sitting there in plaintext and the encryption step is decorative.
#
# Measured on 2026-10-23, because the first version of this probe assumed the wrong thing: a -Fc dump
# compresses each data blob, so a tenant *value* such as an officer email is not greppable in the
# archive (0 hits), while the table-of-contents and object names are (118 hits for "parcels", 10 for
# "officer"). So the string probes below can only claim that the archive's structure is in the clear —
# which is why the functional check after them is the one that actually matters.
MAGIC_IN_PLAIN="$(head -c 5 "$PLAIN" | tr -d '\0')"
chk "premise: the plaintext carries its PGDMP magic header" "PGDMP" "$MAGIC_IN_PLAIN"
MAGIC_IN_CIPHER="$(LC_ALL=C grep -a -o "PGDMP" "$ENC" 2>/dev/null | wc -l | tr -d ' ')"
chk "and the ciphertext does not" "0" "$MAGIC_IN_CIPHER"
OBJ_IN_PLAIN="$(LC_ALL=C grep -a -o "parcels" "$PLAIN" 2>/dev/null | wc -l | tr -d ' ')"
chk "premise: the plaintext names its tenant tables in the clear" "1" "$([ "$OBJ_IN_PLAIN" -gt 0 ] && echo 1 || echo 0)"
OBJ_IN_CIPHER="$(LC_ALL=C grep -a -o "parcels" "$ENC" 2>/dev/null | wc -l | tr -d ' ')"
chk "and the ciphertext names none of them" "0" "$OBJ_IN_CIPHER"

# The claim that actually matters, tested functionally rather than by pattern-matching: the archive is
# restorable by anyone who holds the file — pg_restore reads its manifest with no key at all — while
# the encrypted copy is not even recognisable as an archive.
echo ""
echo "== the keyless-reader test =="
docker cp "$(winpath "$PLAIN")" $SCRATCH:/tmp/probe-plain.dump >/dev/null 2>&1
docker cp "$(winpath "$ENC")"   $SCRATCH:/tmp/probe-enc.enc  >/dev/null 2>&1
docker exec $SCRATCH pg_restore --list /tmp/probe-plain.dump >"$WORK/toc-plain.txt" 2>&1
chk "premise: without a key, pg_restore reads the PLAINTEXT archive's manifest" "0" "$?"
chk "  and that manifest lists tenant tables" "1" "$(grep -q 'TABLE DATA public parcels' "$WORK/toc-plain.txt" && echo 1 || echo 0)"
docker exec $SCRATCH pg_restore --list /tmp/probe-enc.enc >"$WORK/toc-enc.txt" 2>&1
ENC_LIST_RC=$?
chk "the ENCRYPTED archive is not a readable archive (rc $ENC_LIST_RC)" "1" "$([ $ENC_LIST_RC -ne 0 ] && echo 1 || echo 0)"
chk "  and its failure says the file is not an archive" "1" "$(grep -qiE 'not .*valid archive|invalid archive|too short' "$WORK/toc-enc.txt" && echo 1 || echo 0)"
docker exec $SCRATCH sh -c 'rm -f /tmp/probe-plain.dump /tmp/probe-enc.enc' >/dev/null 2>&1

# ---- 3. decrypt and require the round trip to be byte-exact ------------------
DEC="$WORK/archive.decrypted.dump"
"${OPENSSL_DEC[@]}" -in "$ENC" -out "$DEC" 2>"$WORK/dec.err"
chk "decryption exited 0" "0" "$?"
chk "the decrypted copy is the same size as the archive" "$PLAIN_BYTES" "$(wc -c < "$DEC" 2>/dev/null | tr -d ' ')"
chk "the round trip preserves the archive byte for byte" "$PLAIN_DIGEST" "$(digest "$DEC")"
# Same command, different environment: -pass env:BACKUP_PASSPHRASE is how the array reads the secret,
# so overriding the variable is what tests the wrong key — the array itself must stay unmodified.
BACKUP_PASSPHRASE='clearly-the-wrong-passphrase-0123456789' "${OPENSSL_DEC[@]}" -in "$ENC" -out "$WORK/should-not-exist" >/dev/null 2>&1
WRONG_RC=$?
rm -f "$WORK/should-not-exist" 2>/dev/null
chk "the wrong passphrase cannot read it back" "1" "$([ $WRONG_RC -ne 0 ] && echo 1 || echo 0)"

# ---- 4. restore the decrypted copy and compare the registers -----------------
DRILL_DB="encdrill_$$"
echo ""
echo "== restore the DECRYPTED archive into a disposable database =="
docker exec $SCRATCH psql -U postgres -q -c "create database $DRILL_DB" >/dev/null 2>&1
chk "the disposable database was created" "1" "$(docker exec $SCRATCH psql -U postgres -tAc "select 1 from pg_database where datname='$DRILL_DB'" 2>/dev/null | tail -1)"
docker cp "$(winpath "$DEC")" $SCRATCH:/tmp/encdrill.dump >/dev/null 2>&1
chk "the decrypted archive reached the scratch container" "1" "$(docker exec $SCRATCH sh -c '[ -s /tmp/encdrill.dump ] && echo 1 || echo 0' 2>/dev/null | tail -1)"
docker exec $SCRATCH pg_restore -U postgres -d "$DRILL_DB" --no-owner --no-privileges /tmp/encdrill.dump >"$WORK/restore.log" 2>&1
chk "restore from the decrypted archive completed" "0" "$?"
docker exec $SCRATCH psql -U postgres -q -d $DRILL_DB -c "create extension if not exists postgis" >/dev/null 2>&1

# The restored side must be able to answer, too — otherwise a failed restore looks like a match.
RPREMISE="$(qq 'select 1')"
chk "the restored database answers the same premise query" "1" "$RPREMISE"

for t in parcels land_documents users districts organization_districts schema_migrations append_only_audit_logs parcel_owners; do
  SRC_N="$(q "select count(*) from $t" | tr -d '[:space:]')"
  DST_N="$(qq "select count(*) from $t" | tr -d '[:space:]')"
  chk "$t restored with the same row count (source $SRC_N)" "$SRC_N" "$DST_N"
  case "$SRC_N" in ''|*[!0-9]*) chk "  premise: $t is countable in the source" "1" "0" ;; esac
done
chk "the migration ledger came through identical" "$(q "select string_agg(version,',' order by version) from schema_migrations")" \
                                        "$(qq "select string_agg(version,',' order by version) from schema_migrations")"
chk "tenant ownership survived" "$(q "select count(*) from parcels where organization_id is not null")" \
                              "$(qq "select count(*) from parcels where organization_id is not null")"
chk "geometries restored as valid" "$(q "select count(*) from parcels where geom is not null and ST_IsValid(geom)")" \
                                 "$(qq "select count(*) from parcels where geom is not null and ST_IsValid(geom)")"
# Row-level security travels with the archive: a restore that silently lost the policies would still
# match on counts.
chk "RLS is still enabled on parcels in the restored copy" "1" "$(qq "select relrowsecurity::int from pg_class where relname='parcels'")"

# Payload, not just row counts: a dump that restores empty text columns passes a count check.
BIG="$(q "select id from land_documents where length(coalesce(image_uri,'')) > 100000 order by length(image_uri) desc limit 1" | tr -d '[:space:]')"
if [ -n "$BIG" ] && [ "${#BIG}" -lt 200 ]; then
  SRC_MD5="$(q "select md5(image_uri) from land_documents where id='$BIG'" | tr -d '[:space:]')"
  DST_MD5="$(qq "select md5(image_uri) from land_documents where id='$BIG'" | tr -d '[:space:]')"
  chk "the largest document payload digests to 32 hex before anything is compared" "32" "${#SRC_MD5}"
  say "  payload compared: $BIG"
  chk "and it hashes identically after encrypt → decrypt → restore" "$SRC_MD5" "$DST_MD5"
else
  echo "  FAIL  no document with a real payload exists to compare (say so rather than skipping it)"; FAILED=$((FAILED+1))
fi

SRC_CHAIN="$(q "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs" | tr -d '[:space:]')"
DST_CHAIN="$(qq "select md5(string_agg(entry_hash, '' order by id)) from append_only_audit_logs" | tr -d '[:space:]')"
say "  audit chain digest: source=$SRC_CHAIN restored=$DST_CHAIN"
chk "the audit chain is 32 hex before comparing" "32" "${#SRC_CHAIN}"
chk "the whole audit chain survives the encrypted round trip" "$SRC_CHAIN" "$DST_CHAIN"

# ---- 5. what is left on disk -------------------------------------------------
echo ""
echo "== what this leaves behind =="
PLAIN_LEFT="$(ls -1 backups/*.dump 2>/dev/null | wc -l | tr -d ' ')"
say "  encrypted archive kept:  $ENC ($(wc -c < "$ENC" | tr -d ' ') bytes)"
say "  plaintext archives still in backups/: $PLAIN_LEFT — deleting the working copy above does not touch them"
say "  passphrases are never stored by this script; lose it and the archive is unrecoverable by design"

echo ""
echo "=== RESULT: $([ $FAILED -eq 0 ] && echo 'encrypted archive verified end to end' || echo "$FAILED check(s) failed") ==="
say "  encrypted file: $ENC (AES-256-CBC, PBKDF2-HMAC-SHA256, $ITER iterations)"
say "  passphrase: supplied through the environment, never a command-line argument, never printed"
say "  IMPORTANT: every byte above is still on this machine. Encryption without an off-machine copy is"
say "  confidentiality and no durability; see docs/DEPLOYMENT.md §8 for the transfer step you run."
[ $FAILED -eq 0 ] && exit 0
exit 1
