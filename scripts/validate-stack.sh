#!/usr/bin/env bash
# Validation sweep for the DHAROHAR production stack. Prints PASS/FAIL per check and a final count.
set -u
cd "$(dirname "$0")/.."
export POSTGRES_USER=dharohar POSTGRES_DB=dharohar
# Minted per run rather than hard-coded: the suites obtain every token they use by logging in over
# HTTP, so nothing needs to know this value in advance — and a fixed secret in a script that lives in
# a public repository is exactly the pattern that gets flagged, even when no deployment uses it.
export JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
# The demo personas' password, minted per run and handed to the seed and to the suites alike. It used
# to be a literal in this script, which meant the repository shipped a working credential for four
# officer accounts; now the only copy is in this process's environment.
export DEMO_PASSWORD="${DEMO_PASSWORD:-$(openssl rand -hex 12 2>/dev/null || node -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')}"
export WEB_PORT=8088

# ---- PREFLIGHT ------------------------------------------------------------------
# Without this the sweep measured nothing and still reported a mixture of PASS and
# FAIL: when the Docker daemon was down, every `docker inspect` produced the same
# connection error text, and comparing that text against itself looked like equality.
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  echo "ABORT: the Docker daemon is not reachable. No check below can be trusted."
  echo "       Start Docker Desktop (or the docker service) and re-run."
  exit 2
fi
export POSTGRES_PASSWORD="$(docker inspect dharohar-prod-db-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^POSTGRES_PASSWORD=' | cut -d= -f2-)"
if [ -z "$POSTGRES_PASSWORD" ]; then
  echo "ABORT: could not read POSTGRES_PASSWORD from the running dharohar-prod-db-1 container."
  echo "       Bring the stack up first: docker compose -f docker-compose.prod.yml up -d --build"
  exit 2
fi

PASS=0; FAIL=0
# One identity for both write probes in this run: the request the outage must refuse (T7) is then the
# same request that must succeed after recovery, so the pair proves the write path came back rather
# than that a different payload happened to be free.
PROBE_RUN="V$(date +%s | tail -c 6)"

# A measurement that looks like a tool error is not a measurement. Counting one as a
# pass — or comparing one against another — is how a broken gate reports success.
looks_like_error() {
  case "$1" in
    *"error while interpolating"*|*"failed to connect to the docker API"*|*"Cannot connect to the Docker daemon"*|\
    *"No such container"*|*"Error response from daemon"*|*"command not found"*|*"ERR_"*|*"permission denied"*) return 0 ;;
    *) return 1 ;;
  esac
}

chk() { # name, expected, actual
  if looks_like_error "$3" || { [ "$2" != "0" ] && looks_like_error "$2"; }; then
    echo "  FAIL  $1 — not a measurement: $3"; FAIL=$((FAIL+1)); return
  fi
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; PASS=$((PASS+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi
}
api() { docker compose -f docker-compose.prod.yml exec -T api node -e "$1" 2>&1 | tail -1; }
# Every probe must resolve to a status even when the server is unreachable or crashes.
# The 25s deadline is part of the test: a request that never answers is a failure, not a hang.
probe() { api "Promise.race([fetch('$1'${2:-}), new Promise((_,rej)=>setTimeout(()=>rej(new Error('NO_RESPONSE_25S')),25000))]).then(r=>console.log(r.status)).catch(e=>console.log('UNREACHABLE:'+e.message))"; }
q()   { docker compose -f docker-compose.prod.yml exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\"" 2>&1 | tail -1; }

echo "=== T2 backend started / T6 health ==="
chk "api container healthy" "healthy" "$(docker inspect dharohar-prod-api-1 --format '{{.State.Health.Status}}')"
chk "GET /api/health -> 200" "200" "$(api "fetch('http://127.0.0.1:3001/api/health').then(r=>console.log(r.status))")"
chk "GET /api/health/ready -> 200" "200" "$(api "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>console.log(r.status))")"

echo "=== T3 db connectivity + T4 migrations recorded ==="
chk "ready reports postgres-postgis" "postgres-postgis" "$(api "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>r.json()).then(j=>console.log(j.storageMode))")"
chk "schema_migrations has 0001" "1" "$(q "select count(*) from schema_migrations where version='0001'")"
chk "postgis extension present" "1" "$(q "select count(*) from pg_extension where extname='postgis'")"

