# DHAROHAR — Owner Deployment Handoff

Written 2026-10-19 for the person who owns the system, working from a Windows laptop. It assumes you
are not a Linux administrator. Every command is given verbatim; every step says whether **you** do it
or the **code** does it. Nothing here has been run against a public server — see "What has NOT been
verified" at the end.

The service must stay on synthetic data until the release gates pass. Do not enter a real citizen's
land record anywhere until the tenancy decision in step 9 is made.

---

## 1. What you need to buy or sign up for

| Item | What it is | Free tier? | Notes |
| --- | --- | --- | --- |
| One VM, 1 vCPU / 2 GB RAM / 50 GB disk | The server that runs everything | Oracle Cloud "Always Free" Arm/Amd micro qualifies; Google Cloud e2-small is **paid**; AWS Free Tier t2/t3.micro expires after 12 months | 2 GB is the real floor — the stack is capped at ~1.25 GB total |
| A static public IPv4 | So DNS can point at it | Oracle: "reserved" public IP is free; do **not** attach a separate Elastic IP elsewhere if you are avoiding cost | Note it down; you type it into DNS |
| Domain `urbantechx.in` with DNS control | You already have it | you own it | You need permission to add records |
| Outbound 80/443 allowed on the VM firewall | Caddy needs both | free | 80 is used only to redirect to HTTPS |
| A second storage location for backups | Object store or a second machine | Backblaze B2 10 GB / Cloudflare R2 10 GB are free-class | **Not optional.** Today your backups sit on the same disk as the database |
| Nothing else | no database service, no CDN, no paid OCR | | OCR runs in the officer's browser from your own server |

**Paid by accident if you are not careful:** Oracle's *boot volume* over 200 GB, a second VM you left
running, managed Postgres, and any object-store egress. The app itself never calls a paid API.

---

## 2. Get the source onto the server (your hands, ~10 minutes)

1. Open **PowerShell** on Windows and clone the repository into a folder you will not sync:
   ```powershell
   cd $env:USERPROFILE\Desktop
   git clone https://github.com/naamanjain/dharohar.git
   cd dharohar
   ```
   ⚠ Until you make the repository private, anyone can read this history. The retired demo password in
   the old commits no longer works, but a database seeded before 2026-10-19 may still accept it.

2. Connect to the VM from Windows (built-in OpenSSH):
   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\your-key.pem" ubuntu@<SERVER_IP>
   ```

3. Install Docker and the compose plugin **on the VM**:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo systemctl enable --now docker
   sudo usermod -aG docker $USER     # log out and back in afterwards, or this session won't see it
   docker compose version             # must print v2.x
   ```

4. Put the source on the VM — either clone it there (same command as step 1), or from **Windows**:
   ```powershell
   scp -i "$env:USERPROFILE\.ssh\your-key.pem" -r .\dharohar ubuntu@<SERVER_IP>:~/dharohar
   ```
   Do not use OneDrive or Dropbox to move it: the sync will fight the deployment and may publish files.

5. Open only these ports in the cloud firewall/security list: **22 (SSH), 80, 443**. Leave 5432 and
   3001 closed — the compose file publishes no host port for either, which the validation gate checks.

---

## 3. Secrets: how to give the app its passwords without exposing them

Four secrets are required and one is optional-but-recommended. The code refuses to start without any of
the required ones — there is no default, so a missing one stops the deployment instead of quietly using a
guess.

1. Generate the values **on the VM**, in the terminal, so they never sit in your browser history:
   ```bash
   openssl rand -hex 24    # POSTGRES_PASSWORD  (schema owner / maintenance)
   openssl rand -hex 32    # DHAROHAR_APP_PASSWORD (the API's runtime role; hex, not base64)
   openssl rand -hex 32    # JWT_SECRET         (signs login tokens)
   openssl rand -hex 12    # DEMO_PASSWORD      (demo personas only — never a real officer's password)
   openssl rand -hex 32    # DHAROHAR_VERIFIER_PASSWORD (optional: the read-only checking identity)
   ```
