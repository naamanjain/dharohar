import { Router, Request, Response } from 'express';
import { memoryStore, getDbHealth, pool, INITIAL_USERS } from '../db/db';
import { IS_PRODUCTION } from '../config/env';
import { verifyPassword, createJwtToken } from '../utils/crypto';
import { authenticateToken } from '../middleware/auth';
import { recordAuditLog } from '../services/auditService';
import { loadPrincipal } from '../services/jurisdiction';

export const authRouter = Router();

const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginFailures = new Map<string, { count: number; firstSeen: number }>();

/**
 * Counts failed attempts only. Counting successes locked a legitimate officer out after 10
 * ordinary logins in ten minutes, which is what the earlier version did.
 */
function isThrottled(key: string): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstSeen > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_FAILURES;
}

function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const entry = loginFailures.get(key);

  if (!entry || now - entry.firstSeen > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstSeen: now });
    return;
  }
  entry.count += 1;
}

function clearFailedAttempts(key: string): void {
  loginFailures.delete(key);
}

// POST /api/auth/login - Authenticate officer and return JWT access token
authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, username, officerId, profileId, password } = req.body ?? {};
  const loginIdentifier = (email || username || officerId || profileId || '').toLowerCase().trim();

  if (!loginIdentifier || typeof password !== 'string' || !password) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_CREDENTIALS',
        message: 'An officer identifier and a password are both required to log in.',
      },
    });
  }

  const throttleKey = `${req.ip}:${loginIdentifier}`;
  if (isThrottled(throttleKey)) {
    return res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many failed logins. Wait 10 minutes before trying again.',
      },
    });
  }

  let user: any = null;
  // A failed identity lookup must not be reported as a wrong password: an officer with a working
  // account would be told their credentials are bad while the database is simply unreachable.
  let lookupFailed = false;
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT * FROM users WHERE LOWER(email) = $1 OR id = $2 OR LOWER(badge_number) = $1 LIMIT 1',
          [loginIdentifier, loginIdentifier.toUpperCase()]
        );
        if (result.rows.length > 0) {
          const row = result.rows[0];
          user = {
            id: row.id,
            email: row.email,
            passwordHash: row.password_hash,
            salt: row.salt,
            role: row.role,
            displayName: row.display_name,
            designation: row.designation,
            badgeNumber: row.badge_number,
            jurisdiction: row.jurisdiction,
            district: row.district,
            state: row.state,
          };
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      lookupFailed = true;
      console.error('[AUTH] DB fetch error:', err.message);
    }
  }

  // In-memory personas are a development affordance only. In production an officer exists exactly
  // when the database says they do — never when a hardcoded array says so.
  if (!user && !IS_PRODUCTION) {
    // Check in-memory store
    const allUsers = Array.from(memoryStore.users.values());
    user = allUsers.find(
      (u) =>
        u.email.toLowerCase() === loginIdentifier ||
        u.id.toLowerCase() === loginIdentifier ||
        u.badgeNumber.toLowerCase() === loginIdentifier ||
        u.displayName.toLowerCase().replace(/[^a-z]/g, '') === loginIdentifier.replace(/[^a-z]/g, '')
    );
  }

  if (lookupFailed && IS_PRODUCTION) {
    // Not counted as a failed attempt: an outage must not burn an officer's throttle window.
    return res.status(503).json({
      success: false,
      error: {
        code: 'AUTH_LOOKUP_UNAVAILABLE',
        message: 'The officer registry could not be read from the database. Sign-in is refused rather than answered from in-memory data.',
      },
    });
  }

  // One message for both outcomes: distinguishing "no such officer" from "wrong password"
  // turns the login endpoint into a roster of valid badge numbers and IDs.
  if (!user) {
    recordFailedAttempt(throttleKey);
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid officer identifier or password.',
      },
    });
  }

  const isPasswordValid = verifyPassword(password, user.passwordHash, user.salt);

  if (!isPasswordValid) {
    recordFailedAttempt(throttleKey);
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid officer identifier or password.',
      },
    });
  }

  clearFailedAttempts(throttleKey);

  // Create JWT token
  const token = createJwtToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    designation: user.designation,
    badgeNumber: user.badgeNumber,
    district: user.district,
  });

  // Record audit log for login
  await recordAuditLog({
    entityType: 'SYSTEM',
    entityId: user.id,
    actionType: 'OFFICER_LOGGED_IN',
    performedBy: user.displayName,
    officerBadge: user.badgeNumber,
    details: {
      role: user.role,
      district: user.district,
      designation: user.designation,
    },
  });

  // The client is told which districts this session may act in, and which capabilities it holds, so
  // the interface can be scoped the same way the server already is. These are informational: the
  // server re-reads them on every request and never trusts what the browser sends back.
  let grantedDistricts: string[] = [user.district].filter(Boolean);
  let grantedCapabilities: string[] = [];
  try {
    const principal = await loadPrincipal({
      userId: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      designation: user.designation,
      badgeNumber: user.badgeNumber,
      district: user.district,
      iat: 0,
      exp: 0,
    });
    if (principal) {
      grantedDistricts = principal.districts;
      grantedCapabilities = principal.capabilities;
    }
  } catch (err: any) {
    console.error('[AUTH] could not read assignments for the login response:', err.message);
  }

  return res.json({
    success: true,
    data: {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        designation: user.designation,
        badgeNumber: user.badgeNumber,
        jurisdiction: user.jurisdiction,
        district: user.district,
        districts: grantedDistricts,
        capabilities: grantedCapabilities,
        state: user.state,
      },
    },
    message: `Authentication successful. Welcome, ${user.displayName}.`,
  });
});

