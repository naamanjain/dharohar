#!/usr/bin/env bash
# =============================================================================
# DHAROHAR — scripts/backup.sh
#
# Takes a portable, compressed pg_dump of the Dockerised PostGIS land-records
# database. READ-ONLY against the source: it never writes, truncates, drops or
# vacuums anything.
#
# Usage
#   ./scripts/backup.sh --container dharohar-pg --dbname dharohar_db
#   ./scripts/backup.sh --container dharohar-pg --dbname dharohar_db --output /mnt/backups
#   DATABASE_URL=postgresql://postgres:secret@localhost:5432/dharohar_db ./scripts/backup.sh
#
# Connection info comes ONLY from the environment / flags, never hard-coded:
#   PG_DOCKER_CONTAINER | --container : run pg_dump inside this docker container
#                                       (recommended for a Dockerised PostGIS — the dump
#                                        then uses the container's local unix socket)
#   DATABASE_URL                      : full libpq URL, used when no container is given
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE : individual libpq parameters
#   BACKUP_DIR BACKUP_FORMAT BACKUP_PREFIX      : defaults for output dir / format / name
#
# Output
#   <BACKUP_DIR>/<dbname>_<YYYYmmdd_HHMMSS>.dump — pg_dump custom format, zlib compressed,
#   geometry columns preserved verbatim, portable via --no-owner --no-privileges.
#   A .sha256 sidecar is written next to it. --format plain writes gzipped SQL text instead.
#
# The password is never printed; connection details are logged masked.
# Exit codes: 0 ok, 2 usage, 3 connection/target problem, 4 dump failed.
# =============================================================================
set -euo pipefail

PROGRAM="$(basename "$0")"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-dharohar}"
FORMAT="${BACKUP_FORMAT:-custom}"          # custom | plain
CONTAINER="${PG_DOCKER_CONTAINER:-}"
OUT_PATH=""
FORCE=0
VERIFY=1

