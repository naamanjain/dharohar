import { Router, Request, Response, NextFunction } from 'express';
import { PoolClient } from 'pg';
import { pool, getDbHealth, memoryStore } from '../db/db';
import { beginTenantTransaction, tenantQuery } from '../db/tenant';
import { authenticateToken, denyReadOnly, requireRole } from '../middleware/auth';
import { validateParcel, calculateGeodesicAreaHectares } from '../services/validationService';
import { recordAuditLog, getAuditLogs } from '../services/auditService';
import {
  SealRejected,
  fetchFieldInspections,
  linkDocument,
  mapDocumentRow,
  normaliseOwner,
  recordFieldInspection,
  rehomeParcel,
  sealParcel,
} from '../services/parcelService';
import {
  OutOfJurisdiction,
  TenantContextMissing,
  assertDocumentReadable,
  assertParcelReadable,
  assertParcelWritable,
  assertWritableDistrict,
  authorizationErrorResponse,
  districtRefusal,
  intersectReadScope,
  logStateWideRead,
  mayRehomeParcels,
  parcelScopeClause,
  readScope,
  writeScope,
} from '../services/jurisdiction';
import { sha256 } from '../utils/crypto';

export const parcelsRouter = Router();

const normaliseDistrict = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** Same body for "does not exist" and "exists in another district" — 403 would confirm the id. */
function notFound(res: Response, id: string) {
  return res.status(404).json({
    success: false,
    error: {
      code: 'PARCEL_NOT_FOUND',
      message: `Land parcel ${id} was not found in the spatial registry.`,
    },
  });
}

function scopeFailure(res: Response, err: any, id: string, what: string) {
  // A caller with no organization is told so; a record in someone else's tenant is not. The first is
  // a configuration an administrator can fix, the second must stay indistinguishable from absence.
  const tenantRefusal = authorizationErrorResponse(err);
  if (tenantRefusal) return res.status(tenantRefusal.status).json(tenantRefusal.body);
  if (err instanceof OutOfJurisdiction) return notFound(res, id);
  console.error(`[PARCELS] ${what} check failed:`, err.message);
  return res.status(503).json({
    success: false,
    error: { code: 'PARCEL_READ_FAILED', message: 'Authorization could not be verified. No data was returned.' },
  });
}

/**
 * Guards every read of /:id. Applied as middleware rather than inline checks so that a route added
 * later cannot forget one — an omission in this class of control is invisible until it is exploited.
 * A STATE_WIDE_READ holder passes here by design.
 */
async function requireParcelRead(req: Request, res: Response, next: NextFunction) {
  try {
    await assertParcelReadable(req.principal!, req.params.id);
    next();
  } catch (err) {
    return scopeFailure(res, err, req.params.id, 'read scope');
  }
}

/**
 * Guards every mutation of /:id. Deliberately stricter than requireParcelRead: cross-district read
 * capability never becomes a write right, so an officer may only change records in districts they
 * are actually assigned to.
 */
async function requireParcelWrite(req: Request, res: Response, next: NextFunction) {
  try {
    await assertParcelWritable(req.principal!, req.params.id);
    next();
  } catch (err) {
    return scopeFailure(res, err, req.params.id, 'write scope');
  }
}

/**
 * Columns a PATCH may write. Verification fields are deliberately absent: a seal is applied by
 * POST /:id/verify after server-side preconditions, never by patching the row.
 *
 * `district` is deliberately absent too. It is the jurisdiction boundary, so editing it as an
 * ordinary field would let one officer move a record out of (or into) a district with a routine
 * attribute update — an authorization escape and a self-inflicted "record vanished from my own
 * registry". Re-districting is a controlled, reason-bearing operation: POST /:id/jurisdiction.
 */
const PATCHABLE_COLUMNS: Record<string, string> = {
  khasraNo: 'khasra_no',
  khataNo: 'khata_no',
  khewatNo: 'khewat_no',
  patwarCircle: 'patwar_circle',
  tehsil: 'tehsil',
  village: 'village',
  mappedAreaHectares: 'mapped_area_ha',
  recordedAreaHectares: 'recorded_area_ha',
  colour: 'colour',
  ownerName: 'owner_name',
  landType: 'land_type',
  inheritance: 'inheritance',
  documentId: 'document_id',
  documentName: 'document_name',
  documentType: 'document_type',
  documentUploadedAt: 'document_uploaded_at',
  documentDisplayId: 'document_display_id',
  documentUri: 'document_uri',
  ulpinStatus: 'ulpin_status',
  // Validated against WORKFLOW_STATUSES below, which deliberately excludes 'Verified'.
  // Omitting it here made PATCH answer 200 while silently never writing the status.
  status: 'status',
};

const WORKFLOW_STATUSES = [
  'Draft',
  'Mapped',
  'Uploaded',
  'Needs Field Verification',
  'Needs Review',
  'Pending Verification',
  'Extraction Ready',
  'Archived',
];

