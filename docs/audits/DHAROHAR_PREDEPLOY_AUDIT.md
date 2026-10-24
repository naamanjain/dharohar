# DHAROHAR — pre-deployment audit

Audited candidate: branch `main`, repository `C:/Users/allin/OneDrive/Desktop/AI/DHAROHAR`
(single clone; no nested `.git` found), remote `https://github.com/naamanjain/dharohar.git`
(no credentials embedded in the URL).
Commit before this audit: `317377d`. The commit this audit is recorded in is named in
`PACKAGE_INFO.txt` of the accompanying ZIP, and the ZIP's `source/` tree is `git archive` of that
commit — not a copy of the working directory.
Measurement date: **2026-10-25** (all figures below are from that day's runs, with the evidence file
that carries each one).

Database under audit: the **synthetic demo deployment** (`dharohar-prod-db-1`, database `dharohar`).
No real land records, no personal data, no production credentials are present anywhere in this system.

---

## 1. Executive assessment

DHAROHAR is a three-container React + Express + PostgreSQL/PostGIS application being prepared as a
multi-organization (SaaS) land-record register for Indian municipal departments. This audit covers
authorization and tenant isolation, credential handling, migration integrity, backup/recovery
capability, and the cleanliness of the repository and its history.

The controls that matter are implemented **and measured**, not asserted:

* Tenant isolation exists in two independent layers — application authorization and PostgreSQL
  row-level security over **nine** tables — and is exercised against a restored copy as the runtime
  role, without the application in the path (`docs/TENANT-DATA-ACCESS.md`).
* The runtime database role cannot read a password hash at all: not by table privilege, not by column
  privilege, and the refusal is asserted both as a privilege lookup and as an attempted `SELECT`.
* The one credential that had been displayed in a session transcript was **rotated**, and the rotation
  was proven in both directions — the old value refused by PostgreSQL, the new value authenticating.
* Append-only audit chaining is verified by an identity that is exempt from row-level security and
  **refuses to report** when it is not. Four separate checks prove that refusal, because a
  chain validator that cannot see the whole table certifies the rows it was allowed to see.

Three things are **not** true, and are stated here rather than in a footnote:

1. **Off-machine disaster recovery is not proven.** The encrypted-archive leg is proven end to end; the
   transfer leg has never run, because this machine has no external destination, no transfer client
   (`rclone`, `restic`, `age`, `aws` are all absent) and no destination credentials.
2. **Tenant isolation is not complete.** Two specific cross-tenant paths remain and are pinned by
   assertions in §7 below: a session may assert its own tenant context, and the sanctioned login
   lookup returns one named officer's credential columns.
3. **The live-stack provisioning gate has not been run**, because the deployed administrator's password
   is not available to this environment. It is `BLOCKED`, not `PASS`, and nothing was reset to make it
   go green.

Verdict: **SYNTHETIC PILOT ONLY.** See §9 for the reason and for what would change it.

---

