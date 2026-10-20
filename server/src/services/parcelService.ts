/**
 * Parcel write-side services.
 *
 * The seal and field-inspection flows existed twice — once RBAC-protected on /api/parcels,
 * once anonymous on /api/verifications — and neither persisted to PostgreSQL. Both routes now
 * call here so there is one authoritative implementation.
 */

import { PoolClient } from 'pg';
import { pool, getDbHealth, memoryStore } from '../db/db';
import { beginTenantTransaction } from '../db/tenant';
import { recordAuditLog } from './auditService';
import { validateParcel } from './validationService';
import { generateCertificateNumber, signSeal } from '../utils/crypto';
import { parcelDistrict, RequestPrincipal } from './jurisdiction';

export interface SealResult {
  certificateNumber: string;
  signatureHash: string;
  sealedAt: string;
  parcel: any;
  storageMode: string;
}

export class SealRejected extends Error {
  constructor(readonly code: string, message: string, readonly details?: any) {
    super(message);
    this.name = 'SealRejected';
  }
}

/**
 * PostgreSQL rows carry snake_case column names while the API contract is camelCase. Owners
 * arrive through `json_agg(o.*)`, so without this the ownership totals read `sharePercentage`
 * off snake_case objects, summed to 0 and every parcel looked under-owned.
 */
export function normaliseOwner(owner: any) {
  if (!owner) return owner;
  return {
    ...owner,
    sharePercentage: owner.sharePercentage ?? (owner.share_percentage !== undefined ? Number(owner.share_percentage) : undefined),
    shareFraction: owner.shareFraction ?? owner.share_fraction,
    relationType: owner.relationType ?? owner.relation_type,
    relativeName: owner.relativeName ?? owner.relative_name,
    relativeHindiName: owner.relativeHindiName ?? owner.relative_hindi_name,
    hindiName: owner.hindiName ?? owner.hindi_name,
  };
}

function sealMaterial(input: {
  parcelId: string;
  officer: RequestPrincipal;
  certificateNumber: string;
  sealedAt: string;
}) {
  return {
    parcelId: input.parcelId,
    officerId: input.officer.userId,
    badge: input.officer.badgeNumber,
    certificateNumber: input.certificateNumber,
    sealedAt: input.sealedAt,
  };
}

/**
 * Apply the officer's digital seal: preconditions, the parcels row update and the audit entry
 * commit together or not at all.
 */