echo "=== seed demo data (explicitly authorised) then T5/T11 persistence across restart ==="
docker compose -f docker-compose.prod.yml exec -T -e SEED_CONFIRM=demo -e DEMO_PASSWORD="$DEMO_PASSWORD" api node dist-server/db/seed.js >/dev/null 2>&1
BEFORE_P=$(q "select count(*) from parcels"); BEFORE_U=$(q "select count(*) from users")
# Documents POST requires a Bearer token; an anonymous write is correctly refused.
TEH=$(api "fetch('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'tehsildar@dharohar.local',password:'$DEMO_PASSWORD'})}).then(r=>r.json()).then(j=>console.log(j.data?.token||'')).catch(()=>console.log(''))" | tr -d '\r')
DOCID="doc-persist-$(date +%s)"
probe "http://127.0.0.1:3001/api/documents" ",{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $TEH'},body:JSON.stringify({id:'$DOCID',fileName:'persist_probe.pdf',recordType:'Jamabandi',rawOcrText:'khasra 412/1'})}" | sed 's/^/  document POST -> /'
# Link the document to a parcel before the restart. This is the relationship the UI used to keep in
# browser state only, so land_documents.parcel_id stayed NULL and the attachment vanished on reload.
LINK_PID=$(q "select id from parcels where lower(trim(district))=(select lower(trim(district)) from users where id='USR-TEH-01') order by id limit 1")
probe "http://127.0.0.1:3001/api/documents/$DOCID/link" ",{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $TEH'},body:JSON.stringify({parcelId:'$LINK_PID'})}" | sed 's/^/  document link -> /'
echo "  restarting containers (no volume removal)..."
docker compose -f docker-compose.prod.yml restart >/dev/null 2>&1
sleep 25
AFTER_P=$(q "select count(*) from parcels"); AFTER_U=$(q "select count(*) from users")
chk "parcels survive restart" "$BEFORE_P" "$AFTER_P"
chk "users survive restart" "$BEFORE_U" "$AFTER_U"
chk "document row survives restart" "1" "$(q "select count(*) from land_documents where id='$DOCID'")"
chk "document readable via API after restart" "200" "$(probe "http://127.0.0.1:3001/api/documents/$DOCID" ",{headers:{'Authorization':'Bearer $TEH'}}" )"
# The document-to-parcel relationship is the one that used to be browser-only.
chk "document->parcel link persisted in PostgreSQL" "$LINK_PID" "$(q "select parcel_id from land_documents where id='$DOCID'")"
chk "link visible through the API after restart" "$LINK_PID" "$(api "fetch('http://127.0.0.1:3001/api/documents/$DOCID',{headers:{'Authorization':'Bearer $TEH'}}).then(r=>r.json()).then(j=>console.log(j.data?.document?.parcelId||''))" | tr -d '\r')"
chk "parcel points back at the document" "1" "$(q "select count(*) from parcels where id='$LINK_PID' and document_id='$DOCID'")"

echo "=== T8 authz enforced ==="
chk "anonymous parcel read -> 401" "401" "$(api "fetch('http://127.0.0.1:3001/api/parcels').then(r=>console.log(r.status))")"
TOK=$(docker compose -f docker-compose.prod.yml exec -T api node -e "fetch('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'operator@dharohar.local',password:'$DEMO_PASSWORD'})}).then(r=>r.json()).then(j=>console.log(j.data?.token||''))" | tail -1)
OPR_DIST=$(q "select district from users where id='USR-OPR-03'")
# The operator may only act inside their own district, so the positive-path parcel is picked from
# that district. `order by id limit 1` over the whole table used to hand the test a foreign
# parcel, and the resulting 404 was indistinguishable from a jurisdiction bug.
PID=$(q "select id from parcels where lower(trim(district))=lower(trim('$OPR_DIST')) order by id limit 1")
XPID=$(q "select id from parcels where lower(trim(district))<>lower(trim('$OPR_DIST')) order by id limit 1")
XPID_BEFORE=$(q "select land_type from parcels where id='$XPID'")
if [ -z "$PID" ] || [ -z "$XPID" ] || [ -z "$XPID_BEFORE" ]; then
  echo "  FAIL  harness precondition: need a parcel inside and a readable parcel outside the operator's district (own='$PID' foreign='$XPID' foreignLand='$XPID_BEFORE')"; FAIL=$((FAIL+1))
