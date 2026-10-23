/**
 * DHAROHAR — certify the audit chain, with proof that the checker could see it.
 *
 * The chain is the tamper-evidence for every action taken on the register, so its verification is the
 * one diagnostic that must never be satisfiable by an empty result set. A validator that simply walks
 * the entries it was handed reports "verified" when row-level security, a filtered connection or a
 * wrong database handed it nothing — and this project has already been bitten by the mirror image of
 * that: an RLS-blind integrity check invented 41 findings that did not exist.
 *
 * So this command reports three separate things and only certifies when all three agree:
 *
 *   identity   who is asking, whether it is exempt from row-level security, whether the audit table
 *              has any policies at all
 *   coverage   how many entries are visible here versus how many PostgreSQL says have ever been
 *              inserted (pg_stat_user_tables.n_tup_ins is not filtered by RLS), and whether the ids
 *              run 1..N without holes
 *   integrity  the hash walk itself: every previousHash and every entryHash
 *
 * Run it as the read-only verification identity, which is exempt from row-level security and holds no
 * write privilege on anything:
 *
 *   docker compose -f docker-compose.prod.yml --profile tools run --rm \
 *     verify dist-server/verify_audit_chain.js
 *
 * Exit: 0 certified and intact, 1 chain broken, 2 the identity cannot certify it (or no database).
 */

import { pool, initDbConnection } from './db/db';
import { verifyAuditChain, auditChainVisibility } from './services/auditService';

async function main() {
  const health = await initDbConnection();
  if (health.storageMode !== 'postgres-postgis') {
    console.error(`[CHAIN] a PostgreSQL database is required (storage mode: ${health.storageMode}).`);
    console.error('[CHAIN] Nothing was certified.');
    await pool.end().catch(() => {});
    process.exit(2);
  }

  const visibility = await auditChainVisibility();
  console.log('[CHAIN] ===== identity and coverage =====');
  console.log(`  database        : ${health.database}`);
  console.log(`  verified as     : ${visibility.verifiedAs}`);
  console.log(`  superuser/bypass: ${visibility.identityExempt ? 'yes' : 'no'}`);
  console.log(`  RLS on the audit table: ${visibility.rlsEnabled ? 'ENABLED' : 'not enabled'}`);
  console.log(`  entries visible here  : ${visibility.entriesSeen}`);
  console.log(`  highest id visible    : ${visibility.maxIdSeen}`);
  console.log(`  rows ever inserted    : ${visibility.rowsInsertedEver} (pg_stat_user_tables.n_tup_ins)`);
  console.log(`  coverage              : ${visibility.seesWholeLedger ? 'whole ledger' : visibility.reason}`);

  if (!visibility.seesWholeLedger) {
    console.error('\n[CHAIN] NOT CERTIFIED — the chain was not judged from a complete read.');
    console.error(`[CHAIN] ${visibility.reason}`);
    console.error('[CHAIN] Use the read-only verification identity (dharohar_verifier) rather than the API role.');
    await pool.end().catch(() => {});
    process.exit(2);
  }

  const result = await verifyAuditChain();
  console.log('\n[CHAIN] ===== integrity =====');
  console.log(`  entries walked : ${result.totalEntries}`);
  console.log(`  verdict        : ${result.isValid ? 'INTACT' : 'BROKEN'}`);
  console.log(`  ${result.message}`);
  if (typeof result.brokenLinkIndex === 'number') {
    console.log(`  first failure at index ${result.brokenLinkIndex} (0-based, ordered by id)`);
  }
  await pool.end().catch(() => {});
  process.exit(result.isValid ? 0 : 1);
}

main().catch((err) => {
  console.error('[CHAIN] unexpected failure:', err?.message || err);
  process.exit(2);
});