export async function sealParcel(options: {
  parcelId: string;
  officer: RequestPrincipal;
  officerNotes?: string;
  forceOverride?: boolean;
}): Promise<SealResult> {
  const { parcelId, officer, forceOverride = false } = options;
  const notes = options.officerNotes || 'Verified against Master Shajra Cadastre.';
  const sealedAt = new Date().toISOString();

  const valResult = await validateParcel(parcelId, officer, officer.displayName);
  if (!valResult.canBeVerified && !forceOverride) {
    throw new SealRejected(
      'VERIFICATION_PRECONDITIONS_FAILED',
      'Parcel cannot be sealed: prerequisite cadastral or ownership checks are pending.',
      valResult
    );
  }

  if (forceOverride && !valResult.canBeVerified && officer.role !== 'TEHSILDAR') {
    throw new SealRejected(
      'OVERRIDE_FORBIDDEN',
      'Overriding failed validation preconditions requires Tehsildar authority.',
      valResult
    );
  }

  // Cosmetic prefix only. The certificate identifies the sealing officer's primary district; the
  // authorization decision was made from their assignments, not from this string.
  const certificateNumber = generateCertificateNumber(`CERT-DHR/${officer.primaryDistrict}`);
  const signatureHash = signSeal(sealMaterial({ parcelId, officer, certificateNumber, sealedAt }));
  const verifiedBy = `${officer.displayName} (${officer.designation || officer.role})`;

  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    try {
      client = await beginTenantTransaction(officer);

      const current = await client.query(
        'SELECT id, status, verified_at FROM parcels WHERE id = $1 FOR UPDATE',
        [parcelId]
      );
      if (current.rows.length === 0) {
        throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
      }
      if (current.rows[0].verified_at) {
        throw new SealRejected(
          'ALREADY_SEALED',
          `Parcel ${parcelId} was already sealed on ${new Date(current.rows[0].verified_at).toISOString()}. Re-sealing requires a new record, not an overwrite.`
        );
      }

      await client.query(
        `UPDATE parcels
           SET status = 'Verified',
               verified_by = $2,
               verified_at = $3::timestamptz,
               verification_notes = $4,
               certificate_number = $5,
               seal_signature = $6,
               updated_at = NOW()
         WHERE id = $1`,
        [parcelId, verifiedBy, sealedAt, notes, certificateNumber, signatureHash]
      );

      await recordAuditLog(
        {
          parcelId,
          entityType: 'VERIFICATION_SEAL',
          entityId: parcelId,
          actionType: 'RECORD_SEALED',
          performedBy: officer.displayName,
          officerBadge: officer.badgeNumber,
          signatureHash,
          createdAt: sealedAt,
          details: {
            certificateNumber,
            notes,
            sealedBy: officer.displayName,
            sealedAt,
            validationPreconditionsMet: valResult.canBeVerified,
            forceOverride,
          },
        },
        client
      );

      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }

    const stored = memoryStore.parcels.get(parcelId);
    return {
      certificateNumber,
      signatureHash,
      sealedAt,
      parcel: stored ? { ...stored, status: 'Verified' } : { id: parcelId, status: 'Verified' },
      storageMode: health.storageMode,
    };
  }

  const parcel = memoryStore.parcels.get(parcelId);
  if (!parcel) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
  if (parcel.verifiedAt) {
    throw new SealRejected('ALREADY_SEALED', `Parcel ${parcelId} is already sealed.`);
  }

  parcel.status = 'Verified';
  parcel.verifiedBy = verifiedBy;
  parcel.verifiedAt = sealedAt;
  parcel.verificationNotes = notes;
  parcel.certificateNumber = certificateNumber;
  parcel.sealSignature = signatureHash;
  memoryStore.parcels.set(parcelId, parcel);

  await recordAuditLog({
    parcelId,
    entityType: 'VERIFICATION_SEAL',
    entityId: parcelId,
    actionType: 'RECORD_SEALED',
    performedBy: officer.displayName,
    officerBadge: officer.badgeNumber,
    signatureHash,
    createdAt: sealedAt,
    details: {
      certificateNumber,
      notes,
      sealedBy: officer.displayName,
      sealedAt,
      validationPreconditionsMet: valResult.canBeVerified,
      forceOverride,
    },
  });

  return { certificateNumber, signatureHash, sealedAt, parcel, storageMode: health.storageMode };
}

/**
 * Record an assisted GPS/camera field inspection. The field_inspections table existed but was
 * never INSERTed into, so inspections were invisible to validation and lost on restart.
 */
