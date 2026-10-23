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
# The four demo personas' password. There is no shared demo password in this repository: the seed
# reads this value, refuses to run against a production database without SEED_CONFIRM=demo, and
# prints it once. The suites and scripts/validate-stack.sh take it from the environment too.
DEMO_PASSWORD=<openssl rand -hex 12, or any private value>
# Optional: keep seals verifiable after a JWT secret rotation.
# SEAL_SIGNING_KEY=<another openssl rand -hex 32>
# JWT_EXPIRY_HOURS=8
# WEB_BIND=0.0.0.0   # only once TLS is in place; the default is 127.0.0.1
```

Compose **fails closed** on these: `${POSTGRES_PASSWORD:?...}` and `${JWT_SECRET:?...}` abort the
command rather than substituting a default. That is why every `docker compose` invocation below
must run from the directory containing `.env` (or with the variables exported).

Rules this project observes: no secret is printed by the app, the scripts or this runbook; the
`README.md` no longer publishes a signing secret; `server/src/config/env.ts` rejects the old leaked
value outright; logs from `scripts/backup.sh` / `restore.sh` mask connection details.

### Rotating a credential that was published

Rewriting git history does not un-teach a password. When a credential that authenticates something
has been committed, the order below is the one that worked on 2026-10-19; each step names what proves
it, because "we rotated it" and "the deployed service still accepts it" looked identical until the
second one was measured.

1. `./scripts/backup.sh --container <db> --dbname <db>` and `sha256sum -c` the sidecar **from inside
   the `backups/` directory** — from the repository root the recorded filename does not resolve and
   the check fails for a reason that has nothing to do with the data.
2. Remove the literal from the source, then prove it: `grep -rl '<literal>' --exclude-dir=node_modules
   --exclude-dir=.git .` must print nothing.
3. Rebuild and recreate the stack. Prove the *running artifact* is the fixed one:
   `docker exec <api> grep -rl '<literal>' /app/dist-server` must print nothing. A container built
   from a directory you have since deleted will keep serving the old code indefinitely.
4. Rotate the credential in the database — re-seed the demo personas with a new `DEMO_PASSWORD`, or
   change the real account through the provisioning path. Then measure both directions against the
   live service: old value → `401`, new value → `200`, **for accounts you have confirmed exist**.
   Testing a username that is not in `users` also returns `401`, which is how this step reported
   success on a deployment that was still exposed.
5. Rotate `JWT_SECRET`, and expect every issued token to die with it.
6. Replace the published history (`--force-with-lease`), then re-scan:
   `for c in $(git rev-list origin/main); do git grep -I '<literal>' "$c"; done` must find nothing.
7. Disposition the scanner alerts manually — see `docs/SECURITY.md` §8.

### Rotating the runtime database credential (`dharohar_app`)

Distinct from the case above: here the secret was never in a file that Git can rewrite — it was
*displayed*. A `docker inspect` of the API container printed `DHAROHAR_APP_PASSWORD` into a chat
transcript on 2026-10-23, and a later attempt to list "variable names only" from the rendered compose
file printed the whole `DATABASE_URL:` line because YAML renders `key: value`, not `key=value`. Both
times the value went to a place it should not have gone. The rule that follows from that: when redacting
a secret, count **occurrences of the value**, never lines, because a line that contains it is now a line
that shows it.

Where the credential actually lives — measured on 2026-10-23, by digest, before touching anything:

```
.env  DHAROHAR_APP_PASSWORD  ──compose interpolation──┬─→ roleinit: environment DHAROHAR_APP_PASSWORD
        digest 4806a5129364                           │     └→ psql -v app_password=… → scripts/roles.sql
                                                      │         ALTER ROLE dharohar_app … PASSWORD :'app_password'
                                                      ├─→ roleinit: PGPASSWORD (same value, different name)
                                                      └─→ api: DATABASE_URL postgresql://dharohar_app:…@db:5432
                                                            and api: PGPASSWORD
