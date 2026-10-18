# DHAROHAR — Deployment Runbook

Target: one small server, HTTPS public URL, PostGIS with persistent storage, no per-user cost.
Everything below describes files that exist in this repository. Where a step depends on something
outside the repository (your DNS panel, your cloud console, a credit card), it says so.

---

## 1. What is being deployed

| Service | Image / build | Listens | Published to the internet |
|---|---|---|---|
| `db` | `postgis/postgis:16-3.4-alpine` | 5432 on the internal network | **No** — the compose file has no `ports:` for it |
| `api` | `Dockerfile.api` (Node 22, compiled ESM, non-root `node` user) | 3001 on the internal network | **No** — reached only through nginx |
| `web` | `Dockerfile.web` (Vite build → nginx 1.27) | 80 in the container | Yes, if you use the plain stack; loopback-only if you use the TLS overlay |
| `caddy` | `caddy:2-alpine` (overlay `docker-compose.tls.yml`) | 80, 443 | Yes — this is the intended single public entry point |

Data that must survive anything: the `dharohar_pgdata` named volume (all land records, documents,
audit chain). `dharohar_uploads` exists for future on-disk artefacts; the current API stores
document bytes inside PostgreSQL columns — see `docs/DOCUMENT-STORAGE.md`.

Readiness contract the stack depends on:

* `GET /api/health` — process is up (does not prove the database).
* `GET /api/health/ready` — actively pings PostgreSQL; **200 only when the database answers**,
  503 otherwise. Compose healthchecks and the container dependency chain use this endpoint, so
  `web` never starts against an unhealthy `api`, and `api` never starts against an unhealthy `db`.
* In `NODE_ENV=production` the API **refuses to boot** when PostgreSQL is unreachable, when
  `JWT_SECRET` is missing or is the leaked prototype value, or when `ALLOWED_ORIGINS=*`.
  It never falls back to in-memory storage in production.

---

## 2. Choose the host (₹0 budget)