function mapParcelRow(row: any) {
  let boundary: Array<{ lat: number; lng: number }> = [];
  if (row.geojson) {
    try {
      const parsed = JSON.parse(row.geojson);
      if (parsed.coordinates && parsed.coordinates[0]) {
        boundary = parsed.coordinates[0].map((coord: [number, number]) => ({
          lng: coord[0],
          lat: coord[1],
        }));
      }
    } catch {}
  }

  return {
    id: row.id,
    khasraNo: row.khasra_no,
    khataNo: row.khata_no,
    khewatNo: row.khewat_no,
    patwarCircle: row.patwar_circle,
    district: row.district,
    tehsil: row.tehsil,
    village: row.village,
    mappedAreaHectares: Number(row.mapped_area_ha),
    recordedAreaHectares: row.recorded_area_ha ? Number(row.recorded_area_ha) : undefined,
    colour: row.colour,
    ownerName: row.owner_name,
    owners: (row.owners || []).map(normaliseOwner),
    mutationHistory: row.mutations || [],
    boundary,
    landType: row.land_type,
    inheritance: row.inheritance,
    documentId: row.document_id,
    documentName: row.document_name,
    documentType: row.document_type,
    documentUploadedAt: row.document_uploaded_at,
    documentDisplayId: row.document_display_id,
    documentUri: row.document_uri,
    status: row.status,
    ulpinStatus: row.ulpin_status || 'Pending Government Linkage',
    isArchived: row.is_archived,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    verificationNotes: row.verification_notes,
    certificateNumber: row.certificate_number,
    sealSignature: row.seal_signature,
    createdAt: row.created_at,
  };
}

