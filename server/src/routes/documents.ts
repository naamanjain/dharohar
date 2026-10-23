import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { memoryStore, getDbHealth, pool } from '../db/db';
import { authenticateToken, denyReadOnly, requireRole } from '../middleware/auth';
import { recordAuditLog } from '../services/auditService';
import { sha256 } from '../utils/crypto';
import { mapDocumentRow, normaliseOwner, setDocumentParcelLink } from '../services/parcelService';
import {
  OutOfJurisdiction,
  TenantContextMissing,
  assertDocumentReadable,
  assertDocumentWritable,
  assertParcelWritable,
  assertWritableDistrict,
  authorizationErrorResponse,
  DEV_TENANT_ORGANIZATION,
  districtRefusal,
  logStateWideRead,
  organizationScopeClause,
  parcelDistrict,
  readScope,
} from '../services/jurisdiction';
import { beginTenantTransaction, tenantQuery } from '../db/tenant';

export const documentsRouter = Router();

/**
 * "Not found" and "outside your jurisdiction" share one body: a distinct 403 would confirm that the
 * document id another district holds is real.
 */
function notFoundDocument(res: Response, id: string) {
  return res.status(404).json({
    success: false,
    error: { code: 'DOCUMENT_NOT_FOUND', message: `Document ${id} not found in repository.` },
  });
}

// GET /api/documents - List all registered document records
documentsRouter.get('/', authenticateToken, async (req: Request, res: Response) => {
  const health = getDbHealth();
  const parcelId = req.query.parcelId as string;

  // readScope is null only for a holder of STATE_WIDE_READ; otherwise it is the caller's assigned
  // districts, already normalised, and an officer with no assignments gets an empty list.
  //
  // This filter exists in the SQL branch too. It did not: `GET /api/documents` returned every
  // district's documents (OCR text and image included) to any authenticated officer, because only
  // the single-document read was scoped. A list endpoint is the easiest way to dump a jurisdiction.
  const scope = readScope(req.principal!);

  if (health.storageMode === 'postgres-postgis') {
    try {
      const where: string[] = [];
      const params: any[] = [];

      if (parcelId) {
        params.push(parcelId);
        where.push(`d.parcel_id = $${params.length}`);
      }

      if (scope !== null) {
        // A document is reachable through its own district, or failing that through the parcel it is
        // attached to. Rows with neither fall out of the comparison and stay unreachable — the same
        // rule assertDocumentReadable applies to a single read.
        params.push(scope);
        where.push(
          `LOWER(TRIM(COALESCE(NULLIF(d.district, ''), p.district))) = ANY($${params.length}::text[])`
        );
      }

      // Tenancy is a second, independent predicate: two organizations may both be granted a district
      // by organization_districts, and that grant must not put the other tenant's uploads in this
      // list. Unowned (quarantined) rows fail the equality and are excluded by construction.
      const tenant = organizationScopeClause(req.principal!, 'd', params.length + 1);
      if (tenant.sql.startsWith(' AND (1 = 0)')) {
        return res.status(403).json(authorizationErrorResponse(new TenantContextMissing())!.body);
      }
      params.push(...tenant.params);
      where.push(tenant.sql.trim().replace(/^AND /, ''));

      const result = await tenantQuery(req.principal!,
        `SELECT d.* FROM land_documents d
           LEFT JOIN parcels p ON p.id = d.parcel_id
           ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY d.uploaded_at DESC`,
        params
      );
      const documents = result.rows.map(mapDocumentRow);
      if (scope === null) {
        await logStateWideRead(req.principal!, 'document-list', { records: documents.length });
      }
      return res.json({
        success: true,
        data: { total: documents.length, documents },
        storageMode: health.storageMode,
        scopedTo: scope,
      });
    } catch (err: any) {
      console.error('[DOCUMENTS] PostgreSQL fetch error:', err.message);
      return res.status(503).json({
        success: false,
        error: { code: 'DOCUMENT_READ_FAILED', message: 'Documents could not be read from the database.' },
      });
    }
  }

  let documents = Array.from(memoryStore.documents.values());
  // No tenant filter here, and that is deliberate rather than an oversight: the in-memory store holds
  // one environment's fixtures and loadPrincipal gives every persona DEV_TENANT_ORGANIZATION, so there
  // is no second tenant to be separated from. Tenant isolation is proven against PostgreSQL, where the
  // quarantine case and row-level security actually exist.
  if (parcelId) {
    documents = documents.filter((d) => d.parcelId === parcelId);
  }
  if (scope !== null) {
    documents = documents.filter((d) => {
      const own = String(d.district ?? '').trim().toLowerCase();
      if (own) return scope.includes(own);
      const linked = d.parcelId ? memoryStore.parcels.get(d.parcelId) : null;
      return scope.includes(String(linked?.district ?? '').trim().toLowerCase());
    });
  }

  return res.json({
    success: true,
    data: { total: documents.length, documents },
    storageMode: health.storageMode,
    scopedTo: scope,
  });
});