```

The API container does **not** receive `DHAROHAR_APP_PASSWORD` itself (its digest there was the empty
string), so `.env` is the single source and there is no second copy of the secret to find. Three other
holders exist and are deliberately *not* part of this rotation: `POSTGRES_PASSWORD` (the owner identity
`dharohar`, used by `migrate`, `roleinit` and `maint`), `DHAROHAR_VERIFIER_PASSWORD`
(read-only `dharohar_verifier`, never exposed) and `DEMO_PASSWORD` (officer logins — a different layer
entirely; rotating a database role does not log anybody out). `.env` also still carries `PGUSER=postgres`
and a `PGPASSWORD` for a role that does not exist in the container: stale leftovers, untouched, and the
digest comparison above is what proves they stayed untouched.

Do it with the script, which is this procedure with rails on:

```bash
./scripts/rotate-app-credential.sh --check    # maps the holders and changes nothing
./scripts/rotate-app-credential.sh            # rotate, verify both directions, revert itself on failure
```

What it does, and how each step is proved rather than asserted (this is the run that executed on
2026-10-23):

1. **Generate** `openssl rand -hex 32`. Hex, not base64: compose interpolates the value into
   `DATABASE_URL` raw, and a `/` or `+` makes the URL unparseable — the API then dies with `Invalid URL`,
   which names neither the setting nor the cause.
2. **Rewrite exactly one span of bytes in `.env`.** A literal string replacement, not a regex over the
   file, because `.env` here is mixed CRLF/LF and a rewrite would normalise terminators and make the diff
   lie. Proof: the file grows by exactly the length difference (574 → 606 bytes for 32 → 64 characters),
   and a digest over *all the other* secrets is equal before and after
   (`88b98d72b991` on both sides).
3. **Re-assert the role** through the supported path: `docker compose -f docker-compose.prod.yml up -d
   roleinit`. Proof: exit 0, and `md5(rolpassword)` of `dharohar_app` in `pg_authid` changes
   (`d29e4294…` → `ee2f310a…`). That digest is of the SCRAM verifier, not the password.
4. **Test both directions** — the step that separates a rotation from a hope:

   ```bash
   printf '%s\n' "<the old value>" | docker compose -f docker-compose.prod.yml run --rm --no-deps -T db \
     psql -h db -U dharohar_app -d dharohar -W -tAc 'select current_user'
   #   → FATAL: password authentication failed for user "dharohar_app"      (this is the PASS)
   ```

   then the same with the new value → `dharohar_app`. The password travels through **stdin**; note `-W`
   (force the prompt) — `-w` means *never* prompt, and every attempt then fails with
   `fe_sendauth: no password supplied` for a reason that has nothing to do with the credential. Neither
   value is ever a command-line argument (it would sit in the process list and the shell history).
5. **Recreate the dependent service**: `up -d --force-recreate api`, because an already-open pool holds
   connections authenticated under the old credential and will keep working — which is exactly how a
   "successful" rotation can leave a live old password in service. Proof: `/api/health/ready` returns 200
   (`/api/health` only reports the boot mode; `/ready` probes the database **live**, so it is the
   endpoint that proves the running service authenticated with the new value).
6. **On any failed check the script restores the previous value**, re-runs `roleinit`, and compares the
   verifier digest against the one it captured at the start — so a half-applied rotation cannot be
   mistaken for a finished one.

If you must do it by hand instead: edit the one line in `.env`, then run steps 3–5's three commands, then
`git status --porcelain .env` (must print nothing; `.env*` is ignored) and the two `psql -W` attempts
above. What you may not skip is step 4 in both directions: this project has already had a rotation
report success while the deployed service still accepted the old credential.

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

# 1. Start the stack. Compose runs the one-shot `migrate` (schema owner) and `roleinit` (grants) to
#    completion before the API starts, and the API runs as the least-privilege role with
#    RUN_MIGRATIONS=false — it is not allowed to write the migration ledger, by grant.
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
#    Against the containerised stack the database publishes no host port, so run the same check
#    through a one-shot service. NOT through `exec api`: since migration 0006 the api container connects
#    as dharohar_app, which is subject to row-level security and reads zero parcels with no tenant
#    bound — a checker run that way reports records it cannot see as missing, so it now refuses to run
#    as that identity. `maint` carries the schema-owner credential, which owns the tables and is
#    therefore exempt.
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  maint dist-server/verify_district_integrity.js

# 5. Retire the officer accounts the test gate created (it runs suites against this stack, so it
#    creates real logins in a fabricated domain, and nothing deletes rows by design).
#    Dry run first — it lists every candidate with what they can currently reach:
docker compose -f docker-compose.prod.yml exec -T api node dist-server/retireSuiteResidue.js
#    Then act: revoke jurisdictions + capabilities and invalidate the password, each change audited.
docker compose -f docker-compose.prod.yml exec -T -e RESIDUE_APPLY=true \
  -e RESIDUE_ADMIN_EMAIL=sysadmin@dharohar.local api node dist-server/retireSuiteResidue.js
```