## 2. Security gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Runtime credential (`dharohar_app`) rotated after exposure | **DONE, proven both directions** | `scripts/rotate-app-credential.sh` run 2026-10-23: `.env` value digest changed, every other secret's digest unchanged, old credential → `FATAL: password authentication failed`, new → authenticates, API recreated, `/api/health/ready` 200. Re-verified 2026-10-25 (`evidence/11`): `rolsuper=f`, `rolbypassrls=f`, `rolinherit=f`, `rolcreaterole=f`, `rolcreatedb=f`, `rolconnlimit=50`. |
| Owner/migration credential kept separate from the runtime account | **DONE** | `dharohar` (owner, superuser) is used only by the `migrate`, `roleinit` and `maint` one-shots; the API container does not receive `DHAROHAR_APP_PASSWORD` as such (its digest there is the empty string) — the value reaches it only inside `DATABASE_URL`. |
| Cross-tenant officer reads closed | **DONE for enumeration; two residuals named in §7** | `select count(*) from users` as `dharohar_app`: **59 → 0**; postings, capabilities and tenant grants likewise 0 unbound; `select password_hash from users` → `permission denied for table users`; 36 tenant policies over 9 RLS tables (`evidence/11`). |
| Credential columns unreadable by the runtime role | **DONE** | `has_column_privilege('dharohar_app','public.users','password_hash','SELECT')` = **f**, `salt` = **f**, `organization_id` = **t** (needed by the roster and the policies), `UPDATE users` = **t**, `DELETE users` = **f** — re-asserted by `scripts/roles.sql` on every `roleinit`, which aborts with `[ROLES_LOCKDOWN_FAILED]` if it does not hold. |
| Connection-pool tenant context cleanup | **DONE, both commit and rollback** | Tenancy suite §8 (single-connection pool, backend pid equality asserted first): after `COMMIT` the next borrower sees `<unset>`/`<unset>` and 0 records; after `ROLLBACK` the same. 101/0 in `evidence/09-authz-copy.log`. |
| Verifier identity preserves fail-closed behaviour | **DONE** | `dharohar_verifier`: `rolsuper=f`, `rolbypassrls=t`, `rolconnlimit=5`, write privileges on **0** tables, attempted `INSERT` → `permission denied for table parcels`. `evidence/10-blind-certifier.log` (exit 0) proves the chain certifier **refuses** a row-level-security-limited identity and exits 0 only for an identity that sees the whole ledger. |
| Audit chain verification | **PASS** | 2,874 entries walked, ids contiguous 1…2,874, `distinct_ids` = 2,874, verdict **INTACT**, run as `dharohar_verifier`, exit 0. Whole-chain digest `0b68ceb2c11f6913b6b0e7998d1eed48` (`evidence/11`). |
| District integrity verification | **exit 1 by design** | 58 findings reported as `dharohar_verifier`, nothing modified. Each class is dispositioned in `docs/DISTRICT-INTEGRITY-REPORT.md`; the count is from today's run (`evidence/13-integrity.log`). |
| Live-stack provisioning gate | **BLOCKED — existing administrator credential unavailable** | `scripts/validate-stack.sh:230` skips when `ADMIN_PASSWORD` is unset. Not in `.env`, not exported. No second administrator was created and no password was reset. Owner action in §8. |
| Off-machine encrypted recovery | **BLOCKED — no destination, no client, no credentials** | Encryption leg DONE (`evidence/03`, exit 0); transfer leg NOT RUN. What is missing is listed in §8. |
| GitHub-side secret scanning / push protection state | **NOT RUN — `gh` CLI not installed here** | The repository carries `.gitguardian.yaml` with documented, narrow exclusions; the server-side alert list could not be read from this machine. |

---

## 3. Verification results, 2026-10-25

Every row was executed against the code in the audited commit unless marked otherwise. Exit codes are
from the script itself, not from a pipe that could mask them (that masking bit this project twice).

| Command | Result | Exit |
| --- | --- | --- |
| `npm run lint` (`tsc --noEmit`) | clean | 0 |
| `npm test` (`test:i18n`, `test:ocr`, `test:phase4`, `test:e2e`) | phase 4 **47 passed / 0 failed**; E2E **53 / 0** | 0 |
| `npm run test:registry` | **56 passed / 0 failed** | 0 |
| `./scripts/test-tenant-migration.sh` | **141 passed / 0 failed** — 0006–0010 apply, idempotence, rollback, rollback guards, deliberate aborts | 0 |
| `./scripts/test-fresh-install.sh` | **all checks passed** — an empty database reaches the same schema as an upgraded one (211 columns / 62 constraints / 53 indexes / 5 triggers matched), 0010 applies on a from-nothing database, aborted migration diagnosed and recovered | 0 |
| `./scripts/test-authorization-on-copy.sh` | jurisdiction **46/0**, provisioning **91/0**, tenancy **101/0** against a restored copy, API running as `dharohar_app` | 0 |
| `./scripts/test-rls-blind-certifier.sh` | certifier refuses a partial view, accepts an exempt one | 0 |
| `./scripts/encrypted-backup-drill.sh` | **38 checks** — see §5 | 0 |
| `./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups` | all checks passed; **the destination is a second volume of the same machine**, and the script says so | 0 |
| `./scripts/validate-stack.sh` | **68 passed, 1 failed** of 69 checks — the one failure is the `ADMIN_PASSWORD` skip in §8; the suite-residue retirement step that migration 0010 had broken now passes again | 1 |
| `verify dist-server/verify_audit_chain.js` (as `dharohar_verifier`) | 2,874 entries, **INTACT** | 0 |
| `verify dist-server/verify_district_integrity.js` (as `dharohar_verifier`) | **58 findings** — 54 locked suite-created accounts, 2 documents with neither a district nor a parcel, 2 documents unowned and unlinked, the rest dispositioned in `docs/DISTRICT-INTEGRITY-REPORT.md` §6. A non-zero exit is the designed behaviour of a findings report (`evidence/13-integrity.log`) | 1 |
| Secret scan of working tree + all reachable history (§6) | 0 live values; controls pass | 0 |

