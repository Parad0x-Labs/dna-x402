# DNA x402 Privacy And Data Rights

Date: 2026-05-15

## Purpose

Immutable proofs and data subject rights conflict if raw personal data enters receipts, anchors, or audit payloads. The design is offchain personal data and immutable hash references only.

## Implemented Controls

- PII scanner for immutable receipt and audit payloads.
- `DataSubjectRequest` model for access, erasure, rectification, export, and restriction.
- Mutable personal record erasure model.
- Legal/tax retention denial state.
- Receipt verification remains possible after mutable PII erasure.

## Forbidden In Immutable Records

- email
- legal name
- tax ID
- shipping address
- IP address
- KYC result
- seed phrase
- private key
- wallet dump

## Reference

- EDPB blockchain data guidance: https://www.edpb.europa.eu/news/news/2025/edpb-adopts-guidelines-processing-personal-data-through-blockchains-and-ready_hr