Ordered by what actually works for this application. The two hard requirements are **a persistent
disk** (a land-records database cannot live in a container's writable layer) and **a process that
never sleeps** (an API that cold-starts mid-seal can lose a transaction).

1. **Hosting you already pay for.** If your `urbantechx.in` hosting gives you a VPS/VM or any
   "custom Docker / root access" plan, use it — cost is already sunk. Check: can you install Docker,
   open ports 80/443, and keep the VM running 24/7? If yes, skip to §3.
2. **Oracle Cloud Always Free** (`VM.Standard.A1.Flex`, ARM4, up to 4 OCPU / 24 GB RAM, or
   `t2.micro` x86). Genuinely ₹0/month and meets both requirements. **Requires a credit card on file
   for identity verification even on the free tier**, and free ARM capacity is sometimes unavailable
   in a region — you may need to retry or pick another region. I have not created this account for
   you and cannot verify your tenancy or available shapes.
3. **Free PaaS tiers (Render / Railway / Fly.io / Koyeb, etc.).** Do **not** use these for this
   application: the free classes sleep, and/or the database is time-limited or sized for demos.
   A sleeping API plus an ephemeral Postgres is exactly the failure mode the release gate forbids —
   a save that looked successful and is gone. If you want a managed database, that is a paid choice;
   see §11 for the free-to-paid path.

**Real monthly cost of the recommended configuration: ₹0** (Always Free VM + Let's Encrypt + the
domain you already own). The only money that changes hands is if you add a paid block volume or
move off the free VM.

Before anything that can incur a charge — a paid volume, a non-free shape, a managed database, a
Cloudflare paid plan — this deployment does it nowhere. Everything in this runbook is free-tier.

---

## 3. Server preparation (run on the VM as root/sudo)

```bash
# Docker + compose plugin (Debian/Ubuntu/Oracle Linux 8/9 uses yum/dnf instead of apt)
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version          # must print v2.x
```

```bash
git clone <your-repo-url> dharohar && cd dharohar    # or rsync this directory up
```

Architecture note: all four images are multi-arch base images (`node:22-alpine`,
`nginx:1.27-alpine`, `postgis/postgis:16-3.4-alpine`, `caddy:2-alpine`) and the build stages install
dependencies *for the build platform*, so building natively on ARM (`A1.Flex`) or x86 (`VM.Standard`
/ `t2.micro`) both work. **I could not verify this**: the machine this was developed on is x86-64
only, so the ARM64 claim is reasoning from base-image metadata, not a completed ARM build. If you
deploy on ARM, the first `docker compose build` is the test — report back if it fails and the fix
will be in the Dockerfiles, not in application code.

---

## 4. Secrets

Create an untracked `.env` **next to `docker-compose.prod.yml`** (it is already in `.gitignore`;
never commit real values, never put them in a Dockerfile or `docker-compose*.yml`):

```bash
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # JWT_SECRET
```

```ini
# .env — mode 600, owner root
POSTGRES_USER=dharohar
POSTGRES_DB=dharohar
POSTGRES_PASSWORD=<first value>
JWT_SECRET=<second value>
# Optional: keep seals verifiable after a JWT secret rotation.
# SEAL_SIGNING_KEY=<another openssl rand -hex 32>
# JWT_EXPIRY_HOURS=8
```

Compose **fails closed** on these: `${POSTGRES_PASSWORD:?...}` and `${JWT_SECRET:?...}` abort the
command rather than substituting a default. That is why every `docker compose` invocation below
must run from the directory containing `.env` (or with the variables exported).

Rules this project observes: no secret is printed by the app, the scripts or this runbook; the
`README.md` no longer publishes a signing secret; `server/src/config/env.ts` rejects the old leaked
value outright; logs from `scripts/backup.sh` / `restore.sh` mask connection details.

---

## 5. DNS records for `urbantechx.in`

`<SERVER_IP>` = the VM's public IPv4 address (OCI: Instances → your instance → Public IP).

| Type | Name | Value | TTL | Notes |
|---|---|---|---|---|
| `A` | `dharohar.urbantechx.in` | `<SERVER_IP>` | 300 | The officer interface. Required. |
| `AAAA` | `dharohar.urbantechx.in` | your IPv6, if any | 300 | Optional. Omit it unless the VM really has an IPv6 address — a dangling AAAA breaks some clients. |
| `A` | `api.dharohar.urbantechx.in` | `<SERVER_IP>` | 300 | **Only if** you decide to serve the API from a separate origin. The default configuration uses the same-origin `/api` proxy and does not need this record or that certificate. |

Do **not** point `admin.dharohar.urbantechx.in` at this server: there is no admin application in
this repository to serve there. Making that subdomain work is a development task, not a DNS task.

Exact console steps depend on where your DNS lives, which I cannot see:
* **Oracle Cloud DNS**: Networking → DNS Zone Management → Domains → `urbantechx.in` → Add Records →
  record type `A`, name `dharohar.urbantechx.in`, TTL 300, record data `<SERVER_IP>` → Add.
* **Cloudflare**: DNS → Records → Add record → A, name `dharohar`, content `<SERVER_IP>`,
  Proxy status: **Proxied** is optional (see §6 option B); if you choose *DNS only*, Caddy issues the
  certificate itself.
* **Any other registrar/hosting panel**: same three fields — host `dharohar`, type `A`, value
  `<SERVER_IP>`.

Verify before continuing (this is your check, not mine — I cannot resolve your domain):

```bash
dig +short A dharohar.urbantechx.in        # must print <SERVER_IP>
```

---

## 6. HTTPS

### Option A — Caddy overlay (recommended, ₹0, automatic renewal)

`docker-compose.tls.yml` + `deploy/caddy/Caddyfile` add Caddy as the only public entry point:

```bash
cd dharohar
sed -i 's|^dharohar.urbantechx.in.*|dharohar.urbantechx.in|' deploy/caddy/Caddyfile  # only if you changed the hostname
WEB_BIND=127.0.0.1 docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d --build
```

* `WEB_BIND=127.0.0.1` keeps the nginx container's port 8088 on loopback, so **plain HTTP is never
  exposed** — the merged compose config publishes only 80 and 443. Verify it on your own machine:

  ```bash
  WEB_BIND=127.0.0.1 docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml config --format json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const [n,sv] of Object.entries(JSON.parse(s).services))console.log(n,JSON.stringify(sv.ports||[]))})"
  # expected: api [] · db [] · caddy [{target:80},{target:443}] · web [{"host_ip":"127.0.0.1","published":"8088"}]
  ```
* Put the hostname in `deploy/caddy/Caddyfile` (one line) and the ACME contact `email` in its global
  block. Caddy requests the certificate when it first receives a request for that name and renews
  automatically; HTTP is redirected to HTTPS by Caddy's own logic.
* Certificates persist in `dharohar_caddy_data`, so restarts do not re-issue them.
* Cloud firewall: open **80 and 443** inbound (80 is required — ACME HTTP-01 validation uses it).

**What has been verified here**: `caddy validate` reports `Valid configuration` for the committed
Caddyfile, and the merged compose configuration publishes exactly 80/443 with 8088 bound to
loopback. **What has not**: an actual Let's Encrypt issuance, because that needs your public DNS and
your server. Do not treat the local validation as proof of a working certificate.

### Option B — Cloudflare Tunnel (no inbound ports at all)

`cloudflared tunnel` connects out to Cloudflare, so the VM needs no open ports and TLS terminates at
the Cloudflare edge; your origin stays HTTP on loopback only. Free on the Cloudflare free plan.
Trade-off: Cloudflare becomes a mandatory hop for every request, their free plan is not designed for
government-scale traffic, and the tunnel must be rebuilt if you ever leave Cloudflare. Not configured
in this repository — say the word if you want it and I will add a tested `tunnel.yml` + compose service.

### If you must run without TLS

Do not. The JWT is sent in an `Authorization` header and the login form carries a password; over
plain HTTP on a public link both are readable by anyone on the path.

---

## 7. Deploy, migrate, and the first accounts

```bash
cd dharohar

# 1. Start the stack (migrations run automatically on API start; RUN_MIGRATIONS defaults to true)
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d --build

# 2. Confirm each layer
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml ps      # all healthy
docker compose -f docker-compose.prod.yml exec api node dist-server/db/migrate.js   # "No pending migrations"
curl -s https://dharohar.urbantechx.in/api/health/ready                     # storageMode: postgres-postgis

# 3. Introduce the first administrator (once — see §7 "Officer accounts")
docker compose -f docker-compose.prod.yml exec -it \
  -e BOOTSTRAP_ADMIN_EMAIL="you@department.example" \
  -e BOOTSTRAP_ADMIN_NAME="First System Administrator" \
  -e BOOTSTRAP_ADMIN_DISTRICT="Jaipur" \
  api node dist-server/db/bootstrapAdmin.js

# 4. Read the jurisdiction report before and after any migration that touches districts
#    (0003 is one). It never repairs a row: it names the rows that need a departmental decision.
npm run test:integrity          # exit 0 = consistent; exit 1 = findings, listed by primary key
```

**Before upgrading a database that already holds records, take a backup and read the report.**
Migration 0003 is additive and refuses to guess — but it can refuse loudly: an ambiguous registry
(two spellings of one jurisdiction) or a `districts.code` that is not the lower-case form of its name
aborts the whole file, rolls back, and leaves the database exactly as it was. That is the designed
behaviour, not a failure of it. The runner prints PostgreSQL's `detail` and `hint`, and the hint names
`npm run test:integrity` as the way to see the offending rows. Resolve them with the department's
answer, then re-run. `docs/DISTRICT-INTEGRITY-REPORT.md` §3 lists what 0003 will not do on its own.`server/src/db/migrations/*.sql` in filename order, records each in `schema_migrations` with a
SHA-256 checksum, refuses to run if an already-applied file changed, runs each file in its own
transaction (failure = no partial application, nothing recorded), and refuses statements that cannot
be transacted. It never drops, truncates or reseeds. Re-running it is a no-op.

### Do not seed a real database

`npm run db:seed` / `node dist-server/db/seed.js` inserts **fabricated demo records**. It is refused
in production unless you pass `SEED_CONFIRM=demo` deliberately:

```bash
# Demo only. Never against a database holding real land records.
docker compose -f docker-compose.prod.yml exec -e SEED_CONFIRM=demo api node dist-server/db/seed.js
```

Booting the stack **never** seeds. Seeding is a separate, explicit, auditable action.

### Database role versus officer accounts

Two different things, often confused:

**1. The PostgreSQL role the API connects as.** `scripts/roles.sql` creates a least-privilege
database role and grants/revokes exactly what the API needs. It is **additive only** — it never drops
a role, a table, another role's grants or any data. It requires a password passed in, never embedded:

```bash
export DHAROHAR_APP_PASSWORD="$(openssl rand -base64 32)"     # never commit it
docker compose -f docker-compose.prod.yml exec -T \
  -e PGPASSWORD="$POSTGRES_PASSWORD" db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-psqlrc -q -v ON_ERROR_STOP=1 \
  -v app_password="$DHAROHAR_APP_PASSWORD" -f - < scripts/roles.sql
```

Run it as the schema owner, once per database the API uses. If you do, point `PGUSER`/`PGPASSWORD`
(or `DATABASE_URL`) in `.env` at the new role and re-create the API container.

**2. Officer accounts — provisioned, audited, and never self-service.** There is no registration
endpoint and no admin screen yet (the screen is the remaining work). The mechanism is a CLI bootstrap
that introduces the first administrator, then `/api/admin` for everyone after that.

```bash
# Once per deployment, from a shell with DATABASE_URL pointing at the migrated database:
BOOTSTRAP_ADMIN_EMAIL="you@department.example" \
BOOTSTRAP_ADMIN_NAME="First System Administrator" \
BOOTSTRAP_ADMIN_DISTRICT="Jaipur" \
BOOTSTRAP_ADMIN_PASSWORD="$(read -rs pw && printf '%s' "$pw")" \
  npm run db:bootstrap-admin
```

In a container, with no password in your shell history:

```bash
docker compose -f docker-compose.prod.yml exec -it \
  -e BOOTSTRAP_ADMIN_EMAIL="you@department.example" \
  -e BOOTSTRAP_ADMIN_NAME="First System Administrator" \
  -e BOOTSTRAP_ADMIN_DISTRICT="Jaipur" \
  api node dist-server/db/bootstrapAdmin.js
```

If `BOOTSTRAP_ADMIN_PASSWORD` is unset the command generates one and prints it **once** — it is not
stored anywhere readable. The command refuses to run when someone already holds `USER_ADMIN`
(verified: exit 4, nothing created, nothing touched), so it cannot become a back door or a password
reset. Everything after the first administrator goes through the API, each call capability-gated and
each change written to the audit chain:

| Call | Effect |
|---|---|
| `POST /api/admin/officers` | create an officer with role, district assignments and capabilities in one transaction. Refuses an officer who could do nothing (no district and no state-wide read), a short password, an unknown capability, and a duplicate email (409) |
| `PUT /api/admin/officers/:id/jurisdictions` | replace the district set; the audit entry records what was added and what was revoked |
| `PUT /api/admin/officers/:id/capabilities` | replace `STATE_WIDE_READ` / `USER_ADMIN` / `PARCEL_REHOME` grants |
| `PATCH /api/admin/officers/:id/role` | change role, with a stated reason |
| `POST /api/admin/officers/:id/password-reset` | replace the password; the new value never reaches a log or the audit trail |
| `GET /api/admin/officers` | roster with live assignments — `password_hash` and `salt` are not selected |
| `GET /api/admin/districts` | the jurisdiction registry with the counts an operator needs before retiring a district: records filed there, officers currently posted there |
| `POST /api/admin/districts` | declare a jurisdiction as the department spells it. Since migration 0003 nothing can be filed under a district that is not declared, so **this is the only supported way to widen the registry** — declaring by hand in `psql` works but leaves no audit entry. A name that normalizes to an existing jurisdiction is refused with both spellings named; the caller never supplies a code, because `code = lower(trim(name))` is enforced |
| `PATCH /api/admin/districts/:code/active` | retire or restore a jurisdiction, reason required. Nothing is deleted and no record moves: officers keep access to what is already filed there, and only new filing stops |

Revoking a jurisdiction or a capability takes effect on the **next request** from an already-issued
token, because authorization is re-read from the database rather than trusted from the JWT. Verified
by `npm run test:provisioning`.

**Re-districting a record** is equally explicit — a parcel's `district` cannot be patched (PATCH
answers 400 `JURISDICTION_CHANGE_REQUIRES_REHOMING`); it moves through
`POST /api/parcels/:id/jurisdiction`, which needs the `PARCEL_REHOME` capability plus an assignment
over both districts and a reason, writes provenance into `parcel_mutations`, and appends its own
`PARCEL_REDISTRICTED` audit entry without touching earlier ones. Nothing in the codebase infers which
district a record belongs to: the destination is always supplied by someone authorized to say it.

