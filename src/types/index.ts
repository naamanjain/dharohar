export type UserRole = 
  | 'Revenue Officer / Tehsildar'
  | 'Senior Verification Officer'
  | 'Verification Operator'
  | 'Data Entry Clerk'
  | 'State Land Records Auditor';

export interface UserProfile {
  id: string;
  name: string;
  designation: UserRole;
  badgeNumber: string;
  jurisdiction: string;
  district: string;
  state: string;
  avatarUrl?: string;
  /** Assigned by the API on a successful login; the local persona list has no roles. */
  role?: 'TEHSILDAR' | 'PATWARI' | 'DATA_ENTRY_OPERATOR' | 'AUDITOR';
  email?: string;
  /**
   * Jurisdiction assignments the server holds for this session, sent for interface scoping only.
   * The server re-reads them from user_jurisdictions on every request and never trusts these.
   */
  districts?: string[];
  /** Capability grants, e.g. STATE_WIDE_READ. Informational — the server is the authority. */
  capabilities?: string[];
}

export type RecordType = 
  | 'Jamabandi (RoR - Record of Rights)'
  | 'Khasra Girdawari (Harvest Inspection)'
  | 'Dakhil Kharij (Mutation Register)'
  | 'Shajra Kishtwar (Cadastral Map)'
  | 'Bahi Khata (Historical Ledger)';

export type DocumentStatus = 
  | 'Uploaded'
  | 'Quality Checked'
  | 'Processing'
  | 'Extraction Ready'
  | 'Validation Review'
  | 'Pending Verification'
  | 'Under Review'
  | 'Verified'
  | 'Rejected'
  | 'Flagged for Patwari';

export interface BoundingBox {
  id: string;
  field: string;
  x: number; // % from left
  y: number; // % from top
  width: number; // % width
  height: number; // % height
  confidence: number;
}

export interface QualityMetrics {
  dpi: number;
  skewAngle: number; // in degrees
  blurScore: number; // 0 to 100 (higher = sharper)
  lighting: 'Uniform' | 'Moderate Shadow' | 'Severe Glare/Shadow' | 'Not measured';
  stainsAndFolds: 'Clean' | 'Minor Creases' | 'Severe Staining & Ink Bleed' | 'Not measured';
  contrastRatio: number; // e.g. 14.2:1
  overallScore: number; // 0 to 100
  passed: boolean;
}

export interface QualityEnhancements {
  deskew: boolean;
  deskewAngle: number;
  binarize: boolean;
  denoise: boolean;
  contrastBoost: boolean;
  sharpen: boolean;
  invertColors: boolean;
  brightness: number; // -50 to +50
  contrast: number; // 50 to 200
  zoom: number; // 50 to 400
}

export interface LandOwner {
  id: string;
  name: string;
  hindiName: string;
  relationType: 's/o' | 'd/o' | 'w/o' | 'c/o';
  relativeName: string;
  relativeHindiName: string;
  shareFraction: string; // e.g. "1/3" or "2/6"
  sharePercentage: number; // e.g. 33.33
  casteOrCategory?: string;
  aadhaarRef?: string; // masked
  status: 'Active Co-sharer' | 'Deceased (Mutation Pending)' | 'Minor (Guardian)' | 'Disputed Share';
}

export interface ExtractedField<T> {
  value: T;
  hindiValue?: string;
  originalOcr: string;
  confidence: number; // 0 - 100
  bbox?: BoundingBox;
  isFlagged?: boolean;
  flagReason?: string;
  manualOverride?: boolean;
  history?: Array<{ by: string; at: string; from: T; to: T }>;
}

