#!/bin/sh
# DHAROHAR API container entrypoint.
# 1. Optionally waits for PostgreSQL (the app itself REFUSES to boot in production
#    when the DB is unreachable — that behaviour is intentional and not weakened here).
# 2. Optionally applies schema migrations before serving traffic.
# 3. Execs the CMD (compiled server).
set -e

DB_HOST="${PGHOST:-db}"
DB_PORT="${PGPORT:-5432}"

if [ "${WAIT_FOR_DB:-true}" = "true" ]; then
  echo "[entrypoint] waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
  # Wall-clock deadline, not an iteration count: each failed probe costs up to 3s on top of the 2s
  # sleep, so counting attempts made the "after 60s" message a lie — the real ceiling was ~150s, and
  # an operator reading the log picks their recovery strategy from that number.
  deadline=$(( $(date +%s) + ${DB_WAIT_TIMEOUT:-60} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if node -e "
      const net = require('node:net');
      const s = net.connect(Number(process.argv[1]), process.argv[2]);
      s.on('connect', () => process.exit(0));
      s.on('error', () => process.exit(1));
      setTimeout(() => process.exit(1), 3000);
    " "$DB_PORT" "$DB_HOST" 2>/dev/null; then
      echo "[entrypoint] PostgreSQL is accepting connections."
      break
    fi
    sleep 2
  done
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[entrypoint] FATAL: PostgreSQL not reachable after ${DB_WAIT_TIMEOUT:-60}s." >&2
    exit 1
  fi
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying database migrations..."
  node dist-server/db/migrate.js
fi

exec "$@"
