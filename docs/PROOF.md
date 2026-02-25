# Proof Summary

This page is the public evidence index for performance and correctness claims.

## Footprint Snapshot (latest baseline)

- Single anchor tx bytes: `244`
- Single anchor ix data bytes: `34`
- Single anchor accounts/signatures: `4 / 1`
- Batch(32) anchor bytes: `1230` (under Solana 1232-byte tx limit)
- Compute units (single / batch32): `13600 / 19386`

## Semantics

- `FAST`: fulfilled + payment verified + signed receipt valid
- `VERIFIED`: `FAST` + `anchored=true` (anchor tx confirmed on-chain)

## What Anchoring Proves

Anchoring proves an immutable 32-byte commitment to receipt lineage was posted on-chain.

Anchoring does **not** prove seller business truth (for example market outcomes or off-chain model quality).

## Artifact Index

Primary docs:
- `docs/FOOTPRINT.md`
- `docs/PROGRAMMABILITY_CONTRACT.md`

Runtime audit artifacts:
- `x402/audit_out/PROGRAMMABILITY_READINESS_REPORT.md`
- `x402/audit_out/programmable_readiness.json`
- `x402/audit_out/programmable_devnet.json`

Website-exported stable bundle:
- `site/public/proof/latest/footprint.md`
- `site/public/proof/latest/programmability.md`
- `site/public/proof/latest/audit.json`
- `site/public/proof/latest/programmable_devnet.json`