**Before upgrading a database that already holds records, take a backup and read the report.**
Migration 0003 is additive and refuses to guess — but it can refuse loudly: an ambiguous registry
(two spellings of one jurisdiction) or a `districts.code` that is not the lower-case form of its name
aborts the whole file, rolls back, and leaves the database exactly as it was. That is the designed
behaviour, not a failure of it. The runner prints PostgreSQL's `detail` and `hint`, and the hint names
`npm run test:integrity` as the way to see the offending rows. Resolve them with the department's
answer, then re-run. `docs/DISTRICT-INTEGRITY-REPORT.md` §3 lists what 0003 will not do on its own.

Migrations are applied from `server/src/db/migrations/*.sql` in filename order, recorded each in `schema_migrations` with a
SHA-256 checksum, refuses to run if an already-applied file changed, runs each file in its own
transaction (failure = no partial application, nothing recorded), and refuses statements that cannot
be transacted. It never drops, truncates or reseeds. Re-running it is a no-op.

**Adding a migration file is not enough on a containerised deployment.** The `migrate` one-shot reads
the migrations directory *baked into the image*, so a newly added file is invisible until the image is
rebuilt. Discovered the hard way on 2026-10-19: `run --rm migrate` reported "No pending migrations.
3 applied" while the fourth file sat on the host. Re-running it on 2026-10-20 for migration 0005 said
"4 applied, schema up to date" *and* warned that 0004's file had vanished — same cause, and it needed
`--profile tools build migrate` as well as `build api`, because the `migrate` service has its own
`build:` block and is a separate image. Building works from the local layer cache; no registry access
is required. Check rather than assume:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate      # says what it sees
docker compose -f docker-compose.prod.yml exec -T api ls dist-server/db/migrations   # baked into api
docker run --rm --entrypoint sh dharohar-prod-migrate:latest -c 'ls -1 /app/dist-server/db/migrations'
```

If a filename is missing from either listing, the image is stale and no amount of re-running `migrate`
will change that. Build **every** service, not just the two you thought of: `migrate`, `roleinit` and
`maint` each have their own `build:` block and therefore their own image, and on 2026-10-21
`--profile tools build migrate api` left `assignOwnership.js` out of `maint`, which surfaced as
`Cannot find module`. The one command that cannot miss one:

```bash
docker compose -f docker-compose.prod.yml --profile tools build
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate
```

### Which migrations exist, and what each one is for

| | What it does | Guarded by |
| --- | --- | --- |
| `0001`–`0003` | base schema, jurisdiction model, stable district identifiers and the write-time sync trigger | `npm run test:registry` (its own scratch databases) |
| `0004` | canonical district registry, `organizations`, `organization_districts`, `organization_units`, the named demo tenant | `scripts/test-tenant-migration.sh` §3–5 |
| `0005` | the district identifier becomes the primary key; the owner's RJ mapping; probe-pattern fixtures retired | same drill, §5b; `fk_*_district_code` kept as the trigger-bypass backstop |
| `0006` | record **ownership** distinct from district **jurisdiction**: `land_documents.organization_id`, attribution columns with CHECK constraints, ownership assigned only on a stated basis, row-level security on `parcels` and `land_documents` | same drill, §5c; `scripts/test-authorization-on-copy.sh` proves the policies against `dharohar_app` |
| `0007` | a declaration is `candidate`, not canonical geography; promotion needs `USER_ADMIN` + a reason | same drill, §5d; `validate-stack.sh` asserts the default and that retired fixtures stay retired |
| `0008` | audit entries record `actor_user_id` / `actor_organization_id`, outside the entry hash | same drill, §5e — including that the chain digest is unchanged by a re-apply |
| `0009` | `parcel_owners`, `parcel_mutations` and `field_inspections` come under row-level security by inheriting their **parent parcel's** policy — a co-sharer list, a mutation history and a field survey no longer depend on the query that joins them | same drill, §5f: apply, 12 policies asserted by predicate and role, the guard fired on purpose by dropping 0006's policy, rollback refused while a foreign policy exists, re-apply after rollback |
| `0010` | the four authorization tables stop being the exception: `users`, `user_jurisdictions`, `user_capabilities` and `organization_districts` come under row-level security (own row **or** own organization), `dharohar_app` loses table-level SELECT on `users` and keeps it on 17 of 19 columns (`password_hash`, `salt` revoked), and login moves to two `SECURITY DEFINER` functions owned by a **NOLOGIN** `dharohar_identity` role | same drill, §5g; `scripts/test-authorization-on-copy.sh` §9 of the tenancy suite; `scripts/test-fresh-install.sh` proves it applies on a from-nothing database, where the privilege half is deferred to `roleinit` |

Each of `0006`, `0007`, `0008` and `0010` aborts if the migration it is stated against has not been
applied, so they cannot be applied out of order, and each has a `rollback-NNNN.sql` that refuses rather
than guessing: 0006's refuses to erase a human ownership assignment, 0007's refuses while candidate
districts are unresolved, 0010's refuses while any policy it did not create is attached to the four
tables it protects — because dropping those would silently un-secure them — and warns in its own output
that rolling it back restores the runtime role's ability to read every password hash.

### Prove a migration on a copy before the runner ever sees it

Two scripts exist so a schema change is executed against a throwaway database, never against the only
copy of the working data:

```bash
./scripts/test-tenant-migration.sh        # 141 assertions: apply, idempotence, rollback, guards
./scripts/test-authorization-on-copy.sh   # restore a copy, least-privilege API, three suites
./scripts/test-fresh-install.sh           # empty database -> full schema, twice, and compared
./scripts/test-rls-blind-certifier.sh     # the chain certifier must REFUSE a partial read
```

The first takes a migration from `server/src/db-draft/NNNN_*.sql`, applies it, re-applies it, rolls it
back with the matching `rollback-NNNN.sql` and proves the rollback really restored the previous
trigger. The second restores the deployed database into a new database on the scratch PostGIS
container, applies `scripts/roles.sql`, starts a temporary API as `dharohar_app`, bootstraps an
administrator **on the copy only**, and runs the jurisdiction, provisioning and tenancy suites against
it. Both drop everything they create on exit. Neither writes to `dharohar-prod-db-1` except a
read-only `pg_dump`.

Generate database passwords as **hex**, not base64: `openssl rand -hex 32`. Compose interpolates
`DHAROHAR_APP_PASSWORD` into `DATABASE_URL` raw, and base64 can contain `/` or `+`, which makes the
URL unparseable — the API then refuses to start in production with `Invalid URL`, which is correct
behaviour but names neither the setting nor the cause.

### Installing into an empty database — two passes, and why that is correct

`npm run db:migrate` on a brand-new database stops at 0006 with

```
[TENANCY_NO_CANONICAL_GEOGRAPHY] the registry has no canonical districts,
so there is no defined basis for an assignment. Nothing was changed.
```

That is the migration behaving as designed, not a failure to work around. In the demo deployment the
four canonical districts were already present as data when 0004 ran, so 0004 classified what was there
and 0006 had a basis to assign ownership from. A new database has no districts at all, so there is
nothing to assign from — and inventing geography because a deploy script needs it to finish is exactly
the invention this schema refuses everywhere else. The install is therefore two passes with an
attributable human decision between them:

```bash
npm run db:migrate            # 0001–0005, then stops and says why: no canonical geography yet
npm run db:declare-geography  # a person states the districts and which tenant holds which one
npm run db:migrate            # 0006–0009 now have their basis and apply
npm run db:seed               # optional: the synthetic demo dataset, into a single-tenant database
npm run db:bootstrap-admin    # the first officer, given BOOTSTRAP_ORG_ID
```

Re-running any of these is safe: the declaration is idempotent (canonical rows that already exist are
reported and left alone, and `organization_districts` has a unique constraint so a grant is never
duplicated), and the runner records each version once.

`db:declare-geography` refuses rather than guessing, and `scripts/test-fresh-install.sh` asserts each
refusal: a reason shorter than ten characters, an organization id that does not exist, a district name
colliding with an existing row under a different code, re-classifying a district that is already
`test_fixture` or `retired` without `GEOGRAPHY_OVERWRITE=true`, and the same name listed twice. What it
writes is a canonical `districts` row per name plus one `organization_districts` grant per district, each
carrying `granted_by` and `reason`, and an audit entry when 0008 has supplied the actor columns. On a new
database it necessarily runs *before* 0008, so it announces that no audit entry was written and points at
the grant rows, which are the durable record of the decision either way.

`db:seed` follows the same rule. It stamps its demo rows with the tenant that exists — and if more than
one organization exists it aborts with `[SEED_TENANT_AMBIGUOUS]` rather than distributing fixtures
across tenants by guesswork, because a record with no owner is quarantined and invisible, and a seeded
environment nobody can read is a broken install, not a safe one.

The drill that proves all of this runs `./scripts/test-fresh-install.sh`: an empty database migrated to
the same schema as an upgraded one (object counts, RLS policies, ownership, and the runtime role's
privileges compared after `roles.sql` has been applied to both), the documented provisioning sequence
checked against the rows it writes rather than its exit codes, and a migration deliberately aborted by
planting a second tenant — then diagnosed, resolved by removing the ambiguity rather than by editing the
migration, and completed.

### The four database identities

| identity | what it can do | who uses it |
| --- | --- | --- |
| `dharohar` | schema owner, superuser in the container | `migrate`, `roleinit`, `seed`, `maint` one-shots only — never the API |
| `dharohar_app` | SELECT/INSERT/UPDATE on operational tables, DELETE on `parcel_owners` only, INSERT+SELECT on the audit ledger, SELECT on the ledger table; **on `users`, INSERT and UPDATE plus SELECT on 17 of 19 columns — `password_hash` and `salt` are not readable by it**; no DDL, no TRUNCATE, `NOBYPASSRLS`, `NOINHERIT`, `NOCREATEROLE` | the long-running API |
| `dharohar_verifier` | **SELECT on everything, `BYPASSRLS`, no superuser, no write privilege of any kind** | `verify` one-shot: district integrity and audit-chain certification |
| `dharohar_identity` | SELECT on `users` only, `BYPASSRLS`, **`NOLOGIN`, `CONNECTION LIMIT 0`**, and it owns exactly the two functions the login path is allowed to call | nobody connects as it; PostgreSQL executes those functions as it |

The third exists because validating the audit chain requires reading every entry in every tenant. Doing
that as the schema owner hands a routine diagnostic the one credential that can rewrite history; doing
it as `dharohar_app` produces a *false* report, because row-level security hides rows and the validator
then certifies the chain it was allowed to see. `scripts/test-rls-blind-certifier.sh` demonstrates the
second failure on a disposable copy and shows the certifier refusing with exit 2 instead.

The fourth exists because login has to find a person *before* a tenant context exists, which is the one
thing a tenant policy cannot do. A `SECURITY DEFINER` function needs an owner that can see past the
policies, and giving that to the schema owner or to the runtime role would be worse than the problem.
So the functions belong to a role that cannot log in, cannot be a member of anything, and holds one
table read. Migration 0010 and `scripts/roles.sql` both refuse if it ever becomes login-capable, and the
tenancy suite measures `pg_has_role('dharohar_app','dharohar_identity','MEMBER')` is false — otherwise
`BYPASSRLS` would be one `GRANT` away from the API's own identity.

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  verify dist-server/verify_audit_chain.js
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  verify dist-server/verify_district_integrity.js
```

