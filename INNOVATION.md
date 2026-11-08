# DHAROHAR — Design and Innovation

This document explains the specific design choices the prototype is intended to demonstrate. It does not claim that individual techniques are unprecedented or that the system has been validated for government operation.

## 1. Recognition is kept separate from assertion

A scan or OCR result is not a verified land-record fact. DHAROHAR keeps extraction, quality checks, human correction and authorised verification as distinct workflow stages.

**Why it matters:** an OCR error in a name, share fraction, khasra identifier or area should be visible and correctable before it is treated as an accepted record.

## 2. Revenue checks are expressed as inspectable rules

The prototype structures values so that relationships can be checked: ownership shares, required fields and recorded versus mapped area. An imbalance should surface as a discrepancy rather than being silently normalised.

**Why it matters:** a value that looks plausible in isolation may contradict another part of the same record.

## 3. Spatial context is part of the registry workflow

The parcel registry connects record details with available boundary geometry and map context. This helps an officer inspect whether the spatial representation and documentary description appear consistent.

**Boundary:** a rendered polygon is not an authoritative cadastral survey and does not establish a legal boundary.

## 4. Jurisdiction is a grant, not a profile guess

The server resolves officer identity, capabilities and district grants from the stored account and grant records. A browser-selected district or profile label is not itself permission.

**Why it matters:** changing a request parameter should not allow an officer to browse another jurisdiction's records.

## 5. Integrity evidence is part of the workflow

Consequential actions are represented in a hash-linked audit history. The chain can be checked for broken links, and action records include actor and time context.

**Boundary:** a hash chain makes unauthorised alteration detectable under its assumptions; it does not by itself prove that an action was legally correct or that the original input was true.

## 6. The system must report what it cannot know

Unavailable metrics, missing source values, unverified OCR and inconsistent geometry should be shown as gaps or discrepancies. The product should not manufacture a complete-looking answer.

## What is deliberately not claimed

- Novel OCR research or universal OCR accuracy.
- Automated land-title determination.
- Legal certification of parcel boundaries.
- Integration with all state land-record systems.
- Government approval, procurement or endorsement.
- Production suitability for real citizen data.

## Evaluation questions

Reviewers can assess the design by asking:

1. Can an extracted value be traced back to its source and reviewed?
2. Are arithmetic and completeness discrepancies visible?
3. Can a user access another district by changing a client-side field?
4. Does logout invalidate the old session token?
5. Can an auditor detect a broken audit-chain link?
6. Does the UI clearly distinguish live backend data from synthetic fallback data?

See [Validation and Evidence](VALIDATION_AND_EVIDENCE.md) for dated results and [Limitations and Future Scope](LIMITATIONS_AND_FUTURE_SCOPE.md) for gaps.