export async function recordFieldInspection(options: {
  parcelId: string;
  officer: RequestPrincipal;
  body: any;
}): Promise<{ id: string; evidenceHash: string; inspection: any; storageMode: string }> {
  const { parcelId, officer, body } = options;
  const inspectedAt = new Date().toISOString();
  const id = `insp-${Date.now()}-${officer.userId.replace(/[^A-Za-z0-9]/g, '').slice(-4)}`;

  const evidenceHash = signSeal({
    parcelId,
    inspectionId: id,
    inspector: officer.displayName,
    badge: officer.badgeNumber,
    coords: body.gpsCoords || null,
    checkpoints: body.checkpoints || [],
    discrepancyObserved: Boolean(body.discrepancyObserved),
    inspectedAt,
  });

  const inspection = {
    id,
    parcelId,
    inspectedAt,
    inspectedBy: officer.displayName,
    inspectorRole: officer.role === 'PATWARI' ? 'Patwari (Field Revenue Inspector)' : 'Tehsildar',
    gpsCoords: body.gpsCoords,
    deviceHeadingDeg: body.deviceHeadingDeg,
    checkpoints: Array.isArray(body.checkpoints) ? body.checkpoints : [],
    discrepancyObserved: Boolean(body.discrepancyObserved),
    discrepancyNotes: body.discrepancyNotes || '',
    observedLandUse: body.observedLandUse || 'Agricultural',
    photoUri: body.photoUri,
    photoTimestamp: body.photoUri ? body.photoTimestamp || inspectedAt : undefined,
    evidenceHash,
    isProvisional: true,
    recommendedAction: body.recommendedAction || 'Proceed to Officer Seal',
  };

  const health = getDbHealth();
  const statusAfter = inspection.discrepancyObserved ? 'Needs Review' : 'Needs Field Verification';

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    try {
      client = await beginTenantTransaction(officer);

      const exists = await client.query('SELECT id, status FROM parcels WHERE id = $1 FOR UPDATE', [parcelId]);
      if (exists.rows.length === 0) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);

      await client.query(
        `INSERT INTO field_inspections (
          id, parcel_id, inspected_at, inspected_by, inspector_role, gps_lat, gps_lng,
          gps_accuracy_m, device_heading_deg, checkpoints, discrepancy_observed,
          discrepancy_notes, observed_land_use, photo_uri, photo_timestamp, evidence_hash,
          is_provisional, recommended_action
        ) VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::timestamptz, $16, $17, $18)`,
        [
          id,
          parcelId,
          inspectedAt,
          officer.displayName,
          inspection.inspectorRole,
          body.gpsCoords?.latitude ?? null,
          body.gpsCoords?.longitude ?? null,
          body.gpsCoords?.accuracy ?? null,
          body.deviceHeadingDeg ?? null,
          JSON.stringify(inspection.checkpoints),
          inspection.discrepancyObserved,
          inspection.discrepancyNotes,
          inspection.observedLandUse,
          body.photoUri ?? null,
          inspection.photoTimestamp ?? null,
          evidenceHash,
          true,
          inspection.recommendedAction,
        ]
      );

      await client.query(
        `UPDATE parcels SET status = $2, updated_at = NOW() WHERE id = $1 AND status <> 'Verified'`,
        [parcelId, statusAfter]
      );

      await recordAuditLog(
        {
          parcelId,
          entityType: 'FIELD_INSPECTION',
          entityId: id,
          actionType: 'FIELD_INSPECTION_RECORDED',
          performedBy: officer.displayName,
          officerBadge: officer.badgeNumber,
          createdAt: inspectedAt,
          details: {
            inspectionId: id,
            discrepancyObserved: inspection.discrepancyObserved,
            checkpointsCount: inspection.checkpoints.length,
            evidenceHash,
            recommendedAction: inspection.recommendedAction,
          },
        },
        client
      );

      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }

    return { id, evidenceHash, inspection, storageMode: health.storageMode };
  }

  const currentList = memoryStore.fieldInspections.get(parcelId) || [];
  currentList.push(inspection);
  memoryStore.fieldInspections.set(parcelId, currentList);

  const parcel = memoryStore.parcels.get(parcelId);
  if (parcel && parcel.status !== 'Verified') {
    parcel.status = statusAfter;
    memoryStore.parcels.set(parcelId, parcel);
  }

  await recordAuditLog({
    parcelId,
    entityType: 'FIELD_INSPECTION',
    entityId: id,
    actionType: 'FIELD_INSPECTION_RECORDED',
    performedBy: officer.displayName,
    officerBadge: officer.badgeNumber,
    createdAt: inspectedAt,
    details: {
      inspectionId: id,
      discrepancyObserved: inspection.discrepancyObserved,
      checkpointsCount: inspection.checkpoints.length,
      evidenceHash,
      recommendedAction: inspection.recommendedAction,
    },
  });

  return { id, evidenceHash, inspection, storageMode: health.storageMode };
}

/**
 * Read inspections from PostgreSQL where it is the source of truth.
 */