// GET /api/documents/:id - Get single document metadata with OCR text & hash
documentsRouter.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  const { id } = req.params;
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    try {
      const result = await tenantQuery(req.principal!, 'SELECT * FROM land_documents WHERE id = $1', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'DOCUMENT_NOT_FOUND', message: `Document ${id} not found in repository.` },
        });
      }

      const document = mapDocumentRow(result.rows[0]);
      try {
        await assertDocumentReadable(req.principal!, document);
      } catch (err) {
        const tenantRefusal = authorizationErrorResponse(err);
        if (tenantRefusal) return res.status(tenantRefusal.status).json(tenantRefusal.body);
        if (err instanceof OutOfJurisdiction) {
          return res.status(404).json({
            success: false,
            error: { code: 'DOCUMENT_NOT_FOUND', message: `Document ${id} not found in repository.` },
          });
        }
        throw err;
      }
      let linkedParcelOwners: any[] = [];
      if (document.parcelId) {
        // Joined through parcels rather than read straight off parcel_owners: parcel_owners carries
        // no owner column of its own (its tenant is the parcel's), and the row-level policy on parcels
        // is what makes a link into another organization's record unreadable here. A document that
        // predates its parcel's assignment therefore cannot leak the parcel's owners.
        const owners = await tenantQuery(req.principal!,
          `SELECT o.* FROM parcel_owners o
             JOIN parcels p ON p.id = o.parcel_id
            WHERE o.parcel_id = $1`,
          [document.parcelId]
        );
        linkedParcelOwners = owners.rows.map(normaliseOwner);
      }

      return res.json({
        success: true,
        data: { document: { ...document, owners: linkedParcelOwners } },
        storageMode: health.storageMode,
      });
    } catch (err: any) {
      console.error('[DOCUMENTS] DB fetch error:', err.message);
      return res.status(503).json({
        success: false,
        error: { code: 'DOCUMENT_READ_FAILED', message: 'The document could not be read from the database.' },
      });
    }
  }

  const doc = memoryStore.documents.get(id);
  if (!doc) {
    return res.status(404).json({
      success: false,
      error: { code: 'DOCUMENT_NOT_FOUND', message: `Document ${id} not found in repository.` },
    });
  }

  return res.json({ success: true, data: { document: doc }, storageMode: health.storageMode });
});

// POST /api/documents - Register document metadata, OCR text, and cryptographic hash
// POST /api/documents/:id/link — attach an existing document to a parcel, or detach it with null.
//
// The UI's "link this record to that parcel" action used to change browser state only, so the
// database kept land_documents.parcel_id NULL and the link disappeared on reload. It is a real write
// now: it needs authority over the document and over the parcel, and it lands in the same
// transaction as its audit entry.
documentsRouter.post(
  '/:id/link',
  authenticateToken,
  denyReadOnly,
  requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body ?? {};
    const parcelId = body.parcelId === null || body.parcelId === '' ? null : String(body.parcelId ?? '').trim();
    const principal = req.principal!;

    if (body.parcelId === undefined) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARCEL_ID', message: 'Send parcelId to link a document, or parcelId: null to detach it.' },
      });
    }

    let document: any = null;
    try {
      if (getDbHealth().storageMode === 'postgres-postgis') {
        const found = await tenantQuery(principal, 'SELECT * FROM land_documents WHERE id = $1', [id]);
        if (found.rows.length === 0) return notFoundDocument(res, id);
        document = mapDocumentRow(found.rows[0]);
      } else {
        const memoryDoc = memoryStore.documents.get(id);
        if (!memoryDoc) return notFoundDocument(res, id);
        // The fixtures are the development environment's own records, so they are its tenant's.
        document = { ...memoryDoc, organizationId: DEV_TENANT_ORGANIZATION };
      }

      await assertDocumentWritable(principal, document);
      if (parcelId) await assertParcelWritable(principal, parcelId);
    } catch (err) {
      const tenantRefusal = authorizationErrorResponse(err);
      if (tenantRefusal) return res.status(tenantRefusal.status).json(tenantRefusal.body);
      if (err instanceof OutOfJurisdiction) return notFoundDocument(res, id);
      const refusal = districtRefusal(err);
      if (refusal) return res.status(400).json({ success: false, error: refusal });
      console.error('[DOCUMENTS] link authorization could not be verified:', err.message);
      return res.status(503).json({
        success: false,
        error: { code: 'DOCUMENT_WRITE_FAILED', message: 'The link was not recorded. No change was committed.' },
      });
    }

    try {
      const result = await setDocumentParcelLink({ documentId: id, parcelId, principal });
      return res.json({
        success: true,
        data: result,
        message: parcelId ? `Document ${id} linked to parcel ${parcelId}.` : `Document ${id} detached from its parcel.`,
        storageMode: result.storageMode,
      });
    } catch (err: any) {
      console.error('[DOCUMENTS] link failed:', err.message);
      const refusal = districtRefusal(err);
      if (refusal) return res.status(400).json({ success: false, error: refusal });
      const status = err?.code === 'NOT_FOUND' ? 404 : 503;
      return res.status(status).json({
        success: false,
        error: { code: err?.code || 'DOCUMENT_WRITE_FAILED', message: 'The link was not recorded. No change was committed.' },
      });
    }
  }
);

