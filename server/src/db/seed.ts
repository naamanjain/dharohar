import { pool, initDbConnection, memoryStore, INITIAL_USERS, DEMO_CAPABILITY_GRANTS } from './db';
import { GENESIS_AUDIT_HASH, computeAuditEntryHash, sha256 } from '../utils/crypto';
import { DEMO_PASSWORD, IS_PRODUCTION } from '../config/env';

export const INITIAL_PARCELS = [
  {
    id: 'DH-JPR-RAM-001024',
    khasraNo: '412/1',
    khataNo: '78',
    khewatNo: '19',
    patwarCircle: 'Rampur South',
    district: 'Jaipur',
    tehsil: 'Sanganer',
    village: 'Rampur',
    mappedAreaHectares: 1.29,
    recordedAreaHectares: 1.315,
    colour: '#2563eb',
    ownerName: 'Harish Chandra Verma',
    owners: [
      {
        id: 'own-1',
        name: 'Harish Chandra Verma',
        hindiName: 'हरीश चंद्र वर्मा',
        relationType: 's/o',
        relativeName: 'Ramprasad Verma',
        relativeHindiName: 'रामप्रसाद वर्मा',
        shareFraction: '1/2',
        sharePercentage: 50.0,
        status: 'Active Co-sharer',
      },
      {
        id: 'own-2',
        name: 'Suresh Kumar Verma',
        hindiName: 'सुरेश कुमार वर्मा',
        relationType: 's/o',
        relativeName: 'Ramprasad Verma',
        relativeHindiName: 'रामप्रसाद वर्मा',
        shareFraction: '1/2',
        sharePercentage: 50.0,
        status: 'Active Co-sharer',
      },
    ],
    boundary: [
      { lat: 26.842, lng: 75.789 },
      { lat: 26.844, lng: 75.794 },
      { lat: 26.841, lng: 75.798 },
      { lat: 26.838, lng: 75.794 },
      { lat: 26.839, lng: 75.789 },
    ],
    landType: 'Chahi (Well Irrigated)',
    inheritance: 'Current holder through registered succession; co-sharer history retained.',
    mutationHistory: [
      { date: '04 Oct 2023', type: 'Sale Deed', note: 'Mutation Mut-2023/419 approved by Tehsildar Sanganer.' },
      { date: '12 Jun 2019', type: 'Inheritance', note: 'Succession entry recorded.' },
    ],
    documentId: 'DOC-RAJ-2025-08912',
    documentName: 'Jamabandi_2023_Khasra_412.pdf',
    documentType: 'Jamabandi (RoR - Record of Rights)',
    documentUploadedAt: '2026-09-18 10:00:00',
    documentDisplayId: 'DOC-JPR-2023-412',
    status: 'Verified',
    ulpinStatus: 'Pending Government Linkage',
    verifiedBy: 'Shri Arvind Sharma, RAS',
    verifiedAt: '2026-09-18 11:30:00',
    verificationNotes: 'Verified against Master Shajra Cadastre. All ownership shares confirmed.',
    createdAt: '2026-09-18T10:00:00Z',
  },
  {
    id: 'DH-UDA-KOT-001117',
    khasraNo: '77/1',
    khataNo: '104',
    khewatNo: '12',
    patwarCircle: 'Kothari Circle',
    district: 'Udaipur',
    tehsil: 'Girwa',
    village: 'Kothari',
    mappedAreaHectares: 0.82,
    recordedAreaHectares: 0.96,
    colour: '#16a34a',
    ownerName: 'Savitri Devi',
    owners: [
      {
        id: 'own-3',
        name: 'Savitri Devi',
        hindiName: 'सावित्री देवी',
        relationType: 'w/o',
        relativeName: 'Lt. Mohan Lal',
        relativeHindiName: 'स्व. मोहन लाल',
        shareFraction: '1/1',
        sharePercentage: 100.0,
        status: 'Active Co-sharer',
      },
    ],
    boundary: [
      { lat: 26.846, lng: 75.781 },
      { lat: 26.848, lng: 75.786 },
      { lat: 26.845, lng: 75.790 },
      { lat: 26.842, lng: 75.786 },
    ],
    landType: 'Barani (Rainfed)',
    inheritance: 'Deceased co-owner; succession pending field verification.',
    mutationHistory: [
      { date: '18 Feb 2024', type: 'Inheritance', note: 'Pending field verification.' },
    ],
    documentId: 'DOC-RAJ-2025-08913',
    documentName: 'Khasra_Girdawari_Kothari_Village_77_1.pdf',
    documentType: 'Khasra Girdawari (Harvest Inspection)',
    documentUploadedAt: '2026-09-18 10:15:00',
    documentDisplayId: 'DOC-UDA-2024-77-1',
    status: 'Needs Field Verification',
    ulpinStatus: 'Pending Government Linkage',
    verificationNotes: 'Discrepancy observed between recorded rakba (0.96 ha) and provisional mapped boundary (0.82 ha).',
    createdAt: '2026-09-18T10:15:00Z',
  },
  {
    id: 'DH-JOD-OSI-001245',
    khasraNo: '205/1',
    khataNo: '52',
    khewatNo: '14',
    patwarCircle: 'Bhed Circle',
    district: 'Jodhpur',
    tehsil: 'Osian',
    village: 'Bhed',
    mappedAreaHectares: 2.15,
    recordedAreaHectares: 2.15,
    colour: '#d97706',
    ownerName: 'Bhanwar Lal Bishnoi',
    owners: [
      {
        id: 'own-4',
        name: 'Bhanwar Lal Bishnoi',
        hindiName: 'भंवर लाल बिश्नोई',
        relationType: 's/o',
        relativeName: 'Kishna Ram',
        relativeHindiName: 'किशना राम',
        shareFraction: '1/1',
        sharePercentage: 100.0,
        status: 'Active Co-sharer',
      },
    ],
    boundary: [
      { lat: 26.835, lng: 75.775 },
      { lat: 26.839, lng: 75.779 },
      { lat: 26.836, lng: 75.784 },
      { lat: 26.832, lng: 75.780 },
    ],
    landType: 'Nahri (Canal Irrigated)',
    inheritance: 'Ancestral landholding confirmed.',
    mutationHistory: [
      { date: '10 Jan 2022', type: 'Partition', note: 'Partition deed Mut-2022/88 recorded.' },
    ],
    documentId: 'DOC-RAJ-2025-08914',
    documentName: 'Dakhil_Kharij_205.pdf',
    documentType: 'Dakhil Kharij (Mutation Register)',
    documentUploadedAt: '2026-09-18 10:30:00',
    documentDisplayId: 'DOC-JOD-2022-205',
    status: 'Mapped',
    ulpinStatus: 'Pending Government Linkage',
    createdAt: '2026-09-18T10:30:00Z',
  },
];