The gate's own refusal test is in that 68: `PASS the integrity checker refuses to report as the
row-level-security-bound runtime role`. Nothing was repaired to make the integrity report shorter —
58 findings are the state the department has to decide on, printed as such.

**No test was weakened to reach green.** Diffing the two commits before this audit
(`git diff 239c094..HEAD -- server/src/test_* scripts/test-*`) adds 234 lines and removes 11, of which
exactly **three were assertions**, each replaced by a stronger one and each in the direction of *more*
refusal, not less:

| Removed | Replaced by |
| --- | --- |
| `A: db:migrate applies every migration on disk` (one pass) | pass one **must stop at 0006 and name the missing basis**, a person-stated declaration must succeed, and pass two must then apply every file — three assertions where there was one |
| `premise: the personal assignment is revoked` expecting **HTTP 200** for a cross-tenant officer edit | `an administrator cannot re-assign an officer who belongs to another organization` expecting **404 `OFFICER_NOT_FOUND`**, plus a control that the same token still reads its own parcel |
| the personal-revocation consequence asserted through that cross-tenant call | the same property asserted **inside one tenant**: a new officer loses `Jaipur` while the tenant still holds it, and its parcel read then returns 404 |

Migration rollback guards were not relaxed either: 24 refusal assertions remain in
`scripts/test-tenant-migration.sh`, and `rollback-0010.sql` still refuses rather than guessing
(`[ROLLBACK_REFUSED]` when a policy it did not create is attached, and it `WARNING`s that rolling back
restores the runtime role's ability to read every password hash).

---

## 4. Database state, sanitized

Counts move every time a gate runs against this database, because the suites create officers, parcels
and documents and **there is no hard delete in this application by design**. The ownership split and
the quarantine are the facts; the totals are a snapshot (`evidence/11-db-inventory.txt`).

| | |
| --- | --- |
| Parcels | 45 — **33 owned** by `ORG-DHAROHAR-DEMO`, **12 quarantined** (`organization_id IS NULL`) |
| Land documents | 51, of which **2 carry real payload bytes**, both written by drills (2,796,232 and 2,000,028 characters; md5 `d4019b0f11d429a49b0cb93a5e4d3504` and `dba59e9570fc10bb704688fafdd5a181`) |
| Co-sharers / mutations / inspections | 46 / 16 / 0 |
| Officer accounts | 59, **all 59 owned** by the demo tenant. 54 match the suite-created email domain and all 54 are **retired** (grants revoked, capabilities revoked, password replaced with a value that was never printed). 2 active capabilities and 5 active postings remain, belonging to the live administrator. |
| Districts | 16 — **4 canonical**, **12 retired** (`kind = 'retired'`, the probe-pattern fixtures the owner decided on 2026-10-19 are retired fixtures, not geography). Nothing was deleted. |
| Organizations / grants / units | 1 tenant, 4 active district grants, 0 `organization_units` rows |
| Audit entries | 2,874; 830 carry `actor_user_id`, 831 carry `actor_organization_id` (since 0008); ids contiguous |
| Migration ledger | `0001 … 0010`, one sha256 per file, recorded by `server/src/db/migrate.ts`; `run --rm migrate` afterwards reports "10 applied, schema up to date (no-op)", which is what proves the ledger matches the files on disk |

**Quarantine semantics.** A row with no `organization_id` is invisible to every tenant and is preserved
rather than deleted; the 12 quarantined parcels and the 2 unowned persistence-probe documents are the
deliberate consequence of that rule, and `scripts/assignOwnership.ts` is the only path that changes it —
requiring a stated basis and a named human.

---

## 5. Backup and recovery: what is proven, what is not

**Proven on 2026-10-25** (`./scripts/encrypted-backup-drill.sh`, 38 checks, exit 0):

* a `pg_dump -Fc` archive is **plaintext and measurably not opaque** — `pg_restore --list` reads its
  manifest with no key and lists `TABLE DATA public parcels`; the object names are greppable in the
  bytes (`parcels` 118 times, `officer` 10 times) while per-row data is compressed but not encrypted;
* after AES-256-CBC + PBKDF2-SHA256 (200,000 iterations), the ciphertext contains neither the `PGDMP`
  magic nor the object names, the **same `pg_restore --list` command fails** with *"input file does not
  appear to be a valid archive"*, and a wrong passphrase cannot open it (`bad decrypt`, exit 1);
* decrypting with the right passphrase reproduces the archive **byte for byte**, and the decrypted copy
  restores into a disposable database with the ledger, eight table counts, the owned-parcel count,
  valid-geometry count, RLS still enabled on `parcels`, the largest document payload's md5 and the
  **whole audit chain digest** equal to the deployed database.

**Not proven:** that any copy leaves this machine. Measured: `rclone`, `restic`, `age`, `aws`,
`ossutil` are not installed, there is no `%APPDATA%\rclone\rclone.conf`, no network share is mapped
(`net use` → no entries), and no external-storage credentials exist in the environment. `gpg` and
`openssl` are present, so the encryption side is available today.

**A finding that changed the picture:** this repository lives at
`C:\Users\allin\OneDrive\Desktop\AI\DHAROHAR`, the Desktop known folder is redirected into OneDrive, and
the OneDrive sync-root marker folder is present — so `backups/`, holding **76 unencrypted dumps
(~19 MB, 0 byte-identical duplicates)**, is inside a folder that a sync client would upload the moment
one signs in. The OneDrive client was not running and had no account configured when measured, so
**nothing is proven to have left the machine and nothing can be proven not to have.**
`scripts/backup.sh` now prints a `WARNING:` when its resolved output directory lies under a cloud-sync
path (proved firing here and silent for `C:\temp-dh-backup`), and the destination/transit/access/
retention/credential rules are written into `docs/DEPLOYMENT.md` §8.

---

## 6. Secret audit

Scope and method (`evidence/05-secret-scan.txt`, `evidence/scan-secrets.cjs`): every live value in
`.env` was compared **by occurrence of the value** against 326 working-tree files (excluding
`node_modules`, `.git`, build output, and the secret source itself), **2,490 blobs across all 23
reachable commits**, `.git/config`, and the two dangling objects `git fsck` reports. Credential
*shapes* (private-key blocks, URLs with embedded credentials, AWS key ids, GitHub tokens, JWTs,
credential-shaped assignments) were matched at the same time.

Controls, so a clean result means something: a live value planted in memory was **DETECTED**; a
placeholder of the same shape was **not** reported as live; a dense credential URL **was** flagged by
the shape rules. Without those three the scan is decoration — this project has already shipped a
"scanner" whose entry guard never fired and reported clean while reading nothing.

| Result | |
| --- | --- |
| Live values in the working tree | **0** |
| Live values in any reachable commit | **0** |
| `.env` and `.env.local-credentials-preserve-me` | untracked **and** ignored (`.gitignore:8`), sizes 606 and 25 bytes |
| `md5(rolpassword)` / SCRAM verifiers | **never** written to any file, report or archive |
| Dangling objects | 2, both superseded copies of `docs/SECURITY.md` and `docs/DISTRICT-TENANCY-MODEL.md`; no live value, no credential shape. Left in place — pruning is a maintenance decision, not a leak response. |
| Historic prototype secret | `server/src/config/env.ts` stores the SHA-256 of the JWT secret that was published in the original README and **refuses to start with it**. Every literal assignment in every `.env.example` revision across all 23 commits was hashed: **none** matches that digest. The published value is out of the templates and unusable even if resurrected. |
| Shape-only findings | 15, all dispositioned: the vendored Tesseract WASM loaders (base64 bodies that trip an AWS-key-id pattern — the reason `.gitguardian.yaml` excludes `public/tesseract/**`, with provenance recorded in `public/tesseract/PROVENANCE.md`), and `$VAR`-interpolated connection strings in `.env.example` and the two drill scripts, plus one documentation example. |

**Distinguishing exposure from absence.** A scan that finds nothing is not evidence that a value was
never exposed. `DHAROHAR_APP_PASSWORD` was displayed in a session transcript on 2026-10-23 (once via
`docker inspect`, once via a "variable names only" filter over rendered compose YAML that failed because
YAML renders `key: value`). It was rotated the same day; historic exposure is closed **by the rotation**,
not by this scan. No credential remains unrotated that is known to have been displayed.

**.gitignore reviewed in both directions** (Phase 5 requirement): migrations, runner copies, `roles.sql`,
the new scripts, `package-lock.json`, compose files, Dockerfiles, docs, `.gitguardian.yaml` and
`public/tesseract/PROVENANCE.md` are **not** ignored; `.env*`, `backups/`, `*.dump`, `*.sha256`,
`node_modules/`, `dist*/`, `coverage/`, `.enc-drill-tmp/` and the credential-preservation file **are**.
One stale line was removed from `.gitguardian.yaml` (`bun.lock`, a 0-byte stray that is now deleted and
ignored anyway) — an exclusion for a file that does not exist is a claim nobody can check.

---

## 7. Outstanding issues, ranked

1. **Off-machine recovery unproven** — §5. Blocking for real records, not for a synthetic pilot.
2. **Login lookup is a credential oracle for a known identifier.** `dharohar_officer_for_login(text)` is
   `SECURITY DEFINER` (it must be: login resolves a person before a tenant exists), so
   `select password_hash from dharohar_officer_for_login('someone@exact.address')` returns that
   officer's PBKDF2 verifier — 128 hex characters, measured — even though the role cannot read the
   column from the table. It matches **exactly one** of `email`/`id`/`badge_number` with `LIMIT 1`, and
   `%` returns 0 rows, so it cannot enumerate. Closing it needs an authentication identity that alone
   may read a credential column, with the runtime role reading none. The tenancy suite asserts the
   current behaviour (`RESIDUAL, asserted on purpose`, §9 of the suite) so a change is visible.
3. **Row-level security constrains the application, not the holder of the runtime credential.**
   `app.organization_id` and `app.user_id` are set by the session, so a connection can assert a tenant
   with no token involved. Measured: 0 officers unbound → 59 of *the asserted tenant* after
   `set_config(...)`, **0 rows of any other tenant, and 0 parcels** (record policies also require a
   session user that resolves in `users`). This is defense-in-depth against a query that forgot its
   predicate; it is not a wall against a compromised API process, and no document here claims it is.
4. **PBKDF2 at 10,000 iterations** (`server/src/utils/crypto.ts`), fixed because raising it invalidates
   every stored hash. Acceptable while the data is synthetic; a real deployment needs an iteration
   count carried inside the hash record so it can be raised without locking anyone out.
5. **Live-stack provisioning gate BLOCKED** (§8) — the behaviour is tested on a copy, not on the
   deployment.
6. **Document bytes live in PostgreSQL TEXT columns** as base64. Confidentiality therefore travels
   with the database backup chain, and the stored "checksum" covers the stored text plus the data URI,
   not independently verifiable file bytes. Migration plan: `docs/DOCUMENT-STORAGE.md`.
7. **Unrun / unverified:** GitHub secret-scanning alert state (`gh` absent), ARM image build
   (everything here is `linux/amd64`), load or capacity under real traffic, a real department IdP
   round trip, TLS and DNS from outside this network, and browser-level verification of the SPA in this
   session (the checks are HTTP-level and database-level).
8. **Deliberate non-policies** (not defects): `districts` is shared geography; `organization_units` has
   zero rows and zero queries — a policy for a table no code reads is decoration, so the requirement is
   recorded in `docs/TENANT-DATA-ACCESS.md` to arrive with the query; `append_only_audit_logs` is
   whole-table by nature, and a filtered chain read is the failure mode §2's certifier test exists to
   catch.

---

## 8. Owner-only actions, with the exact command

**a. The live-stack provisioning gate.** The deployed administrator is `USR-SYSADM-01`,
`sysadmin@dharohar.local` (role `TEHSILDAR`, organization `ORG-DHAROHAR-DEMO`, `badge_number` NULL,
created 2026-10-16). Its password came from `BOOTSTRAP_ADMIN_PASSWORD` at a terminal that day and is
stored nowhere. `DEMO_PASSWORD` governs the *seeded personas*, and no seeded persona exists in this
database (`demo.doe@dharohar.local` → 0 of 59 rows; signing in as the administrator with
`DEMO_PASSWORD` returns **HTTP 401**, measured). Bootstrap refuses to run twice, so it cannot be used
to reset a password, and no second administrator was created to make a gate pass.

```bash
cd "C:/Users/allin/OneDrive/Desktop/AI/DHAROHAR"
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD     # typed, never echoed, never in history
./scripts/validate-stack.sh                          # the ADMIN_PASSWORD skip disappears
unset ADMIN_PASSWORD
```

**b. Off-machine encrypted backup.** Install a client, add a destination, then run the drill against it:

```bash
winget install rclone.rclone
rclone config                      # new remote; keep the passphrase in your password manager, not here
BACKUP_PASSPHRASE='>=20 characters, typed at the prompt' ./scripts/encrypted-backup-drill.sh
rclone copy backups/encrypted/ "remote:dharohar-backups" --checksum
# then restore FROM the destination into a disposable database, exactly as docs/DEPLOYMENT.md §8 shows
```

Retention is 30 days and is **not yet applied anywhere**: 76 dumps have accumulated in `backups/`
(~19 MB). Applying it means deleting files — that is your call, not a cleanup step I should take
silently.

**c. Decide the fate of the scratch databases** on the disposable PostGIS container. Nothing in this
repository references the two strays, but I could not prove their purpose, so I left them:
`dgtest` (16 MB) and `p10b_11212` (23 MB), plus `template_postgis` (18 MB) which the PostGIS image
creates itself and should **not** be dropped.

```bash
docker exec dharohar-audit-pg psql -U postgres -c 'drop database if exists dgtest'
docker exec dharohar-audit-pg psql -U postgres -c 'drop database if exists p10b_11212'
```

**d. Move the repository (or at least `backups/`) out of the OneDrive sync root**, or enable volume-level
encryption, so the plaintext-dump-in-a-synced-folder condition in §5 stops being true.

**e. Before real records:** rotate `DEMO_PASSWORD` out of the picture entirely (real officers must never
share one password), raise the PBKDF2 iteration scheme, and close residual #2 with a separate
authentication identity.

---

## 9. Deployment-readiness verdict

**SYNTHETIC PILOT ONLY.**

*Why it is not `BLOCKED`:* every credential known to have been exposed has been rotated and re-proven;
no live secret exists in the working tree or in any of the 23 reachable commits; the authorization and
tenant-isolation controls are implemented and measured in two layers with 101 tenant assertions, 91
provisioning assertions and 46 jurisdiction assertions running as the actual runtime role against a
restored copy; the migrations apply forward from nothing and roll back through guards that refuse
rather than guess; the audit chain verifies intact under an identity that refuses to be blind.

*Why it is not `READY FOR HOSTING-COMPATIBILITY CHECK` in the full sense:* a deployment that will hold
land records needs the off-machine encrypted restore to have actually happened, and it needs the two
named cross-tenant residuals (§7.2, §7.3) closed or formally accepted by the department. Both are
operator/organisation decisions rather than code defects, and both are outside what this environment can
prove — there is no destination to copy to and no real IdP or traffic to test against.

A **private, synthetic staging box reached only over an SSH tunnel** (`docs/OWNER-HANDOFF.md` §4b) is
the right next step: it exercises the install, the migrations, the TLS overlay choice and the runbook
without publishing anything.

---

## 10. Hosting compatibility — Requirements for `dharohar.urbantechx.in`

| Requirement | Current state | What a host must provide |
| --- | --- | --- |
| Runtime | `node:22-alpine` in the images; this workstation runs Node v24.20.0 for the gates | Any Linux host with Docker Engine + Compose v2. No Node needed on the host: everything runs in containers. |
| Architecture | images built **`linux/amd64`** here. ARM hosts (OCI `a1.flex`, some Hetzner, Apple Silicon in Docker Desktop) would be pulling or building a different architecture. | On ARM, build on the host or publish multi-arch; the compose files do not pin `platform`. **Unverified.** |
| CPU / memory | limits in `docker-compose.prod.yml`: api `0.75` cpu / `512M`, db `0.75` cpu / `512M`, web `0.5` cpu / `256M`. Measured working set: api 25 MiB, db 69 MiB, web 12 MiB | A **1 GB** VM is comfortable for synthetic traffic; 2 GB recommended once OCR runs in-process and payloads grow. |
| Disk | images: api 398 MB (four services build from the same Dockerfile), web 100 MB, plus `postgis/postgis:16-3.4-alpine`; database volume 16 MB of data today | 20 GB for the OS plus image churn, more for document payloads. Base64 payloads live in the database, so the **data volume grows with the register** — see `docs/DOCUMENT-STORAGE.md`. |
| Volumes | `dharohar-prod_dharohar_pgdata`, `dharohar-prod_dharohar_uploads` | Named volumes, backed up. Losing `pgdata` is losing the register; that is what §5 is about. |
| Ports | `web` publishes `127.0.0.1:8088→80` by default (`WEB_BIND`), and `api` and `db` publish **nothing** to the host | A reverse proxy (Caddy overlay in `docker-compose.tls.yml`) terminates TLS on 443 and reaches `web` over the internal network. Never set `WEB_BIND=0.0.0.0` without TLS in place. |
| DNS | documented in `docs/DEPLOYMENT.md` §5 | `A dharohar.urbantechx.in → <SERVER_IP>`, TTL 300. `api.` and `admin.` subdomains are **not** needed and there is no admin app to serve. |
| Secrets | five required values, all interpolated from `.env` by compose, which **fails closed** if one is missing | Generate on the host with `openssl rand -hex`; `.env` mode `600`; never in an image (`.dockerignore` blocks it), never in a transcript. |
| Cost | ₹0 constraint holds for the software: no paid service is required at runtime | OCR is vendored (`public/tesseract`) — no CDN, no API key, works offline. Object storage for off-machine backups is the only thing that might cost money, and B2/R2 free tiers cover this scale. |
| Health and readiness | `/api/health` reports boot mode; **`/api/health/ready` probes the database live** and is what a proxy or orchestrator should watch | Wire the proxy's upstream health check to `/api/health/ready`, not `/api/health`. |
| Fail-closed behaviour | with the API stopped, the SPA shows a persistent "Cannot reach the server" warning and refuses sign-in (tested); writes with an unreachable authorization layer answer `503 AUTHORIZATION_UNAVAILABLE` rather than succeeding quietly | Do not add a client-side fallback that pretends success. That rule is in force. |

---

## 11. What was removed and what was kept in this pass

Removed, each after confirming it is regenerable or has no referents (repo size 323 MB → 306 MB):

| Item | Size | Why it was disposable |
| --- | --- | --- |
| `dist/` | 17 MB, 16 files | `npm run build` output; `.dockerignore` excludes it, so images never used it. Tree hash before removal `6a813f0d3d198292`. |
| `dist-server/` | 372 KB, 9 files | `npm run build:server` output; `Dockerfile.api:18` rebuilds it inside the image and `.dockerignore:5` keeps the local copy out. Tree hash `d9ec440381a042bd`. |
| `bun.lock` | 0 bytes | An empty stray; `package-lock.json` is the only lockfile the repository tracks and no file references bun. |
| Session logs from the previous phase (`g-*.log`, `gates-*.log`) | — | Regenerated as `evidence/01…12` for this audit, now written **outside** the repository. |

Kept, deliberately:

* `node_modules/` (257 MB) — regenerable from the tracked `package-lock.json`, but the verification suite
  in this same pass runs against it. `npm ci` reproducibility is the last item in §12.
* `backups/` (76 dumps, ~19 MB, **0 byte-identical duplicates**) and `backups-pre0003/` (the pre-0003
  baseline dump). A blocked external-backup test is not a reason to delete a backup.
* `.env`, `.env.local-credentials-preserve-me` — untracked and ignored; the second is the owner's own
  credential-preservation file and nobody else's to touch.
* `assets/` — contains only `.aistudio/.gitignore`; purpose not established, so kept.
* Everything tracked: source, migrations, drafts, rollbacks, tests, fixtures, docs, Dockerfiles, compose.
* **No database row was deleted, truncated or reseeded.** The 12 quarantined parcels, the 12 retired
  fixture districts, the 2 unowned probe documents and the 54 retired suite accounts are all still
  there, because forensic history and the "retire, never delete" rule depend on them.

---

## 12. Reproducing this audit

```bash
cd "C:/Users/allin/OneDrive/Desktop/AI/DHAROHAR"
set -a; . ./.env; set +a
npm run lint && npm test
npm run test:registry                                   # needs REGISTRY_ADMIN_URL (scratch PostGIS)
./scripts/test-tenant-migration.sh
./scripts/test-fresh-install.sh
./scripts/test-authorization-on-copy.sh
./scripts/test-rls-blind-certifier.sh
./scripts/validate-stack.sh                             # + ADMIN_PASSWORD for the last gate
./scripts/encrypted-backup-drill.sh                     # + BACKUP_PASSPHRASE, typed not echoed
./scripts/offsite-copy-drill.sh --dest D:/dharohar-backups
docker compose -f docker-compose.prod.yml --profile tools run --rm verify dist-server/verify_audit_chain.js
```

Outstanding: `npm ci` from an empty `node_modules` to prove the lockfile reproduces the toolchain
(registry reachability confirmed by probe; the reinstall itself was not run in this pass, so the tree
that produced these results is the one that was installed before it).

---

## 13. Git and package provenance

| | |
| --- | --- |
| Branch | `main` |
| Audited commit | named in `PACKAGE_INFO.txt`; this report is committed in it |
| Remote | `https://github.com/naamanjain/dharohar.git` — no embedded credentials; unchanged by this audit |
| Push | normal push of `main`, no `--force`, no history rewrite, no visibility change; outcome recorded in §14 |
| ZIP | `DHAROHAR_PREDEPLOY_AUDIT_<date>.zip`, built outside the repository from `git archive` of the audited commit plus `evidence/`, with `MANIFEST.sha256`; verified by re-extracting and re-hashing every entry, and by a directory+content exclusion check before packing |

