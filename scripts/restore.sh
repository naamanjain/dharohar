#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — scripts/restore.sh
#
# Restores a scripts/backup.sh archive (pg_dump custom format, or gzipped/plain
# SQL) into a PostgreSQL + PostGIS database, Dockerised or not.
#
# Usage
#   ./scripts/restore.sh --container dharohar-pg --dbname dharohar_staging \
#                        --input backups/dharohar_dharohar_db_20261015_093000.dump --create-db
#   DATABASE_URL=postgresql://postgres:secret@localhost:5432/dharohar_staging \
#     ./scripts/restore.sh --input backups/….dump --allow-non-empty
#
# Connection info comes ONLY from the environment / flags, never hard-coded:
#   PG_DOCKER_CONTAINER | --container : run pg_restore/psql inside this docker container
#   DATABASE_URL                      : full libpq URL when no container is given
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
#   MAINTENANCE_DB                    : database used for CREATE DATABASE checks (default postgres)
#
# SAFETY
#   * The target must be EMPTY. Any pre-existing user relation (extension objects such as
#     PostGIS' spatial_ref_sys are ignored) makes this script REFUSE and exit 3 unless the
#     explicit --allow-non-empty flag is passed. Nothing is ever dropped or truncated first.
#   * The restore runs in a single transaction with --exit-on-error, so a half-applied
#     restore leaves the target exactly as it was.
#   * A .sha256 sidecar next to the archive is verified automatically when present.
#   * The password is never printed.
# Exit codes: 0 ok, 2 usage, 3 refused/safety gate, 4 restore failed.
# =============================================================================
set -euo pipefail

PROGRAM="$(basename "$0")"
CONTAINER="${PG_DOCKER_CONTAINER:-}"
INPUT=""
DB_NAME="${PGDATABASE:-}"
DB_USER="${PGUSER:-}"
DB_HOST="${PGHOST:-}"
DB_PORT="${PGPORT:-}"
DB_URL="${DATABASE_URL:-}"
MAINT_DB="${MAINTENANCE_DB:-postgres}"
CREATE_DB=0
ALLOW_NON_EMPTY=0
ANALYZE=0
SINGLE_TX=1

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }
die()  { local msg="$1"; local code="${2:-4}"; echo "[DHAROHAR RESTORE] ERROR: $msg" >&2; exit "$code"; }
info() { echo "[DHAROHAR RESTORE] $*"; }
warn() { echo "[DHAROHAR RESTORE] WARNING: $*" >&2; }

# Temporary files are removed on exit, in either the host or the container.
declare -a HOST_TMP=() CONTAINER_TMP=()
cleanup() {
  local f
  if [[ ${#HOST_TMP[@]} -gt 0 ]]; then for f in "${HOST_TMP[@]}"; do rm -f "$f" 2>/dev/null || true; done; fi
  if [[ -n "$CONTAINER" && ${#CONTAINER_TMP[@]} -gt 0 ]]; then
    for f in "${CONTAINER_TMP[@]}"; do
      MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker exec "$CONTAINER" rm -f "$f" </dev/null >/dev/null 2>&1 || true
    done
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input|-i)     INPUT="${2:-}"; shift 2 ;;
    --container)    CONTAINER="${2:-}"; shift 2 ;;
    --dbname|-d)    DB_NAME="${2:-}"; shift 2 ;;
    --username|-U)  DB_USER="${2:-}"; shift 2 ;;
    --host)         DB_HOST="${2:-}"; shift 2 ;;
    --port)         DB_PORT="${2:-}"; shift 2 ;;
    --url)          DB_URL="${2:-}"; shift 2 ;;
    --maintenance-db) MAINT_DB="${2:-}"; shift 2 ;;
    --create-db)    CREATE_DB=1; shift ;;
    --allow-non-empty) ALLOW_NON_EMPTY=1; shift ;;
    --analyze)      ANALYZE=1; shift ;;
    --no-single-transaction) SINGLE_TX=0; shift ;;
    --help)         usage; exit 0 ;;
    *)              echo "$PROGRAM: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$INPUT" ]] || die "--input <archive> is required" 2
[[ -f "$INPUT" ]] || die "archive not found: $INPUT" 2
[[ -s "$INPUT" ]] || die "archive is empty: $INPUT" 2

