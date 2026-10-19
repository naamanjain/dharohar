/**
 * DHAROHAR server configuration.
 *
 * This module must be imported before anything that reads process.env: dotenv only
 * loads .env when this file is evaluated, so importing it first guarantees the real
 * values win over the fallbacks below.
 */

import crypto from 'crypto';
import dotenv from 'dotenv';

// `quiet` because dotenv otherwise prints a status line — including a rotating marketing tip with a
// third-party URL — to stdout on every process start. Server logs must carry server output.
dotenv.config({ quiet: true });

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * SHA-256 of the signing secret that shipped in the prototype and was published in its README.
 *
 * Held as a digest on purpose. The previous version of this file carried the literal, which meant
 * the codebase re-published the exact credential its own check exists to retire — and a secret
 * scanner is right to flag a high-entropy string sitting in source, even when it appears there to be
 * rejected. Comparing digests keeps the guarantee and removes the exposure: a token signed with the
 * old value is still refused, but nobody learns the value by reading this file.
 */
const LEAKED_JWT_SECRET_DIGEST = '990423f3a69318d13318d5ab09be155cbaa2bd46856a460fe439c4c3e2cbca76';

const isLeakedPrototypeSecret = (value: string): boolean =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex') === LEAKED_JWT_SECRET_DIGEST;

function resolveJwtSecret(): string {
  const configured = (process.env.JWT_SECRET || '').trim();

  if (configured && !isLeakedPrototypeSecret(configured)) {
    return configured;
  }

  if (IS_PRODUCTION) {
    throw new Error(
      configured
        ? 'JWT_SECRET is set to the leaked prototype secret. Generate a unique value (e.g. `openssl rand -hex 32`) and set JWT_SECRET.'
        : 'JWT_SECRET is not set. A unique signing secret is required to start the server in production.'
    );
  }

  console.warn(
    '[DHAROHAR AUTH] JWT_SECRET is unset — using a random secret for this process only.\n' +
      '                    Sessions will not survive a restart and tokens from earlier runs are rejected.\n' +
      '                    Set JWT_SECRET before deploying anywhere real records live.'
  );
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Resolved on first use, not at import.
 *
 * This used to be `export const JWT_SECRET = resolveJwtSecret()`, which threw during module load in
 * production. Any script that imported anything reaching this file — including the migration runner,
 * which needs no signing key at all — died with "JWT_SECRET is not set". That forced the maintenance
 * containers to carry the API's signing secret, which is exactly the coupling Phase "separate
 * migrations from the runtime" is meant to remove. The guarantee is unchanged: the HTTP server calls
 * assertProductionSecrets() before it binds a port, so production still refuses to start without a
 * unique secret — it just refuses at the component that uses it.
 */
let resolvedJwtSecret: string | null = null;

export function signingSecret(): string {
  if (resolvedJwtSecret === null) resolvedJwtSecret = resolveJwtSecret();
  return resolvedJwtSecret;
}

/** Fail fast, in the process that actually signs tokens. */
export function assertProductionSecrets(): void {
  signingSecret();
}

/**
 * The password the four demo personas are seeded with.
 *
 * This used to be a literal in the source, which meant the repository shipped a working credential
 * for a Tehsildar, a Patwari, an operator and an auditor — and every scanner that ever looked at this
 * project flagged it, correctly, because that is exactly what a leaked password looks like. The value
 * now comes from the environment; when nobody sets it, each process generates its own, so a
 * development instance has a demo password only its operator knows.
 *
 * Seeding prints it once. Suites and the validation gate must be given the same value they seeded
 * with, or they cannot sign in — and they fail with that instruction rather than trying a default.
 */
export const DEMO_PASSWORD: string =
  (process.env.DEMO_PASSWORD || '').trim() || crypto.randomBytes(12).toString('base64url');

/**
 * Seal signatures must not be reproducible from anything a reader of the audit log can
 * see, so they get their own HMAC key rather than the plain SHA-256 the prototype used.
 * Lazy for the same reason as signingSecret(): falling back to the JWT secret at import
 * meant a module that never signs a seal still forced the secret to be resolved.
 */
export function sealSigningKey(): string {
  return (process.env.SEAL_SIGNING_KEY || '').trim() || signingSecret();
}

export const JWT_EXPIRY_HOURS = Number(process.env.JWT_EXPIRY_HOURS) || 24;

export const PORT = Number(process.env.PORT) || 3001;

/**
 * Origin allowlist. Unset in development allows local origins only; production refuses to
 * start on a wildcard because credentialed CORS plus a wildcard is a cross-site data leak.
 */
function resolveAllowedOrigins(): string[] | 'any' {
  const configured = (process.env.ALLOWED_ORIGINS || '').trim();

  if (configured === '*') {
    if (IS_PRODUCTION) {
      throw new Error('ALLOWED_ORIGINS cannot be "*" in production — list the exact origins that may call the API.');
    }
    return 'any';
  }

  const origins = configured
    ? configured.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];

  return origins;
}

export const ALLOWED_ORIGINS = resolveAllowedOrigins();

export const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
