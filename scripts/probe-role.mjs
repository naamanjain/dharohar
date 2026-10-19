// Effective-privilege probe for the runtime database identity.
//
// Run it as the role the API uses — the point is to ask PostgreSQL what it will actually honour,
// not to read what scripts/roles.sql intended:
//   docker compose -f docker-compose.prod.yml exec -T api node - < scripts/probe-role.mjs
//
// Every statement is attempted in its own transaction and rolled back, so a permitted write leaves
// no residue and a denied one reports the denial rather than aborting the rest.
// Dynamic import so the file runs identically whether node treats stdin as CommonJS or as ESM.
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });

const identity = [
  ['current_user', `select current_user as v`],
  ['session_user', `select session_user as v`],
  ['database', `select current_database() as v`],
  ['attributes', `select 'login='||rolcanlogin||' superuser='||rolsuper||' createrole='||rolcreaterole||' createdb='||rolcreatedb||' bypassrls='||rolbypassrls||' replication='||rolreplication as v from pg_roles where rolname = current_user`],
  ['owns_schema_public', `select 'pg_namespace_owner='||(select nspowner::regrole::text from pg_namespace where nspname='public') as v`],
];

// name -> [expected, sql]. `denied` means the release design requires the runtime role to fail here.
const probes = [
  ['denied', 'CREATE TABLE probe_ddl (id int)', 'DDL is the migration identity\'s job, not the runtime role\'s'],
  ['denied', 'TRUNCATE parcels', 'a runtime role that can truncate can erase the register'],
  ['denied', 'DELETE FROM parcels', 'land records are archived, never deleted'],
  ['denied', 'DELETE FROM users', 'officer rows survive for the audit trail'],
  ['denied', 'UPDATE append_only_audit_logs SET action_type = action_type', 'the chain is append-only by grant as well as by trigger'],
  ['denied', 'DELETE FROM append_only_audit_logs', 'history cannot be removed'],
  ['denied', 'INSERT INTO schema_migrations (version,name,filename,checksum,runner) VALUES (\'9999\',\'probe\',\'probe.sql\',\'x\',\'probe\')', 'the runtime role must not be able to mark a migration applied'],
  ['denied', 'CREATE ROLE probe_role LOGIN', 'a runtime role that can create roles can grant itself anything'],
  ['allowed', 'SELECT count(*)::int AS n FROM parcels', 'read of operational data'],
  // code must equal lower(btrim(name)) (ck_districts_code_is_name), so the probe row is written the
  // way the registry requires; an invalid pair would report a constraint error, not a privilege one.
  ['granted', "INSERT INTO districts (code,name,provenance) VALUES ('probe invalid','Probe Invalid','declared')", 'the admin district endpoint writes through this role'],
  // Zero rows: this only asks whether INSERT is authorised, without fighting the append-only guard
  // trigger or leaving a hash-chain entry behind.
  ['granted', "INSERT INTO append_only_audit_logs (entity_type, entity_id, action_type, performed_by, previous_hash, entry_hash) SELECT 'PROBE','probe','PROBE','probe','x','y' FROM append_only_audit_logs LIMIT 0", 'append-only means INSERT is permitted'],
];

const run = async (sql) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(sql);
    await client.query('ROLLBACK');
    return { ok: true, code: null, detail: r.rows && r.rows.length ? JSON.stringify(r.rows[0]) : 'statement accepted' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, code: e.code || null, detail: `${e.code || 'ERR'} ${String(e.message).split('\n')[0]}` };
  } finally {
    client.release();
  }
};

(async () => {
  console.log('=== identity (asked of the live connection) ===');
  for (const [label, sql] of identity) {
    const r = await run(sql);
    console.log(`  ${label.padEnd(20)} ${r.ok ? r.detail : 'ERROR ' + r.detail}`);
    if (!r.ok && label === 'attributes') process.exit(2);   // unmeasured is not a pass
  }

  console.log('\n=== effective privileges (each rolled back) ===');
  let wrong = 0;
  for (const [expected, sql, why] of probes) {
    const r = await run(sql);
    const permissionDenied = r.code === '42501';
    const got = permissionDenied ? 'denied' : r.ok ? 'allowed' : `reached-executor(${r.code})`;
    let ok;
    if (expected === 'denied') ok = permissionDenied;
    else if (expected === 'allowed') ok = r.ok;
    else ok = !permissionDenied;   // 'granted': authorisation passed, even if the statement then hit a rule
    if (!ok) wrong++;
    console.log(`  ${ok ? 'OK  ' : 'WRONG'} ${expected.padEnd(8)} got=${got.padEnd(24)} ${sql.slice(0, 52)}${sql.length > 52 ? '…' : ''}`);
    if (!r.ok) console.log(`        server said: ${r.detail}`);
    if (!ok) console.log(`        why it matters: ${why}`);
  }

  console.log(`\n${wrong === 0 ? 'ALL PRIVILEGE ASSERTIONS MATCH THE DESIGN' : `${wrong} ASSERTION(S) WRONG`}`);
  await pool.end();
  process.exit(wrong === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('PROBE FAILED:', e.message);
  await pool.end().catch(() => {});
  process.exit(2);
});