export const INITIAL_DOCUMENTS = [
  {
    id: 'DOC-RAJ-2025-08912',
    parcelId: 'DH-JPR-RAM-001024',
    documentCode: 'DOC-JPR-2023-412',
    fileName: 'Jamabandi_2023_Khasra_412.pdf',
    recordType: 'Jamabandi (RoR - Record of Rights)',
    ocrLanguage: 'hin+eng',
    rawOcrText: 'जमाबंदी नकल मौजा रामपुर खसरा संख्या ४१२/१ खाता संख्या ७८',
    district: 'Jaipur',
    tehsil: 'Sanganer',
    village: 'Rampur',
    patwarCircle: 'Rampur South',
    status: 'Verified',
    priority: 'High',
    documentHash: sha256('Jamabandi_2023_Khasra_412_content_hash'),
    ocrConfidence: 98.6,
    uploadedBy: 'Vikram Singh Rathore',
    uploadedAt: '2026-09-18T10:00:00Z',
  },
  {
    id: 'DOC-RAJ-2025-08913',
    parcelId: 'DH-UDA-KOT-001117',
    documentCode: 'DOC-UDA-2024-77-1',
    fileName: 'Khasra_Girdawari_Kothari_Village_77_1.pdf',
    recordType: 'Khasra Girdawari (Harvest Inspection)',
    ocrLanguage: 'hin+eng',
    rawOcrText: 'खसरा गिरदावरी मौजा कोठारी खसरा संख्या ७७/१ खाता संख्या १०४ रकबा ०.९६ हेक्टेयर',
    district: 'Udaipur',
    tehsil: 'Girwa',
    village: 'Kothari',
    patwarCircle: 'Kothari Circle',
    status: 'Needs Review',
    priority: 'High',
    documentHash: sha256('Khasra_Girdawari_Kothari_Village_77_1_content_hash'),
    ocrConfidence: 97.4,
    uploadedBy: 'Vikram Singh Rathore',
    uploadedAt: '2026-09-18T10:15:00Z',
  },
  {
    id: 'DOC-RAJ-2025-08914',
    parcelId: 'DH-JOD-OSI-001245',
    documentCode: 'DOC-JOD-2022-205',
    fileName: 'Dakhil_Kharij_205.pdf',
    recordType: 'Dakhil Kharij (Mutation Register)',
    ocrLanguage: 'hin+eng',
    rawOcrText: 'दाखिल खारिज रजिस्टर मौजा भेड़ खसरा संख्या २०५/१',
    district: 'Jodhpur',
    tehsil: 'Osian',
    village: 'Bhed',
    patwarCircle: 'Bhed Circle',
    status: 'Extraction Ready',
    priority: 'Medium',
    documentHash: sha256('Dakhil_Kharij_205_content_hash'),
    ocrConfidence: 96.8,
    uploadedBy: 'Vikram Singh Rathore',
    uploadedAt: '2026-09-18T10:30:00Z',
  },
];

