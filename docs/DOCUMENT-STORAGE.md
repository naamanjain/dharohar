# Document Storage — Current State and Migration Path

Scope: the scanned Jamabandi / Khasra-Girdawari / Mutation images and field-inspection photos that
DHAROHAR keeps for each land record. This is a design document with a staged plan; **no part of it
is implemented yet.** Nothing here has been executed against a populated database.

---

## 1. Where the bytes live today (verified)

| Column | Type | Holds | Written by |
|---|---|---|---|
| `land_documents.image_uri` | `TEXT` | `data:image/<png\|jpeg>;base64,…` of the scanned page | `POST /api/documents`, `POST /api/parcels/:id/documents` |
| `field_inspections.photo_uri` | `TEXT` | `data:image/…;base64,…` from the camera capture | `POST /:id/field-inspections`, `/api/verifications/field-inspection` |
| `parcels.document_uri` | `TEXT` | a copy of the linked document's data URI | `POST /api/parcels`, `PATCH /api/parcels/:id` |

Frontend side: `DocumentUploadView.tsx:134` renders the uploaded file onto a canvas and produces the
data-URI string; `FieldVerificationView.tsx:321` does the same for the camera photo. The string is
posted inside the JSON body.

Consequences that are already true:

1. **Size ceiling.** Express caps a JSON body at **15 MB** (`index.ts:30`) and nginx at 25 MB
   (`client_max_body_size`). Base64 inflates by ~33 %, so a scan larger than roughly **11 MB cannot
   be stored at all**, and the failure surfaces as a request-body error rather than a storage error.
2. **Read amplification.** `PARCEL_SELECT` (`routes/parcels.ts:188`) is `SELECT p.* …`, so
   `GET /api/parcels` returns **every parcel's `document_uri`** — the whole base64 image — inside a
   list response. The registry list is the largest payload in the app for no reason.
   (`DashboardView.tsx:57` only tests whether `documentUri` is present, never renders it.)
3. **Backup coupling.** The images ride inside `pg_dump`. One dump carries both the ledger and the
   evidence, which is convenient today and will be the first thing that makes backups slow.
4. **The stored "checksum" is not a file checksum.** `documentHash = sha256(id:rawOcrText:imageUri)`
   — computed over the *concatenation the server received*, not over independently verifiable file
   bytes. It proves the row was not edited behind the API's back; it does not let a third party
   verify that a recovered file is intact.
5. **Retrieval is by authenticated API only.** There is no public URL for a document — access goes
   through `assertDocumentAccess`, which is the correct behaviour and must be preserved.
6. Some legacy rows carry non-image placeholders (`sample:<name>`, `mockFieldPhotoData`) from the
   demo flow. They must be recognised during any backfill instead of being treated as images.

---

## 2. Target state

```
browser ──(multipart or presigned PUT)──> object/file storage   ← bytes
                        │
                        └─> POST /api/documents { checksum, size, mime, key }
                                    │
                          PostgreSQL stores METADATA ONLY
                          (storage_key, sha256, bytes, mime, width/height, state)
                                    │
read:  GET /api/documents/:id/content  → authorises → streams from storage
```

Requirements the design must satisfy, restated from the release gate:

* Access control stays server-side — **no public URLs and no long-lived signed URLs that bypass
  `assertDocumentAccess`**.
* Real checksums over real bytes, recorded at write time and re-verifiable at read time.
* Backups must cover the bytes as well as the rows, and a restore must be able to put both back.
* Existing functionality keeps working during the migration; **no existing image is discarded.**

---

## 3. Storage backend decision

| Option | Fits ₹0 / self-hosted | Notes |
|---|---|---|
| **Local filesystem volume** (`dharohar_uploads`, already declared in `docker-compose.prod.yml`) | Yes | Simplest. Survives container recreation. Needs the volume included in backups and needs the API to hold the only handle on it. |
| MinIO / S3-compatible gateway on the same VM | Yes | Adds bucket policy, lifecycle and an audit surface; costs RAM (~1 GB) on a free-tier VM and one more service to secure. |
| Managed object storage (OCI Object Storage, etc.) | Partly | Cheapest to operate safely, but it is a **paid** service beyond the free allowance — requires explicit approval before enabling. |

Recommendation: **start on the mounted volume, behind an interface that behaves like an object
store** (`put(key, stream) / get(key) / delete(key) / stat(key)`), so moving to MinIO or OCI later
is a configuration change rather than a rewrite. Do not build a second abstraction on top of what is
already a thin one.

---

## 4. Staged migration (each stage shippable on its own)

### Stage 0 — stop the list-response bleeding (small, no schema change)
Select the metadata columns explicitly in `PARCEL_SELECT` instead of `p.*`, and return
`hasDocument: boolean` (+ `documentBytes` later) on list rows, keeping the full content on the single
record read. Before shipping, confirm with a browser pass that no list view renders a thumbnail from
the list payload; `DocumentViewer` reads `document.imageUri`, so if any registry row opens the
viewer directly from list data, it must be switched to fetch the detail record first.

### Stage 1 — additive schema (no data movement)
New migration `0002_document_blobs.sql`, forward-only and additive, following the rules in
`docs/DEPLOYMENT.md` §7:

