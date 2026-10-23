/**
 * DHAROHAR Authentication & Role-Based Access Control (RBAC) Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { verifyJwtToken } from '../utils/crypto';
import { AuthTokenPayload, UserRole } from '../types/backend';
import { RequestPrincipal, isReadOnlyRole, loadPrincipal } from '../services/jurisdiction';

// Extend Express Request interface to include user
declare global {
  namespace Express {
    interface Request {
      /** Verified token claims. Identity only — never consulted for authorization. */
      user?: AuthTokenPayload;
      /** Live role, jurisdiction assignments and capabilities, resolved from the database. */
      principal?: RequestPrincipal;
    }
  }
}

/**
 * Extracts and verifies JWT from Authorization header
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Please provide a valid Bearer token.',
      },
    });
  }

  const payload = verifyJwtToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired authentication token. Please log in again.',
      },
    });
  }

  req.user = payload;

  // Authorization is decided from live server-side state, not from what the token asserted when it
  // was signed. A revoked jurisdiction assignment, a withdrawn capability or a deleted officer all
  // take effect on the next request instead of whenever the token expires.
  void (async () => {
    try {
      const principal = await loadPrincipal(payload);
      if (!principal) {
        res.status(401).json({
          success: false,
          error: {
            code: 'OFFICER_NOT_FOUND',
            message: 'This token belongs to an officer who no longer exists in the registry. Please log in again.',
          },
        });
        return;
      }
      req.principal = principal;
      next();
    } catch (err: any) {
      console.error('[AUTH] principal lookup failed:', err.message);
      res.status(503).json({
        success: false,
        error: {
          code: 'AUTHORIZATION_UNAVAILABLE',
          message: 'Officer authorizations could not be read from the database. No record data was returned.',
        },
      });
    }
  })();
}

/**
 * Read-only roles may look but never change. Kept as a separate gate from role lists and from
 * jurisdiction so an auditor's oversight reads are not confused with mutation rights, and so that
 * adding a new write role to a `requireRole` list cannot silently make auditors writers.
 */
export function denyReadOnly(req: Request, res: Response, next: NextFunction) {
  if (req.principal && isReadOnlyRole(req.principal)) {
    return res.status(403).json({
      success: false,
      error: { code: 'READ_ONLY_ROLE', message: 'Auditors have read-only access to the registry.' },
    });
  }
  next();
}

/**
 * Enforces role-based permissions on protected endpoints
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Read from the principal loaded from the database on THIS request, never from the role signed
    // into the token. A token stays valid until it expires, so an officer demoted out of SYSTEM_ADMIN
    // — or out of the tenant entirely — would otherwise keep exercising the old role for the rest of
    // the token's life. `req.user` is kept for identity only.
    const principal = req.principal;
    if (!principal) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required for role verification.',
        },
      });
    }

    if (!allowedRoles.includes(principal.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Access denied. Role '${principal.role}' is not authorized for this operation. Required: [${allowedRoles.join(', ')}].`,
        },
      });
    }

    next();
  };
}