export async function fetchFieldInspections(parcelId: string): Promise<any[]> {
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    const result = await pool.query(
      'SELECT * FROM field_inspections WHERE parcel_id = $1 ORDER BY inspected_at DESC',
      [parcelId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      parcelId: row.parcel_id,
      inspectedAt: row.inspected_at,
      inspectedBy: row.inspected_by,
      inspectorRole: row.inspector_role,
      gpsCoords: { latitude: Number(row.gps_lat), longitude: Number(row.gps_lng), accuracy: Number(row.gps_accuracy_m) },
      deviceHeadingDeg: row.device_heading_deg !== null ? Number(row.device_heading_deg) : undefined,
      checkpoints: typeof row.checkpoints === 'string' ? JSON.parse(row.checkpoints) : row.checkpoints || [],
      discrepancyObserved: row.discrepancy_observed,
      discrepancyNotes: row.discrepancy_notes,
      observedLandUse: row.observed_land_use,
      photoUri: row.photo_uri,
      photoTimestamp: row.photo_timestamp,
      evidenceHash: row.evidence_hash,
      isProvisional: row.is_provisional,
      recommendedAction: row.recommended_action,
    }));
  }

  return memoryStore.fieldInspections.get(parcelId) || [];
}

/**
 * Attach a controlled document to a parcel. Document rows previously lived only in memory, so
 * uploads disappeared on restart and seeded documents 404-ed.
 */
export async function linkDocument(options: {
  parcelId: string | null;
  document: {
    id: string;
    documentCode?: string;
    fileName: string;
    recordType: string;
    ocrLanguage?: string;
    rawOcrText?: string;
    extractedData?: any;
    documentHash: string;
    status?: string;
    priority?: string;
    imageUri?: string;
    qualityMetrics?: any;
    district?: string;
    tehsil?: string;
    village?: string;
    patwarCircle?: string;
  };
  performedBy: string;
  officerBadge?: string;
  /** Used only when neither the caller nor the parcel carries a district. */
  defaultDistrict?: string;
  /**
   * Required. The link writes to two tenant-scoped tables, so it must run in the caller's row-level
   * security context and stamp the new document with the caller's organization — not with whatever
   * district string arrived in the request body.
   */
  principal: RequestPrincipal;
}): Promise<{ storageMode: string; district: string | null }> {
  const { parcelId, document, performedBy, officerBadge, defaultDistrict, principal } = options;
  const health = getDbHealth();
  const uploadedAt = new Date().toISOString();
  const suppliedDistrict = typeof document.district === 'string' ? document.district.trim() : '';

  if (health.storageMode === 'postgres-postgis' && parcelId) {
    let client: PoolClient | null = null;
    let filedDistrict: string | null = null;
    try {
      client = await beginTenantTransaction(principal);

      const parcel = await client.query('SELECT id, district, document_id, document_name, document_type FROM parcels WHERE id = $1 FOR UPDATE', [parcelId]);
      if (parcel.rows.length === 0) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
      // The parcel's own district wins over anything the caller sent: this route has already
      // proved the parcel is in the caller's jurisdiction, and a document must be filed where the
      // land is. A row with neither a district nor a parcel is unreachable to every officer.
      filedDistrict = suppliedDistrict || parcel.rows[0].district || (defaultDistrict || '').trim() || null;

      await client.query(
        `INSERT INTO land_documents (
          id, parcel_id, document_code, file_name, record_type, ocr_language, raw_ocr_text,
          district, tehsil, village, patwar_circle, status, priority, image_uri,
          quality_metrics, extracted_data, document_hash, uploaded_by, uploaded_at,
          organization_id, organization_granted_by, organization_grant_reason, organization_granted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19::timestamptz,
          $20, $21, $22, NOW())
        ON CONFLICT (id) DO UPDATE SET
          parcel_id = EXCLUDED.parcel_id,
          status = EXCLUDED.status,
          raw_ocr_text = EXCLUDED.raw_ocr_text,
          extracted_data = EXCLUDED.extracted_data,
          document_hash = EXCLUDED.document_hash,
          uploaded_at = EXCLUDED.uploaded_at`,
        [
          document.id,
          parcelId,
          document.documentCode || null,
          document.fileName,
          document.recordType,
          document.ocrLanguage || 'hin+eng',
          document.rawOcrText || '',
          filedDistrict,
          document.tehsil || null,
          document.village || null,
          document.patwarCircle || null,
          document.status || 'Uploaded',
          document.priority || 'Medium',
          document.imageUri || null,
          document.qualityMetrics ? JSON.stringify(document.qualityMetrics) : null,
          document.extractedData ? JSON.stringify(document.extractedData) : null,
          document.documentHash,
          performedBy,
          uploadedAt,
          principal.organizationId, `officer:${principal.email}`,
          `Linked to parcel ${parcelId} through the API by ${performedBy}.`,
        ]
      );

      await client.query(
        `UPDATE parcels SET document_id = $2, document_name = $3, document_type = $4, document_uploaded_at = $5::timestamptz, updated_at = NOW() WHERE id = $1`,
        [parcelId, document.id, document.fileName, document.recordType, uploadedAt]
      );

      await recordAuditLog(
        {
          parcelId,
          documentId: document.id,
          entityType: 'DOCUMENT',
          entityId: document.id,
          actionType: 'DOCUMENT_LINKED',
          performedBy,
          officerBadge,
          createdAt: uploadedAt,
          details: { fileName: document.fileName, recordType: document.recordType, documentHash: document.documentHash },
        },
        client
      );

      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }

    return { storageMode: health.storageMode, district: filedDistrict };
  }

  const memoryParcel = parcelId ? memoryStore.parcels.get(parcelId) : null;
  const memoryDistrict = suppliedDistrict || memoryParcel?.district || (defaultDistrict || '').trim() || null;
  memoryStore.documents.set(document.id, { ...document, district: memoryDistrict, parcelId, uploadedBy: performedBy, uploadedAt });

  if (parcelId) {
    const parcel = memoryStore.parcels.get(parcelId);
    if (parcel) {
      parcel.documentId = document.id;
      parcel.documentName = document.fileName;
      parcel.documentType = document.recordType;
      memoryStore.parcels.set(parcelId, parcel);
    }
  }

  await recordAuditLog({
    parcelId,
    documentId: document.id,
    entityType: 'DOCUMENT',
    entityId: document.id,
    actionType: 'DOCUMENT_LINKED',
    performedBy,
    officerBadge,
    createdAt: uploadedAt,
    details: { fileName: document.fileName, recordType: document.recordType, documentHash: document.documentHash },
  });

  return { storageMode: health.storageMode, district: memoryDistrict };
}

