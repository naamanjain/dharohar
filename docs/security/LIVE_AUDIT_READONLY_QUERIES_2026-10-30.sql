-- DHAROHAR live audit — READ-ONLY query pack (v2, every column below was read out of
-- server/src/db/migrations-mysql/0001_register_schema.sql before being written here).
-- Run in the hosting database console against `<the application database>`. Every statement is SELECT or SHOW.
-- Paste each numbered block's output back to me. Row counts and QA values are enough;
-- these queries are scoped so real citizens' names should not appear — if one does, redact it.
--
-- Synthetic QA conventions used by this audit:
--   parcel id   QA-DHAROHAR-20261030-001 .. -0NN
--   khasra_no   QA-DHAROHAR-20261030-<n>

-- ---------------------------------------------------------------------------
-- A. Deployment vs source (Phase 9). Decides SEC-01: is session revocation applied?
-- ---------------------------------------------------------------------------
A1| SELECT version, name, filename, applied_at FROM schema_migrations ORDER BY version;
A2| SHOW COLUMNS FROM users LIKE 'sessions_revoked_at';
A3| SELECT COUNT(*) AS parcels_total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM parcels;
A4| SELECT COUNT(*) AS audit_rows, MAX(created_at) AS last_audit FROM append_only_audit_logs;
A5| SELECT id, role, district, organization_id, sessions_revoked_at
    FROM users WHERE role = 'SYSTEM_ADMIN' ORDER BY created_at;
    -- report the count and whether sessions_revoked_at is NULL. Emails are not needed.

-- ---------------------------------------------------------------------------
-- B. District scoping model (Phase 3C). Grants must come from user_jurisdictions,
--    never be invented from the user's own users.district value.
-- ---------------------------------------------------------------------------
B1| SELECT u.id, u.role, u.district AS users_district, u.district_code AS users_district_code,
           uj.district AS granted_district, uj.district_code AS granted_code,
           uj.granted_by, uj.revoked_at
    FROM users u LEFT JOIN user_jurisdictions uj ON uj.user_id = u.id
    ORDER BY u.id LIMIT 40;
B2| SELECT COUNT(*) AS open_grants FROM user_jurisdictions WHERE revoked_at IS NULL;
B3| SELECT capability, COUNT(*) AS n FROM user_capabilities WHERE revoked_at IS NULL GROUP BY capability;
B4| SELECT code, name, kind, is_active, retired_at FROM districts WHERE is_active = 1 ORDER BY code LIMIT 40;

-- ---------------------------------------------------------------------------
-- C. Baseline around each synthetic QA record (Phase 4 step 1).
--    Run C1+C2+C3 BEFORE a UI write and again AFTER. C3 must not move.
-- ---------------------------------------------------------------------------
C1| SELECT COUNT(*) AS qa_rows_now FROM parcels WHERE id LIKE 'QA-DHAROHAR-20261030%';
C2| SELECT id, khasra_no, khata_no, khewat_no, district, tehsil, village,
           mapped_area_ha, recorded_area_ha, status, ulpin_status,
           is_archived, verified_by, verified_at, document_id, document_display_id, owner_name
    FROM parcels WHERE id LIKE 'QA-DHAROHAR-20261030%' ORDER BY created_at;
C3| SELECT COUNT(*) AS non_qa_parcel_rows FROM parcels WHERE id NOT LIKE 'QA-DHAROHAR-20261030%';

-- ---------------------------------------------------------------------------
-- D. Duplicate detection — a 200 response that produced two rows is a failure.
-- ---------------------------------------------------------------------------
D1| SELECT khasra_no, COUNT(*) AS n FROM parcels
    WHERE khasra_no LIKE 'QA-DHAROHAR-20261030%' GROUP BY khasra_no HAVING COUNT(*) > 1;
D2| SELECT id, COUNT(*) AS n FROM parcels
    WHERE id LIKE 'QA-DHAROHAR-20261030%' GROUP BY id HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------------
