/**
 * DHAROHAR Cryptographic Utilities
 * Provides secure password hashing (PBKDF2), HMAC-SHA256 JWT tokens,
 * SHA-256 document hashing, and append-only audit log cryptographic chaining.
 */

import crypto from 'crypto';
import { JWT_EXPIRY_HOURS, JWT_SECRET, SEAL_SIGNING_KEY } from '../config/env';
import { AuthTokenPayload } from '../types/backend';

/**
 * Raising this invalidates every stored password_hash, so the count is fixed here until
 * hashes carry their own iteration count.
 */
const PBKDF2_ITERATIONS = 10000;

/**
 * Hash a plain text password with a unique cryptographic salt using PBKDF2 (SHA-512)
 */
export function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return { hash, salt };
}

/**
 * Verify a plain text password against stored hash and salt.
 * Returns false instead of throwing when the stored hash is missing or malformed, so a
 * row with a NULL password_hash cannot take down the request.
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!password || !hash || !salt) return false;

  const computed = hashPassword(password, salt);
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(computed.hash, 'hex');

  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Generate a standard HMAC-SHA256 signed JSON Web Token (JWT)
 */
export function createJwtToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: AuthTokenPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_HOURS * 3600,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signature = signHmac(signatureInput);

  return `${signatureInput}.${signature}`;
}

function signHmac(message: string): string {
  return crypto.createHmac('sha256', JWT_SECRET).update(message).digest('base64url');
}

function hmacMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify and decode an HMAC-SHA256 signed JWT
 */
export function verifyJwtToken(token: string): AuthTokenPayload | null {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = signHmac(signatureInput);

    if (!hmacMatches(expectedSignature, signature)) {
      return null;
    }

    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as AuthTokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate SHA-256 hash for document content, strings, or object payloads
 */
export function sha256(data: string | Buffer | object): string {
  const content = typeof data === 'object' && !Buffer.isBuffer(data)
    ? canonicalJson(data)
    : data;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * JSON with object keys in a fixed order. PostgreSQL jsonb does not preserve key order, so
 * hashing `JSON.stringify(details)` produced a different digest for the same stored payload
 * and verifyAuditChain reported a healthy chain as tampered.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((acc: Record<string, any>, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Timestamps round-trip through PostgreSQL as Date objects while the chain was hashed over
 * the ISO string that was written, so both sides normalise here before hashing.
 */
export function canonicalTimestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Compute Chained Entry Hash for append-only audit trail
 */
export function computeAuditEntryHash(
  previousHash: string,
  entityId: string,
  actionType: string,
  performedBy: string,
  timestamp: string | Date,
  details: any
): string {
  const detailsHash = sha256(details);
  const rawPayload = `${previousHash}:${entityId}:${actionType}:${performedBy}:${canonicalTimestamp(timestamp)}:${detailsHash}`;
  return sha256(rawPayload);
}

/**
 * Genesis hash for the root of the audit chain
 */
export const GENESIS_AUDIT_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Sign a verification seal with a server-side secret. The prototype used plain SHA-256 of
 * values that are all visible in the audit log, so anyone holding the log could mint a
 * matching "seal"; an HMAC over the same material cannot be forged without the key.
 */
export function signSeal(material: Record<string, unknown>): string {
  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return crypto.createHmac('sha256', SEAL_SIGNING_KEY).update(canonical).digest('hex');
}

/**
 * Certificate numbers must not collide or be guessable, which Math.random() is neither.
 */
export function generateCertificateNumber(prefix = 'DHAROHAR/ROR'): string {
  const year = new Date().getFullYear();
  const serial = crypto.randomBytes(6).readUIntBE(0, 6).toString().padStart(12, '0');
  return `${prefix}/${year}/${serial}`;
}