else
  chk "operator seal attempt -> 403" "403" "$(api "fetch('http://127.0.0.1:3001/api/verifications/seal',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $TOK'},body:JSON.stringify({parcelId:'$PID'})}).then(r=>console.log(r.status))")"
  chk "patch verifiedBy -> 400" "400" "$(api "fetch('http://127.0.0.1:3001/api/parcels/$PID',{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer $TOK'},body:JSON.stringify({verifiedBy:'x'})}).then(r=>console.log(r.status))")"
  # Cross-district: answered as 404, never 403 — a 403 would confirm the foreign id is real.
  chk "cross-district parcel GET -> 404" "404" "$(probe "http://127.0.0.1:3001/api/parcels/$XPID" ",{headers:{'Authorization':'Bearer $TOK'}}")"
  chk "cross-district PATCH -> 404" "404" "$(api "fetch('http://127.0.0.1:3001/api/parcels/$XPID',{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer $TOK'},body:JSON.stringify({landType:'WrongDistrictWrite'})}).then(r=>console.log(r.status))")"
  chk "cross-district PATCH left the foreign row unchanged" "$XPID_BEFORE" "$(q "select land_type from parcels where id='$XPID'")"
fi

echo "=== T9 document jurisdiction filing ==="
# A document uploaded without an explicit district must still be reachable by the officer who
# uploaded it; a row with neither a district nor a parcel used to be denied to everyone.
NEWDOC="doc-district-$(date +%s)"
chk "district-less document POST -> 201" "201" "$(probe "http://127.0.0.1:3001/api/documents" ",{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $TEH'},body:JSON.stringify({id:'$NEWDOC',fileName:'district_filing.pdf',recordType:'Jamabandi',rawOcrText:'khasra 900'})}")"
chk "document filed under the uploader's district" "1" "$(q "select count(*) from land_documents where id='$NEWDOC' and lower(trim(district))=lower(trim((select district from users where id='USR-TEH-01')))")"
chk "uploader can read it back -> 200" "200" "$(probe "http://127.0.0.1:3001/api/documents/$NEWDOC" ",{headers:{'Authorization':'Bearer $TEH'}}")"
chk "foreign district read of it -> 404" "404" "$(probe "http://127.0.0.1:3001/api/documents/$NEWDOC" ",{headers:{'Authorization':'Bearer $TOK'}}")"

echo "=== T7 database failure must NOT produce false success ==="
docker compose -f docker-compose.prod.yml stop db >/dev/null 2>&1
sleep 3
chk "ready -> 503 with db down" "503" "$(probe "http://127.0.0.1:3001/api/health/ready" "")"
chk "api process still running with db down" "running" "$(docker inspect dharohar-prod-api-1 --format '{{.State.Status}}')"
# One probe, both assertions — running it twice let the two halves disagree.
# The invariant is "a database outage never produces a success". WHERE it is refused may legitimately
# move: authorizations are re-read from the database per request, so a refusal can now come from the
# authentication layer (AUTHORIZATION_UNAVAILABLE) before the write layer (PARCEL_WRITE_FAILED) is
# reached. Both are 503 and neither claims the record was saved.
WRITE_LINE=$(docker compose -f docker-compose.prod.yml exec -T -e PROBE_TOKEN="$TEH" -e PROBE_RUN="$PROBE_RUN" api node - < scripts/probe-write.mjs 2>&1 | tail -1)
chk "write attempt -> 503, not a success" "503" "$(echo "$WRITE_LINE" | cut -d'|' -f1)"
case "|$(echo "$WRITE_LINE" | cut -d'|' -f2)|" in
  "|PARCEL_WRITE_FAILED|"|"|AUTHORIZATION_UNAVAILABLE|")
    echo "  PASS  write refused with an honest failure code ($(echo "$WRITE_LINE" | cut -d'|' -f2))"; PASS=$((PASS+1)) ;;
  *)
    echo "  FAIL  write refusal code is not an honest failure: $WRITE_LINE"; FAIL=$((FAIL+1)) ;;
esac
docker compose -f docker-compose.prod.yml start db >/dev/null 2>&1
sleep 20
chk "ready recovers to 200" "200" "$(probe "http://127.0.0.1:3001/api/health/ready" "")"

# A health endpoint proving one connection works is not proof that writes work. On 2026-10-19 this
# gate reported "ready recovers to 200" and then the authorization suite's first write failed with
# 503 PARCEL_WRITE_FAILED: the restart had terminated a pooled client, and the request that happened
# to draw it was sacrificed. That is honest behaviour — nothing was claimed that did not commit — but
# a deployment that cannot write after its database came back is not recovered. Retry the probe and
# report how long recovery actually took. A 409 also proves the write path reached the database.
RECOV=""
RECOV_ATTEMPT=0
for attempt in 1 2 3 4 5 6; do
  RECOV_ATTEMPT=$attempt
  RECOV=$(docker compose -f docker-compose.prod.yml exec -T -e PROBE_TOKEN="$TEH" -e PROBE_RUN="$PROBE_RUN" api node - < scripts/probe-write.mjs 2>&1 | tail -1)
  case "$RECOV" in 2[0-9][0-9]\|*|409\|*) break ;; esac
  sleep 5
done
case "$RECOV" in
  2[0-9][0-9]\|*|409\|*)
    echo "  PASS  pool serves a real write after recovery (attempt $RECOV_ATTEMPT: $RECOV)"; PASS=$((PASS+1)) ;;
  *)
    echo "  FAIL  the database is back but writes still fail after $RECOV_ATTEMPT attempts: $RECOV"; FAIL=$((FAIL+1)) ;;