function respondWriteError(res: Response, err: any, what: string, parcelId = '') {
  const tenantRefusal = authorizationErrorResponse(err);
  if (tenantRefusal) return res.status(tenantRefusal.status).json(tenantRefusal.body);
  if (err instanceof OutOfJurisdiction) {
    return notFound(res, parcelId);
  }
  if (err instanceof SealRejected) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'VERIFICATION_PRECONDITIONS_FAILED' ? 422 : 409;
    return res.status(status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Two parcels cannot share (khasra, village, tehsil) inside one district, and that includes moving a
  // parcel into a district where the identity is already taken. The database refuses it with 23505;
  // reporting that as 503 PARCEL_WRITE_FAILED tells the caller the dependency is unavailable and to
  // retry the same request forever. It is a conflict, and it is named as one.
  if (err?.code === '23505' && /uq_parcels_identity/.test(String(err?.constraint ?? ''))) {
    return res.status(409).json({
      success: false,
      error: {
        code: 'PARCEL_IDENTITY_TAKEN',
        message: 'Another parcel already carries this khasra number, village and tehsil in that district. No change was committed.',
      },
    });
  }

  const refusal = districtRefusal(err);
  if (refusal) {
    return res.status(400).json({ success: false, error: refusal });
  }

  console.error(`[PARCELS] ${what} failed:`, err.message);
  return res.status(503).json({
    success: false,
    error: {
      code: 'PARCEL_WRITE_FAILED',
      message: `The parcel ${what} could not be recorded. No change was committed.`,
    },
  });
}

/**
 * Parcel rows carry a mutationHistory array in the API contract, but the parcel_mutations table
 * was never read by anything, so views crashed on `mutationHistory.length` once parcels came
 * from PostgreSQL instead of the mock fixtures. The scalar subquery keeps owners aggregation
 * free of a cartesian join.
 */
const PARCEL_SELECT = `SELECT p.*, ST_AsGeoJSON(p.geom) as geojson,
            COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '[]') as owners,
            (SELECT COALESCE(json_agg(json_build_object(
                       'date', m.mutation_date, 'type', m.mutation_type, 'note', m.note
                     ) ORDER BY m.id), '[]'::json)
               FROM parcel_mutations m WHERE m.parcel_id = p.id) as mutations
           FROM parcels p
           LEFT JOIN parcel_owners o ON p.id = o.parcel_id`;

// GET /api/parcels - List parcels with optional search and GIS validation filtering
parcelsRouter.get('/', authenticateToken, async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === 'true';
  const search = (req.query.search as string || '').toLowerCase().trim();
  const statusFilter = req.query.status as string;
  const filterType = req.query.filter as string; // 'all' | 'discrepancy' | 'verified' | 'needs_verification' | 'missing_data' | 'ownership_issue'
  const district = req.query.district as string;
  const village = req.query.village as string;

  const health = getDbHealth();

  let parcelsList: any[] = [];

  if (health.storageMode === 'postgres-postgis') {
    try {
      // A caller with no organization cannot be tenant-scoped, and an empty 200 would look like an
      // empty register rather than like a misconfiguration. Say which it is, before querying.
      if (!req.principal!.organizationId) {
        return res.status(403).json(authorizationErrorResponse(new TenantContextMissing())!.body);
      }
      // Scoping happens in SQL, not after fetching: filtering the array afterwards would still
      // read every district's rows out of the database on each request.
      const scope = parcelScopeClause(req.principal!, 'p', 1);
      const whereParts: string[] = [];
      const queryParams: any[] = [];

      if (scope.sql) {
        whereParts.push(scope.sql.trim().replace(/^AND /, ''));
        queryParams.push(...scope.params);
      }
      if (!includeArchived) whereParts.push('p.is_archived = FALSE');

      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
      const query = `${PARCEL_SELECT}
           ${where}
           GROUP BY p.id
           ORDER BY p.created_at DESC`;

      const result = await tenantQuery(req.principal!, query, queryParams);
      parcelsList = result.rows.map(mapParcelRow);
    } catch (err: any) {
      console.error('[PARCELS] PostgreSQL fetch error:', err.message);
      return res.status(503).json({
        success: false,
        error: {
          code: 'PARCEL_READ_FAILED',
          message: 'The parcel registry could not be read from the database. Demo records were not substituted.',
        },
      });
    }
  } else {
    const scope = readScope(req.principal!);
    parcelsList = Array.from(memoryStore.parcels.values())
      .filter((p) => includeArchived || !p.isArchived)
      .filter((p) => scope === null || scope.includes(normaliseDistrict(p.district)))
      .map((p) => ({ ...p, owners: (memoryStore.owners.get(p.id) || p.owners || []).map(normaliseOwner) }));
  }

  // Apply search query filter
  if (search) {
    parcelsList = parcelsList.filter((p) =>
      p.id.toLowerCase().includes(search) ||
      (p.khasraNo && p.khasraNo.toLowerCase().includes(search)) ||
      (p.khataNo && p.khataNo.toLowerCase().includes(search)) ||
      (p.ownerName && p.ownerName.toLowerCase().includes(search)) ||
      (p.village && p.village.toLowerCase().includes(search)) ||
      (p.district && p.district.toLowerCase().includes(search))
    );
  }

  // Apply status or special category filters
  if (statusFilter) {
    parcelsList = parcelsList.filter((p) => p.status === statusFilter);
  }

  if (filterType === 'discrepancy') {
    parcelsList = parcelsList.filter((p) => {
      const mapped = Number(p.mappedAreaHectares || 0);
      const recorded = Number(p.recordedAreaHectares || mapped);
      const delta = Math.abs(recorded - mapped);
      return delta > 0.02 || p.status === 'Needs Field Verification' || p.status === 'Needs Review';
    });
  } else if (filterType === 'verified') {
    parcelsList = parcelsList.filter((p) => p.status === 'Verified');
  } else if (filterType === 'needs_verification') {
    parcelsList = parcelsList.filter((p) => p.status === 'Needs Field Verification');
  } else if (filterType === 'ownership_issue') {
    parcelsList = parcelsList.filter((p) => {
      const owners = p.owners || [];
      const total = owners.reduce((acc: number, o: any) => acc + (Number(o.sharePercentage) || 0), 0);
      return Math.abs(total - 100.0) > 0.01;
    });
  }

  // A caller-supplied district may narrow the result set, never widen it. An officer with no
  // assignment for the requested district gets an empty list rather than the other district's rows.
  if (district) {
    const effective = intersectReadScope(req.principal!, district);
    if (effective !== null && effective.length === 0) {
      parcelsList = [];
    } else {
      const requested = normaliseDistrict(district);
      parcelsList = parcelsList.filter((p) => normaliseDistrict(p.district) === requested);
    }
  }
  if (village) {
    parcelsList = parcelsList.filter((p) => p.village?.toLowerCase() === village.toLowerCase());
  }

  // Design default D3: state-wide access is logged whenever it is exercised. scope === null is the
  // only way a caller sees records from districts they hold no assignment for.
  if (readScope(req.principal!) === null) {
    await logStateWideRead(req.principal!, 'parcel-registry-list', { records: parcelsList.length });
  }

  return res.json({
    success: true,
    data: {
      total: parcelsList.length,
      parcels: parcelsList,
    },
    storageMode: health.storageMode,
  });
});

// GET /api/parcels/:id - Get single parcel with related records
parcelsRouter.get('/:id', authenticateToken, requireParcelRead, async (req: Request, res: Response) => {
  const { id } = req.params;
  const health = getDbHealth();

  let parcel: any = null;
  let owners: any[] = [];
  let inspections: any[] = [];
  let auditHistory: any[] = [];

  if (health.storageMode === 'postgres-postgis') {
    try {
      const result = await tenantQuery(req.principal!,
        `${PARCEL_SELECT}
         WHERE p.id = $1
         GROUP BY p.id`,
        [id]
      );

      if (result.rows.length > 0) {
        parcel = mapParcelRow(result.rows[0]);
        owners = parcel.owners;
      }
    } catch (err: any) {
      console.error('[PARCELS] DB fetch single parcel error:', err.message);
      return res.status(503).json({
        success: false,
        error: { code: 'PARCEL_READ_FAILED', message: 'The parcel could not be read from the database.' },
      });
    }
  } else {
    parcel = memoryStore.parcels.get(id);
    if (parcel) {
      owners = (memoryStore.owners.get(id) || parcel.owners || []).map(normaliseOwner);
      parcel = { ...parcel, owners };
    }
  }

  if (!parcel) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'PARCEL_NOT_FOUND',
        message: `Land parcel ${id} was not found in the spatial registry.`,
      },
    });
  }

  try {
    inspections = await fetchFieldInspections(id, req.principal!);
  } catch (err: any) {
    console.error('[PARCELS] inspection read failed:', err.message);
    inspections = [];
  }
  auditHistory = await getAuditLogs({ parcelId: id, principal: req.principal! });

  return res.json({
    success: true,
    data: {
      parcel: {
        ...parcel,
        inspections,
        auditHistory,
      },
    },
    storageMode: health.storageMode,
  });
});