```sql
CREATE TABLE document_blobs (
  storage_key    TEXT PRIMARY KEY,
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('LAND_DOCUMENT','FIELD_PHOTO','PARCEL_ATTACHMENT')),
  owner_id       TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  byte_length    BIGINT NOT NULL CHECK (byte_length > 0),
  sha256         CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state          TEXT NOT NULL DEFAULT 'stored' CHECK (state IN ('stored','migrating','verified','missing')),
  stored_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE land_documents     ADD COLUMN storage_key TEXT, ADD COLUMN content_sha256 CHAR(64), ADD COLUMN content_bytes BIGINT;
ALTER TABLE field_inspections  ADD COLUMN storage_key TEXT, ADD COLUMN content_sha256 CHAR(64);
```
Nothing is dropped. `image_uri` / `photo_uri` / `document_uri` stay exactly as they are until Stage 4.

### Stage 2 — dual write
New uploads write bytes to storage **and** keep filling the legacy column, in the same request:
compute `sha256` over the decoded bytes (not over the data-URI text), record `byte_length` and
`mime_type`, and store under an opaque key that embeds no PII and no district spelling —
e.g. `blobs/<yyyy>/<mm>/<sha256>.<ext>`. Write failures must fail the request with `503` and roll
the transaction back — the same rule the seal path already follows: never report a stored document
whose bytes are not there.

Raise the ceiling at the same time by switching to **multipart upload** (or a presigned PUT against
the object store) so the 15 MB JSON limit stops being the product's maximum scan size. nginx
`client_max_body_size` and the Express limit must be changed together, and the API limit remains
authoritative.

### Stage 3 — backfill existing rows, idempotently and verifiably
A script (`scripts/backfill-document-blobs.ts`) that, per row:

1. reads `image_uri`; skips `sample:` / non-base64 placeholders, recording them as `state='missing'`
   candidates for re-scan rather than inventing content;
2. decodes, hashes, writes the file, `fsync`s, re-reads and re-hashes to prove the bytes on disk
   match;
3. inserts the `document_blobs` row + sets `storage_key`/`content_sha256` on the owner row;
4. records progress so an interrupted run resumes, and never deletes the legacy column.

Rules: run it against a **restored copy** of production first, report counts (`processed / written /
mismatched / skipped`), and require the mismatch count to be zero before Stage 4. Batch it — the
first pass is also the moment you learn how large the corpus really is.

### Stage 4 — read through the API, then retire the columns
Add `GET /api/documents/:id/content` (and `…/field-inspections/:id/photo`) which runs
`assertDocumentAccess` / `assertParcelAccess`, then streams the object with
`Content-Type` and `Content-Security-Policy: default-src 'none'`, `Cache-Control: private,
max-age=300`. `DocumentViewer` uses that URL when `storage_key` is present and falls back to the
inline data URI while any row still has one.

Only after every row reports `state='verified'`: drop the base64 columns in a **separate,
deliberately scheduled** migration, with a fresh full backup taken immediately beforehand.

---

## 5. Access control rules that must survive the move

* The bytes are reachable **only** through the authenticated API. No static location in nginx for
  the blob directory; no bucket policy allowing public read.
* Presigned URLs, if ever used for direct uploads, must be short, single-object, write-only, and
  must never be the read path for an officer in another district.
* `assertDocumentAccess` semantics stay: district match, or the linked parcel's district, else
  **404**. A document whose district and parcel are both null is unreachable — which is why Stage 2
  must always file a district (the write path already does this since the fix in
  `routes/documents.ts`).
* Deletion is still soft: mark the blob `tombstoned` and keep it, because the audit chain and legal
  retention outlive any single record view. No purge endpoint (project rule).

---

## 6. Checksums, backup and restore for the bytes

* **At write**: sha256 over decoded bytes, stored in `document_blobs.sha256` and mirrored onto the
  owner row.
* **At read**: recompute and compare, log a `BLOB_CHECKSUM_MISMATCH` error and refuse to serve if it
  differs — the same "report the failure rather than paper over it" rule used everywhere else.
* **Scheduled**: a nightly `scripts/verify-blobs.ts` pass over a random sample (and a full pass
  weekly), so silent disk rot is found before an officer opens that record.
* **Backup**: `pg_dump` covers metadata; the blob volume needs its own copy (`restic`/`borg` or
  object-versioned storage). A dump alone no longer restores the evidence.
* **Restore drill**: the drill in `docs/DEPLOYMENT.md` §8 must be extended to (1) restore the dump,
  (2) restore the blob volume, (3) run `verify-blobs.ts` and require zero mismatches, (4) open one
  real record through the UI. A restore that passes step 1 and fails step 3 is a failed restore.

---

## 7. What is *not* decided yet (needs the owner)

1. Object store choice: mounted volume vs MinIO vs OCI Object Storage (paid beyond free allowance).
2. Maximum acceptable scan size and the resulting `client_max_body_size` / Express limit pair.
3. Retention: how long tombstoned blobs stay before any deletion is even discussable, and whether
   the department requires a legal-hold flag.
4. Whether field photos stay in the same store as scanned records or are separated (different
   sensitivity and different volume).

Each of those is a product/department decision, not an engineering default — say which way you want
them and Stage 0/1 can be implemented immediately; Stage 2 onward needs the storage choice settled.