if [[ -n "$DB_URL" ]]; then
  [[ "$DB_URL" =~ ^postgres(ql)?:// ]] || die "DATABASE_URL is not a postgresql:// URI" 2
  rest="${DB_URL#*://}"
  if [[ "$rest" == *@* ]]; then creds="${rest%@*}"; hostpart="${rest##*@}"; DB_USER="${creds%%:*}"
  else hostpart="$rest"; fi
  DB_HOST="${hostpart%%/*}"
  DB_NAME="${hostpart#*/}"; DB_NAME="${DB_NAME%%\?*}"
  if [[ "$DB_HOST" == *:* ]]; then DB_PORT="${DB_HOST##*:}"; DB_HOST="${DB_HOST%%:*}"; fi
fi
[[ -n "$DB_NAME" ]] || die "target database is required (--dbname or PGDATABASE/DATABASE_URL)" 2

# ---------------------------------------------------------------------------
# Format detection from the archive itself (magic bytes), not just the name.
# ---------------------------------------------------------------------------
MAGIC="$(head -c 5 "$INPUT" 2>/dev/null | tr -d '\0' || true)"
case "$INPUT" in
  *.gz) FORMAT="plain-gz" ;;
  *)
    if [[ "$MAGIC" == "PGDMP" ]]; then FORMAT="custom"
    else FORMAT="plain"; fi
    ;;
esac
if [[ "$FORMAT" == "plain-gz" ]]; then
  command -v gunzip >/dev/null 2>&1 || die "gunzip needed for $INPUT" 2
  DECOMPRESSED="/tmp/dharohar_restore_$$_$(basename "${INPUT%.gz}")"
  HOST_TMP+=("$DECOMPRESSED")
  gunzip -c "$INPUT" > "$DECOMPRESSED"
  INPUT_FOR_RESTORE="$DECOMPRESSED"; FORMAT="plain"
else
  INPUT_FOR_RESTORE="$INPUT"
fi

# Verify the checksum sidecar if the backup wrote one.
if [[ -f "${INPUT}.sha256" ]] && command -v sha256sum >/dev/null 2>&1; then
  ( cd "$(dirname "$INPUT")" && sha256sum --check --status "$(basename "$INPUT").sha256" ) \
    || die "checksum mismatch for $INPUT against ${INPUT}.sha256 — the archive has changed since backup" 3
  info "checksum sidecar verified"
fi

# ---------------------------------------------------------------------------
# Executor: docker (client tools inside the PostGIS container) or direct
# ---------------------------------------------------------------------------
if [[ -n "$CONTAINER" ]]; then
  command -v docker >/dev/null 2>&1 || die "docker CLI not found for --container mode" 3
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' is not available" 3
  MODE="docker"; RUN_USER="${DB_USER:-postgres}"
  # Git-Bash/MSYS rewrites absolute POSIX paths handed to a native binary (docker.exe) into
  # Windows paths, so a container-side `/tmp/x` silently becomes C:\tmp\x. The switches below
  # disable that conversion for `docker exec` arguments only — `docker cp` is deliberately left
  # alone so its HOST-side path still converts correctly. Ignored on Linux and macOS.
  db_exec() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker exec ${PGPASSWORD:+-e PGPASSWORD} "$CONTAINER" "$@"; }
  sql() { db_exec psql -X -q -At -U "$RUN_USER" -d "$1" -c "$2"; }
else
  MODE="direct"; DB_HOST="${DB_HOST:-127.0.0.1}"; DB_PORT="${DB_PORT:-5432}"; DB_USER="${DB_USER:-postgres}"
  RUN_USER="$DB_USER"
  command -v pg_restore >/dev/null 2>&1 || command -v psql >/dev/null 2>&1 \
    || die "no pg_restore/psql on PATH — pass --container <name> for a Dockerised PostGIS" 3
  db_exec() { "$@"; }
  sql() { PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" psql -X -q -At -d "$1" -c "$2"; }
fi

info "mode=$MODE target db='$DB_NAME' user='$RUN_USER' host='${DB_HOST:-<container socket>}' port='${DB_PORT:-<container socket>}' password=(not shown) format=$FORMAT"

# ---- Does the target database exist? --------------------------------------
EXISTS="$(sql "$MAINT_DB" "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null || echo "")"
[[ -n "$EXISTS" ]] || die "cannot reach maintenance database '$MAINT_DB' (mode=$MODE)" 3
if [[ "$EXISTS" == "0" ]]; then
  [[ $CREATE_DB -eq 1 ]] || die "target database '$DB_NAME' does not exist; pass --create-db to create it empty" 3
  info "creating empty database '$DB_NAME' from template0 (UTF8)"
  sql "$MAINT_DB" "CREATE DATABASE \"$DB_NAME\" WITH TEMPLATE = template0 ENCODING = 'UTF8'" \
    || die "CREATE DATABASE failed" 4