---

## 8. Backup and restore

```bash
# Backup (read-only against the source; never writes, truncates or drops)
mkdir -p /var/backups/dharohar          # --output is a DIRECTORY only if it already exists;
                                        # otherwise the value is used as the output file path
PGUSER=dharohar ./scripts/backup.sh \
  --container dharohar-prod-db-1 --dbname dharohar --output /var/backups/dharohar
# → /var/backups/dharohar/dharohar_dharohar_<YYYYmmdd_HHMMSS>.dump  (+ .sha256 sidecar)
# Verify a dump before trusting it — the sidecar records the file name only, so run it from the
# directory that holds the dump:  cd <backup dir> && sha256sum -c <file>.dump.sha256
# Exit codes: 0 ok, 2 usage, 3 connection/target problem, 4 dump failed

# Restore — into an EMPTY database, always
./scripts/restore.sh \
  --container dharohar-audit-pg --dbname dharohar_restore_test \
  --input /var/backups/dharohar/dharohar_dharohar_20261016_152000.dump --create-db
# Exit codes: 0 ok, 2 usage, 3 refused by the safety gate, 4 restore failed
```

Restore safety, by design: it **refuses a target that already holds user relations** (PostGIS's own
`spatial_ref_sys` is ignored) and exits 3 rather than overwriting; nothing is ever dropped or
truncated first; the restore runs in a single transaction with `--exit-on-error`, so a failure
leaves the target exactly as it was; the `.sha256` sidecar is verified automatically when present.
`--allow-non-empty` exists for deliberate re-application — use it knowingly.