2. Write them into one file next to the compose file, then lock its permissions:
   ```bash
   cd ~/dharohar
   cat > .env <<'EOF'
   POSTGRES_USER=dharohar
   POSTGRES_DB=dharohar
   POSTGRES_PASSWORD=<paste>
   DHAROHAR_APP_USER=dharohar_app
   DHAROHAR_APP_PASSWORD=<paste>
   JWT_SECRET=<paste>
   DEMO_PASSWORD=<paste>
   DHAROHAR_VERIFIER_PASSWORD=<paste, or leave the line out>
   EOF
   chmod 600 .env && ls -l .env      # must show -rw------- and your user as owner
   ```
   `.env` is gitignored and `.dockerignore` keeps it out of the images. Never paste these into a
   Dockerfile, compose file, commit, screenshot, chat message or ticket.
3. There are deliberately **four** database identities now.
   * `dharohar` — the owner. Used only by the one-shot `migrate`, `roleinit` and `maint` containers; the
     API cannot see this password.
   * `dharohar_app` — the runtime role. No DDL, no TRUNCATE, no DELETE on records, subject to row-level
     security, and since migration 0010 it cannot read `users.password_hash` or `users.salt` at all.
   * `dharohar_verifier` — **read-only, and the one you should run the checks with.** It can see every
     row (including other tenants') because integrity checking has to, but it cannot write anything:
     `roles.sql` creates it only when you supply the password, and refuses to finish if any write
     privilege ends up on it. Without it the checks have to run as the owner, which is a credential that
     could rewrite the audit chain.
   * `dharohar_identity` — **NOLOGIN**, owns only the two functions the login path is allowed to call.
     Nobody connects as it; if `pg_roles` ever says it can log in, `roles.sql` and migration 0010 both
     say so and stop.
4. If a value ever appears in a terminal log, a chat or a commit, rotate `DHAROHAR_APP_PASSWORD` with
   `./scripts/rotate-app-credential.sh` (see `docs/DEPLOYMENT.md` §4 for what it measures). It edits one
   line of `.env`, re-runs `roleinit` so PostgreSQL applies the new value to the role, recreates the API,
   then **proves both directions**: the new credential authenticates and the old one is refused.
   It prints digests, never values, and puts the old value back if any check fails.
   Two ways this project has actually leaked a secret, so that the shape of the trap is on the record:
   `docker inspect` prints a container's whole environment, and `docker compose config` prints every
   interpolated URL — `postgresql://dharohar_app:<password>@db:5432/dharohar` is one line, so filtering
   for "lines that look like a variable name" does not redact it. Count **occurrences of the value**;
   a line that contains a secret is a line that shows it.

---

## 4. First deployment (mostly the code's work)

```bash
cd ~/dharohar
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

What happens by itself, in this order: `db` starts → `migrate` applies the migrations as the owner and
exits → `roleinit` creates/refreshes the least-privilege role (and the read-only verifier, if you gave it
a password) and exits → `api` starts **as that role** and waits for `/api/health/ready` → `web` starts. If
any step fails, the next one does not start; that is deliberate, so a half-built system never serves
officers.

**On a brand-new database, `migrate` stops at 0006 on purpose** with
`[TENANCY_NO_CANONICAL_GEOGRAPHY]`. It is not a crash: 0006 assigns record ownership on the basis of
which districts are authoritative, and a new database has no authoritative districts yet — geography is a
statement a person makes, not something a deploy script invents. Say it, then finish:

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  -e GEOGRAPHY_DISTRICTS="Jaipur,Ajmer,Jodhpur,Udaipur" \
  -e GEOGRAPHY_ORGANIZATION=ORG-DHAROHAR-DEMO \
  -e GEOGRAPHY_BY="<your name and address>" \
  -e GEOGRAPHY_REASON="Rajasthan districts this register is filed under" \
  maint dist-server/db/declareGeography.js
docker compose -f docker-compose.prod.yml run --rm migrate     # now completes through 0009
```

Pick the districts that are actually authoritative for you; the four above are what the synthetic demo
uses. The command refuses a blank or one-word reason, an organization that does not exist, and a name
that collides with a district already in the registry — and it records who declared what, in the grant
rows.

Then load the demo data (this writes fabricated records — it refuses without the confirmation you see
below, precisely so nobody runs it against real records by habit):

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm -e SEED_CONFIRM=demo \
  -e DEMO_PASSWORD="$(grep '^DEMO_PASSWORD=' .env | cut -d= -f2)" \
  maint dist-server/db/seed.js
```

Check it is genuinely talking to PostgreSQL, not to a fallback:

```bash
curl -s http://127.0.0.1:8088/api/health | head -c 300
# you want: "storageMode":"postgres-postgis" and "database":"dharohar"
```

---

## 4b. Synthetic staging at ₹0 — no domain, no certificate, nothing public

Use this shape until the blockers in §9 are closed. It is the same compose stack; the only difference is
that **nothing but SSH is reachable from the internet**, so there is no DNS, no certificate, and no
attack surface to defend while the data is still fabricated.

**You do these, in this order.**

1. Cloud firewall / security list: allow ingress on **22 only**, ideally restricted to your own current
   IP. Do not add 80, 443, 3001 or 5432. There is no reason to open them for staging, and closing them
   later is how an accidental public deployment gets forgotten about.
2. Deploy exactly as §4 (`docker compose -f docker-compose.prod.yml up -d --build`), and **skip §5
   entirely**. The compose file publishes the web container on `127.0.0.1:8088` by default (`WEB_BIND`),
   so it is already loopback-only — confirm it rather than trusting the file:
   ```bash
   sudo ss -ltnp | grep -E ':(80|443|3001|5432|8088)\b'
   ```
   Every line must show `127.0.0.1` on the left-hand address column. A `0.0.0.0` or `*` next to any of
   those ports means something is exposed, and the run stops being staging.
3. Seed the synthetic data and create the administrator (§4 and §6). Both are demo-only writes and both
   refuse to run without the confirmation flags they show.
4. From **Windows PowerShell**, open a tunnel to your own laptop:
   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\your-key.pem" -N -L 8088:127.0.0.1:8088 ubuntu@<SERVER_IP>
   ```
   Leave that window open. Then browse to `http://127.0.0.1:8088` on the laptop. The traffic is
   encrypted by SSH; there is no browser padlock, and that is expected on a loopback URL.
5. Run the suites **from the laptop** with the tunnel up — this is why staging does not need Node on the
   VM. In Git Bash, from the repository:
   ```bash
   set -a; . ./.env; set +a
   export TEST_BASE_URL=http://127.0.0.1:8088/api
   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD       # §6 — the one credential only you have
   npx tsx server/src/test_jurisdiction_suite.ts          # 46 checks: cross-district access denied
   npx tsx server/src/test_provisioning_suite.ts          # 91 checks: grants, capabilities, rotation
   npx tsx server/src/test_tenancy_isolation_suite.ts     # 101 checks: two tenants, one district each
   ./scripts/validate-stack.sh                            # 69 checks today: 68 pass, 1 = the ADMIN_PASSWORD skip
   unset ADMIN_PASSWORD
   ```
   The tenancy suite needs `TENANCY_DB_URL` and `TENANCY_APP_URL` as well, which is why the same three
   suites are also run against a disposable copy by `./scripts/test-authorization-on-copy.sh` — that
   script is the one that can be run with no operator credentials at all.
   Retire what the gate created when you are done: `docker compose -f docker-compose.prod.yml exec -T
   -e RESIDUE_APPLY=true -e RESIDUE_ADMIN_EMAIL=<the administrator's address> api node
   dist-server/retireSuiteResidue.js`. Since migration 0010 it reads only its own tenant's residue, so
   a multi-tenant box retires one tenant per administrator (or runs as the owner via `maint`).
6. Back up on a schedule and get the dump **off the VM** (§8). A staging box with no off-machine copy is
   a machine that will lose its data and its proof at the same time.

What this staging does **not** prove: public reachability, TLS, DNS, the ARM image, or capacity under
real traffic — those are in §9. Tenant isolation is no longer on that list: it is tested, in two layers,
against a restored copy and against this stack, and the two named residuals are in
`docs/TENANT-DATA-ACCESS.md` §4b rather than in a footnote.

---

## 5. DNS and HTTPS

1. **You do this in your domain dashboard.** Add one record:
   `A` for `dharohar.urbantechx.in` → `<SERVER_IP>`, TTL 300. Wait a few minutes, then check from
   Windows: `nslookup dharohar.urbantechx.in` must return that IP.
2. **The code does the certificate.** With DNS pointing at you:
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d --build
   ```
   Caddy obtains and renews Let's Encrypt certificates automatically and redirects port 80 to 443.
   It needs ports 80 and 443 reachable from the internet — nothing else.
3. Verify: open `https://dharohar.urbantechx.in` and confirm the padlock, and that the address bar stays
   on `https://` after you click around. If the browser warns about the certificate, DNS has not
   propagated yet or the ports are blocked — say which, don't click through it.

---

## 6. First administrator (there is no default password)

Nobody can be an administrator until you create one, and the create command refuses to run twice — so
it cannot be used to reset a password on a live system.

```bash
cd ~/dharohar
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  -e BOOTSTRAP_ADMIN_EMAIL="you@urbantechx.in" \
  -e BOOTSTRAP_ADMIN_NAME="Naaman Jain" \
  -e BOOTSTRAP_ADMIN_DISTRICT="Jaipur" \
  -e BOOTSTRAP_ADMIN_PASSWORD \
  maint dist-server/db/bootstrapAdmin.js
```

- Set `BOOTSTRAP_ADMIN_PASSWORD` in your shell first (`read -rs` prompts for it without echoing) so the
  password never appears in the command line or your history. If you leave it unset, one is generated
  and printed **once** — copy it immediately; it is not stored anywhere readable.
- Since migration 0006, also pass `-e BOOTSTRAP_ORG_ID=ORG-DHAROHAR-DEMO` (or `BOOTSTRAP_ORG_NAME` to
  mint a new tenant). An administrator **with no organization** is a real state, not a mistake to ignore:
  it can still create officers, and it can read no record at all — the API answers
  `403 TENANT_CONTEXT_MISSING` rather than showing you an empty register and letting you wonder.
- After this, every further officer is created through the API's provisioning endpoint
  (`POST /api/admin/officers`) by that administrator. There is no self-signup, and there is no admin
  web page yet — that is a known open item, not a missing step on your side.
- Confirm you can sign in at the URL with that email and password before you show anyone the system.

### The one stack-gate check that needs you, and why

`scripts/validate-stack.sh` ends with a single check that cannot run without your administrator
password — line 230: if `ADMIN_PASSWORD` is unset it prints

```
  FAIL  ADMIN_PASSWORD not exported — provisioning suite not run here.
```

and that is the only failure in an otherwise complete run (**68 passed, 1 failed** of 69 checks, measured
2026-10-23 after migration 0010).
The check is the **provisioning suite against the live stack**: it signs in as the administrator, then
creates, grants, revokes and retires officers through the real API. Nothing else in the gate can do
that, because nothing else holds an administrator credential.

Why the password is not in `.env`, stated precisely because "just use DEMO_PASSWORD" is wrong here:

| | |
| --- | --- |
| The live administrator | `USR-SYSADM-01`, `sysadmin@dharohar.local`, role `TEHSILDAR`, organization `ORG-DHAROHAR-DEMO`, `badge_number` NULL, created 2026-10-16 |
| How it was created | the bootstrap one-shot above, taking `BOOTSTRAP_ADMIN_PASSWORD` from the terminal that day |
| Where that password lives | nowhere on disk. It was never written to `.env`, and the generator that prints one prints it once, to a terminal |
| What `DEMO_PASSWORD` governs | the **seeded demo personas** only |
| Are those personas in this database? | no — `select count(*) from users where lower(email)='demo.doe@dharohar.local'` returns **0** of the 59 officers (measured 2026-10-23) |
| So what happens if you try it | `POST /api/auth/login` for `sysadmin@dharohar.local` with `DEMO_PASSWORD` returns **HTTP 401**, measured the same day |

Two things this project will not do about that, on purpose: it will not run the bootstrap again to
"reset" the administrator (the script refuses when an administrator already exists — it is an
introduction, not a back door), and it will not create a second administrator so a test can pass. Both
would be changing a live register to satisfy a script.

Run it yourself, in a form that leaves no trace in history or in a log:

```bash
cd <the directory holding docker-compose.prod.yml and .env>
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD     # typed, never echoed, never stored in history
./scripts/validate-stack.sh
unset ADMIN_PASSWORD
```

`ADMIN_EMAIL` already defaults to `sysadmin@dharohar.local` (validate-stack.sh:231); set it only if the
administrator is someone else. Measured state without the password: **68 passed, 1 failed** (69 checks).
With it, that one failure stops being a skip and the provisioning suite runs against the live stack; I
have not executed that combination, so the honest expectation is "no failures", not a number I can name
in advance. If the password is wrong the provisioning suite fails at its own login step — a different
message from the skip above, which is why they are printed separately. Do not paste the password into a
chat so an agent can run it: everything else in the gate runs without it.

---

## 7. Verify it from outside your own network (you must do this; the laptop cannot)

From a phone on mobile data, or a different building:

1. `https://dharohar.urbantechx.in` loads and the padlock is valid.
2. Sign in with the administrator, open a record, and search.
3. `https://dharohar.urbantechx.in/api/health` returns `postgres-postgis`.
4. **Negative checks** — these must fail:
   - `http://…:8088` from the phone must not connect (the app is loopback-bound; only 443 is public).
   - `http://…:5432` must not connect.
   - Signing in with a wrong password is refused **with a message on screen**, not a silent no-op.
   - Sign in as a district officer, then try to open a parcel from another district: it says "not
     found", not "forbidden". That difference is intentional — it avoids confirming other districts'
     records exist.
5. Stop the API (`docker compose -f docker-compose.prod.yml stop api`) and reload the site: the login
   screen must show the persistent "Cannot reach the server" warning and refuse sign-in. Start it
   again (`… start api`) and confirm the warning disappears. This behaviour is tested; if you see a
   silent failure instead, that is a regression — report it rather than working around it.

---

## 8. Backups, restore tests and rollback

```bash
# Daily backup into a directory that already exists (otherwise the name is used as a file path):
mkdir -p /var/backups/dharohar
PGUSER=dharohar ./scripts/backup.sh --container dharohar-prod-db-1 --dbname dharohar \
  --output /var/backups/dharohar

# Verify the archive before you trust it (run from inside that directory — the sidecar records a
# bare filename):
cd /var/backups/dharohar && sha256sum -c dharohar_dharohar_<stamp>.dump.sha256

# Copy it off the machine, encrypted. A dump on the same disk is not a backup, and a plaintext dump in
# someone else's bucket is a disclosure:
rclone copy /var/backups/dharohar "remote:dharohar-backups" --checksum

# Prove the whole chain in one command — dump, checksum sidecar, copy to a second location, restore
# FROM THAT COPY into a throwaway database, then compare record counts, a document's payload digest and
# the hash of the entire audit chain between the live database and the restored one:
./scripts/offsite-copy-drill.sh --dest /var/backups/offsite-dharohar
# Point --dest at an rclone mount or a second server for the off-machine claim to be true. On a second
# volume of the same laptop the drill proves the procedure and the archive's portability, and the script
# says so in its own output rather than letting you infer more than it tested.

# Prove the archive is unreadable without a passphrase, and still restores with one. The passphrase is
# typed at the prompt, never stored in history, never an argument (an argument would sit in the process
# list for the length of the run):
read -rs -p 'passphrase: ' BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE
./scripts/encrypted-backup-drill.sh
unset BACKUP_PASSPHRASE
# Run 2026-10-23: 38 checks, exit 0. It shows pg_restore reading the PLAINTEXT archive's manifest with
# no key at all and failing on the encrypted one, that a wrong passphrase cannot open it, that the
# decrypted bytes are identical to the archive, and that the decrypted copy restores with the ledger,
# the payload digest, the geometry count and the whole audit chain matching the live database.

# Restore-test into a NEW empty database. Never over the working one — the script refuses unless you
# pass --allow-non-empty, and you must never pass that flag against live records:
./scripts/restore.sh --container <pg-container> --dbname restore_test_$(date +%s) --create-db \
  --input /var/backups/dharohar/dharohar_dharohar_<stamp>.dump
```

**Read this before you take a backup on the laptop.** `pg_dump`'s custom format is not encrypted, and
measured on 2026-10-23 it is not opaque either — `pg_restore --list` prints every table it holds without
a key. This repository sits at `C:\Users\allin\OneDrive\Desktop\AI\DHAROHAR`, and your Desktop known
folder is redirected into OneDrive, so `backups/` — 69 plaintext dumps at the time of checking — is
inside a folder that a sync client would upload the moment one signs in. The OneDrive client was not
running and had no account configured when I measured, so **nothing is proven to have left the machine,
and nothing can be proven not to have.** Two things follow:

1. `scripts/backup.sh` now says so out loud. When the resolved output directory lies under a cloud-sync
   path it prints a `WARNING:` naming the directory and pointing at the encrypted drill. It warns and
   still writes; the warning is the signal, not a lock-out. Verified in both directions — it fires for
   `backups/` here and stays silent for `C:\temp-dh-backup`.
2. Take the backup somewhere that is not this tree: `--output D:/dharohar-backups`, or move the
   repository out of a sync root. Then apply a retention rule (30 days) — accumulation is its own leak.

Full procedure, including what has to be true for the off-machine claim: `docs/DEPLOYMENT.md` §8.

Cron example (2:30 nightly, keep 30 days): see `docs/DEPLOYMENT.md` §8.

**Checking the register's integrity, and checking the audit chain.** Run these as the read-only
verifier, not as the owner and not as the API role:

```bash
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  verify dist-server/verify_audit_chain.js          # exit 0 = intact; prints how many entries it saw and as whom
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  verify dist-server/verify_district_integrity.js   # the findings report; nothing is modified
```

Both print the identity they ran as, and both **refuse** rather than report if that identity cannot see
the whole table. That refusal matters: a chain check run through a filtered connection sees fewer
entries, finds no broken links among them, and reports a healthy chain — which is how this project once
"found" 41 problems that did not exist. `./scripts/test-rls-blind-certifier.sh` demonstrates the refusal
on a disposable copy, so the guard is proved rather than asserted.

**Rollback of the software** (as opposed to the data): `docker compose -f docker-compose.prod.yml down`
keeps the data volumes. Migrations are additive and forward-only — there is no automated down-migration,
so rolling an *older* image against a newer database is supported only if that older code still matches
the columns, which is why you take a verified dump **before** every upgrade. Each migration also has a
`rollback-NNNN.sql` in `server/src/db-draft/` that refuses to run unless it can reverse its own change
without touching a human decision — 0006's won't erase an ownership assignment made by a person, 0007's
won't run while a candidate district is unresolved, 0009's won't drop policies it did not create.

Restore drill already executed on 2026-10-19 against a disposable database: 3 migrations present,
33/33 parcel geometries valid, a 2,000,000-character document payload with an identical md5 in source
and restored copy, and the audit chain verified through the API as valid across 1,379 entries.

---

## 9. What only you (or the department) can decide

1. **Whether the demo-environment ownership assignment is accepted.** Migrations 0006–0008 are applied to
   the demo deployment (ledger `0001…0008`) and tenant isolation is enforced in the application and by
   PostgreSQL row-level security — the cross-tenant read that used to answer HTTP 200 now answers 404,
   measured. What 0006 did is a stated inference, not evidence about land: it assigned records in the four
   canonical districts to `ORG-DHAROHAR-DEMO` because this database has only ever been the synthetic demo
   environment and that is the only tenant it has had. It refused to assign anything else: **12 parcels
   and 2 documents are quarantined** (`organization_id IS NULL`), invisible to every tenant, preserved in
   the database. Read `docs/DISTRICT-TENANCY-MODEL.md` §11 and decide (a) whether you accept that
   assignment for the demo tenant, and (b) what to do with the quarantined rows. The disposition path is
   `docker compose -f docker-compose.prod.yml --profile tools run --rm -e ASSIGN_TABLE=parcels
   -e ASSIGN_IDS=… -e ASSIGN_ORGANIZATION=… -e ASSIGN_BY=… -e ASSIGN_REASON=… maint
   dist-server/db/assignOwnership.js`; it refuses a missing reason, an unknown id and any move between
   two tenants unless `ASSIGN_TAKEOVER=true` is passed.
2. **Adding a second organization is now a live configuration decision, not a schema one.** The isolation
   tests in `server/src/test_tenancy_isolation_suite.ts` create a second tenant on a disposable copy and
   assert that each side sees only its own records in a district both hold (42 checks, all green with
   `./scripts/test-authorization-on-copy.sh`). Before you create a real tenant against real records,
   decide who may create organizations and who signs off on a district grant: today only the schema-owner
   one-shots and the declaring officer's own tenant can create them, and there is no approval workflow.
3. **Who may promote a declared district to canonical geography.** Fixed as of migration 0007: a
   declaration lands as `candidate` and only `POST /api/admin/districts/:code/promote` — `USER_ADMIN`,
   a reason of at least 10 characters, an audit entry, and a refusal to rescue a retired fixture — makes
   it canonical. What is still yours to decide is the approval rule around that: today any officer
   holding `USER_ADMIN` inside a tenant can promote a district, and nothing requires a second person.
4. **The real district list.** Everything in the registry today was derived from values the demo data
   already contained. Declare the actual ones (`POST /api/admin/districts`) before treating any clean
   integrity report as authoritative.
5. **Password policy for real officers.** The demo personas share one environment-provided password;
   that is fine for a demo and unacceptable for staff. Note also that the bootstrapped administrator's
   password cannot be recovered or reset by the bootstrap command by design — decide now who holds it
   and where it is written down, because the provisioning suite cannot run without it
   (`./scripts/test-authorization-on-copy.sh` is the alternative that needs nothing from you).
6. **Whether `dharohar.urbantechx.in` is the final hostname**, and who is allowed to see it. For
   synthetic staging (§4b) there is no hostname at all, which is the safer answer for now.
7. **Retention and off-machine location for backups**, and who holds the encryption key.

---

## What has NOT been verified

Do not read this document as a claim that these were tested. They were not:

* **Public reachability, DNS propagation and HTTPS on a real public VM** — no deployment was made to
  the internet during this work. The stack listens on `127.0.0.1` only, by design.
* **ARM compatibility.** The images were built and run on an x64 machine. Oracle's free Arm tier is a
  reasonable target but this has not been executed on Arm.
* **Production capacity / concurrent officers.** The containers are capped at 0.75 vCPU and 512 MB each;
  no load test was performed.
* **Real record volumes.** Every measurement in this document is on synthetic demo data — 45 parcels
  (33 owned by the demo tenant, 12 quarantined), 51 documents (2 carrying a real payload, both written
  by drills), 59 accounts (all owned), 2,874 audit entries (831 carrying an actor organization since
  0008). These numbers move every time a gate runs against this database; the ratios and the ownership
  split are the facts, the totals are a snapshot.
* **Row-level security: nine tables, and only those.** `parcels` and `land_documents` carry four tenant
  policies each (0006); `parcel_owners`, `parcel_mutations` and `field_inspections` carry four each and
  inherit their parcel's policy (0009); `users`, `user_jurisdictions`, `user_capabilities` and
  `organization_districts` carry four each, scoped to *own row or own organization* (0010). All of it is
  verified directly as `dharohar_app`: no context → zero rows, forged context → only the asserted
  tenant's rows and still zero records, cross-tenant child write refused, `SET ROLE` refused, and since
  0010 the credential columns unreadable by privilege *and* by attempted select. The tables still left
  without policies are `districts` (shared geography), `organization_units` (no code reads it) and
  `append_only_audit_logs` (chain verification is whole-table by nature). The reasoning, the measured
  privileges and the queries that reproduce all of it are in
  [docs/TENANT-DATA-ACCESS.md](TENANT-DATA-ACCESS.md) — including §4b, which states the two things layer
  two does **not** do: a session may assert its own tenant, and the sanctioned login lookup returns one
  named officer's credential columns. Neither is closed, so tenant isolation is not described as
  complete anywhere in this repository, and closing the second needs a separate authentication identity.
* **An administrator password you have not supplied.** `./scripts/validate-stack.sh` runs **68 passed,
  1 failed**, and the one failure is that `ADMIN_PASSWORD` was not exported, so the provisioning suite
  did not run *against this live stack*. The same suite ran **91/0** against a disposable copy where the
  harness bootstraps an administrator of its own (`./scripts/test-authorization-on-copy.sh`), so the
  behaviour is tested; what is missing is the operator-side credential to run it on the deployment
  itself. `db:bootstrap-admin` will not mint a second administrator, by design, and the existing
  `sysadmin@dharohar.local` password is not the demo password (measured: HTTP 401). This is yours to
  close, and it is a credential decision, not a code one.
* **A copy on another machine.** `./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups` passed end
  to end — dump, checksum sidecar, copy to a second volume, restore from that copy, payload digest and
  the whole 2,341-entry chain compared — but D: is a different **volume on the same physical machine**,
  and the archive is **not encrypted**. `rclone`/B2/R2 with `--checksum` has not been executed. Until
  both are done, do not describe this as production-grade disaster recovery: the restore path is proven,
  the durability and confidentiality of the archive are not.

Everything claimed as *done* in this document is backed by a command in `docs/DEPLOYMENT.md` §9 and, as
of 2026-10-24, by one full sweep run against the same build:

| gate | measured |
| --- | --- |
| `./scripts/test-tenant-migration.sh` | **141 passed, 0 failed** (exit 0) — migrations 0004–0009, guards fired on purpose, rollbacks and re-applies |
| `./scripts/test-fresh-install.sh` | **all checks passed**, exit 0 (106 assertions) — empty database to full schema, compared with an upgraded one, provisioning checked against the rows it writes, an aborted migration diagnosed and recovered |
| `./scripts/test-authorization-on-copy.sh` | jurisdiction **46/0**, provisioning **91/0**, tenancy **101/0** (exit 0) |
| `./scripts/test-tenant-migration.sh` | **141 passed, 0 failed**, exit 0 |
| `npm run test:registry` | **56 passed, 0 failed**, exit 0 |
| `./scripts/encrypted-backup-drill.sh` | **38 checks**, exit 0 — see §8; the off-machine leg is NOT executed |
| `./scripts/test-rls-blind-certifier.sh` | all checks passed (exit 0) — the chain certifier refuses a partial read instead of reporting health |
| `npm run lint`, `npm test` | exit 0 — tsc clean, phase 4 **47/0**, E2E **53/0** |
| `verify dist-server/verify_audit_chain.js` | exit 0 — **2,874 entries**, ids contiguous, **INTACT**, as `dharohar_verifier` |
| `verify dist-server/verify_district_integrity.js` | exit 1 by design — findings all accounted for in `docs/DISTRICT-INTEGRITY-REPORT.md` §6 |
| `./scripts/validate-stack.sh` | **68 passed, 1 failed** of 69 checks — see the `ADMIN_PASSWORD` bullet above |
| `./scripts/offsite-copy-drill.sh` | all checks passed (exit 0) — see the same-volume caveat above |
