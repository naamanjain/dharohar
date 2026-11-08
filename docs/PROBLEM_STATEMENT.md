# DHAROHAR — Problem Statement

## The record is distributed

Land-record information is often represented across multiple documentary and spatial sources. A parcel may be described in a record of rights, a field or cultivation register, a mutation history and a cadastral map. The sources answer related but different questions, and they may be held as paper records, scans or separate datasets.

A person trying to understand one parcel may therefore need to reconcile:

- parcel identifiers such as khasra, khata and khewat references;
- recorded area and ownership-share information;
- names and relationships as transcribed from source records;
- mutation or transfer history;
- village, tehsil, circle and district context;
- mapped parcel geometry and neighbouring boundaries.

## Why digitising an image is not enough

Scanning a register preserves an image, but does not by itself create reliable structured information. Manual transcription can introduce errors in names, fractions, identifiers and units. OCR can accelerate capture, but OCR output may be incomplete or wrong, particularly on handwriting, degraded scans, local terminology and variable document layouts.

A system that silently treats extracted text as authoritative can turn a recognition error into an operational record.

## The operational gap

A useful workstation should help an authorised officer:

1. capture the source document;
2. extract candidate fields;
3. compare related values;
4. surface missing or contradictory information;
5. inspect the parcel's spatial context;
6. record a human decision and its provenance.

It should also make access boundaries explicit. A user should not gain access to another district simply by changing a browser parameter or choosing a different record identifier.

## Design risks to avoid

- Treating OCR confidence as proof of correctness.
- Silently normalising an inconsistent share or area value.
- Inferring jurisdiction from a profile label instead of an explicit grant.
- Showing sample data as though it came from the live database.
- Allowing a visual map overlay to imply cadastral or legal authority it does not possess.
- Using a prototype with real citizen data before approved governance, privacy, security and operational controls exist.

## Scope of this prototype

DHAROHAR explores these workflow and control patterns with synthetic demonstration data. It does not claim that all Indian land-record formats have been reconciled, that OCR is accurate for every district, or that the system is an official record repository.
