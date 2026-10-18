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
  const holders = await pool.query(
    `SELECT u.id, u.email FROM users u
       JOIN user_capabilities c ON c.user_id = u.id
      WHERE c.capability = 'USER_ADMIN' AND c.revoked_at IS NULL
      ORDER BY u.email`
  );
  if (holders.rowCount === 0) return null;

  const wanted = String(process.env.RESIDUE_ADMIN_EMAIL || '').trim();
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
    console.error('[RETIRE] no usable USER_ADMIN officer found, so there is no identity to attribute the');
    console.error('[RETIRE] revocations to. Bootstrap one (npm run db:bootstrap-admin) and re-run.');
    process.exit(4);
  }
  console.log(`[RETIRE] acting as ${actor.email} (${actor.userId}), capabilities: ${actor.capabilities.join(', ')}`);
  console.log(`[RETIRE] retiring accounts whose email ends with ${SUFFIX}${APPLY ? '' : ' — DRY RUN, nothing will change'}`);

  const candidates = await pool.query(
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
    const anyMatch = await pool.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [pattern]);
    if (anyMatch.rows[0].n === 0) {
      console.error(`[RETIRE] no row in users matches '${pattern}', so the table was scanned and nothing was`);
      console.error('[RETIRE] found. A "nothing to retire" that came from a pattern matching nothing is not a');
      console.error('[RETIRE] clean result. Suite-created officers end in @dharohar.test; check the suffix.');
      await pool.end();
      process.exit(5);
    }
    console.log(`[RETIRE] ${anyMatch.rows[0].n} account(s) match '${pattern}' and every one holds USER_ADMIN, so none is retired.`);
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