esac

echo "=== T10 web proxy serves SPA + /api ==="
chk "GET / -> 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8088/)"
chk "SPA deep route -> 200 (fallback)" "200" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8088/some/client/route)"
chk "proxied /api/health -> 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8088/api/health)"
chk "db publishes NO host port" "0" "$(docker port dharohar-prod-db-1 2>/dev/null | wc -l | tr -d ' ')"

echo "=== T12 authorization suites against this stack ==="
# The negative-test suites speak HTTP only, so they run against the proxied origin. Both abort with a
# non-zero exit rather than passing vacuously, so a missing seed or a missing administrator is a FAIL
# here, not a skip.
TEST_BASE_URL="http://127.0.0.1:${WEB_PORT:-8088}/api" DEMO_PASSWORD="$DEMO_PASSWORD" npx tsx server/src/test_jurisdiction_suite.ts > /tmp/validate-jurisdiction.log 2>&1
chk "test:jurisdiction passes" "0" "$?"
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  TEST_BASE_URL="http://127.0.0.1:${WEB_PORT:-8088}/api" DEMO_PASSWORD="$DEMO_PASSWORD" ADMIN_EMAIL="${ADMIN_EMAIL:-sysadmin@dharohar.local}" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    npx tsx server/src/test_provisioning_suite.ts > /tmp/validate-provisioning.log 2>&1
  chk "test:provisioning passes" "0" "$?"
else
  echo "  FAIL  ADMIN_PASSWORD not exported — provisioning suite not run (bootstrap: npm run db:bootstrap-admin)"; FAIL=$((FAIL+1))
fi

echo "=== T13 the gate retires the officers it created ==="
# T12 proves authorization by creating real officers in a fabricated domain, against this database.
# Nothing deletes them — there is no hard delete in this application by design — so before this step
# every validation run left a few more accounts that could authenticate, and 16 of the 24 accumulated
# by 2026-10-19 could read Jaipur or Udaipur records. Retirement is soft (revocation + a password
# replaced by a random value that is never printed) and is written into the audit chain by the same
# service the admin API uses. It runs inside the api container because the database publishes no port.
docker compose -f docker-compose.prod.yml exec -T \
  -e RESIDUE_APPLY=true \
  -e RESIDUE_ADMIN_EMAIL="${ADMIN_EMAIL:-sysadmin@dharohar.local}" \
  api node dist-server/retireSuiteResidue.js > /tmp/validate-retire.log 2>&1
chk "suite residue retired (exit 0, none left reachable)" "0" "$?"
if grep -qE 'account\(s\) revoked and locked|holds USER_ADMIN' /tmp/validate-retire.log; then
  echo "  PASS  retirement reported its outcome ($(grep -oE '[0-9]+ account\(s\) revoked' /tmp/validate-retire.log | head -1))"; PASS=$((PASS+1))
else
  echo "  FAIL  retirement exited 0 without saying what it did — read /tmp/validate-retire.log"; FAIL=$((FAIL+1))
fi

echo
echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