// POST /api/parcels - Create new parcel polygon record
parcelsRouter.post(
  '/',
  authenticateToken,
  requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'),
  async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.boundary || !Array.isArray(body.boundary) || body.boundary.length < 3) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_BOUNDARY',
        message: 'A valid polygon boundary with at least 3 coordinate vertices is required.',
      },
    });
  }

  const officer = req.principal!;
  const performer = officer.displayName;
  const badge = officer.badgeNumber;

  const district = body.district || officer.primaryDistrict || officer.districts[0] || '';

  // Without this, creating a parcel with district='Jodhpur' while signed in to Jaipur would
  // place a record outside the caller's own jurisdiction, defeating every read-side rule.
  try {
    assertWritableDistrict(officer, district);
  } catch {
    return res.status(400).json({
      success: false,
      error: {
        code: 'DISTRICT_OUT_OF_JURISDICTION',
        message: 'Parcels can only be registered in your own district.',
      },
    });
  }
  const village = body.village || 'Rampur';
  const districtCode = district.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'RJ';
  const villageCode = village.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'LAN';
  const id = body.id || `DH-${districtCode}-${villageCode}-${String(Date.now()).slice(-6)}`;

  const mappedAreaHectares = body.mappedAreaHectares ?? calculateGeodesicAreaHectares(body.boundary);
  const recordedAreaHectares = body.recordedAreaHectares ? Number(body.recordedAreaHectares) : undefined;
  const owners = Array.isArray(body.owners) && body.owners.length > 0 ? body.owners : [
    {
      id: `own-${Date.now()}`,
      name: body.ownerName || 'Unassigned',
      hindiName: body.ownerName || 'अनियत',
      relationType: 's/o',
      relativeName: 'Not recorded',
      relativeHindiName: 'उपलब्ध नहीं',
      shareFraction: '1/1',
      sharePercentage: 100.0,
      status: 'Active Co-sharer',
    }
  ];

  const newParcel = {
    id,
    khasraNo: body.khasraNo || '—',
    khataNo: body.khataNo || '—',
    khewatNo: body.khewatNo || '—',
    patwarCircle: body.patwarCircle || '—',
    district,
    tehsil: body.tehsil || 'Sanganer',
    village,
    mappedAreaHectares,
    recordedAreaHectares,
    colour: body.colour || '#2563eb',
    ownerName: owners[0]?.name || 'Unassigned',
    owners,
    boundary: body.boundary,
    landType: body.landType || 'Agricultural',
    inheritance: body.inheritance || 'Not recorded',
    mutationHistory: body.mutationHistory || [],
    documentId: body.documentId,
    documentName: body.documentName,
    documentType: body.documentType,
    documentUploadedAt: body.documentUploadedAt,
    documentDisplayId: body.documentDisplayId,
    documentUri: body.documentUri,
    status: WORKFLOW_STATUSES.includes(body.status) ? body.status : 'Draft',
    ulpinStatus: 'Pending Government Linkage',
    isArchived: false,
    createdAt: new Date().toISOString(),
  };

  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    try {
      client = await beginTenantTransaction(officer);

      const clash = await client.query('SELECT id FROM parcels WHERE id = $1', [id]);
      if (clash.rows.length > 0) {
        throw new SealRejected('DUPLICATE_PARCEL_ID', `Parcel ${id} already exists.`);
      }

      const ring = [...newParcel.boundary, newParcel.boundary[0]]
        .map((pt: any) => `${pt.lng} ${pt.lat}`)
        .join(', ');
      const wkt = `POLYGON((${ring}))`;

      await client.query(
        `INSERT INTO parcels (
          id, khasra_no, khata_no, khewat_no, patwar_circle, district, tehsil, village,
          mapped_area_ha, recorded_area_ha, colour, owner_name, land_type,
          inheritance, document_id, document_name, document_type, document_uploaded_at,
          document_display_id, document_uri, status, ulpin_status, is_archived, geom, created_at,
          organization_id, organization_granted_by, organization_grant_reason, organization_granted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, ST_GeomFromText($24, 4326), $25,
          $26, $27, $28, NOW())`,
        [
          newParcel.id, newParcel.khasraNo, newParcel.khataNo, newParcel.khewatNo,
          newParcel.patwarCircle, newParcel.district, newParcel.tehsil, newParcel.village,
          newParcel.mappedAreaHectares, newParcel.recordedAreaHectares || null,
          newParcel.colour, newParcel.ownerName, newParcel.landType, newParcel.inheritance,
          newParcel.documentId || null, newParcel.documentName || null, newParcel.documentType || null,
          newParcel.documentUploadedAt || null, newParcel.documentDisplayId || null,
          newParcel.documentUri || null, newParcel.status, newParcel.ulpinStatus, false,
          wkt, newParcel.createdAt,
          // assertWritableDistrict already refused a caller with no organization, so this cannot be
          // null. Writing it explicitly is what makes the new row visible to the tenant that made it.
          officer.organizationId, `officer:${officer.email}`,
          `Registered through the API by ${officer.displayName} (${officer.badgeNumber}).`
        ]
      );

      for (const o of newParcel.owners) {
        await client.query(
          `INSERT INTO parcel_owners (
            id, parcel_id, name, hindi_name, relation_type, relative_name,
            relative_hindi_name, share_fraction, share_percentage, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            o.id || `own-${Date.now()}`, newParcel.id, o.name, o.hindiName || o.name,
            o.relationType || 's/o', o.relativeName || 'Not recorded',
            o.relativeHindiName || 'उपलब्ध नहीं', o.shareFraction || '1/1',
            o.sharePercentage || 100, o.status || 'Active Co-sharer'
          ]
        );
      }

      await recordAuditLog(
        {
          parcelId: newParcel.id,
          entityType: 'PARCEL',
          entityId: newParcel.id,
          actionType: 'PARCEL_CREATED',
          performedBy: performer,
          officerBadge: badge,
          createdAt: newParcel.createdAt,
          details: {
            khasraNo: newParcel.khasraNo,
            village: newParcel.village,
            mappedAreaHa: newParcel.mappedAreaHectares,
          },
        },
        client
      );

      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      return respondWriteError(res, err, 'creation');
    } finally {
      client?.release();
    }
  } else {
    memoryStore.parcels.set(newParcel.id, newParcel);
    memoryStore.owners.set(newParcel.id, newParcel.owners);

    await recordAuditLog({
      parcelId: newParcel.id,
      entityType: 'PARCEL',
      entityId: newParcel.id,
      actionType: 'PARCEL_CREATED',
      performedBy: performer,
      officerBadge: badge,
      createdAt: newParcel.createdAt,
      details: {
        khasraNo: newParcel.khasraNo,
        village: newParcel.village,
        mappedAreaHa: newParcel.mappedAreaHectares,
      },
    });
  }

  return res.status(201).json({
    success: true,
    data: { parcel: newParcel },
    storageMode: health.storageMode,
    message: `Land parcel ${newParcel.id} registered successfully in the spatial registry.`,
  });
});

// PATCH & PUT /api/parcels/:id - Update parcel attributes
const updateParcelHandler = async (req: Request, res: Response) => {
  const { id } = req.params;
  const patch = req.body ?? {};
  const officer = req.principal!;
  const performer = officer.displayName;
  const badge = officer.badgeNumber;

  // The prototype copied patch.status / verifiedBy / verifiedAt straight into the row, so any
  // caller could mark their own parcel Verified without a seal. Seals go through /:id/verify.
  const forbidden = ['verifiedBy', 'verifiedAt', 'verificationNotes', 'certificateNumber', 'sealSignature']
    .filter((key) => patch[key] !== undefined);
  if (forbidden.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'SEALED_FIELDS_NOT_PATCHABLE',
        message: `Verification fields cannot be set by patch: ${forbidden.join(', ')}. Use POST /api/parcels/:id/verify.`,
      },
    });
  }

  // Answered explicitly rather than ignored: silently dropping `district` was the defect that made
  // PATCH return 200 for a field it never wrote.
  if (patch.district !== undefined) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'JURISDICTION_CHANGE_REQUIRES_REHOMING',
        message: 'A parcel\'s district is its jurisdiction. Move a record between districts with POST /api/parcels/:id/jurisdiction, which requires authority over both districts and records a reason, a mutation and an audit entry.',
      },
    });
  }

  if (patch.status !== undefined && !WORKFLOW_STATUSES.includes(patch.status)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_STATUS',
        message: `Status must be one of: ${WORKFLOW_STATUSES.join(', ')}. 'Verified' is set only by the seal route.`,
      },
    });
  }

  const changes = Object.keys(PATCHABLE_COLUMNS).filter((key) => patch[key] !== undefined);
  const hasOwners = Array.isArray(patch.owners);
  const hasBoundary = Array.isArray(patch.boundary) && patch.boundary.length >= 3;

  if (changes.length === 0 && !hasOwners && !hasBoundary) {
    return res.status(400).json({
      success: false,
      error: { code: 'EMPTY_PATCH', message: 'No recognised parcel fields were supplied.' },
    });
  }

  const health = getDbHealth();
  let updatedRow: any = null;

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    try {
      client = await beginTenantTransaction(officer);

      const checkRes = await client.query('SELECT * FROM parcels WHERE id = $1 FOR UPDATE', [id]);
      if (checkRes.rows.length === 0) {
        throw new SealRejected('NOT_FOUND', `Parcel ${id} not found.`);
      }

      const sets: string[] = [];
      const values: any[] = [];
      for (const key of changes) {
        values.push(patch[key] === null ? null : patch[key]);
        sets.push(`${PATCHABLE_COLUMNS[key]} = $${values.length}`);
      }
      if (hasBoundary) {
        const ring = [...patch.boundary, patch.boundary[0]]
          .map((pt: any) => `${pt.lng} ${pt.lat}`)
          .join(', ');
        values.push(`POLYGON((${ring}))`);
        sets.push(`geom = ST_GeomFromText($${values.length}, 4326)`);
      }

      if (sets.length > 0) {
        sets.push('updated_at = NOW()');
        values.push(id);
        await client.query(`UPDATE parcels SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
      }

      if (hasOwners) {
        await client.query('DELETE FROM parcel_owners WHERE parcel_id = $1', [id]);
        for (const o of patch.owners) {
          await client.query(
            `INSERT INTO parcel_owners (
              id, parcel_id, name, hindi_name, relation_type, relative_name,
              relative_hindi_name, share_fraction, share_percentage, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              o.id || `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              id, o.name, o.hindiName || o.name, o.relationType || 's/o',
              o.relativeName || 'Not recorded', o.relativeHindiName || 'उपलब्ध नहीं',
              o.shareFraction || '1/1', o.sharePercentage ?? 100, o.status || 'Active Co-sharer'
            ]
          );
        }
      }

      const after = await client.query(
        `${PARCEL_SELECT}
         WHERE p.id = $1
         GROUP BY p.id`,
        [id]
      );
      updatedRow = mapParcelRow(after.rows[0]);

      await recordAuditLog(
        {
          parcelId: id,
          entityType: 'PARCEL',
          entityId: id,
          actionType: 'PARCEL_UPDATED',
          performedBy: performer,
          officerBadge: badge,
          details: {
            changedFields: changes.concat(hasOwners ? ['owners'] : []).concat(hasBoundary ? ['boundary'] : []),
            patch: changes.reduce((acc: Record<string, any>, key) => ({ ...acc, [key]: patch[key] }), {}),
          },
        },
        client
      );

      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      return respondWriteError(res, err, 'update', id);
    } finally {
      client?.release();
    }
  } else {
    const existing = memoryStore.parcels.get(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Parcel ${id} not found.` },
      });
    }

    const updated = { ...existing, ...Object.fromEntries(changes.map((key) => [key, patch[key]])) };
    if (hasBoundary) updated.boundary = patch.boundary;
    updated.id = id;
    updated.updatedAt = new Date().toISOString();

    memoryStore.parcels.set(id, updated);
    if (hasOwners) memoryStore.owners.set(id, patch.owners);
    updatedRow = { ...updated, owners: hasOwners ? patch.owners : memoryStore.owners.get(id) || updated.owners || [] };

    await recordAuditLog({
      parcelId: id,
      entityType: 'PARCEL',
      entityId: id,
      actionType: 'PARCEL_UPDATED',
      performedBy: performer,
      officerBadge: badge,
      details: {
        changedFields: changes.concat(hasOwners ? ['owners'] : []).concat(hasBoundary ? ['boundary'] : []),
        patch: changes.reduce((acc: Record<string, any>, key) => ({ ...acc, [key]: patch[key] }), {}),
      },
    });
  }

  return res.json({
    success: true,
    data: { parcel: updatedRow },
    storageMode: health.storageMode,
    message: `Parcel ${id} updated successfully.`,
  });
};

// Middleware order is deliberate: authenticate, then role, then jurisdiction. A caller whose role
// may not perform the action is refused with 403 regardless of which record they named, so the
// answer does not depend on data they cannot see. Jurisdiction is checked afterwards and answers
// 404, which reveals nothing about foreign records either.
parcelsRouter.patch('/:id', authenticateToken, denyReadOnly, requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'), requireParcelWrite, updateParcelHandler);
parcelsRouter.put('/:id', authenticateToken, denyReadOnly, requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'), requireParcelWrite, updateParcelHandler);

// POST /api/parcels/:id/validate - Server-authoritative validation endpoint
parcelsRouter.post('/:id/validate', authenticateToken, denyReadOnly, requireParcelWrite, async (req: Request, res: Response) => {
  const { id } = req.params;
  const validator = req.principal!.displayName;

  try {
    const result = await validateParcel(id, req.principal!, validator);

    await recordAuditLog({
      parcelId: id,
      entityType: 'PARCEL',
      entityId: id,
      actionType: 'VALIDATION_EXECUTED',
      performedBy: validator,
      officerBadge: req.user?.badgeNumber || 'SYS-VAL-01',
      details: {
        isValid: result.isValid,
        canBeVerified: result.canBeVerified,
        hasDiscrepancy: result.areaValidation.hasDiscrepancy,
        differenceHa: result.areaValidation.differenceHa,
        totalSharePercentage: result.ownershipValidation.totalSharePercentage,
      },
    });

    return res.json({
      success: true,
      data: result,
      message: `Validation completed for parcel ${id}.`,
    });
  } catch (err: any) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: err.message || 'Parcel validation failed.',
      },
    });
  }
});

// GET /api/parcels/:id/documents - Get documents associated with a parcel
parcelsRouter.get('/:id/documents', authenticateToken, requireParcelRead, async (req: Request, res: Response) => {
  const { id } = req.params;
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    try {
      const result = await tenantQuery(req.principal!,
        'SELECT * FROM land_documents WHERE parcel_id = $1 ORDER BY uploaded_at DESC',
        [id]
      );
      // Mapped, not passed through: this endpoint used to answer with raw `SELECT *` rows while the
      // same route in dev-fallback mode answered with camelCase objects, so the shape of a document
      // depended on which storage mode the server happened to be in.
      return res.json({ success: true, data: { documents: result.rows.map(mapDocumentRow) }, storageMode: health.storageMode });
    } catch (err: any) {
      console.error('[DOCS] Error querying PostgreSQL:', err.message);
      return res.status(503).json({
        success: false,
        error: { code: 'DOCUMENT_READ_FAILED', message: 'Documents could not be read from the database.' },
      });
    }
  }

  const docs = Array.from(memoryStore.documents.values()).filter((d) => d.parcelId === id);
  return res.json({ success: true, data: { documents: docs }, storageMode: health.storageMode });
});

// POST /api/parcels/:id/documents - Link document to parcel
parcelsRouter.post(
  '/:id/documents',
  authenticateToken,
  denyReadOnly,
  requireRole('TEHSILDAR', 'PATWARI', 'DATA_ENTRY_OPERATOR'),
  requireParcelWrite,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body ?? {};
    const docId = body.documentId || `doc-${Date.now()}`;
    const officer = req.principal!;

    // A client-supplied hash is only a claim about the bytes it names; the prototype also hashed
    // the file *name* when no hash was sent, which deduplicates nothing and proves nothing.
    if (body.documentHash && typeof body.documentHash !== 'string') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_DOCUMENT_HASH', message: 'documentHash must be a string.' },
      });
    }

    const doc = {
      id: docId,
      documentCode: body.documentCode || `DOC-${Date.now().toString().slice(-6)}`,
      fileName: body.fileName || 'Scanned_Land_Record.pdf',
      recordType: body.recordType || 'Jamabandi (RoR - Record of Rights)',
      ocrLanguage: body.ocrLanguage || 'hin+eng',
      rawOcrText: body.rawOcrText || '',
      extractedData: body.extractedData || {},
      documentHash: body.documentHash || sha256(`${docId}:${body.rawOcrText || ''}:${body.imageUri || ''}`),
      status: body.status || 'Uploaded',
      priority: body.priority || 'Medium',
      imageUri: body.imageUri,
      qualityMetrics: body.qualityMetrics,
      district: body.district,
      tehsil: body.tehsil,
      village: body.village,
      patwarCircle: body.patwarCircle,
    };

    try {
      const result = await linkDocument({
        parcelId: id,
        document: doc,
        performedBy: officer.displayName,
        officerBadge: officer.badgeNumber,
        defaultDistrict: officer.primaryDistrict || officer.districts[0],
        principal: officer,
      });

      return res.status(201).json({
        success: true,
        data: { document: { ...doc, district: result.district, parcelId: id } },
        storageMode: result.storageMode,
        message: `Document ${doc.fileName} linked to parcel ${id}.`,
      });
    } catch (err) {
      return respondWriteError(res, err, 'document link', id);
    }
  }
);

// GET /api/parcels/:id/field-inspections - Get field inspections for parcel
parcelsRouter.get('/:id/field-inspections', authenticateToken, requireParcelRead, async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const inspections = await fetchFieldInspections(id, req.principal!);
    return res.json({ success: true, data: { inspections } });
  } catch (err: any) {
    console.error('[INSPECTION] Error reading inspections:', err.message);
    return res.status(503).json({
      success: false,
      error: { code: 'INSPECTION_READ_FAILED', message: 'Field inspections could not be read.' },
    });
  }
});

// POST /api/parcels/:id/field-inspections - Submit assisted GPS/camera field inspection
parcelsRouter.post(
  '/:id/field-inspections',
  authenticateToken,
  denyReadOnly,
  requireRole('PATWARI', 'TEHSILDAR'),
  requireParcelWrite,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const result = await recordFieldInspection({
        parcelId: id,
        officer: req.principal!,
        body: req.body ?? {},
      });

      return res.status(201).json({
        success: true,
        data: { inspection: result.inspection },
        storageMode: result.storageMode,
        message: 'Field inspection submitted and registered in audit trail.',
      });
    } catch (err) {
      return respondWriteError(res, err, 'field inspection', id);
    }
  }
);

// POST /api/parcels/:id/verify - Official Officer Verification & Digital Sealing (TEHSILDAR ONLY)
parcelsRouter.post(
  '/:id/verify',
  authenticateToken,
  requireRole('TEHSILDAR'),
  requireParcelWrite,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body ?? {};

    try {
      const result = await sealParcel({
        parcelId: id,
        officer: req.principal!,
        officerNotes: body.officerNotes,
        forceOverride: Boolean(body.forceOverride),
      });

      return res.json({
        success: true,
        data: {
          certificateNumber: result.certificateNumber,
          signatureHash: result.signatureHash,
          sealedAt: result.sealedAt,
          parcel: result.parcel,
        },
        storageMode: result.storageMode,
        message: 'Land parcel authenticated and sealed by revenue authority.',
      });
    } catch (err) {
      return respondWriteError(res, err, 'seal', id);
    }
  }
);

// GET /api/parcels/:id/audit - Get chronological audit trail for parcel
parcelsRouter.get('/:id/audit', authenticateToken, requireParcelRead, async (req: Request, res: Response) => {
  const { id } = req.params;
  const logs = await getAuditLogs({ parcelId: id, principal: req.principal! });

  return res.json({
    success: true,
    data: {
      total: logs.length,
      auditLogs: logs,
    },
  });
});

// POST /api/parcels/:id/jurisdiction - Controlled re-districting (design default D5)
//
// The only way a parcel's district changes. Ordinary attribute edits cannot do it: PATCH rejects
// `district` outright. Requires the explicit PARCEL_REHOME capability, an active assignment over
// both districts (enforced in the service, against live data), and a reason that ends up in the
// provenance row and the chained audit entry.
parcelsRouter.post(
  '/:id/jurisdiction',
  authenticateToken,
  denyReadOnly,
  requireRole('TEHSILDAR'),
  requireParcelWrite,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body ?? {};
    const toDistrict = typeof body.toDistrict === 'string' ? body.toDistrict.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const principal = req.principal!;

    if (!mayRehomeParcels(principal)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'REHOME_CAPABILITY_REQUIRED',
          message: 'Re-districting requires the PARCEL_REHOME capability, which is granted explicitly and separately from the Tehsildar role.',
        },
      });
    }

    if (!toDistrict) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_DISTRICT', message: 'toDistrict is required.' },
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'REASON_REQUIRED',
          message: 'A re-districting order must state its reason: it is recorded in the parcel\'s mutation history and in the audit chain.',
        },
      });
    }

    try {
      const result = await rehomeParcel({ parcelId: id, toDistrict, reason, principal });
      return res.json({
        success: true,
        data: result,
        message: `Parcel ${id} moved from ${result.fromDistrict} to ${result.toDistrict}. Previous audit entries were not altered.`,
        storageMode: result.storageMode,
      });
    } catch (err) {
      return respondWriteError(res, err, 're-districting', id);
    }
  }
);

// DELETE /api/parcels/:id - Soft-delete / Archive ONLY (No hard delete permitted)
parcelsRouter.delete(
  '/:id',
  authenticateToken,
  requireRole('TEHSILDAR'),
  requireParcelWrite,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const reason = req.body?.reason || (req.query.reason as string) || '';
    const officer = req.principal!;

    if (!reason.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'An archive reason is required for the audit trail.' },
      });
    }

    const archivedAt = new Date().toISOString();
    const health = getDbHealth();

    if (health.storageMode === 'postgres-postgis') {
      let client: PoolClient | null = null;
      try {
        client = await beginTenantTransaction(officer);

        const target = await client.query('SELECT id, status FROM parcels WHERE id = $1 FOR UPDATE', [id]);
        if (target.rows.length === 0) {
          throw new SealRejected('NOT_FOUND', `Parcel ${id} not found.`);
        }

        await client.query(
          `UPDATE parcels SET
            is_archived = TRUE,
            status = 'Archived',
            archived_at = $2::timestamptz,
            archive_reason = $3,
            updated_at = NOW()
           WHERE id = $1`,
          [id, archivedAt, reason]
        );

        await recordAuditLog(
          {
            parcelId: id,
            entityType: 'PARCEL',
            entityId: id,
            actionType: 'PARCEL_ARCHIVED',
            performedBy: officer.displayName,
            officerBadge: officer.badgeNumber,
            createdAt: archivedAt,
            details: { reason, previousStatus: target.rows[0].status },
          },
          client
        );

        await client.query('COMMIT');
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        return respondWriteError(res, err, 'archive', id);
      } finally {
        client?.release();
      }
    } else {
      const parcel = memoryStore.parcels.get(id);
      if (!parcel) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `Parcel ${id} not found.` },
        });
      }

      const previousStatus = parcel.status;
      parcel.isArchived = true;
      parcel.status = 'Archived';
      parcel.archivedAt = archivedAt;
      parcel.archiveReason = reason;
      memoryStore.parcels.set(id, parcel);

      await recordAuditLog({
        parcelId: id,
        entityType: 'PARCEL',
        entityId: id,
        actionType: 'PARCEL_ARCHIVED',
        performedBy: officer.displayName,
        officerBadge: officer.badgeNumber,
        createdAt: archivedAt,
        details: { reason, previousStatus },
      });
    }

    return res.json({
      success: true,
      data: { id, isArchived: true },
      storageMode: health.storageMode,
      message: `Parcel ${id} soft-deleted (archived). Historical state retained in append-only audit trail.`,
    });
  }
);