-- E. Related rows written by the same operation (transactions, FK integrity)
-- ---------------------------------------------------------------------------
E1| SELECT p.id AS parcel_id, po.id AS owner_row_id, po.name AS owner_row_name, po.status
    FROM parcels p LEFT JOIN parcel_owners po ON po.parcel_id = p.id
    WHERE p.id LIKE 'QA-DHAROHAR-20261030%';
E2| SELECT pm.parcel_id, pm.id AS mutation_id, pm.mutation_type, pm.recorded_by, pm.created_at
    FROM parcel_mutations pm WHERE pm.parcel_id LIKE 'QA-DHAROHAR-20261030%' ORDER BY pm.created_at;
E3| SELECT fi.parcel_id, fi.id AS inspection_id, fi.inspected_at, fi.inspected_by,
           fi.discrepancy_observed, fi.observed_land_use
    FROM field_inspections fi WHERE fi.parcel_id LIKE 'QA-DHAROHAR-20261030%';
E4| SELECT ld.id AS document_id, ld.parcel_id, ld.document_code, ld.file_name, ld.record_type,
           ld.status, ld.document_hash, ld.ocr_confidence, ld.uploaded_at
    FROM land_documents ld
    WHERE ld.parcel_id LIKE 'QA-DHAROHAR-20261030%' OR ld.uploaded_at >= CURDATE();
E5| SELECT a.id, a.entity_type, a.entity_id, a.action_type, a.performed_by, a.actor_user_id,
           a.created_at, LEFT(a.previous_hash, 12) AS prev12, LEFT(a.entry_hash, 12) AS entry12
    FROM append_only_audit_logs a
    WHERE a.entity_id LIKE 'QA-DHAROHAR-20261030%' OR a.parcel_id LIKE 'QA-DHAROHAR-20261030%'
    ORDER BY a.created_at;

-- ---------------------------------------------------------------------------
-- F. Append-only chain sanity (read-only, no mutation of the chain)
-- ---------------------------------------------------------------------------
F1| SELECT COUNT(*) AS null_hashes FROM append_only_audit_logs
    WHERE entry_hash IS NULL OR previous_hash IS NULL;
F2| SELECT COUNT(*) AS reused_entry_hashes FROM (
        SELECT entry_hash FROM append_only_audit_logs GROUP BY entry_hash HAVING COUNT(*) > 1) t;

-- ---------------------------------------------------------------------------
-- G. Dashboard metric reconciliation (Phase 3D) — compare against the numbers on screen
-- ---------------------------------------------------------------------------
G1| SELECT district, COUNT(*) AS parcels, ROUND(SUM(mapped_area_ha), 2) AS mapped_ha,
           ROUND(SUM(recorded_area_ha), 2) AS recorded_ha
    FROM parcels WHERE is_archived = 0 GROUP BY district ORDER BY parcels DESC LIMIT 20;
G2| SELECT status, COUNT(*) AS n FROM parcels GROUP BY status ORDER BY n DESC;
G3| SELECT COUNT(*) AS mapped_area_zero_or_null FROM parcels WHERE mapped_area_ha IS NULL OR mapped_area_ha = 0;
G4| SELECT COUNT(*) AS recorded_area_null FROM parcels WHERE recorded_area_ha IS NULL;

-- ---------------------------------------------------------------------------
-- H. Cleanup verification — only after authorized removal/archival
-- ---------------------------------------------------------------------------
H1| SELECT id, is_archived, archived_at, archive_reason FROM parcels WHERE id LIKE 'QA-DHAROHAR-20261030%';
H2| SELECT COUNT(*) AS orphan_owner_rows FROM parcel_owners po
    LEFT JOIN parcels p ON p.id = po.parcel_id WHERE p.id IS NULL;
H3| SELECT COUNT(*) AS orphan_document_rows FROM land_documents ld
    LEFT JOIN parcels p ON p.id = ld.parcel_id WHERE ld.parcel_id IS NOT NULL AND p.id IS NULL;