`roles.sql` creates and updates it only when `DHAROHAR_VERIFIER_PASSWORD` is present in the environment,
and refuses to finish if the role it created can write anywhere — `[ROLES_LOCKDOWN_FAILED]`. Without
that variable the script says so and the diagnostics continue to run as the owner through `maint`.

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
export DHAROHAR_APP_PASSWORD="$(openssl rand -hex 32)"        # never commit it
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

### The dump is not a backup until it leaves the machine — encrypted

Two independent properties are required and neither implies the other:

* **durability** — a copy that survives this laptop dying;
* **confidentiality** — a copy that is worthless to whoever intercepts it.

A `pg_dump -Fc` archive is **not** encrypted, and measured on 2026-10-23 it is not even opaque:
`pg_restore --list` reads its manifest with no key and prints `TABLE DATA public parcels`, the object
names are greppable in the bytes (`parcels` appears 118 times, `officer` 10 times), and the per-row
data inside each blob is zlib-compressed but not encrypted. Anyone holding the file holds every
officer, every parcel, every base64 document and the whole audit chain.

What is on this machine today, measured rather than assumed:

| Thing | Measured 2026-10-23 |
| --- | --- |
| Second-location tooling | `rclone` **not installed**, `restic` **not installed**, `aws`/`ossutil` **not installed**, no `%APPDATA%\rclone\rclone.conf`, no mapped network drive (`net use` → "no entries"). `gpg` and `openssl` are present. |
| Where the dumps live | `backups/` **inside the repository**, which is at `C:\Users\allin\OneDrive\Desktop\AI\DHAROHAR` |
| Sync exposure | the Desktop known folder is redirected to `C:\Users\allin\OneDrive\Desktop` (registry `HKCU\…\User Shell Folders`) and the OneDrive sync-root marker folder exists, so this tree **is** a sync root by location. At the time of checking the OneDrive client was not running and no account was configured under `HKCU\Software\Microsoft\OneDrive\Accounts`, and the dumps carry only the `A` attribute (no cloud placeholder). **So no upload is proven — and none is excluded.** If the client ever signs in on this machine, 69 plaintext archives upload with it. |
| Accumulation | 69 `.dump` files, ~16 MB, no retention rule applied yet |