Schedule it (crontab on the VM, daily at 02:30, keeping 14 days):

```cron
30 2 * * *  cd /root/dharohar && PGUSER=dharohar ./scripts/backup.sh --container dharohar-prod-db-1 --dbname dharohar --output /var/backups/dharohar >> /var/log/dharohar-backup.log 2>&1 && find /var/backups/dharohar -name '*.dump' -mtime +14 -delete
```

A backup you have never restored is a hope, not a backup. **Restore drill before go-live**, on a
disposable container:

```bash
docker run -d --name dharohar-audit-pg -e POSTGRES_PASSWORD_FILE=/run/secrets/pgpass \
  -e POSTGRES_USER=dharohar -e POSTGRES_DB=dharohar -v /tmp/drill:/tmp/drill postgis/postgis:16-3.4-alpine
./scripts/restore.sh --container dharohar-audit-pg --dbname dharohar_drill \
  --input /var/backups/dharohar/<latest>.dump --create-db
docker exec dharohar-audit-pg psql -U dharohar -d dharohar_drill -c \
  "select (select count(*) from parcels), (select count(*) from land_documents), (select count(*) from append_only_audit_logs);"
```

Compare those counts against production, and verify the audit chain in the restored copy:

```bash
curl -s -X GET https://dharohar.urbantechx.in/api/verifications/audit-logs/verify-chain \
  -H "Authorization: Bearer <AUDITOR token>"
```

