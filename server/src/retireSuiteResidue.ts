/**
 * Retire the officer accounts the authorization suites leave in the database they test against.
 *
 *   npx tsx server/src/retireSuiteResidue.ts                    # lists, changes nothing
 *   RESIDUE_APPLY=true npx tsx server/src/retireSuiteResidue.ts # revokes and locks
 *
 * The suites must run against a real stack to prove real authorization, so every run creates a few
 * officers in a fabricated domain (`@dharohar.test`). Nothing deletes them — there is no hard delete
 * in this application by design, and `users` has no retirement state — so they accumulate as accounts
 * that authenticate and, until now, could reach districts.
 *
 * This is the retirement path that design lacks, using the same service functions the admin API uses,
 * so each change is written into the audit chain under the administrator who ran it. It revokes every
 * jurisdiction and capability, then sets the password to a random value that is generated, never
 * printed and never stored anywhere readable: the row survives, the login does not work.
 *
 * It never touches an officer holding USER_ADMIN — retiring the administrator would lock the
 * deployment out of its own provisioning path — and it refuses to run without a real database.
 */

import crypto from 'crypto';
import { initDbConnection, getDbHealth, pool } from './db/db';
import { tenantQuery } from './db/tenant';
import { loadPrincipal, RequestPrincipal } from './services/jurisdiction';
import {
  setOfficerCapabilities,
  setOfficerJurisdictions,
  resetOfficerPassword,
} from './services/provisioning';

const SUFFIX = String(process.env.RESIDUE_EMAIL_SUFFIX || '@dharohar.test').trim();
const APPLY = process.env.RESIDUE_APPLY === 'true';
const REASON = String(
  process.env.RESIDUE_REASON ||
    `suite fixture retired by server/src/retireSuiteResidue.ts (domain suffix ${SUFFIX})`
).trim();

async function findActor(): Promise<RequestPrincipal | null> {
  const wanted = String(process.env.RESIDUE_ADMIN_EMAIL || '').trim();

  // Migration 0010 put `users` under row-level security, so this enumeration returns ZERO rows to the
  // runtime role — which is the whole point of the migration, and it quietly broke this script: it
  // exited 4 ("no usable USER_ADMIN officer") while the administrator sat in the table the whole time.
  // The refusal was correct behaviour from a blind identity, which is the failure mode this project has
  // now hit three times. A named administrator is resolved through the one lookup that exists for reads
  // before a tenant is known — the same exact-identifier function login uses.
  if (wanted) {
    const resolved = await loadPrincipal({ userId: '', email: wanted } as any);
    if (resolved && resolved.capabilities.includes('USER_ADMIN')) return resolved;
    console.error(`[RETIRE] RESIDUE_ADMIN_EMAIL='${wanted}' did not resolve to an officer holding an active USER_ADMIN capability.`);
    return null;
  }

  const holders = await pool.query(
    `SELECT u.id, u.email FROM users u
       JOIN user_capabilities c ON c.user_id = u.id
      WHERE c.capability = 'USER_ADMIN' AND c.revoked_at IS NULL
      ORDER BY u.email`
  );
  if (holders.rowCount === 0) {
    console.error('[RETIRE] no USER_ADMIN holder is visible to this identity. Since migration 0010 the runtime role');
    console.error('[RETIRE] cannot enumerate officers at all, so this is either "there is none" or "I am not allowed');
    console.error('[RETIRE] to see them" and the script cannot tell. Set RESIDUE_ADMIN_EMAIL=<the address>, or run');
    console.error('[RETIRE] it as the schema owner: docker compose -f docker-compose.prod.yml --profile tools \\');
    console.error('[RETIRE]   run --rm -e RESIDUE_APPLY=true maint dist-server/retireSuiteResidue.js');
    return null;
  }

  const chosen = wanted
    ? holders.rows.find((r: any) => r.email === wanted)
    : holders.rowCount === 1
      ? holders.rows[0]
      : null;

  if (!chosen) {
    console.error(`[RETIRE] ${holders.rowCount} officers hold USER_ADMIN; set RESIDUE_ADMIN_EMAIL to one`);
    console.error(`[RETIRE] candidates: ${holders.rows.map((r: any) => r.email).join(', ')}`);
    process.exit(2);
  }

  const principal = await loadPrincipal({
    userId: chosen.id,
    email: chosen.email,
  } as any);
  if (!principal || !principal.capabilities.includes('USER_ADMIN')) return null;
  return principal;
}