// GET /api/auth/me - Get current authenticated officer profile
authRouter.get('/me', authenticateToken, async (req: Request, res: Response) => {
  const tokenUser = req.user!;
  let userProfile: { designation?: string; jurisdiction?: string; state?: string } | undefined;

  // Profile attributes come from the row of record whenever PostgreSQL is the store. The in-memory
  // personas and the hardcoded INITIAL_USERS array are development conveniences only: reading them
  // in production would let a deployed instance answer /me from a source no administrator controls.
  if (getDbHealth().storageMode === 'postgres-postgis') {
    try {
      const result = await pool.query(
        'SELECT designation, jurisdiction, state FROM users WHERE id = $1 OR email = $2 LIMIT 1',
        [tokenUser.userId, tokenUser.email]
      );
      if (result.rows.length > 0) {
        userProfile = {
          designation: result.rows[0].designation,
          jurisdiction: result.rows[0].jurisdiction,
          state: result.rows[0].state,
        };
      }
    } catch (err: any) {
      console.error('[AUTH] /me profile lookup failed:', err.message);
      if (IS_PRODUCTION) {
        return res.status(503).json({
          success: false,
          error: { code: 'PROFILE_LOOKUP_UNAVAILABLE', message: 'The officer profile could not be read from the database.' },
        });
      }
    }
  }

  if (!userProfile && !IS_PRODUCTION) {
    const stored = memoryStore.users.get(tokenUser.userId)
      || INITIAL_USERS.find((u) => u.id === tokenUser.userId || u.email === tokenUser.email);
    userProfile = { designation: stored?.designation, jurisdiction: stored?.jurisdiction, state: stored?.state };
  }

  return res.json({
    success: true,
    data: {
      user: {
        id: tokenUser.userId,
        email: tokenUser.email,
        role: tokenUser.role,
        displayName: tokenUser.displayName,
        badgeNumber: tokenUser.badgeNumber,
        district: tokenUser.district,
        districts: req.principal?.districts ?? [tokenUser.district].filter(Boolean),
        capabilities: req.principal?.capabilities ?? [],
        // Read from the live principal, never from the token and never from the request: an officer who
        // belongs to no organization has to be able to see that, because the alternative is an empty
        // register with no explanation.
        organizationId: req.principal?.organizationId ?? null,
        designation: userProfile?.designation || tokenUser.role,
        jurisdiction: userProfile?.jurisdiction || `${tokenUser.district} District`,
        state: userProfile?.state || 'Rajasthan',
      },
    },
  });
});