Copy at least one dump off the machine (Object Storage, another host, encrypted). A dump that dies
with the VM protects nothing.

---

## 9. Verification

`scripts/validate-stack.sh` runs the whole sweep against the compose stack and prints PASS/FAIL with
a count and a non-zero exit on any failure — it cannot pass silently.

```bash
bash scripts/validate-stack.sh
```

It covers: containers healthy and `/api/health` + `/api/health/ready` → 200; PostGIS extension and the
`schema_migrations` ledger rows present (0001 and 0002); **persistence across a container restart with
no volume removal** (parcel/user/document counts identical, a written document still readable through
the API, and the **document→parcel link still attached** in both the database and the API response);
authorization (anonymous read → 401, wrong role seal → 403, patching `verifiedBy` → 400,
**cross-district read and PATCH → 404 with the foreign row provably unchanged**); document
jurisdiction filing (district-less upload is filed under the uploader, readable by them, 404 to
another district); **database outage** (`/api/health/ready` → 503, the API process still `running`, a
write attempt → 503 `PARCEL_WRITE_FAILED`, then recovery to 200); the nginx proxy (SPA root, SPA deep
route, `/api/health` proxied); that **the database publishes no host port**; and finally the two
authorization suites against this stack.

The sweep refuses to report a pass it did not measure: it aborts with exit 2 if the Docker daemon is
unreachable or the database credentials cannot be read, and any check whose "actual" value is an error
string (compose interpolation failure, daemon unreachable, container missing) is scored FAIL rather
than compared against another error string. That is not theoretical — a run with the daemon dead
produced exactly such a false PASS before the guard existed.