export async function seedDatabase() {
  // This inserts FABRICATED officer accounts, parcels, co-sharers and documents. Against a real
  // land-records database that is corruption, not setup — so production requires an explicit,
  // operator-supplied confirmation rather than running because a deploy script happened to call it.
  if (IS_PRODUCTION && process.env.SEED_CONFIRM !== 'demo') {
    throw new Error(
      'Refusing to seed demo records into a production database. ' +
        'This writes fabricated officers, parcels and co-sharers that are not real land records. ' +
        'If you genuinely want the demo dataset, re-run with SEED_CONFIRM=demo.'
    );
  }

  console.log(
    IS_PRODUCTION
      ? '[DHAROHAR DB] SEED_CONFIRM=demo accepted — inserting DEMO records into a PRODUCTION database.'
      : '[DHAROHAR DB] Seeding database with authoritative demo accounts and land parcels...'
  );

  const health = await initDbConnection();

  // 1. Seed memory store for users
  for (const user of INITIAL_USERS) {
    memoryStore.users.set(user.id, user);
  }

  // 2. Seed memory store for parcels & owners
  for (const parcel of INITIAL_PARCELS) {
    memoryStore.parcels.set(parcel.id, {
      ...parcel,
      isArchived: false,
    });
    memoryStore.owners.set(parcel.id, parcel.owners);
  }

  // 3. Seed memory store for documents
  for (const doc of INITIAL_DOCUMENTS) {
    memoryStore.documents.set(doc.id, doc);
  }

  // 4. Seed initial append-only audit trail with hash chaining
  memoryStore.auditLogs = [];
  let prevHash = GENESIS_AUDIT_HASH;

  const initialAuditEvents = [
    {
      parcelId: 'DH-JPR-RAM-001024',
      entityType: 'PARCEL' as const,
      entityId: 'DH-JPR-RAM-001024',
      actionType: 'PARCEL_CREATED',
      performedBy: 'Shri Arvind Sharma, RAS',
      officerBadge: 'RJ-REV-2018-0941',
      details: { note: 'Initial cadastral polygon mapped from Shajra Kishtwar' },
      createdAt: '2026-09-18T10:00:00Z',
    },
    {
      parcelId: 'DH-JPR-RAM-001024',
      documentId: 'DOC-RAJ-2025-08912',
      entityType: 'DOCUMENT' as const,
      entityId: 'DOC-RAJ-2025-08912',
      actionType: 'DOCUMENT_LINKED',
      performedBy: 'Vikram Singh Rathore',
      officerBadge: 'RJ-OPS-2023-1109',
      details: { documentName: 'Jamabandi_2023_Khasra_412.pdf', verifiedKhasra: '412/1' },
      createdAt: '2026-09-18T10:30:00Z',
    },
    {
      parcelId: 'DH-JPR-RAM-001024',
      entityType: 'VERIFICATION_SEAL' as const,
      entityId: 'DH-JPR-RAM-001024',
      actionType: 'RECORD_SEALED',
      performedBy: 'Shri Arvind Sharma, RAS',
      officerBadge: 'RJ-REV-2018-0941',
      details: {
        certificateNumber: 'CERT-DHR-2026-849201',
        notes: 'Verified against Master Shajra Cadastre. All ownership shares confirmed.',
      },
      signatureHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      createdAt: '2026-09-18T11:30:00Z',
    },
    {
      parcelId: 'DH-UDA-KOT-001117',
      entityType: 'PARCEL' as const,
      entityId: 'DH-UDA-KOT-001117',
      actionType: 'PARCEL_CREATED',
      performedBy: 'Vikram Singh Rathore',
      officerBadge: 'RJ-OPS-2023-1109',
      details: { note: 'Provisional boundary mapped; area discrepancy 0.14 ha detected vs recorded Rakba' },
      createdAt: '2026-09-18T10:15:00Z',
    },
  ];

  for (let i = 0; i < initialAuditEvents.length; i++) {
    const ev = initialAuditEvents[i];
    const entryHash = computeAuditEntryHash(
      prevHash,
      ev.entityId,
      ev.actionType,
      ev.performedBy,
      ev.createdAt,
      ev.details
    );

    memoryStore.auditLogs.push({
      id: i + 1,
      parcelId: ev.parcelId,
      documentId: ev.documentId,
      entityType: ev.entityType,
      entityId: ev.entityId,
      actionType: ev.actionType,
      performedBy: ev.performedBy,
      officerBadge: ev.officerBadge,
      details: ev.details,
      previousHash: prevHash,
      entryHash,
      signatureHash: ev.signatureHash,
      createdAt: ev.createdAt,
    });

    prevHash = entryHash;
  }

  if (health.storageMode !== 'postgres-postgis') {
    console.log('[DHAROHAR DB] Seeded memory store for dev-fallback mode with 4 users, 3 parcels, 3 docs, and audit chain.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 0. Register every district the demo rows name, BEFORE any row references one.
    //
    // Since migration 0003 a jurisdiction that is not in the registry is refused at write time — the
    // database will not invent one — so seeding has to declare its own fixture districts first. They
    // are recorded as 'derived' for the same reason 0002 used that value: the row exists because some
    // record named the place, not because an administrator declared a boundary.
    const seedDistricts = [
      ...new Set(
        [...INITIAL_USERS.map((u) => u.district), ...INITIAL_PARCELS.map((p) => p.district)]
          .filter((d): d is string => !!d && d.trim() !== '')
      ),
    ];
    for (const d of seedDistricts) {
      await client.query(
        `INSERT INTO districts (code, name, provenance)
         VALUES (LOWER(TRIM($1)), $1, 'derived')
         ON CONFLICT (code) DO NOTHING`,
        [d]
      );
    }

    // 0b. Resolve the tenant the demo rows belong to, BEFORE any row is written.
    //
    // Since migration 0006 a record with no organization is quarantined: it stays in the database but
    // is invisible to every tenant, at both layers. Seed rows written without an owner therefore
    // produce an environment that looks empty to the officer you bootstrap next. "The only tenant this
    // environment has" is the same stated basis 0006 uses for the rows that already existed — it is not
    // an inference from which district a row sits in, and the moment a second tenant exists the basis
    // stops existing, so the seed refuses rather than distributing fixtures across tenants by guesswork.
    const seedGrantor = 'seed:db:seed';
    const seedReason =
      'Synthetic demo fixture written by db:seed. Demo data only: not a statement about real land records.';
    const registry = await client.query(`SELECT to_regclass('public.organizations') IS NOT NULL AS present`);
    let tenantCount = 0;
    let seedTenantId: string | null = null;
    if (registry.rows[0].present) {
      const tenants = await client.query(`SELECT id FROM public.organizations ORDER BY id`);
      tenantCount = tenants.rowCount ?? 0;
      if (tenantCount === 1) seedTenantId = tenants.rows[0].id;
    }
    if (tenantCount > 1) {
      throw new Error(
        `[SEED_TENANT_AMBIGUOUS] this database has ${tenantCount} organizations, so there is no single tenant ` +
          'these fixtures belong to. Seeding would either invent an owner for every demo record or leave them all ' +
          'quarantined. Assign ownership per record through the disposition command instead, and seed only a ' +
          'single-tenant demo environment.'
      );
    }
    if (!seedTenantId) {
      console.warn(
        '[DHAROHAR DB] No organization exists yet, so seeded records are written unowned. They will be ' +
          'invisible to every tenant until ownership is assigned (server/src/db/assignOwnership.ts).'
      );
    }
    // The three inserts below carry 12, 27 and 17 positional parameters, so the tenant columns are
    // $13-$15, $28-$30 and $18-$20. `now()` is not parameterised because it is not caller input.
    const ownerColumns = seedTenantId
      ? ', organization_id, organization_granted_by, organization_grant_reason, organization_granted_at'
      : '';
    const ownerUsers = seedTenantId ? ', $13, $14, $15, now()' : '';
    const ownerParcels = seedTenantId ? ', $28, $29, $30, now()' : '';
    const ownerDocuments = seedTenantId ? ', $18, $19, $20, now()' : '';
    const ownerParams = seedTenantId ? [seedTenantId, seedGrantor, seedReason] : [];

    // 1. Seed users
    for (const u of INITIAL_USERS) {
      await client.query(
        `INSERT INTO users (
          id, email, password_hash, salt, role, display_name, designation,
          badge_number, jurisdiction, district, state, created_at${ownerColumns}
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12${ownerUsers})
        ON CONFLICT (id) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          role = EXCLUDED.role,
          display_name = EXCLUDED.display_name,
          designation = EXCLUDED.designation
          ${seedTenantId ? `, organization_id = COALESCE(users.organization_id, EXCLUDED.organization_id),
            organization_granted_by = COALESCE(users.organization_granted_by, EXCLUDED.organization_granted_by),
            organization_grant_reason = COALESCE(users.organization_grant_reason, EXCLUDED.organization_grant_reason),
            organization_granted_at = COALESCE(users.organization_granted_at, EXCLUDED.organization_granted_at)` : ''};`,
        [
          u.id, u.email, u.passwordHash, u.salt, u.role, u.displayName,
          u.designation, u.badgeNumber, u.jurisdiction, u.district, u.state, u.createdAt,
          ...ownerParams
        ]
      );
    }

    // 1b. Demo jurisdiction assignments.
    //
    // Authorization reads user_jurisdictions, not users.district, so a persona without an assignment
    // row would be denied everything. These rows describe the demo personas only — a real officer is
    // assigned by an administrator through the provisioning path, never by seeding.
    for (const u of INITIAL_USERS) {
      if (!u.district) continue;
      await client.query(
        `INSERT INTO districts (code, name, provenance)
         VALUES (LOWER(TRIM($1)), $1, 'derived')
         ON CONFLICT (code) DO NOTHING`,
        [u.district]
      );
      await client.query(
        `INSERT INTO user_jurisdictions (user_id, district, granted_by)
         VALUES ($1, $2, 'seed:demo_persona')
         ON CONFLICT (user_id, district) DO NOTHING`,
        [u.id, u.district]
      );

      // Same source of truth the in-memory principal loader uses, so dev and PostgreSQL agree.
      for (const capability of DEMO_CAPABILITY_GRANTS[u.id] ?? []) {
        await client.query(
          `INSERT INTO user_capabilities (user_id, capability, granted_by)
           VALUES ($1, $2, 'seed:demo_persona')
           ON CONFLICT (user_id, capability) DO NOTHING`,
          [u.id, capability]
        );
      }
    }

    // 2. Seed parcels
    for (const p of INITIAL_PARCELS) {
      const ring = [...p.boundary, p.boundary[0]]
        .map((pt) => `${pt.lng} ${pt.lat}`)
        .join(', ');
      const wkt = `POLYGON((${ring}))`;

      await client.query(
        `INSERT INTO parcels (
          id, khasra_no, khata_no, khewat_no, patwar_circle, district, tehsil, village,
          mapped_area_ha, recorded_area_ha, colour, owner_name, land_type,
          inheritance, document_id, document_name, document_type, document_uploaded_at,
          document_display_id, status, ulpin_status, is_archived, verified_by, verified_at,
          verification_notes, geom, created_at${ownerColumns}
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
          $23, $24, $25, ST_GeomFromText($26, 4326), $27${ownerParcels}
        ) ON CONFLICT (id) DO NOTHING;`,
        [
          p.id, p.khasraNo, p.khataNo, p.khewatNo, p.patwarCircle, p.district, p.tehsil, p.village,
          p.mappedAreaHectares, p.recordedAreaHectares, p.colour, p.ownerName, p.landType,
          p.inheritance, p.documentId, p.documentName, p.documentType, p.documentUploadedAt,
          p.documentDisplayId, p.status, p.ulpinStatus, false, p.verifiedBy || null, p.verifiedAt || null,
          p.verificationNotes || null, wkt, p.createdAt,
          ...ownerParams
        ]
      );

      // Insert owners
      for (const o of p.owners) {
        await client.query(
          `INSERT INTO parcel_owners (
            id, parcel_id, name, hindi_name, relation_type, relative_name,
            relative_hindi_name, share_fraction, share_percentage, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO NOTHING;`,
          [
            o.id, p.id, o.name, o.hindiName, o.relationType, o.relativeName,
            o.relativeHindiName, o.shareFraction, o.sharePercentage, o.status
          ]
        );
      }
    }

    // 3. Seed documents
    for (const d of INITIAL_DOCUMENTS) {
      await client.query(
        `INSERT INTO land_documents (
          id, parcel_id, document_code, file_name, record_type, ocr_language,
          raw_ocr_text, district, tehsil, village, patwar_circle, status,
          priority, document_hash, ocr_confidence, uploaded_by, uploaded_at${ownerColumns}
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17${ownerDocuments})
        ON CONFLICT (id) DO NOTHING;`,
        [
          d.id, d.parcelId, d.documentCode, d.fileName, d.recordType, d.ocrLanguage,
          d.rawOcrText, d.district, d.tehsil, d.village, d.patwarCircle, d.status,
          d.priority, d.documentHash, d.ocrConfidence, d.uploadedBy, d.uploadedAt,
          ...ownerParams
        ]
      );
    }

    await client.query('COMMIT');
    console.log('[DHAROHAR DB] Seed data populated into PostgreSQL with PostGIS geometries.');
    console.log(
      `[DHAROHAR DB] Demo records owned by: ${seedTenantId ?? 'NO TENANT — written unowned, invisible to every tenant'}`
    );
    // Printed once, by the command that just set it, to the person who ran it. The alternative —
    // shipping the demo password in the repository — gave anyone who could read the code a working
    // credential for four officer accounts.
    console.log(
      `[DHAROHAR DB] Demo persona password (all four accounts): ${DEMO_PASSWORD}\n` +
        '                    Set DEMO_PASSWORD yourself to choose it, and pass the same value to the\n' +
        '                    test suites. These accounts are demo fixtures: never seed them anywhere reachable.'
    );
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DHAROHAR DB] Seeding failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

import { fileURLToPath } from 'url';
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      // Exiting 1 silently makes a refused or failed seed look like a crash to whoever ran it.
      console.error('[DHAROHAR DB] Seeding aborted:', err?.message || err);
      process.exit(1);
    });
}
