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

Four secrets are required. The code refuses to start without any of them — there is no default, so a
missing one stops the deployment instead of quietly using a guess.

1. Generate the values **on the VM**, in the terminal, so they never sit in your browser history:
   ```bash
   openssl rand -hex 24    # POSTGRES_PASSWORD  (schema owner / maintenance)
   openssl rand -hex 32    # DHAROHAR_APP_PASSWORD (the API's runtime role; hex, not base64)
   openssl rand -hex 32    # JWT_SECRET         (signs login tokens)
   openssl rand -hex 12    # DEMO_PASSWORD      (demo personas only — never a real officer's password)
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
   EOF
   chmod 600 .env && ls -l .env      # must show -rw------- and your user as owner
   ```
   `.env` is gitignored and `.dockerignore` keeps it out of the images. Never paste these into a
   Dockerfile, compose file, commit, screenshot, chat message or ticket.
3. There are deliberately **two** database passwords now. The owner one is used only by the one-shot
   migration/grant containers; the API container physically cannot see it. That is the point.
4. If a value ever appears in a terminal log, a chat or a commit: rotate it (put a new value in `.env`,
   run `docker compose -f docker-compose.prod.yml up -d` — `roleinit` reapplies it), then treat the old
   one as known to whoever saw it.

---

## 4. First deployment (mostly the code's work)

```bash
cd ~/dharohar
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

What happens by itself, in this order: `db` starts → `migrate` applies the five migrations as the
owner and exits → `roleinit` creates/refreshes the least-privilege role and exits → `api` starts
**as that role** and waits for `/api/health/ready` → `web` starts. If any step fails, the next one does
not start; that is deliberate, so a half-built system never serves officers.

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
   TEST_BASE_URL=http://127.0.0.1:8088/api DEMO_PASSWORD="$DEMO_PASSWORD" \
     npx tsx server/src/test_jurisdiction_suite.ts
   ```
   46 checks. Cross-district access must all be denied.
6. Back up on a schedule and get the dump **off the VM** (§8). A staging box with no off-machine copy is
   a machine that will lose its data and its proof at the same time.

What this staging does **not** prove: public reachability, TLS, DNS, the ARM image, capacity under real
traffic, or anything about tenant isolation. Those are in §9 and in `docs/SECURITY.md` §"open items".

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
- After this, every further officer is created through the API's provisioning endpoint
  (`POST /api/admin/officers`) by that administrator. There is no self-signup, and there is no admin
  web page yet — that is a known open item, not a missing step on your side.
- Confirm you can sign in at the URL with that email and password before you show anyone the system.

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

# Copy it off the machine, encrypted. A dump on the same disk is not a backup:
rclone copy /var/backups/dharohar "remote:dharohar-backups" --checksum

# Restore-test into a NEW empty database. Never over the working one — the script refuses unless you
# pass --allow-non-empty, and you must never pass that flag against live records:
./scripts/restore.sh --container <pg-container> --dbname restore_test_$(date +%s) --create-db \
  --input /var/backups/dharohar/dharohar_dharohar_<stamp>.dump
```

Cron example (2:30 nightly, keep 30 days): see `docs/DEPLOYMENT.md` §8.

**Rollback of the software** (as opposed to the data): `docker compose -f docker-compose.prod.yml down`
keeps the data volumes. Migrations are additive and forward-only — there is no automated down-migration,
so rolling an *older* image against a newer database is supported only if that older code still matches
the columns, which is why you take a verified dump **before** every upgrade.

Restore drill already executed on 2026-10-19 against a disposable database: 3 migrations present,
33/33 parcel geometries valid, a 2,000,000-character document payload with an identical md5 in source
and restored copy, and the audit chain verified through the API as valid across 1,379 entries.

---

## 9. What only you (or the department) can decide

1. **Which organization each record belongs to — this is now the blocking one.** Migrations 0004 and
   0005 have been applied: the district identifier is the primary key, `organization_districts` is the
   explicit relationship, Ajmer/Jaipur/Jodhpur/Udaipur carry `state_code='RJ'` as a demo-environment
   mapping, and all 12 `probe %` fixtures are retired with their parcels kept as isolated synthetic
   history. What still has no owner is the record itself. Measured on the deployed demo database on
   2026-10-20: `organization_id` is NULL on **39 of 39 parcels** and **59 of 59 users**, and
   `land_documents` has no `organization_id` column at all. Until that is decided, a tenant policy has
   nothing to filter on and the cross-organization leak in the next item cannot be closed by RLS.
   The decision is: inherit the tenant that administers the parcel's district, or label records by
   hand. `docs/DISTRICT-TENANCY-MODEL.md` §8 holds the options.
2. **Tenant enforcement is not implemented, and it is now measured.** An officer belonging to a second
   organization, personally granted the same district, reads another organization's parcel with
   **HTTP 200**, and the record appears in that district's listing. That is the result of
   `server/src/test_tenancy_isolation_suite.ts` (17 passed / 4 failed against a disposable copy), which
   is expected to stay red until the application consults `organizations` at all — today it authorizes
   only from `user_jurisdictions`. Do not add two real organizations to one database before this is
   green.
3. **A declared district is a canonical district by default.** `districts.kind` defaults to
   `'canonical'`, so every declaration — including the ones the test suites make — arrives as
   geography. That is how `probe 790279` got into the registry. The validation gate re-applies your
   standing retirement decision on each run, but choosing what a *new* declaration means (candidate
   until approved?) is a governance decision, not a script's.
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
* **Real record volumes.** Every measurement in this document is on synthetic demo data — 39 parcels,
  59 accounts.
* **Row-level security.** Not implemented, and per-district isolation is the only layer that exists.
  The cross-organization behaviour that is missing is measured in item 2 above, not assumed.
* **Restore from the off-machine copy.** The local restore drill passed; fetching an encrypted dump from
  a second location and restoring that has not been done, because no off-machine copy exists yet.

Everything claimed as *done* in this document is backed by a command in `docs/DEPLOYMENT.md` §9 or by the
validation gate (`./scripts/validate-stack.sh` — **52 passed, 1 failed** on 2026-10-20, the one failure
being that provisioning was not run against the live stack because no administrator password was
exported; it ran green against a disposable copy), and by `./scripts/test-tenant-migration.sh`
(**65 passed, 0 failed**) and `./scripts/test-authorization-on-copy.sh`.