elif [[ $CREATE_DB -eq 1 ]]; then
  warn "target database '$DB_NAME' already exists — not recreating it (no drop, nothing was destroyed)"
fi

# ---- SAFETY GATE: refuse to overwrite a non-empty target ------------------
# Extension-owned objects (PostGIS spatial_ref_sys, topology, ...) are excluded so that a
# database that merely has PostGIS installed still counts as empty.
NON_EMPTY_SQL="SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relkind IN ('r','p','m','f','v','t') AND d.objid IS NULL"
USER_RELATIONS="$(sql "$DB_NAME" "$NON_EMPTY_SQL" 2>/dev/null || echo '')"
[[ -n "$USER_RELATIONS" ]] || die "cannot inspect target database '$DB_NAME'" 3
if [[ "$USER_RELATIONS" != "0" ]]; then
  LEDGER_ROWS="$(sql "$DB_NAME" "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 'n/a')"
  msg="target database '$DB_NAME' is NOT empty ($USER_RELATIONS user relation(s), schema_migrations rows: $LEDGER_ROWS)."
  if [[ $ALLOW_NON_EMPTY -eq 0 ]]; then
    die "$msg Refusing to overwrite existing land records. Back it up first (scripts/backup.sh) and pass --allow-non-empty only when you fully understand the consequence." 3
  fi
  warn "$msg --allow-non-empty passed: objects from the archive will be added on top of this database."
  warn "this script will NOT drop or truncate anything itself; a conflict with existing objects aborts the restore and rolls back."
fi

RESTORE_DONE=0
TX_ARGS=()
[[ $SINGLE_TX -eq 1 ]] && TX_ARGS=(--single-transaction)
if [[ "$MODE" == "docker" ]]; then
  TMP="/tmp/dharohar_restore_$$_$(basename "$INPUT_FOR_RESTORE")"
  CONTAINER_TMP+=("$TMP")
  docker cp "$INPUT_FOR_RESTORE" "$CONTAINER:$TMP" >/dev/null || die "docker cp in failed" 4
  if [[ "$FORMAT" == "custom" ]]; then
    info "pg_restore inside container '$CONTAINER' ..."
    db_exec pg_restore -U "$RUN_USER" -d "$DB_NAME" --no-owner --no-privileges --exit-on-error \
      "${TX_ARGS[@]}" "$TMP" || die "pg_restore failed (nothing was committed)" 4
  else
    info "psql -f inside container '$CONTAINER' ..."
    db_exec psql -X -q -v ON_ERROR_STOP=1 -U "$RUN_USER" -d "$DB_NAME" \
      "${TX_ARGS[@]}" -f "$TMP" || die "psql restore failed (nothing was committed)" 4
  fi
else
  if [[ "$FORMAT" == "custom" ]]; then
    info "pg_restore on the host ..."
    PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" pg_restore -d "$DB_NAME" \
      --no-owner --no-privileges --exit-on-error "${TX_ARGS[@]}" "$INPUT_FOR_RESTORE" \
      || die "pg_restore failed (nothing was committed)" 4
  else
    info "psql -f on the host ..."
    PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" psql -X -q -v ON_ERROR_STOP=1 \
      "${TX_ARGS[@]}" -d "$DB_NAME" -f "$INPUT_FOR_RESTORE" \
      || die "psql restore failed (nothing was committed)" 4
  fi
fi
RESTORE_DONE=1

[[ $ANALYZE -eq 1 ]] && { sql "$DB_NAME" "ANALYZE" >/dev/null && info "ANALYZE complete"; }

# ---- Post-restore summary (read-only) -------------------------------------
info "restore complete — verifying target"
TABLES="$(sql "$DB_NAME" "$NON_EMPTY_SQL")"
LEDGER="$(sql "$DB_NAME" "SELECT string_agg(version || ':' || name, ', ' ORDER BY version) FROM schema_migrations" 2>/dev/null || echo 'no ledger')"
info "user relations restored: $TABLES"
info "schema_migrations: $LEDGER"
[[ $RESTORE_DONE -eq 1 ]] || die "restore did not complete" 4
info "NOTE: run migrations after a restore to converge the schema: npm run db:migrate"
exit 0