**This is not a security certification.** It is a record of what was measured on one machine against
one synthetic dataset, by the person building it. Passing tests are the evidence that specific claims
are true, not evidence that no others are false — see the two named residuals in §7, which are exactly
the kind of thing a green suite can hide.

## 14. Push outcome

| | |
| --- | --- |
| Pushed | `git push origin main`, normal push, no `--force`, no history rewrite, no visibility change, no remote branch deleted |
| Moved | `459f3b8` → `22650f1` (seven commits went up: the remote had not been updated since the tenant-model work began, because every earlier phase was explicitly un-pushed by the owner) |
| Audited code candidate | `22650f1` — the commit this report was written in |
| Verified on the server | `git ls-remote --heads origin` returned `22650f1fd3135b726fa3313d2a33d05dc0430469` for `refs/heads/main`; `git status -sb` then showed `## main...origin/main` with no ahead/behind |
| Server-side secret scanning | The push was accepted. That is **not** proof GitHub found nothing: push protection can be warn-only or off on a private repository, and `gh` is not installed here, so the alert list could not be read. The local audit in §6 is the evidence; this line only records that nothing blocked the push. |
| What was **not** done | no deployment, no container started on any public host, no DNS record created, no real record entered, `WEB_BIND` left at its loopback default |

The following documentation-only commit completes this section; `git diff --name-only` between it and
`22650f1` lists exactly this file, which is how the ZIP's claim that it contains the audited *code* is
checked rather than asserted.
