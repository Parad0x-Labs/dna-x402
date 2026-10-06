# Proof Summary

This page indexes the evidence behind the transaction-footprint figures. The capability-level record,
with what is demonstrated and what is not, is [`REVIEW.md`](../REVIEW.md) and
[`evidence/claims.json`](../evidence/claims.json).

## Footprint snapshot (baseline from `docs/FOOTPRINT.md`, generated 2026-02-17)

- Single anchor tx bytes: `244` (v0 with an address lookup table; 270 legacy)
- Single anchor ix data bytes: `34`
- Single anchor accounts/signatures: `4 / 1`
- Batch of 32 anchors: fits under the Solana 1232-byte transaction limit
- Compute units (single / batch of 32): `13,600 / 19,434`

The byte and account budgets are checked offline by `x402/tests/budget.txsize.test.ts` and
`x402/tests/anchor.batch.test.ts` (assert below the thresholds in `x402/src/bench/thresholds.ts`). The
compute-unit figures come from a 2026-02-17 run whose report files (`x402/reports/bench_*.json`) are not
committed; regenerate them with `npm --prefix x402 run bench:txsize`, `bench:compute` and
`bench:footprint` against a `receipt_anchor` deployment you control (`--program-id` or
`RECEIPT_ANCHOR_PROGRAM_ID`; there is no default).

## Semantics

- `FAST`: fulfilled + payment verified + signed receipt valid
- `VERIFIED`: `FAST` + `anchored=true` (anchor tx confirmed on-chain)

## What anchoring shows

The `receipt_anchor` program folds each 32-byte value into an hourly hash chain
(`root = sha256(prev_root || value)`). In the x402 server the anchored value is the commit's payer
commitment, not the receipt hash. Showing that one value was anchored needs the ordered anchors of that
hourly bucket, not a single transaction. No `receipt_anchor` deployment is configured by default: the
operator names one with `RECEIPT_ANCHOR_PROGRAM_ID` (the mainnet pilot program was retired on 2026-07-14).

Anchoring does **not** prove seller business truth (for example market outcomes or off-chain model quality).

## Artifact index

Committed:
- [`docs/FOOTPRINT.md`](./FOOTPRINT.md): size, compute and soak summary (2026-02-17)
- [`docs/PROGRAMMABILITY_CONTRACT.md`](./PROGRAMMABILITY_CONTRACT.md)
- `x402/tests/budget.txsize.test.ts`, `x402/tests/anchor.batch.test.ts`: offline size checks

Generated locally, not committed:
- `x402/audit_out/`: written by `x402/scripts/audit/run-programmability-audit.ts`
- `site/public/proof/latest/`: written by `x402/scripts/publish-proof-bundle.ts`
- `x402/reports/`: benchmark and soak reports referenced by `docs/FOOTPRINT.md`
