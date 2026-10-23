/**
 * Bootstrap the first system administrator (design default D4).
 *
 *   BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_NAME=... BOOTSTRAP_ADMIN_DISTRICT=... \
 *   BOOTSTRAP_ADMIN_PASSWORD='a long private password' npm run db:bootstrap-admin
 *
 * Run it at the shell, against a migrated database, once. It exists because nothing else in the
 * application can create an administrator: there is no public registration, and every provisioning
 * endpoint requires the USER_ADMIN capability that this command introduces.
 *
 * Refuses to run when an administrator already exists — it is an introduction, not a back door, and
 * it will not silently create a second one or reset an existing password. It writes no land record.
 */

import { initDbConnection, getDbHealth, pool } from './db';
import { createOfficer, hasAnyAdministrator, VALID_ROLES } from '../services/provisioning';
import { RequestPrincipal } from '../services/jurisdiction';
import crypto from 'crypto';
import { UserRole } from '../types/backend';

function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    console.error(`[BOOTSTRAP] ${name} is required. Nothing was created.`);
    process.exit(2);
  }
  return value;
}

async function bootstrap() {
  const health = await initDbConnection();

  if (health.storageMode !== 'postgres-postgis') {
    console.error('[BOOTSTRAP] A real PostgreSQL database is required. No in-memory administrator was created.');
    process.exit(3);
  }

  const email = required('BOOTSTRAP_ADMIN_EMAIL');
  const displayName = required('BOOTSTRAP_ADMIN_NAME');
  const district = required('BOOTSTRAP_ADMIN_DISTRICT');
  const role = (String(process.env.BOOTSTRAP_ADMIN_ROLE ?? 'TEHSILDAR').trim().toUpperCase()) as UserRole;
  if (!VALID_ROLES.includes(role)) {
    console.error(`[BOOTSTRAP] BOOTSTRAP_ADMIN_ROLE must be one of ${VALID_ROLES.join(', ')}. Nothing was created.`);
    process.exit(2);
  }

  // Generated only when the operator did not supply one, and printed exactly once. An operator who
  // wants no secret in terminal output should pass BOOTSTRAP_ADMIN_PASSWORD themselves.
  let password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '');
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(18).toString('base64url');
    generated = true;
  }
  if (password.length < 10) {
    console.error('[BOOTSTRAP] BOOTSTRAP_ADMIN_PASSWORD is shorter than 10 characters. Nothing was created.');
    process.exit(2);
  }

  if (await hasAnyAdministrator()) {
    console.error('[BOOTSTRAP] An officer already holds the USER_ADMIN capability.');
    console.error('[BOOTSTRAP] Create further officers through POST /api/admin/officers, or change roles there.');
    console.error('[BOOTSTRAP] Nothing was created and no existing account was touched.');
    process.exit(4);
  }

  const organizationName = String(process.env.BOOTSTRAP_ORG_NAME ?? '').trim();
  let organizationId: string | null = null;
  if (organizationName) {
    const inserted = await pool.query(
      `INSERT INTO organizations (id, name, description)
       VALUES ($1, $2, 'created by db:bootstrap-admin')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`ORG-${crypto.randomBytes(4).toString('hex')}`, organizationName]
    );
    organizationId = inserted.rows[0].id;
  }

  // Or attach the administrator to a tenant that already exists — which is how a deployed database
  // with ORG-DHAROHAR-DEMO in it bootstraps a further administrator. Validated here rather than left
  // to the foreign key, because an id that does not exist should be named as the flag that produced
  // it, not reported as an insert failure.
  const existingOrganization = String(process.env.BOOTSTRAP_ORG_ID ?? '').trim();
  if (existingOrganization) {
    if (organizationId) {
      console.error('[BOOTSTRAP] BOOTSTRAP_ORG_NAME and BOOTSTRAP_ORG_ID are mutually exclusive. Nothing was created.');
      process.exit(2);
    }
    const found = await pool.query('SELECT id FROM organizations WHERE id = $1', [existingOrganization]);
    if (found.rows.length === 0) {
      console.error(`[BOOTSTRAP] organization "${existingOrganization}" does not exist. Nothing was created.`);
      console.error('[BOOTSTRAP] Create the tenant first (organizations table), or omit BOOTSTRAP_ORG_ID to leave the administrator unowned.');
      process.exit(2);
    }
    organizationId = found.rows[0].id;
  }

  // An officer with no tenant cannot read a single record: every record route answers
  // TENANT_CONTEXT_MISSING, and RLS filters everything out. That is the correct fail-closed behaviour,
  // but it is not what someone running this command to "get in" expects, so say it out loud rather
  // than letting them discover it through a wall of 403s.
  if (!organizationId) {
    const registry = await pool.query(`SELECT to_regclass('public.organizations') IS NOT NULL AS present`);
    const tenants = registry.rows[0].present
      ? (await pool.query(`SELECT string_agg(id, ', ' ORDER BY id) AS ids, count(*)::int AS n FROM public.organizations`)).rows[0]
      : { ids: null as string | null, n: 0 as number };
    if (tenants.n > 0) {
      console.warn('[BOOTSTRAP] No tenant was given, so this administrator is written with organization_id = NULL.');
      console.warn(`[BOOTSTRAP] Tenants in this database: ${tenants.ids}`);
      console.warn('[BOOTSTRAP] A tenant-less officer is refused by every record route (TENANT_CONTEXT_MISSING).');
      console.warn('[BOOTSTRAP] Re-run with BOOTSTRAP_ORG_ID=<tenant>, or assign ownership afterwards with ' +
        'server/src/db/assignOwnership.ts.');
    }
  }

  // There is no logged-in officer yet, so the trail attributes the grant to the bootstrap command
  // itself rather than inventing a person.
  const bootstrapActor: RequestPrincipal = {
    userId: 'bootstrap:db:bootstrap-admin',
    email,
    role,
    displayName: 'Initial administrator bootstrap',
    designation: 'System',
    badgeNumber: 'BOOTSTRAP',
    organizationId,
    districts: [district],
    capabilities: ['USER_ADMIN'],
    // No district grants: this is an account-provisioning identity, not a records identity. It can
    // create the first officers; it cannot read a parcel until its organization is granted a district
    // through organization_districts, which is a decision rather than a default.
    organizationGrants: [],
    primaryDistrict: district,
  };

  const officer = await createOfficer(
    {
      id: String(process.env.BOOTSTRAP_ADMIN_ID ?? '').trim() || undefined,
      email,
      displayName,
      designation: String(process.env.BOOTSTRAP_ADMIN_DESIGNATION ?? 'System Administrator').trim(),
      badgeNumber: String(process.env.BOOTSTRAP_ADMIN_BADGE ?? '').trim() || undefined,
      role,
      districts: [district],
      // USER_ADMIN only: STATE_WIDE_READ and PARCEL_REHOME are separate decisions to make later.
      capabilities: ['USER_ADMIN'],
      password,
      state: String(process.env.BOOTSTRAP_ADMIN_STATE ?? 'Rajasthan').trim(),
      // No organizationId here: createOfficer takes the tenant from the actor, and the actor above is
      // this command, whose organizationId is the one BOOTSTRAP_ORG_NAME/BOOTSTRAP_ORG_ID resolved to.
    },
    bootstrapActor
  );

  console.log('[BOOTSTRAP] Initial system administrator created and recorded in the audit chain.');
  console.log(`[BOOTSTRAP]   officer id : ${officer.id}`);
  console.log(`[BOOTSTRAP]   email      : ${officer.email}`);
  console.log(`[BOOTSTRAP]   role       : ${officer.role} (capability USER_ADMIN)`);
  console.log(`[BOOTSTRAP]   district   : ${officer.districts.join(', ')}`);
  if (organizationId) console.log(`[BOOTSTRAP]   organization: ${organizationId}`);
  if (generated) {
    console.log('[BOOTSTRAP]   password   : ' + password);
    console.log('[BOOTSTRAP] This password was generated because BOOTSTRAP_ADMIN_PASSWORD was not set.');
    console.log('[BOOTSTRAP] It is shown once and is not stored anywhere readable. Record it now.');
  }
}

bootstrap()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error('[BOOTSTRAP] FAILED:', err?.message ?? err);
    if (getDbHealth().storageMode === 'postgres-postgis') {
      console.error('[BOOTSTRAP] No account, assignment or capability was committed.');
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