`scripts/backup.sh` now refuses to stay quiet about this: when the resolved output directory lies under
a cloud-sync path it prints a `WARNING:` naming the directory and pointing at the encrypted drill. It
warns and still writes — the warning is the operator's signal, not a lock-out. Verified both directions
on 2026-10-23: the warning fires for `backups/` in this tree and stays silent for `C:\temp-dh-backup`.

#### The encrypted leg, executed

```bash
BACKUP_PASSPHRASE='≥20 characters, exported into the environment — never an argument' \
  ./scripts/encrypted-backup-drill.sh
```

AES-256-CBC, PBKDF2-HMAC-SHA256 with 200,000 iterations, salted by default. Run 2026-10-23:
**38 checks passed, exit 0.** It dumps through `backup.sh`, encrypts to
`backups/encrypted/<stamp>.dump.enc`, and proves each step instead of asserting it:

* the plaintext's `PGDMP` magic and its object names are present in the archive and **absent** from the
  ciphertext, which is a real file of a real size with a different digest;
* `pg_restore --list` **succeeds** on the plaintext (no key needed) and **fails** on the ciphertext with
  *"input file does not appear to be a valid archive"* — the same tool, both sides, so the check can
  only pass if the encryption did something;
* the wrong passphrase cannot read it back (`bad decrypt`, exit 1);
* decrypting with the right passphrase reproduces the archive **byte for byte** (SHA-256 equal);
* the **decrypted** copy restores into a disposable database `encdrill_*` on `dharohar-audit-pg` and
  matches the deployed register: parcels 43, land_documents 47, users 59, districts 16,
  organization_districts 4, parcel_owners 44, schema_migrations 10 (ledger `0001…0010` identical),
  31 owner-tagged parcels, 43/43 valid geometries, row-level security still enabled on `parcels`;
