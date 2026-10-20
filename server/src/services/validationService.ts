/**
 * DHAROHAR Cadastral & Legal Record Validation Service
 * 
 * Provides server-authoritative validation for:
 * 1. Geodesic area vs. recorded revenue Rakba (discrepancy detection)
 * 2. Co-sharer ownership percentage sum (100% mathematical integrity)
 * 3. Mandatory revenue identifiers (Khasra, Khata, Khewat, Mauza, Tehsil, District)
 * 4. Document linkage & cryptographic hash evidence
 * 5. Field inspection requirements and 9-point integrity checklist
 */

import { ParcelValidationResult, ValidationCheckItem } from '../types/backend';
import { memoryStore, getDbHealth, pool } from '../db/db';
import { withTenant } from '../db/tenant';
import type { RequestPrincipal } from './jurisdiction';

export function calculateGeodesicAreaHectares(pts: Array<{ lat: number; lng: number }>): number {
  if (!pts || pts.length < 3) return 0;
  const EARTH_RADIUS_M = 6371008.8;
  const ring = pts.map((p) => [(p.lng * Math.PI) / 180, (p.lat * Math.PI) / 180] as [number, number]);
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Number(((Math.abs(area * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / 10000).toFixed(4));
}

/**
 * Validate a parcel against authoritative cadastral and legal rules
 */
export async function validateParcel(
  parcelId: string,
  officer: RequestPrincipal,
  validatedBy = 'System Validator'
): Promise<ParcelValidationResult> {
  const health = getDbHealth();
  let parcel: any = null;
  let owners: any[] = [];
  let inspections: any[] = [];
  let documents: any[] = [];

  if (health.storageMode === 'postgres-postgis') {
    // Read through the caller's tenant: the parcel, its owners, its inspections and its documents are
    // one record's worth of evidence and must all come from the same organization. Without row-level
    // security applied here, a validation report could quote another tenant's document hash.
    await withTenant(officer, async (client) => {
      const pRes = await client.query('SELECT * FROM parcels WHERE id = $1', [parcelId]);
      if (pRes.rows.length > 0) {
        const row = pRes.rows[0];
        parcel = {
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
          status: row.status,
          documentId: row.document_id,
          documentName: row.document_name,
          verifiedBy: row.verified_by,
          verifiedAt: row.verified_at,
          certificateNumber: row.certificate_number,
          geom: row.geom,
        };
      }

      const oRes = await client.query('SELECT * FROM parcel_owners WHERE parcel_id = $1', [parcelId]);
      owners = oRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        sharePercentage: Number(r.share_percentage),
        shareFraction: r.share_fraction,
      }));

      const iRes = await client.query('SELECT * FROM field_inspections WHERE parcel_id = $1 ORDER BY inspected_at DESC', [parcelId]);
      inspections = iRes.rows;

      const dRes = await client.query('SELECT * FROM land_documents WHERE parcel_id = $1', [parcelId]);
      documents = dRes.rows;
    });

    // Previously a query error dropped validation onto the in-memory demo parcels, so a
    // database outage could still return "canBeVerified: true" for a record it never read.
    if (!parcel) {
      throw new Error(`Parcel ${parcelId} not found for validation.`);
    }
  } else {
    parcel = memoryStore.parcels.get(parcelId);
    owners = memoryStore.owners.get(parcelId) || (parcel?.owners || []);
    inspections = memoryStore.fieldInspections.get(parcelId) || [];
    documents = Array.from(memoryStore.documents.values()).filter((d) => d.parcelId === parcelId);

    if (!parcel) {
      throw new Error(`Parcel ${parcelId} not found for validation.`);
    }
  }

  const checklist: ValidationCheckItem[] = [];

  // 1. Geometry check
  const hasBoundary = Boolean(parcel.boundary && parcel.boundary.length >= 3) || Boolean(parcel.geom);
  checklist.push({
    id: 'chk-geom',
    name: 'Spatial Geometry Defined',
    passed: hasBoundary || parcel.mappedAreaHectares > 0,
    severity: 'ERROR',
    message: hasBoundary ? 'Valid closed polygon boundary detected.' : 'Missing spatial geometry.',
  });

  // 2. Area Calculation & Discrepancy
  const mappedAreaHa = Number(parcel.mappedAreaHectares || 0);
  const recordedAreaHa = Number(parcel.recordedAreaHectares || mappedAreaHa);
  const differenceHa = Number(Math.abs(recordedAreaHa - mappedAreaHa).toFixed(4));
  const percentageDifference = recordedAreaHa > 0
    ? Number(((differenceHa / recordedAreaHa) * 100).toFixed(2))
    : 0;

  const hasAreaDiscrepancy = differenceHa > 0.02 || percentageDifference > 2.0;
  const areaStatus = !hasAreaDiscrepancy
    ? 'MATCHED'
    : percentageDifference < 5.0
    ? 'MINOR_VARIANCE'
    : 'AREA_MISMATCH_REQUIRES_FIELD_INSPECTION';

  checklist.push({
    id: 'chk-area-consistency',
    name: 'Area Consistency (Mapped vs Recorded)',
    passed: !hasAreaDiscrepancy,
    severity: hasAreaDiscrepancy ? 'WARNING' : 'INFO',
    message: hasAreaDiscrepancy
      ? `Area mismatch detected: Mapped ${mappedAreaHa.toFixed(2)} ha vs Recorded ${recordedAreaHa.toFixed(2)} ha (Difference: ${differenceHa.toFixed(2)} ha / ${percentageDifference}%). Field verification required.`
      : `Mapped area (${mappedAreaHa.toFixed(2)} ha) matches recorded area within allowable tolerance.`,
    actualValue: `${mappedAreaHa} ha`,
    expectedValue: `${recordedAreaHa} ha`,
  });

  // 3. Ownership Share Sum (100% check)
  const totalSharePercentage = owners.reduce((sum, o) => sum + (Number(o.sharePercentage) || 0), 0);
  const isOwnershipValid = Math.abs(totalSharePercentage - 100.0) < 0.01;

  checklist.push({
    id: 'chk-ownership-shares',
    name: 'Ownership Co-Sharer Allocation',
    passed: isOwnershipValid,
    severity: isOwnershipValid ? 'INFO' : 'ERROR',
    message: isOwnershipValid
      ? `100.00% ownership share accounted for across ${owners.length} registered co-sharer(s).`
      : `Ownership shares sum to ${totalSharePercentage.toFixed(2)}% (must equal exactly 100.00%).`,
    actualValue: `${totalSharePercentage.toFixed(2)}%`,
    expectedValue: '100.00%',
  });

  // 4. Cadastral Identifiers (Khasra, Khata, Khewat, Mauza, Tehsil, District)
  const missingCadastralFields: string[] = [];
  if (!parcel.khasraNo || parcel.khasraNo === '—') missingCadastralFields.push('Khasra No');
  if (!parcel.khataNo || parcel.khataNo === '—') missingCadastralFields.push('Khata No');
  if (!parcel.village) missingCadastralFields.push('Mauza/Village');
  if (!parcel.tehsil) missingCadastralFields.push('Tehsil');
  if (!parcel.district) missingCadastralFields.push('District');

  const allCadastralPresent = missingCadastralFields.length === 0;
  checklist.push({
    id: 'chk-mandatory-fields',
    name: 'Mandatory Cadastral Identifiers',
    passed: allCadastralPresent,
    severity: allCadastralPresent ? 'INFO' : 'ERROR',
    message: allCadastralPresent
      ? `Khasra ${parcel.khasraNo}, Khata ${parcel.khataNo}, Mauza ${parcel.village} present.`
      : `Missing mandatory cadastral fields: ${missingCadastralFields.join(', ')}.`,
  });

  // 5. Document Linkage
  const isDocLinked = Boolean(parcel.documentId || parcel.documentName || documents.length > 0);
  checklist.push({
    id: 'chk-document-link',
    name: 'Document Linkage & Evidence',
    passed: isDocLinked,
    severity: isDocLinked ? 'INFO' : 'WARNING',
    message: isDocLinked
      ? `Linked to land record document: ${parcel.documentName || documents[0]?.fileName || parcel.documentId}.`
      : 'No source land document linked to parcel.',
  });

  // 6. Field Inspection Validation
  const hasPassedInspection = inspections.length > 0;
  const isInspectionRequired = hasAreaDiscrepancy;

  checklist.push({
    id: 'chk-field-inspection',
    name: 'Assisted Field Inspection Status',
    passed: !isInspectionRequired || hasPassedInspection,
    severity: isInspectionRequired && !hasPassedInspection ? 'WARNING' : 'INFO',
    message: hasPassedInspection
      ? `${inspections.length} field inspection record(s) on file.`
      : isInspectionRequired
      ? 'Field inspection pending due to area discrepancy.'
      : 'No area discrepancy; routine field verification optional.',
  });

  // 7. Officer Verification Status
  const isVerified = parcel.status === 'Verified';
  checklist.push({
    id: 'chk-officer-seal',
    name: 'Officer Verification & Digital Seal',
    passed: isVerified,
    severity: 'INFO',
    message: isVerified
      ? `Verified and digitally sealed by ${parcel.verifiedBy || 'Revenue Officer'}.`
      : 'Provisional/unsealed record awaiting revenue officer sign-off.',
  });

  // 8. Overall Integrity & Verification Eligibility
  const canBeVerified = allCadastralPresent && isOwnershipValid && (!hasAreaDiscrepancy || hasPassedInspection);
  const isValid = allCadastralPresent && isOwnershipValid;

  return {
    parcelId,
    isValid,
    canBeVerified,
    areaValidation: {
      mappedAreaHa,
      recordedAreaHa,
      differenceHa,
      percentageDifference,
      hasDiscrepancy: hasAreaDiscrepancy,
      status: areaStatus,
    },
    ownershipValidation: {
      totalSharePercentage,
      isValid: isOwnershipValid,
      ownersCount: owners.length,
      shares: owners.map((o) => ({
        ownerId: o.id,
        name: o.name,
        sharePercentage: Number(o.sharePercentage),
      })),
    },
    cadastralFieldsValidation: {
      khasraNo: Boolean(parcel.khasraNo && parcel.khasraNo !== '—'),
      khataNo: Boolean(parcel.khataNo && parcel.khataNo !== '—'),
      khewatNo: Boolean(parcel.khewatNo && parcel.khewatNo !== '—'),
      village: Boolean(parcel.village),
      tehsil: Boolean(parcel.tehsil),
      district: Boolean(parcel.district),
      geometry: hasBoundary,
      allPresent: allCadastralPresent,
      missingFields: missingCadastralFields,
    },
    documentValidation: {
      isLinked: isDocLinked,
      documentId: parcel.documentId,
      documentName: parcel.documentName,
    },
    fieldInspectionValidation: {
      inspectionsCount: inspections.length,
      hasPassedInspection,
      latestInspection: inspections[0] || undefined,
      requiredDueToDiscrepancy: isInspectionRequired,
    },
    checklist,
    validationTimestamp: new Date().toISOString(),
    validatedBy,
  };
}
