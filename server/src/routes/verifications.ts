import { Router, Request, Response } from 'express';
import { getDbHealth } from '../db/db';
import { authenticateToken, requireRole } from '../middleware/auth';
import { recordAuditLog, getAuditLogs, verifyAuditChain } from '../services/auditService';
import { SealRejected, recordFieldInspection, sealParcel } from '../services/parcelService';
import {
  OutOfJurisdiction,
  assertParcelReadable,
  assertParcelWritable,
  hasStateWideRead,
  logStateWideRead,
  mayProvisionOfficers,
  readScope,
} from '../services/jurisdiction';

export const verificationsRouter = Router();

function notFound(res: Response, id: string) {
  return res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Record ${id} was not found.` },
  });
}

function respondError(res: Response, err: any) {
  if (err instanceof SealRejected) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VERIFICATION_PRECONDITIONS_FAILED' ? 422 : 409;
    return res.status(status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  console.error('[VERIFICATIONS] write failed:', err);
  return res.status(503).json({
    success: false,
    error: {
      code: 'VERIFICATION_WRITE_FAILED',
      message: 'The verification could not be recorded. No state was changed.',
    },
  });
}

// GET /api/verifications/audit-logs - Append-only audit records with cryptographic chain info
verificationsRouter.get('/audit-logs', authenticateToken, async (req: Request, res: Response) => {
  const parcelId = req.query.parcelId as string;
  const entityId = req.query.entityId as string;

  // A parcelId is checked explicitly; anything else is narrowed by the caller's districts so an
  // unfiltered read cannot dump the whole state's audit history.
  if (parcelId) {
    try {
      await assertParcelReadable(req.principal!, parcelId);
    } catch (err) {
      if (err instanceof OutOfJurisdiction) return notFound(res, parcelId);
      throw err;
    }
  }

  const scope = readScope(req.principal!);
  // An administrator sees the account-provisioning trail (which belongs to no district); a district
  // officer does not, and neither case changes what parcels they can reach.
  const logs = await getAuditLogs({
    principal: req.principal!,
    parcelId,
    entityId,
    districts: parcelId ? null : scope,
    includeUnattributed: mayProvisionOfficers(req.principal!),
  });

  // scope === null means records outside the caller's own assignments were included.
  if (!parcelId && scope === null) {
    await logStateWideRead(req.principal!, 'audit-logs', { entries: logs.length });
  }

  return res.json({
    success: true,
    data: {
      total: logs.length,
      auditLogs: logs.slice().reverse(),
    },
    scopedTo: scope,
    storageMode: getDbHealth().storageMode,
  });
});

// GET /api/verifications/audit-logs/verify-chain - Cryptographically verify the entire audit log chain
//
// This reports on the whole state's chain, so it takes BOTH the auditor role and the separately
// granted STATE_WIDE_READ capability (D3): a district auditor cannot learn the state's totals, and a
// holder of the capability is recorded as having used it. It verifies the chain — it never mutates.
verificationsRouter.get(
  '/audit-logs/verify-chain',
  authenticateToken,
  requireRole('AUDITOR'),
  async (req: Request, res: Response) => {
    if (!hasStateWideRead(req.principal!)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'STATE_WIDE_READ_REQUIRED',
          message: 'Verifying the state-wide chain requires the STATE_WIDE_READ capability, which is granted explicitly and separately from the auditor role.',
        },
      });
    }

    const verification = await verifyAuditChain();
    await logStateWideRead(req.principal!, 'audit-chain-verify', { entries: verification.totalEntries });

    return res.json({
      success: verification.isValid,
      data: verification,
    });
  }
);

// POST /api/verifications/field-inspection - Assisted AR / GPS field inspection
// Identity comes from the token only; the prototype let callers name whoever they liked.
verificationsRouter.post(
  '/field-inspection',
  authenticateToken,
  requireRole('PATWARI', 'TEHSILDAR'),
  async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.parcelId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARCEL_ID', message: 'parcelId is required for field inspection.' },
      });
    }

    try {
      await assertParcelWritable(req.principal!, body.parcelId);
    } catch (err) {
      if (err instanceof OutOfJurisdiction) return notFound(res, body.parcelId);
      throw err;
    }

    try {
      const result = await recordFieldInspection({
        parcelId: body.parcelId,
        officer: req.principal!,
        body,
      });

      return res.status(201).json({
        success: true,
        data: { inspection: result.inspection },
        message: 'Assisted field inspection recorded.',
        storageMode: result.storageMode,
      });
    } catch (err) {
      return respondError(res, err);
    }
  }
);

// POST /api/verifications/seal - Officer Official Verification Seal (TEHSILDAR ONLY)
verificationsRouter.post(
  '/seal',
  authenticateToken,
  requireRole('TEHSILDAR'),
  async (req: Request, res: Response) => {
    const { parcelId, documentId, officerNotes, recordData, forceOverride } = req.body ?? {};

    if (!parcelId && !documentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TARGET', message: 'parcelId or documentId is required to seal record.' },
      });
    }

    if (!parcelId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PARCEL_ID_REQUIRED',
          message: 'Sealing a document alone is not supported: the parcel row holds the seal.',
        },
      });
    }

    const officer = req.principal!;

    try {
      await assertParcelWritable(officer, parcelId);
    } catch (err) {
      if (err instanceof OutOfJurisdiction) return notFound(res, parcelId);
      throw err;
    }

    try {
      const result = await sealParcel({ parcelId, officer, officerNotes, forceOverride });

      if (documentId) {
        await recordAuditLog({
          parcelId,
          documentId,
          entityType: 'DOCUMENT',
          entityId: documentId,
          actionType: 'DOCUMENT_SEALED',
          performedBy: officer.displayName,
          officerBadge: officer.badgeNumber,
          signatureHash: result.signatureHash,
          details: { certificateNumber: result.certificateNumber, recordData },
        });
      }

      return res.json({
        success: true,
        data: {
          certificateNumber: result.certificateNumber,
          signatureHash: result.signatureHash,
          sealedAt: result.sealedAt,
          verifiedBy: `${officer.displayName} (${officer.designation || officer.role})`,
          officerBadge: officer.badgeNumber,
        },
        message: 'Record authenticated and sealed by revenue authority. Append-only audit record created.',
        storageMode: result.storageMode,
      });
    } catch (err) {
      return respondError(res, err);
    }
  }
);