* the largest document payload (`bytes-proof-1792520519025`) hashes to the same md5 on both sides
  (`d4019b0f…`), and the **whole audit chain** — 2,520 entries folded into one md5 — is identical
  (`a5e9148a…`).

It deletes the decrypted working copy, keeps the encrypted archive, and prints how many plaintext
archives are still sitting in `backups/` — because deleting the working copy does not touch them.

**What this does NOT prove, and the script says so in its own output:** every byte above is still on
this machine. Encryption at rest without a copy that leaves is confidentiality with no durability.
The transfer leg is **NOT EXECUTED** because this workstation has no external destination and no
credentials for one; `rclone` is not installed. It is an owner step, below.

#### Owner-side transfer (the leg that is not executed here)

Pick one destination. ₹0-class options first; the requirement is only that it is *not this disk*.

```bash
# (a) second machine or VM you own, over SSH — rsync copies inside an encrypted SSH channel
rsync -av --checksum backups/encrypted/ backupuser@second-host:/var/backups/dharohar/

# (b) object storage with a free tier (B2 10 GB, R2, Backblaze, a Hetzner bucket). Install rclone once:
winget install rclone.rclone
rclone config                     # n → new remote → your provider → leave 'env auth' on
#   then encrypt the *contents* too, so the provider never sees a readable archive:
rclone copy backups/encrypted/ "remote:dharohar-backups" --checksum --min-age 1m --fast-list

# (c) no network at all: an encrypted USB drive, kept somewhere other than next to the laptop.
```