`npm run test:jurisdiction` (46 assertions) and `npm run test:provisioning` (57 assertions) are the
negative tests: an officer of District A denied District B through ID substitution, query parameters,
alternate endpoints, document references and audit reads, with the foreign row snapshotted before and
after; plus multi-district grants, immediate revocation, state-wide read without mutation, the logging
of state-wide reads, the full re-homing matrix and password rotation.

Current results are in the completion report. Anything marked "not verified" there is genuinely
unverified — chiefly: public DNS resolution, a real ACME certificate, ARM64 build, and any claim
about behaviour at scale.

---

## 10. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | Compose fails closed by design. | Run from the directory holding `.env`, or export the variables. |
| API container restarts with `Production startup requires a reachable PostgreSQL database` | Intentional: the API will not run without its database. | `docker compose ... ps db` → if unhealthy, check the `dharohar_pgdata` volume exists and the DB logs. |
| `/api/health/ready` returns 503 but the page loads | The API is up, the database is not. Writes are refused with 503 rather than faked. | Same as above. Never "fix" this by unsetting `NODE_ENV`. |
| Authenticated requests all answer 503 `AUTHORIZATION_UNAVAILABLE`, or login answers 503 `AUTH_LOOKUP_UNAVAILABLE` | Expected while the database is unreachable: officer jurisdictions and capabilities are re-read per request, so the server refuses rather than trusting a cached or in-memory answer. It is not an auth bug and not a bad token. | Restore the database. Sessions resume on the next request; nobody needs to re-log in unless their token expired. |
| Login works, then everything is empty and the header says `demo` | The SPA could not reach the API and is in demo mode. | Check `WEB_BIND`, the `/api/` proxy, and that `VITE_API_BASE` was left at `/api`. |
| 401 with `INVALID_TOKEN` after a deploy | Tokens are signed with `JWT_SECRET`; changing it invalidates every session. Expected. | Re-login. If it happens without your changing the secret, the container is not getting `.env`. |
| `403 Access denied` on seal | Only `TEHSILDAR` may seal — identity is taken from the token, never the request body. | Correct. |
| `404 Land parcel ... not found` for a parcel you know exists | Either it truly is absent, **or** it belongs to another district — cross-district access is answered 404 on purpose so record existence is not leaked. | Check `select district from parcels where id='...'`. |
| OCR fails with "network error" on a fresh deploy | The self-hosted assets at `/tesseract/` are missing from the image. | `Dockerfile.web` fails the build if they are absent; if you bypassed it, `public/tesseract/` is incomplete — see `public/tesseract/PROVENANCE.md`. |
| `docker port dharohar-prod-db-1` shows anything | The database is reachable from the host network. | Restore the committed compose file — it must have no `ports:` for `db`. |
| Maps or fonts fail in a restricted network | CSP allow-lists `*.tile.openstreetmap.org` and Google Fonts; those are still external calls from the **browser**. | Air-gapped deployment needs them vendored too — see `docs/SECURITY.md` §"external browser dependencies". |

