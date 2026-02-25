# Programmability Contract

This document defines what the platform guarantees and what remains seller-defined logic.

## x402 Flow Contract

For paid endpoints, the canonical flow is:

1. Client requests protected resource.
2. Server returns `HTTP 402` with payment requirements.
3. Client commits and finalizes payment proof.
4. Client retries with commit header and receives `HTTP 200` + signed receipt.

## Protocol Guarantees (Rails)

1. Payment correctness
   - Commit/finalize verify the selected settlement mode and proof shape.
   - Invalid proof paths are rejected.
2. Receipt integrity
   - Receipts are signed and hash-chained.
   - Tampering invalidates verification.
3. On-chain anchoring correctness
   - Anchor payloads are pushed to `receipt_anchor`.
   - VERIFIED tier requires anchored receipts.
4. Market safety controls
   - Rate limiting for registration/heartbeat/order surfaces.
   - Pause flags for market/finalize/orders.
   - Netting + fee accrual with deterministic settlement split.
5. Truth-in-analytics semantics
   - FAST: fulfilled + payment verified + signed receipt.
   - VERIFIED: FAST + anchored on-chain confirmation.

## Seller Guarantees (Not Protocol Guarantees)

Sellers own and define:

1. Pricing policy and auction rules.
2. Service quality and correctness of returned business result.
3. Market resolution logic (for example, prediction outcomes).
4. Any off-chain state machine transitions.

The platform is not a truth oracle for seller-specific outcomes.

## Dispute Model (v0)

If seller behavior is disputed:

1. Platform can provide signed receipt evidence and anchor traces.
2. Platform can enforce safety controls (pause/rate limit).
3. Platform cannot cryptographically arbitrate seller business truth in v0.