export interface ValidationError {
  id: string;
  ruleCode: string;
  category: 'Area Math' | 'Ownership Share' | 'Cadastral Survey' | 'Encumbrance' | 'Mutation Record' | 'OCR Quality';
  severity: 'Critical' | 'Warning' | 'Informational';
  title: string;
  description: string;
  suggestedAction: string;
  resolved: boolean;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface LandRecordData {
  khasraNo: ExtractedField<string>;
  khatauniNo: ExtractedField<string>;
  khewatNo: ExtractedField<string>;
  villageMauza: ExtractedField<string>;
  patwarCircle: ExtractedField<string>;
  tehsil: ExtractedField<string>;
  district: ExtractedField<string>;
  state: ExtractedField<string>;
  settlementYear: ExtractedField<string>;
  owners: LandOwner[];
  rakbaArea: {
    bigha: number;
    biswa: number;
    biswansi: number;
    totalHectares: number;
    standardAcre: number;
    confidence: number;
    isFlagged?: boolean;
    flagReason?: string;
  };
  landClassification: ExtractedField<'Chahi (Well Irrigated)' | 'Nahri (Canal Irrigated)' | 'Barani (Rainfed)' | 'Gair Mumkin (Non-arable / Built-up)' | 'Banjar Jadid / Qadeem (Fallow)' | '—'>;
  soilClass: ExtractedField<string>;
  annualLagaanRevenue: ExtractedField<number>;
  encumbrance: {
    isMortgaged: boolean;
    bankName?: string;
    loanAccountNo?: string;
    mortgageAmountINR?: number;
    courtInjunctionActive: boolean;
    courtCaseRef?: string;
    remarks?: string;
  };
  mutationDetails: {
    lastMutationNo: string;
    mutationDate: string;
    mutationType: 'Sale Deed (Bainama)' | 'Inheritance (Wirasat)' | 'Partition (Batwara)' | 'Gift (Hiba)' | 'None' | '—';
    approvingAuthority: string;
  };
}

export interface DocumentRecord {
  id: string;
  /** Canonical spatial record link when a document is associated with a parcel. */
  parcelId?: string;
  documentCode: string;
  fileName: string;
  uploadedAt: string;
  recordType: RecordType;
  district: string;
  tehsil: string;
  village: string;
  patwarCircle: string;
  status: DocumentStatus;
  priority: 'High' | 'Medium' | 'Low';
  imageUri: string;
  enhancedImageUri?: string;
  qualityMetrics: QualityMetrics;
  qualityEnhancements: QualityEnhancements;
  data: LandRecordData;
  rawOcrText?: string;
  ocrLanguage?: string;
  isAccepted?: boolean;
  /** True when the record came from bundled sample text rather than a reading of a scan. */
  isSimulated?: boolean;
  ocrWords?: Array<{ id: string; text: string; confidence: number; bbox?: BoundingBox }>;
  ocrEngines: {
    tesseractConfidence: number;
    trocrConfidence: number;
    indicOcrConfidence: number;
    ensembleConfidence: number;
    characterErrorRate: number;
    processingTimeMs: number;
  };
  validationErrors: ValidationError[];
  auditTrail: {
    uploadedBy: string;
    processedAt?: string;
    qualityCheckedAt?: string;
    verifiedBy?: string;
    verifiedAt?: string;
    verifierBadge?: string;
    digitalSignatureHash?: string;
    certificateNumber?: string;
    qrPayload?: string;
    patwariRemarks?: string;
    verificationNotes?: string;
  };
  processingLogs: Array<{
    timestamp: string;
    stage: string;
    message: string;
    level: 'info' | 'success' | 'warning' | 'error';
  }>;
}

export interface BulkBatch {
  id: string;
  batchName: string;
  district: string;
  tehsil: string;
  village: string;
  recordType: RecordType;
  totalDocuments: number;
  processedCount: number;
  verifiedCount: number;
  flaggedCount: number;
  failedCount: number;
  status: 'Queued' | 'Scanning' | 'OCR In Progress' | 'Validation Ready' | 'Completed' | 'Paused';
  startedAt: string;
  estimatedCompletion: string;
  throughputPerPageHour: number;
  documents: DocumentRecord[];
}

export interface DistrictMetric {
  district: string;
  totalVillages: number;
  completedVillages: number;
  totalRecords: number;
  digitizedRecords: number;
  verifiedRecords: number;
  disputedRecords: number;
  accuracyScore: number;
  digitizedAreaHectares: number;
  pendingReview: number;
  ocrAccuracyRate: number;
  completionPercentage: number;
  lastUpdated: string;
}

export interface LandParcel {
  id: string;
  documentId?: string;
  /** Local/demo object URL for a document uploaded directly from the parcel workflow. */
  documentUri?: string;
  boundary: Array<{ lat: number; lng: number }>;
  district?: string;
  tehsil?: string;
  village?: string;
  mappedAreaHectares: number;
  colour: string;
  /** Kept for backward compatibility with the original prototype. */
  ownerName: string;
  /** Parcel-first ownership model; supports co-sharers and proportional area analysis. */
  owners: LandOwner[];
  khasraNo: string;
  khataNo: string;
  khewatNo?: string;
  recordedAreaHectares?: number;
  landType: string;
  inheritance: string;
  mutationHistory: Array<{ date: string; type: string; note: string }>;
  documentName?: string;
  documentType?: string;
  documentUploadedAt?: string;
  documentDisplayId?: string;
  status: 'Draft' | 'Mapped' | 'Needs Field Verification' | 'Verified' | 'Needs Review' | 'Archived';
  isArchived?: boolean;
  archivedAt?: string;
  archiveReason?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  verificationNotes?: string;
  createdAt: string;
  inspectionHistory?: FieldInspectionRecord[];
  /** ULPIN external government link readiness state. */
  ulpin?: string;
  ulpinStatus?: 'Pending Government Linkage' | 'Linked' | 'Not Linked';
  /** Demo / Reference imagery comparison metadata. */
  imageryComparison?: {
    historicalYear: number;
    currentYear: number;
    observedChange: string;
    status: 'Normal' | 'Review Recommended' | 'Field Verification Required';
    notes?: string;
  };
}

export interface FieldCheckpoint {
  id: string;
  label: string;
  hindiLabel: string;
  status: 'passed' | 'failed' | 'pending' | 'flagged';
  notes?: string;
}

export interface FieldInspectionRecord {
  id: string;
  parcelId: string;
  inspectedAt: string;
  inspectedBy: string;
  inspectorRole: string;
  gpsCoords?: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  };
  deviceHeadingDeg?: number;
  checkpoints: FieldCheckpoint[];
  discrepancyObserved: boolean;
  discrepancyNotes?: string;
  observedLandUse: string;
  photoUri?: string;
  photoTimestamp?: string;
  isProvisional: boolean;
  recommendedAction: 'Proceed to Officer Seal' | 'Flag for Revenue Court' | 'Re-survey Required';
}

export interface BackendHealthInfo {
  status: 'connected' | 'disconnected' | 'dev-fallback';
  storageMode: 'postgres-postgis' | 'dev-fallback';
  postgisAvailable: boolean;
  version?: string;
  database?: string;
  uptimeSeconds?: number;
  lastSync?: string;
}

export type ActiveView = 
  | 'login'
  | 'dashboard'
  | 'spatial_registry'
  | 'upload'
  | 'quality_check'
  | 'processing'
  | 'extraction_results'
  | 'record_validation'
  | 'verification_queue'
  | 'human_verification'
  | 'field_verification'
  | 'verified_record'
  | 'bulk_processing'
  | 'digitization_reports'
  | 'reports';