Useful commands:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 api
docker compose -f docker-compose.prod.yml exec api node -e "console.log(process.env.NODE_ENV)"
docker compose -f docker-compose.prod.yml ps
```

---

## 11. Rollback

Migrations are forward-only, so rollback is **restore the dump**, not "run the old SQL":

```bash
docker compose -f docker-compose.prod.yml down              # volumes are NOT removed
# Restore the pre-change dump into a fresh database name, verify counts, then point the API at it
# by changing POSTGRES_DB in .env and re-updating, OR restore over a deliberately emptied target.
```

Application rollback: `docker compose -f docker-compose.prod.yml build --pull api web` after
`git checkout <known-good-tag>`, then `up -d`. The schema does not roll back — which is why
migrations must stay additive and why the restore drill in §8 is a go-live gate.

---

## 12. Free → paid migration path

Nothing in the application is specific to the free tier. To move:

1. **More CPU/RAM on the same box** — resize the OCI instance (Free → paid shapes). No config change.
2. **Separate managed database** — `./scripts/backup.sh`, restore into the managed Postgres
   (it must support PostGIS), then set `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (or
   `DATABASE_URL`) in `.env`, `docker compose up -d api`. Verify with `/api/health/ready` →
   `storageMode: postgres-postgis`.
3. **Object storage for document bytes** — already designed in `docs/DOCUMENT-STORAGE.md`; it becomes
   worth paying for once the database exceeds a few GB of base64 images.
4. **Backups off-box** — OCI Object Storage standard tier is cheap; the dump format is unchanged.

---

## 13. Outstanding before real records go public

Read `docs/DATA-MODEL-JURISDICTION.md` §2 and §5, and `docs/SECURITY.md` §7. The five design defaults
are adopted and implemented; **formal organisational policy confirmation is still outstanding**, and
nothing here claims it. What is genuinely left:

1. **Public verification, none of it done.** DNS resolution for your domain, a real Let's Encrypt
   issuance, external browser/API reachability and any behaviour under load. This repository has only
   ever been run on a local container network.
2. **No administrative interface** — provisioning is CLI + `/api/admin`, working and audited, but not
   clickable.
3. **The deployment default is still a superuser database role.** `scripts/roles.sql` produces a
   least-privilege role that the whole suite passes through, but compose still connects as
   `POSTGRES_USER`. Switch it, then Row-Level Security becomes worth writing.
4. **Document bytes still live in database columns** — `docs/DOCUMENT-STORAGE.md` is a plan, not a
   migration.
5. **Real records must arrive with an authoritative district.** Migration 0003 now makes that the
   database's problem as well as the application's: a district that is not declared cannot be written,
   and every jurisdiction column carries a foreign key to `districts(code)`. What is still missing is
   the declaration itself — the registry is currently populated only from values already stored, so it
   reflects what the data says, not what the department recognises. Declare the districts before
   importing, then run `npm run test:integrity` against the loaded database and treat any finding as a
   blocker to report rather than a field to guess.
6. **The dashboard's district MIS figures are fabricated demo data.** They are badged ("Demo figures"),
   scoped to the officer's own districts, and empty-state-guarded — but they remain sample numbers in a
   government interface, which is a product decision you should make consciously, not inherit.