documentsRouter.post(
  '/',
  authenticateToken,
  denyReadOnly,
  requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'),
  async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const id = body.id || `doc-${Date.now()}`;
    const officer = req.principal!;

    const rawOcrText = body.rawOcrText || body.ocrText || '';

    // Attaching a document to another district's parcel is the easiest cross-jurisdiction write
    // left, because the parcel link is what later grants read access to the record. This is the
    // WRITE side of the check: a STATE_WIDE_READ holder is refused here exactly as any officer
    // outside the parcel's district is.
    try {
      if (body.parcelId) await assertParcelWritable(officer, body.parcelId);
      if (body.district) assertWritableDistrict(officer, body.district);
    } catch (err) {
      if (err instanceof OutOfJurisdiction) {
        return res.status(404).json({
          success: false,
          error: { code: 'PARCEL_NOT_FOUND', message: `Land parcel ${body.parcelId} was not found in the spatial registry.` },
        });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'DISTRICT_OUT_OF_JURISDICTION', message: 'Documents can only be registered in your own district.' },
      });
    }

    // Every document is filed under a district. A row with neither a district nor a parcel is
    // unreachable — assertDocumentReadable denies it to every officer, including the one who created
    // it — so the district is resolved from the attached parcel, then from the uploader's live
    // assignments, at write time rather than left null for a reader to discover.
    const filedDistrict =
      (typeof body.district === 'string' && body.district.trim()) ||
      (body.parcelId ? await parcelDistrict(officer, body.parcelId) : null) ||
      officer.primaryDistrict ||
      officer.districts[0] ||
      null;

    const newDoc = {
      id,
      parcelId: body.parcelId || null,
      documentCode: body.documentCode || `DOC-${Date.now().toString().slice(-6)}`,
      fileName: body.fileName || 'Scanned_Record.pdf',
      recordType: body.recordType || 'Jamabandi (RoR - Record of Rights)',
      ocrLanguage: body.ocrLanguage || 'hin+eng',
      rawOcrText,
      district: filedDistrict,
      tehsil: body.tehsil,
      village: body.village,
      patwarCircle: body.patwarCircle,
      status: body.status || 'Uploaded',
      priority: body.priority || 'Medium',
      imageUri: body.imageUri || '',
      qualityMetrics: body.qualityMetrics || {},
      extractedData: body.extractedData || body.data || {},
      // Hashed from the text actually stored, not from whatever the caller asserted.
      documentHash: sha256(`${id}:${rawOcrText}:${body.imageUri || ''}`),
      ocrConfidence: typeof body.ocrConfidence === 'number' ? body.ocrConfidence : 0,
      uploadedBy: officer.displayName,
      uploadedAt: new Date().toISOString(),
    };

    const health = getDbHealth();

    if (health.storageMode === 'postgres-postgis') {
      let client: PoolClient | null = null;
      try {
        client = await beginTenantTransaction(officer);
        // The upload's owner is the uploading officer's organization, taken from the principal the
        // server built from the database — never from the request body. Attribution columns are
        // mandatory: migration 0006's CHECK refuses a row that claims an owner without them.
        await client.query(
          `INSERT INTO land_documents (
            id, parcel_id, document_code, file_name, record_type, ocr_language, raw_ocr_text,
            district, tehsil, village, patwar_circle, status, priority, image_uri,
            quality_metrics, extracted_data, document_hash, ocr_confidence, uploaded_by, uploaded_at,
            organization_id, organization_granted_by, organization_grant_reason, organization_granted_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20::timestamptz,
            $21, $22, $23, NOW())
          ON CONFLICT (id) DO UPDATE SET
            raw_ocr_text = EXCLUDED.raw_ocr_text,
            extracted_data = EXCLUDED.extracted_data,
            document_hash = EXCLUDED.document_hash,
            ocr_confidence = EXCLUDED.ocr_confidence,
            status = EXCLUDED.status`,
          [
            newDoc.id, newDoc.parcelId, newDoc.documentCode, newDoc.fileName, newDoc.recordType,
            newDoc.ocrLanguage, newDoc.rawOcrText, newDoc.district, newDoc.tehsil, newDoc.village,
            newDoc.patwarCircle, newDoc.status, newDoc.priority, newDoc.imageUri,
            JSON.stringify(newDoc.qualityMetrics), JSON.stringify(newDoc.extractedData),
            newDoc.documentHash, newDoc.ocrConfidence, newDoc.uploadedBy, newDoc.uploadedAt,
            officer.organizationId, `officer:${officer.email}`,
            `Uploaded through the API by ${officer.displayName} (${officer.badgeNumber}).`,
          ]
        );

        if (newDoc.parcelId) {
          const parcel = await client.query('SELECT id FROM parcels WHERE id = $1 FOR UPDATE', [newDoc.parcelId]);
          if (parcel.rows.length > 0) {
            await client.query(
              `UPDATE parcels SET document_id = $2, document_name = $3, document_type = $4, document_uploaded_at = $5::timestamptz, updated_at = NOW() WHERE id = $1`,
              [newDoc.parcelId, newDoc.id, newDoc.fileName, newDoc.recordType, newDoc.uploadedAt]
            );
          }
        }

        await recordAuditLog(
          {
            parcelId: newDoc.parcelId,
            documentId: id,
            entityType: 'DOCUMENT',
            entityId: id,
            actionType: 'DOCUMENT_REGISTERED',
            performedBy: officer.displayName,
            officerBadge: officer.badgeNumber,
            createdAt: newDoc.uploadedAt,
            details: {
              fileName: newDoc.fileName,
              recordType: newDoc.recordType,
              documentHash: newDoc.documentHash,
              ocrConfidence: newDoc.ocrConfidence,
            },
          },
          client
        );

        await client.query('COMMIT');
      } catch (err: any) {
        await client?.query('ROLLBACK').catch(() => {});
        console.error('[DOCUMENTS] register failed:', err.message);
        const refusal = districtRefusal(err);
        if (refusal) {
          return res.status(400).json({ success: false, error: refusal });
        }
        return res.status(503).json({
          success: false,
          error: { code: 'DOCUMENT_WRITE_FAILED', message: 'The document was not stored. No change was committed.' },
        });
      } finally {
        client?.release();
      }

      return res.status(201).json({
        success: true,
        data: { document: newDoc },
        storageMode: health.storageMode,
        message: `Document ${id} registered and hashed in controlled storage.`,
      });
    }

    memoryStore.documents.set(id, newDoc);

    if (newDoc.parcelId) {
      const parcel = memoryStore.parcels.get(newDoc.parcelId);
      if (parcel) {
        parcel.documentId = id;
        parcel.documentName = newDoc.fileName;
        parcel.documentType = newDoc.recordType;
        memoryStore.parcels.set(newDoc.parcelId, parcel);
      }
    }

    await recordAuditLog({
      parcelId: newDoc.parcelId,
      documentId: id,
      entityType: 'DOCUMENT',
      entityId: id,
      actionType: 'DOCUMENT_REGISTERED',
      performedBy: officer.displayName,
      officerBadge: officer.badgeNumber,
      createdAt: newDoc.uploadedAt,
      details: {
        fileName: newDoc.fileName,
        recordType: newDoc.recordType,
        documentHash: newDoc.documentHash,
        ocrConfidence: newDoc.ocrConfidence,
      },
    });

    return res.status(201).json({
      success: true,
      data: { document: newDoc },
      storageMode: health.storageMode,
      message: `Document ${id} registered and hashed in controlled storage.`,
    });
  }
);
