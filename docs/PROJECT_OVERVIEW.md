# DHAROHAR — Project Overview

**DHAROHAR · धरोहर** is a bilingual land-record digitisation and verification workstation designed around the work of revenue officers.

- **Live demonstration:** https://dharohar.urbantechx.in
- **Public repository:** https://github.com/naamanjain/dharohar
- **Implementation:** maintained separately in a private engineering repository
- **Status:** prototype and evaluation deployment using synthetic demonstration records

## What it is

DHAROHAR brings together document intake, browser-based OCR, structured revenue fields, arithmetic checks, parcel geometry, document linking, officer review and an auditable history. It is intended to help an officer organise and check information that may otherwise be distributed across paper registers, document scans and spatial records.

The system is designed around a strict boundary: OCR and extracted values are suggestions that require human review. A recognised name, share or area is not automatically a legal fact.

## Who it is for

The primary workflow is an officer workstation. Different activities require different permissions:

- **Data-entry work:** capture and organise source information.
- **Revenue-officer review:** inspect records, discrepancies and parcel context.
- **Field verification:** record observations that need an on-ground check.
- **Administration and audit:** manage authorised accounts, capabilities and review history.

The prototype demonstrates parts of these role-separated workflows. A full multi-organisation deployment requires institutionally approved identity, jurisdiction and operating policies.

## What makes the approach useful

1. **Recognition is separate from assertion.** OCR output remains reviewable and correctable.
2. **Structured records are checkable.** Share arithmetic, required fields and area comparisons can expose inconsistencies.
3. **Spatial context is connected to records.** Parcel geometry can be viewed and edited as part of the registry workflow.
4. **Authority is server-side.** Roles, capabilities and district grants are resolved by the API rather than trusted from the browser.
5. **Consequential actions leave evidence.** The audit chain makes later alteration detectable.

## Current boundaries

DHAROHAR is not a government land-record source of truth. It is not connected to an authoritative state registry, does not establish ownership, and has not been validated across real district document formats. The hosted demonstration uses synthetic records only.

See:
- [Problem statement](PROBLEM_STATEMENT.md)
- [Solution overview](SOLUTION_OVERVIEW.md)
- [Architecture](ARCHITECTURE_OVERVIEW.md)
- [Feature matrix](FEATURES.md)
- [Validation evidence](VALIDATION_AND_EVIDENCE.md)
- [Limitations and future scope](LIMITATIONS_AND_FUTURE_SCOPE.md)
- [Demonstration guide](DEMONSTRATION_GUIDE.md)
