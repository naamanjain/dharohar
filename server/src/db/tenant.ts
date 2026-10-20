/**
 * Transaction-scoped tenant context for PostgreSQL row-level security.
 *
 * WHY A TRANSACTION AND NOT A SESSION SETTING. The pool is shared between concurrent requests. A
 * `SET app.organization_id = …` at session scope stays on that connection after the request ends, so
 * the next request that reuses it — including one that forgot to set anything — would read as the
 * previous officer's organization. `set_config(name, value, true)` is local to the current
 * transaction, which is why every record path has to be inside one. The same call is made on every
 * path whether or not the caller has an organization, so a connection can never be handed back
 * holding a context a later query inherits.
 *
 * The policies in migration 0006 require TWO things to agree: the session's organization, and the
 * organization the `users` table records for the session's user id. Setting only one of them — the
 * shape a forged context would take — resolves to no rows at all.
 */

import { PoolClient } from 'pg';
import { pool, getDbHealth } from './db';
import type { RequestPrincipal } from '../services/jurisdiction';

const ORG_GUC = 'app.organization_id';
const USER_GUC = 'app.user_id';

/**
 * Runs `fn` inside one transaction whose session carries the caller's tenant.
 *
 * A principal with no organization is not an error to paper over: the context is set to the empty
 * string, the policies match nothing, and any read returns zero rows. That is the quarantine and
 * mis-configuration case handled in one place rather than by eighteen guards.
 */
export async function withTenant<T>(
  principal: RequestPrincipal,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await beginTenantTransaction(principal);
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Roll back and rethrow. A swallowed failure here would let a handler report a write that the
    // database never committed.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Opens the transaction and binds the context, for the handlers that already own a
 * `pool.connect()` / `BEGIN` / `COMMIT` / `release()` lifecycle. They keep their structure and gain
 * the context; there is no second implementation of the binding to drift out of step.
 * The caller still owes the COMMIT or ROLLBACK and the release.
 */
export async function beginTenantTransaction(principal: RequestPrincipal): Promise<PoolClient> {
  if (getDbHealth().storageMode !== 'postgres-postgis') {
    throw new Error('tenant context requires PostgreSQL; the in-memory development store has no row-level security to scope');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, principal);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  return client;
}

export async function applyTenantContext(client: PoolClient, principal: RequestPrincipal): Promise<void> {
  await client.query(`SELECT set_config($1, $2, true), set_config($3, $4, true)`, [
    ORG_GUC, principal.organizationId ?? '',
    USER_GUC, principal.userId ?? '',
  ]);
}

/**
 * One statement, executed inside its own transaction with the caller's tenant context bound.
 *
 * This exists because the handlers in server/src/routes were written against the shared pool, and the
 * pool has no tenant. Under row-level security an unbound read returns no rows at all, which would
 * break the application instead of protecting it — so the binding has to happen at the call, not on
 * the pool. Work that spans several statements still uses withTenant() and one real transaction.
 */
export async function tenantQuery<T = any>(
  principal: RequestPrincipal,
  sql: string,
  params: any[] = []
): Promise<{ rows: T[]; rowCount: number | null }> {
  return withTenant(principal, async (client) => {
    const result = await client.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  });
}