async function main() {
  const health = await initDbConnection();
  if (health.storageMode !== 'postgres-postgis') {
    console.error('[RETIRE] a real PostgreSQL database is required; nothing was retired in memory.');
    process.exit(3);
  }

  const actor = await findActor();
  if (!actor) {
    console.error('[RETIRE] no usable USER_ADMIN officer was found or resolved. Either none exists');
    console.error('[RETIRE] (bootstrap one with npm run db:bootstrap-admin) or this identity is not');
    console.error('[RETIRE] allowed to see it — the message above says which.');
    process.exit(4);
  }
  console.log(`[RETIRE] acting as ${actor.email} (${actor.userId}), capabilities: ${actor.capabilities.join(', ')}`);
  console.log(`[RETIRE] retiring accounts whose email ends with ${SUFFIX}${APPLY ? '' : ' — DRY RUN, nothing will change'}`);

  // Read through the actor's own tenant context. `users`, `user_jurisdictions` and `user_capabilities`
  // are row-level-security scoped since migration 0010, so an unbound pool query here returns zero rows
  // and the script would report "nothing to retire" about 54 accounts that are sitting in this very
  // tenant. In a multi-tenant deployment each tenant's residue is retired by an administrator of that
  // tenant, or by the schema owner through `maint` — never by one tenant reading another's officers.
  const candidates = await tenantQuery(actor,
    `SELECT u.id, u.email, u.role,
            coalesce(j.districts, '') AS districts,
            coalesce(c.capabilities, '') AS capabilities
       FROM users u
       LEFT JOIN LATERAL (
         SELECT string_agg(district, ',' ORDER BY district) AS districts
           FROM user_jurisdictions WHERE user_id = u.id AND revoked_at IS NULL
       ) j ON TRUE
       LEFT JOIN LATERAL (
         SELECT string_agg(capability, ',' ORDER BY capability) AS capabilities
           FROM user_capabilities WHERE user_id = u.id AND revoked_at IS NULL
       ) c ON TRUE
      WHERE u.email LIKE '%' || $1
        AND u.id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM user_capabilities ac
           WHERE ac.user_id = u.id AND ac.capability = 'USER_ADMIN' AND ac.revoked_at IS NULL
        )
      ORDER BY u.email`,
    [SUFFIX, actor.userId]
  );

  if (candidates.rowCount === 0) {
    const pattern = `%${SUFFIX}`;
    const anyMatch = await tenantQuery(actor, `SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [pattern]);
    const n = anyMatch.rows[0]?.n ?? 0;
    if (n === 0) {
      // Two states produce this, and row-level security makes them indistinguishable from inside it:
      // no such account exists, or it exists in a tenant this actor may not read. Say which of the two
      // is being claimed — here, neither — and name the identity that can settle it. A "nothing to
      // retire" that came from a scan of a table the caller cannot see is not a clean result.
      console.error(`[RETIRE] no account matching '${pattern}' is visible to ${actor.email}`);
      console.error(`[RETIRE] (organization ${actor.organizationId ?? 'NONE'}). Whether that means there is nothing`);
      console.error(`[RETIRE] to retire, or the residue belongs to a tenant this identity is not allowed to read,`);
      console.error(`[RETIRE] cannot be told from inside row-level security. Settle it as the schema owner:`);
      console.error(`[RETIRE]   docker compose -f docker-compose.prod.yml --profile tools run --rm -e RESIDUE_APPLY=true maint dist-server/retireSuiteResidue.js`);
      await pool.end();
      process.exit(5);
    }
    console.log(`[RETIRE] ${n} account(s) match '${pattern}' and every one holds USER_ADMIN, so none is retired.`);
    await pool.end();
    return;
  }

  for (const row of candidates.rows) {
    console.log(
      `  ${row.email}  id=${row.id}  role=${row.role}  ` +
        `districts=[${row.districts}]  capabilities=[${row.capabilities}]`
    );
  }
  console.log(`\n[RETIRE] ${candidates.rowCount} candidate officer account(s).`);

  if (!APPLY) {
    console.log('[RETIRE] dry run. Re-run with RESIDUE_APPLY=true to revoke and lock these accounts.');
    await pool.end();
    return;
  }

  let changed = 0;
  for (const row of candidates.rows) {
    const j = await setOfficerJurisdictions(row.id, [], REASON, actor);
    const c = await setOfficerCapabilities(row.id, [], REASON, actor);
    // Generated per account, never printed: the credential is destroyed, not moved somewhere readable.
    await resetOfficerPassword(row.id, crypto.randomBytes(24).toString('base64url'), REASON, actor);
    changed += 1;
    console.log(
      `  retired ${row.email}: districts ${j.before.length} -> ${j.after.length}, ` +
        `capabilities ${c.before.length} -> ${c.after.length}, password invalidated`
    );
  }

  console.log(`\n[RETIRE] ${changed} account(s) revoked and locked. No row was deleted and every change`);
  console.log('[RETIRE] is in the audit chain as OFFICER_JURISDICTIONS_CHANGED / _CAPABILITIES_CHANGED /');
  console.log('[RETIRE] _PASSWORD_RESET attributed to the officer who ran this command.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('[RETIRE] FAILED:', err?.message ?? err);
  if (getDbHealth().storageMode === 'postgres-postgis') {
    console.error('[RETIRE] Each account is retired in its own transaction; a failure mid-run leaves the');
    console.error('[RETIRE] remaining ones untouched and re-running is safe.');
  }
  await pool.end().catch(() => {});
  process.exit(1);
});