DB_URL="${DATABASE_URL:-}"
DB_NAME="${PGDATABASE:-}"
DB_USER="${PGUSER:-}"
DB_HOST="${PGHOST:-}"
DB_PORT="${PGPORT:-}"
# PGPASSWORD is intentionally never echoed — it only travels through the environment.

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }
die()  { local msg="$1"; local code="${2:-4}"; echo "[DHAROHAR BACKUP] ERROR: $msg" >&2; exit "$code"; }
info() { echo "[DHAROHAR BACKUP] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container)   CONTAINER="${2:-}"; shift 2 ;;
    --dbname|-d)   DB_NAME="${2:-}"; shift 2 ;;
    --username|-U) DB_USER="${2:-}"; shift 2 ;;
    --host)        DB_HOST="${2:-}"; shift 2 ;;
    --port)        DB_PORT="${2:-}"; shift 2 ;;
    --url)         DB_URL="${2:-}"; shift 2 ;;
    --output|-o)   OUT_PATH="${2:-}"; shift 2 ;;
    --format)      FORMAT="${2:-}"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --no-verify)   VERIFY=0; shift ;;
    --help)        usage; exit 0 ;;
    *)             echo "$PROGRAM: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$DB_URL" ]]; then
  # Best-effort libpq URL parsing. Percent-encode a password containing '@' or ':'.
  [[ "$DB_URL" =~ ^postgres(ql)?:// ]] || die "DATABASE_URL is not a postgresql:// URI" 2
  rest="${DB_URL#*://}"
  if [[ "$rest" == *@* ]]; then
    creds="${rest%@*}"; hostpart="${rest##*@}"; DB_USER="${creds%%:*}"
  else
    hostpart="$rest"
  fi
  DB_HOST="${hostpart%%/*}"
  DB_NAME="${hostpart#*/}"; DB_NAME="${DB_NAME%%\?*}"
  if [[ "$DB_HOST" == *:* ]]; then DB_PORT="${DB_HOST##*:}"; DB_HOST="${DB_HOST%%:*}"; fi
fi

DB_NAME="${DB_NAME:-dharohar_db}"
[[ "$FORMAT" == "custom" || "$FORMAT" == "plain" ]] || die "--format must be 'custom' or 'plain'" 2

# ---------------------------------------------------------------------------
# Executor: docker (pg_dump inside the PostGIS container) or direct (host client)
# ---------------------------------------------------------------------------
if [[ -n "$CONTAINER" ]]; then
  command -v docker >/dev/null 2>&1 || die "docker CLI not found for --container mode" 3
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' is not available" 3
  MODE="docker"
  CONTAINER_USER="${DB_USER:-postgres}"
  # Git-Bash/MSYS rewrites absolute POSIX paths handed to a native binary (docker.exe) into
  # Windows paths, so a container-side `/tmp/x` silently becomes C:\tmp\x. The two switches
  # below disable that conversion for `docker exec` arguments only — `docker cp` is deliberately
  # left alone so its HOST-side path still converts correctly. Ignored on Linux and macOS.
  # -e PGPASSWORD (no =value) forwards the variable without putting a secret on any command line.
  db_exec() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker exec ${PGPASSWORD:+-e PGPASSWORD} "$CONTAINER" "$@"; }
else
  MODE="direct"
  DB_HOST="${DB_HOST:-127.0.0.1}"; DB_PORT="${DB_PORT:-5432}"; DB_USER="${DB_USER:-postgres}"
  CONTAINER_USER="$DB_USER"
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump not on PATH — pass --container <name> for a Dockerised PostGIS" 3
  db_exec() { "$@"; }
fi

psql_probe() {
  if [[ "$MODE" == "docker" ]]; then db_exec psql -X -q -At -U "$CONTAINER_USER" -d "$DB_NAME" -c "$1"
  else PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" psql -X -q -At -c "$1" "$DB_NAME"; fi
}

info "mode=$MODE db='$DB_NAME' user='${CONTAINER_USER}' host='${DB_HOST:-<container socket>}' port='${DB_PORT:-<container socket>}' password=(not shown)"

psql_probe "SELECT current_database()" >/dev/null 2>&1 \
  || die "cannot connect to database '$DB_NAME' (mode=$MODE). Check PG*/DATABASE_URL or --container." 3
POSTGIS_VERSION="$(psql_probe "SELECT PostGIS_Version()" 2>/dev/null || echo 'PostGIS not detected')"
info "PostGIS: $POSTGIS_VERSION"
info "objects to be backed up: $(psql_probe "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','m','f')" 2>/dev/null || echo '?') relations in public"

# ---------------------------------------------------------------------------
# Output path
# ---------------------------------------------------------------------------
TS="$(date -u +%Y%m%d_%H%M%S)"
EXT="dump"; [[ "$FORMAT" == "plain" ]] && EXT="sql"
if [[ -n "$OUT_PATH" && -d "$OUT_PATH" ]]; then
  OUT_DIR="$OUT_PATH"; OUT_FILE="$OUT_DIR/${BACKUP_PREFIX}_${DB_NAME}_${TS}.${EXT}"
elif [[ -n "$OUT_PATH" ]]; then
  OUT_DIR="$(dirname "$OUT_PATH")"; OUT_FILE="$OUT_PATH"
else
  OUT_DIR="$BACKUP_DIR"; OUT_FILE="$OUT_DIR/${BACKUP_PREFIX}_${DB_NAME}_${TS}.${EXT}"
fi
mkdir -p "$OUT_DIR"
[[ -e "$OUT_FILE" && $FORCE -eq 0 ]] && die "refusing to overwrite existing file $OUT_FILE (pass --force)" 2

DUMP_ARGS=(--no-owner --no-privileges --encoding=UTF8)
if [[ "$FORMAT" == "custom" ]]; then DUMP_ARGS+=(--format=custom --compress=6); else DUMP_ARGS+=(--format=plain); fi

dump_cmd() {
  if [[ "$MODE" == "docker" ]]; then
    db_exec pg_dump -U "$CONTAINER_USER" "${DUMP_ARGS[@]}" --file="$1" "$DB_NAME"
  elif [[ "$FORMAT" == "custom" ]]; then
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "${DUMP_ARGS[@]}" --file="$1" "$DB_NAME"
  else
    # Plain SQL is written to stdout so it can be gzipped in the same pass.
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "${DUMP_ARGS[@]}" "$DB_NAME" > "$1"
  fi
}

# ---------------------------------------------------------------------------
# Dump. In docker mode the archive is created inside the container and moved with
# `docker cp`, so no binary stream ever passes through a terminal layer.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "docker" ]]; then
  TMP="/tmp/dharohar_backup_${TS}_$$.${EXT}"
  trap 'db_exec rm -f "$TMP" >/dev/null 2>&1 || true' EXIT
  info "running pg_dump inside container '$CONTAINER' ..."
  dump_cmd "$TMP" || die "pg_dump failed inside container" 4
  [[ $VERIFY -eq 1 ]] && {
    [[ "$FORMAT" == "custom" ]] && { db_exec pg_restore --list "$TMP" >/dev/null || die "archive not readable by pg_restore --list" 4; }
  }
  db_exec test -s "$TMP" || die "pg_dump produced an empty archive" 4
  docker cp "$CONTAINER:$TMP" "$OUT_FILE" >/dev/null || die "docker cp out failed" 4
else
  info "running pg_dump on the host ..."
  dump_cmd "$OUT_FILE" || die "pg_dump failed" 4
  [[ $VERIFY -eq 1 && "$FORMAT" == "custom" ]] && {
    pg_restore --list "$OUT_FILE" >/dev/null || die "archive not readable by pg_restore --list" 4
  }
  [[ -s "$OUT_FILE" ]] || die "pg_dump produced an empty archive" 4
fi

if [[ "$FORMAT" == "plain" ]]; then
  command -v gzip >/dev/null 2>&1 && { gzip -f "$OUT_FILE"; OUT_FILE="${OUT_FILE}.gz"; }
fi

# Checksum sidecar so a restore operator can prove which dump they used.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$(dirname "$OUT_FILE")" && sha256sum "$(basename "$OUT_FILE")" > "$(basename "$OUT_FILE").sha256" )
fi

SIZE="$(wc -c < "$OUT_FILE" | tr -d '[:space:]')"
info "backup written: $OUT_FILE ($SIZE bytes, format=$FORMAT)"
info "verify integrity any time:  sha256sum -c '${OUT_FILE}.sha256'"
info "restore into a fresh empty db:  ./scripts/restore.sh --input '$OUT_FILE' --dbname <target_db>"
exit 0