Then prove the leg you just took, by restoring **from the destination**, not from the local file:

```bash
rclone copy "remote:dharohar-backups" ./verify-download --include "*.dump.enc"
BACKUP_PASSPHRASE='…' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in verify-download/<stamp>.dump.enc -out verify-download/<stamp>.dump
cd verify-download && sha256sum -c ../backups/<stamp>.dump.sha256   # digest across the wire
./scripts/restore.sh --container dharohar-audit-pg --dbname restore_from_offmachine_$(date +%s) \
  --create-db --input verify-download/<stamp>.dump
```

Four rules that turn a copy into a backup:

1. **Encrypt before it leaves**, and keep the ciphertext and the passphrase apart. `openssl enc` (built
   in here), `rclone crypt`, `age`, or `gpg --symmetric` — any of them; a plaintext dump in a bucket you
   did not encrypt is a disclosure waiting to happen. Moving the repo (or `backups/`) outside a
   cloud-synced folder is part of this rule, not a separate one.
2. **Access restrictions.** One credential per destination, held by you, not shared with the app and not
   stored in `.env`. For object storage use a key that can *write only* to that bucket prefix and cannot
   list or delete the account's other buckets. For an SSH target use a dedicated key with
   `command="rsync --server -s …"` forced in `authorized_keys` so the key only receives backups.
