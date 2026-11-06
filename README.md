<p align="center">
  <strong>DHAROHAR · धरोहर</strong><br>
  <em>Land Record Digitisation & Verification Portal</em>
</p>

<p align="center">
  Live demonstration: <a href="https://dharohar.urbantechx.in">dharohar.urbantechx.in</a>
</p>

---

DHAROHAR is a revenue-officer workstation that turns photographed land records into a verified,
auditable register — **without sending any document to a third-party service.** Recognition runs in the
browser; only structured, officer-approved results reach the server, and every consequential action is
written to a hash-chained audit log.

> **Status.** A working prototype on synthetic data, deployed and reachable. It is not an authoritative
> land-records system and does not claim to be. See [Limitations](#limitations-and-roadmap).

## The problem

A single parcel's story is split across three registers that never quite agree: the **jamabandi**
(record of rights), the **khasra** (field-by-field account of cultivation), and the **kewal /
daakhil-kharij** (mutation register of transfers). Ownership shares exist as handwriting on paper,
spatial extent exists in a cadastral layer, and transfer history exists in a third place. Citizens
travel to tehsil offices to resolve discrepancies; officers re-key the same facts by hand under time
pressure while carrying personal liability for the result; disputes routinely hinge on a transcription
difference rather than on any real disagreement about the land.

Digitisation efforts usually stop at scanning the paper — which makes an image machine-readable only in
the trivial sense, because nobody can query it — and often ship batches of identity documents to external
transcription services along the way.

## The approach

Treat **recognition** and **assertion** as separate, individually auditable stages.

1. **Ingest** a document image or PDF scan.
2. **Recognise locally** — bundled WASM OCR, executed in the browser. No document leaves the machine.
3. **Parse** into a revenue schema: khasra / khata / khewat numbers, patwar circle, tehsil, village,
   area, owner names, share fractions, mutation entries.
4. **Verify arithmetically** — shares must sum to a whole; recorded area must reconcile with mapped
   area; imbalances surface as defects instead of being quietly normalised.
5. **Cross-reference** against the cadastral layer and the mutation history.
6. **Human review** — an officer confirms or corrects. The system never auto-asserts a legal fact.
7. **Attest** — issue a certificate bound to the reviewed content, with an append-only audit trail.

The governing rule: **a declaration is not a fact.** Digitised values carry provenance and confidence,
and authoritative state changes only through an authenticated officer action that is itself recorded.

## Try it

Open the [live demonstration](https://dharohar.urbantechx.in). The sign-in screen is bilingual
(Hindi default, English toggle in the header) and states plainly that it runs on sample data only.

Demo credentials are issued by the project administrator on request — **this repository publishes no
username, password, token or default credential**, and neither does the application. Treat everything
on screen as synthetic; there is no real citizen, owner or parcel data. Please do not run
authentication-rate or load tests: the deployment is on shared hosting.

## What is in this repository

Documentation only. The implementation lives in a separate private development repository and is
deliberately not published here.

| Document | Contents |
| --- | --- |
| [Evaluation package](./docs/EVALUATION_PACKAGE.md) | Problem statement, proposed solution, system architecture and diagram, module documentation, technology stack, data model, API reference, security and privacy architecture, deployment overview, testing methodology with dated results, limitations and roadmap, demonstration instructions |
| [Verification queries](./docs/security/LIVE_AUDIT_READONLY_QUERIES_2026-10-30.sql) | The read-only SQL used to reconcile application claims against the database |

## Architecture at a glance

```
Browser workstation (React, Hindi/English)
  digitisation → local WASM OCR → rule verification → human review → attestation
  spatial registry (Leaflet) · dashboards · audit trail
        │ same-origin JSON, bearer token
        ▼
Node.js API behind /api
  security headers → CORS allowlist → authentication → per-request principal
  resolution → capability gate → write gate → role gate → tenant/district scoping
        ▼
MariaDB (deployed)  ·  or PostgreSQL + PostGIS with row-level security
  tenant model · parcels · owners · mutations · inspections · documents
  append-only audit chain, hash-linked, DB-enforced
```

Two properties are worth judging on their merits rather than skimming:

- **Authorisation is re-derived from the database on every request**, never read from the token, so a
  demotion or reassignment bites on the next call rather than at token expiry. Access is
  capability-based: an officer's *role* describes the office they hold, and separately-granted
  capabilities decide what they may do.
- **The system refuses to invent what it does not know.** The metrics endpoint publishes an explicit
  list of figures it cannot compute; the OCR path carries accuracy rather than false confidence;
  migrations report as pending; and a production boot fails closed rather than falling back to a
  demo store.

## Verified on the deployment

| Property | Result |
| --- | --- |
| Live map tiles render real cadastral-area basemap content | **PASS** — pixel-verified (28 colour buckets, mean 235), 0 failed tiles, correct attribution, policy-compliant endpoint |
| Session revocation on logout | **PASS** — verified by token reuse, not by a redirect |
| District-level data isolation | **PASS** — another district returns an empty set; a foreign record id returns 404 |
| Role enforcement | **PASS** — capability-holding officer reaches the roster; without it, 403 |
| Dashboard metrics reconcile with the API | **PASS** |
| Rejected write leaves no partial record | **PASS** |
| Automated suites | crypto 57/0 · DTO contract 65/0 · tile provider 86/0 · sign-in challenge 35/0 · i18n · OCR (0 cloud dependencies) |

## Limitations and roadmap

The prototype branding you see on screen is accurate. The open items, in order:

1. No consented real district data has been loaded; semantic reconciliation against actual
   jamabandi/khasra formats across districts is the main body of work.
2. Field-officer-perspective and multi-account authorisation behaviour needs a second restricted test
   identity to be fully exercised.
3. Operational data cached in browser storage should move to session memory before any real records.
4. Missing-asset responses and touch-target sizing need a small hardening pass.
5. Then: reconcile declared geography against authoritative spatial data, and pilot with a consented
   tehsil.

## Licence

All rights reserved by the project author. Bundled third-party components remain under their own
licences, and their attribution notices are preserved in the distributed application bundle.
