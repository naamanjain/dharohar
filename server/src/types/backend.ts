/**
 * DHAROHAR Backend Types & Interfaces
 * Phase 4: Backend Completion, Security & Integration
 */

export type UserRole = 'TEHSILDAR' | 'PATWARI' | 'DATA_ENTRY_OPERATOR' | 'AUDITOR';

export interface UserAccount {
  id: string;
  email: string;
  passwordHash: string;
  salt: string;
  role: UserRole;
  displayName: string;
  designation: string;
  badgeNumber: string;
  jurisdiction: string;
  district: string;
  state: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  displayName: string;
  designation?: string;
  badgeNumber: string;
  district: string;
  iat: number;
  exp: number;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  storageMode?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface ValidationCheckItem {
  id: string;
  name: string;
  passed: boolean;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  actualValue?: any;
  expectedValue?: any;
}

export interface ParcelValidationResult {
  parcelId: string;
  isValid: boolean;
  canBeVerified: boolean;
  areaValidation: {
    mappedAreaHa: number;
    recordedAreaHa: number;
    differenceHa: number;
    percentageDifference: number;
    hasDiscrepancy: boolean;
    status: 'MATCHED' | 'MINOR_VARIANCE' | 'AREA_MISMATCH_REQUIRES_FIELD_INSPECTION';
  };
  ownershipValidation: {
    totalSharePercentage: number;
    isValid: boolean;
    ownersCount: number;
    shares: Array<{
      ownerId: string;
      name: string;
      sharePercentage: number;
    }>;
  };
  cadastralFieldsValidation: {
    khasraNo: boolean;
    khataNo: boolean;
    khewatNo: boolean;
    village: boolean;
    tehsil: boolean;
    district: boolean;
    geometry: boolean;
    allPresent: boolean;
    missingFields: string[];
  };
  documentValidation: {
    isLinked: boolean;
    documentId?: string;
    documentName?: string;
    documentHash?: string;
    extractedKhasraMatch?: boolean;
    extractedAreaMatch?: boolean;
  };
  fieldInspectionValidation: {
    inspectionsCount: number;
    hasPassedInspection: boolean;
    latestInspection?: any;
    requiredDueToDiscrepancy: boolean;
  };
  checklist: ValidationCheckItem[];
  validationTimestamp: string;
  validatedBy: string;
}

export interface AuditLogEntry {
  id: number | string;
  parcelId?: string | null;
  documentId?: string | null;
  entityType: 'PARCEL' | 'DOCUMENT' | 'FIELD_INSPECTION' | 'VERIFICATION_SEAL' | 'SYSTEM' | 'OFFICER' | 'DISTRICT';
  entityId: string;
  actionType: string;
  performedBy: string;
  officerBadge?: string;
  details: Record<string, any>;
  previousHash: string;
  entryHash: string;
  signatureHash?: string;
  createdAt: string;
}