3. **Retention, applied and checked.** 30 days rolling is the documented default:
   `rclone delete "remote:dharohar-backups" --min-age 30d --rmdirs` (or `find … -mtime +30 -delete`),
   run *after* a successful checksum verification of the new copy, never before. Keep at least one copy
   that an administrator with a grudge — or a ransomware process running as your user — cannot rewrite:
   an object store with versioning or object-lock, or a USB drive that is normally unplugged.
4. **Restore-test the off-machine copy quarterly**, into a disposable database, with the digest checks
   above. An unreadable archive is how a year of backups turns out to be nothing.

**Credential handling for the passphrase.** Store it in the same place you store your other master
secrets (a password manager), not in a file, not in `.env`, not in a shell script, and not in the
repository — `.gitignore` cannot protect you from a passphrase that was committed on purpose.
Rotate it whenever a copy leaves a destination you no longer control; re-encryption is cheap
(295 KB took under a second) and the only cost is that old archives then need the old passphrase.
Losing it is unrecoverable by design, which is the same fact as "it is actually encrypted".


### What a restore drill has to prove (and what was proven on 2026-10-19)

A restore is verified by these measurements, run against a **disposable** database — never the working
one. The drill below was executed end to end on the current deployment; the results are measurements,
not intentions.

| Property | How to check it | Result measured |
| --- | --- | --- |
| Migrations carried | restore output lists `schema_migrations` | `0001`, `0002`, `0003` all present in the restored copy |
| Spatial data | `select count(*) … where st_isvalid(geom)` | 33 of 33 parcels valid, 0 invalid |
| Document bytes | `md5(split_part(image_uri,'base64,',2))` in source vs restored | **identical digest and length (2,000,000 chars)** — the payload survives the dump |
| Record↔document links | `parcels.document_id` not null | 5 references intact |
| Audit chain | start the API against the restored DB, `GET /api/verifications/audit-logs/verify-chain` | `isValid: true`, **1,379 entries** verified |
| Application reads | `GET /api/parcels` through that API | HTTP 200, rows returned, `storageMode=postgres-postgis` |

One caveat worth recording, because it would otherwise make the "document bytes" row meaningless: at the
time of the drill the live database held **no** document payloads at all — `image_uri` was empty for all
33 stored documents, so a backup/restore comparison would have passed vacuously. The drill therefore
wrote a 1.5 MB synthetic payload through the real upload endpoint first, and compared that. Before any
release, confirm on the actual production data that uploads populate `image_uri`; a register full of OCR
text and no source images is not a digitized record set (see `docs/DOCUMENT-STORAGE.md`).

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
write attempt → 503 `PARCEL_WRITE_FAILED`, recovery to 200, **and then the same write proven to
succeed** — a health endpoint proves one connection, not that the pool can serve a write); the nginx
proxy (SPA root, SPA deep route, `/api/health` proxied); that **the database publishes no host port**;
the two authorization suites against this stack; and finally the retirement of the officer accounts
those suites created, with its outcome required to be stated rather than implied.

The sweep refuses to report a pass it did not measure: it aborts with exit 2 if the Docker daemon is
unreachable or the database credentials cannot be read, and any check whose "actual" value is an error
string (compose interpolation failure, daemon unreachable, container missing) is scored FAIL rather
than compared against another error string. That is not theoretical — a run with the daemon dead
produced exactly such a false PASS before the guard existed.

`npm run test:jurisdiction` (46 assertions) and `npm run test:provisioning` (91 assertions, measured on
the copy drill 2026-10-23) are the
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