/**
 * Controlled re-districting (design default D5).
 *
 * A parcel's district is its jurisdiction, so moving one is an administrative order, not an
 * attribute edit: it requires the PARCEL_REHOME capability, an active assignment over BOTH the
 * source and the destination, and a reason. It writes a `parcel_mutations` provenance row and its
 * own chained audit entry in the same transaction as the column update, and it changes no earlier
 * audit event — history stays as it was recorded, including the record's previous district.
 *
 * Nothing here infers a destination. If the correct district for a record is not known, this
 * endpoint is not the answer; the revenue department supplies it.
 */
export async function rehomeParcel(input: {
  parcelId: string;
  toDistrict: string;
  reason: string;
  principal: RequestPrincipal;
}): Promise<{ parcelId: string; fromDistrict: string; toDistrict: string; storageMode: string }> {
  const { parcelId, toDistrict, reason, principal } = input;
  const normalise = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const from = await parcelDistrict(principal, parcelId);

  if (from === null) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
  if (normalise(from) === normalise(toDistrict)) {
    throw new SealRejected('NO_JURISDICTION_CHANGE', `Parcel ${parcelId} is already in ${from}.`);
  }

  const writable = principal.districts.map(normalise);
  if (!writable.includes(normalise(from)) || !writable.includes(normalise(toDistrict))) {
    // Answered as a plain rejection: the caller is authorized over the source, so 404 would be
    // misleading, and the destination's existence is not something to confirm or deny.
    throw new SealRejected(
      'REHOME_REQUIRES_BOTH_JURISDICTIONS',
      'Re-districting requires an active assignment over both the current and the destination district.'
    );
  }

  const at = new Date().toISOString();
  const performedBy = `${principal.displayName} (${principal.designation || principal.role})`;
  const health = getDbHealth();

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    try {
      client = await beginTenantTransaction(principal);

      const locked = await client.query('SELECT district FROM parcels WHERE id = $1 FOR UPDATE', [parcelId]);
      if (locked.rows.length === 0) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
      const actualFrom = locked.rows[0].district;
      if (normalise(actualFrom) !== normalise(from)) {
        // Somebody moved it between the pre-check and the lock; refuse rather than chain a move
        // onto a state we never showed the officer.
        throw new SealRejected('JURISDICTION_CHANGED_CONCURRENTLY', 'The parcel\'s jurisdiction changed while this request was being prepared. Re-read the record and try again.');
      }

      await client.query('UPDATE parcels SET district = $2, updated_at = NOW() WHERE id = $1', [parcelId, toDistrict]);

      // Documents filed under the old district would otherwise become unreachable for the officer
      // who legitimately holds the parcel now, and unreachable for its uploader too.
      await client.query(
        'UPDATE land_documents SET district = $2 WHERE parcel_id = $1 AND district IS NOT NULL',
        [parcelId, toDistrict]
      );

      await client.query(
        `INSERT INTO parcel_mutations (parcel_id, mutation_date, mutation_type, note, previous_value, new_value, recorded_by)
         VALUES ($1, $2, 'Re-districting (jurisdiction change)', $3, $4, $5, $6)`,
        [parcelId, at, reason, actualFrom, toDistrict, performedBy]
      );

      await recordAuditLog(
        {
          parcelId,
          entityType: 'PARCEL',
          entityId: parcelId,
          actionType: 'PARCEL_REDISTRICTED',
          performedBy,
          officerBadge: principal.badgeNumber,
          createdAt: at,
          details: { fromDistrict: actualFrom, toDistrict, reason },
        },
        client
      );

      await client.query('COMMIT');
      return { parcelId, fromDistrict: actualFrom, toDistrict, storageMode: health.storageMode };
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }
  }

  const parcel = memoryStore.parcels.get(parcelId);
  if (!parcel) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} not found.`);
  const fromMemory = parcel.district;
  parcel.district = toDistrict;
  parcel.updatedAt = at;
  memoryStore.parcels.set(parcelId, parcel);

  for (const doc of memoryStore.documents.values()) {
    if (doc.parcelId === parcelId && doc.district) doc.district = toDistrict;
  }

  await recordAuditLog({
    parcelId,
    entityType: 'PARCEL',
    entityId: parcelId,
    actionType: 'PARCEL_REDISTRICTED',
    performedBy,
    officerBadge: principal.badgeNumber,
    createdAt: at,
    details: { fromDistrict: fromMemory, toDistrict, reason },
  });

  return { parcelId, fromDistrict: fromMemory, toDistrict, storageMode: health.storageMode };
}

/**
 * Point an existing document at a parcel, or detach it.
 *
 * This is deliberately separate from linkDocument, which registers a *new* document: replaying that
 * path to relink an existing row would overwrite its OCR text, status and hash with whatever the
 * caller happened to send. Here only the relationship and the jurisdiction it inherits are written.
 */
export async function setDocumentParcelLink(input: {
  documentId: string;
  parcelId: string | null;
  principal: RequestPrincipal;
}): Promise<{ documentId: string; parcelId: string | null; district: string | null; storageMode: string }> {
  const { documentId, parcelId, principal } = input;
  const health = getDbHealth();
  const at = new Date().toISOString();

  if (health.storageMode === 'postgres-postgis') {
    let client: PoolClient | null = null;
    let district: string | null = null;
    try {
      client = await beginTenantTransaction(principal);

      const doc = await client.query('SELECT id, parcel_id, file_name, record_type FROM land_documents WHERE id = $1 FOR UPDATE', [documentId]);
      if (doc.rows.length === 0) throw new SealRejected('NOT_FOUND', `Document ${documentId} was not found.`);

      if (parcelId) {
        const parcel = await client.query('SELECT id, district FROM parcels WHERE id = $1 FOR UPDATE', [parcelId]);
        if (parcel.rows.length === 0) throw new SealRejected('NOT_FOUND', `Parcel ${parcelId} was not found.`);
        district = parcel.rows[0].district;

        // A document follows the land it describes: filing it under the parcel's district keeps it
        // reachable by the officer who holds that district, including its uploader.
        await client.query(
          `UPDATE land_documents SET parcel_id = $2, district = COALESCE(district, $3) WHERE id = $1`,
          [documentId, parcelId, district]
        );
        await client.query(
          `UPDATE parcels SET document_id = $2, document_name = $3, document_type = $4, updated_at = NOW() WHERE id = $1`,
          [parcelId, documentId, doc.rows[0].file_name, doc.rows[0].record_type]
        );
      } else {
        await client.query('UPDATE land_documents SET parcel_id = NULL WHERE id = $1', [documentId]);
        await client.query('UPDATE parcels SET document_id = NULL WHERE id = $1 AND document_id = $2', [doc.rows[0].parcel_id, documentId]);
      }

      await recordAuditLog(
        {
          parcelId,
          documentId,
          entityType: 'DOCUMENT',
          entityId: documentId,
          actionType: parcelId ? 'DOCUMENT_LINKED' : 'DOCUMENT_UNLINKED',
          performedBy: principal.displayName,
          officerBadge: principal.badgeNumber,
          createdAt: at,
          details: { parcelId, previousParcelId: doc.rows[0].parcel_id ?? null },
        },
        client
      );

      await client.query('COMMIT');
      return { documentId, parcelId, district, storageMode: health.storageMode };
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }
  }

  const stored = memoryStore.documents.get(documentId);
  if (!stored) throw new SealRejected('NOT_FOUND', `Document ${documentId} was not found.`);
  const previousParcelId = stored.parcelId ?? null;
  stored.parcelId = parcelId ?? undefined;
  if (parcelId) {
    stored.district = stored.district || memoryStore.parcels.get(parcelId)?.district || null;
    const parcel = memoryStore.parcels.get(parcelId);
    if (parcel) {
      parcel.documentId = documentId;
      parcel.documentName = stored.fileName;
      parcel.documentType = stored.recordType;
      memoryStore.parcels.set(parcelId, parcel);
    }
  } else if (previousParcelId) {
    const parcel = memoryStore.parcels.get(previousParcelId);
    if (parcel?.documentId === documentId) {
      parcel.documentId = undefined;
      memoryStore.parcels.set(previousParcelId, parcel);
    }
  }
  memoryStore.documents.set(documentId, stored);

  await recordAuditLog({
    parcelId,
    documentId,
    entityType: 'DOCUMENT',
    entityId: documentId,
    actionType: parcelId ? 'DOCUMENT_LINKED' : 'DOCUMENT_UNLINKED',
    performedBy: principal.displayName,
    officerBadge: principal.badgeNumber,
    createdAt: at,
    details: { parcelId, previousParcelId },
  });

  return { documentId, parcelId, district: stored.district ?? null, storageMode: health.storageMode };
}

/**
 * The one shape a document takes anywhere in this API.
 *
 * `GET /api/parcels/:id/documents` used to return `SELECT *` rows, so the same resource arrived as
 * snake_case database columns from the PostgreSQL branch and as camelCase objects from the dev
 * fallback branch. A client written against either shape silently breaks on the other, and nothing
 * in the types notices because the rows are `any`. Documents are mapped in exactly one place now.
 */
export function mapDocumentRow(row: any) {
  return {
    id: row.id,
    parcelId: row.parcel_id,
    documentCode: row.document_code,
    fileName: row.file_name,
    recordType: row.record_type,
    ocrLanguage: row.ocr_language,
    rawOcrText: row.raw_ocr_text,
    district: row.district,
    districtCode: row.district_code ?? null,
    tehsil: row.tehsil,
    village: row.village,
    patwarCircle: row.patwar_circle,
    status: row.status,
    priority: row.priority,
    imageUri: row.image_uri,
    qualityMetrics: row.quality_metrics,
    extractedData: row.extracted_data,
    documentHash: row.document_hash,
    ocrConfidence: row.ocr_confidence !== null && row.ocr_confidence !== undefined ? Number(row.ocr_confidence) : undefined,
    uploadedBy: row.uploaded_by,
    // Required by DocumentScope: an assertion cannot decide tenancy without it, and leaving it
    // optional would let a caller that forgot to select the column skip the check entirely.
    organizationId: row.organization_id ?? null,
    uploadedAt: row.uploaded_at,
  };
}
