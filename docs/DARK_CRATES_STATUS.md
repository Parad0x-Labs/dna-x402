# Dark-* crate library — honest status (2026-06-06)

The repo has a large `dark-*` crate library (236 crates) plus 23 on-chain programs.
**The scale is real; the maturity is not uniform.** Many crates are scaffolds or
stubs — correct data structures and tests, but the claimed cryptographic operation
(ZK verify, ECDH, range proof, Nova fold, Merkle inclusion) is NOT implemented.

A "GOBLIN engineering report" (2026-06-06) marketed 10 of these as
"first-in-existence" primitives. A code audit of the named crates found that claim
**overstated**: most are stubs. This file is the ground truth, so nobody — human or
agent — ships, builds on, or markets a stub as a working primitive.

## Golden rule
- A stub that is a **security gate / verifier MUST fail closed** (deny / error),
  never fail open (approve). A verifier with no verifier that returns "approved"
  is a forgeable hole, not a feature.
- **Never** describe a stub as working, "first", "only implementation", or
  "audited". Use it only behind `IS_STUB`/`MAINNET_READY` gates for testing.

## Audited crates (sample of the headline claims)

| Crate | Exists | Status | Notes |
|---|---|---|---|
| `dark-macaroons` | ✅ | **REAL** | RFC2104 HMAC, caveat enforcement, NIST vectors. Build on this. |
| `dark-proof-of-innocence` | ✅ | **REAL** | Sorted-set non-membership, proper witness validation. Build on this. |
| `dark-blind-oracle` | ✅ | scaffold (real HMAC) | Logic complete, not deployed/audited. |
| `dark-x402-commit-reveal` | ✅ | scaffold | Sound logic; on-chain anchor program not deployed. |
| `dark-zk-hook` | ✅ | **STUB — now FAIL-CLOSED (fixed 2026-06-06)** | Was `approved:true` for any non-zero proof (forgeable). Now returns `StubVerifierDisabled`; no real Groth16 pairing yet. |
| `dark-imt-nullifier` | ✅ | **STUB — verify hardened (fixed 2026-06-06)** | `verify_non_membership` now binds the low node to the real tree (was forgeable). On-chain Merkle-inclusion path still TODO. |
| `dark-nova-receipt` | ✅ | STUB | `step_proof` is a SHA256 hash, not a Nova/IVC fold. |
| `dark-x402-stealth` | ✅ | STUB | "ECDH" is domain-separated SHA256, not Curve25519. |
| `dark-x402-private-intent` | ✅ | STUB | Commitments via SHA256, no real range proof. |
| `dark-x402-session-key` | ✅ | STUB | Session checks real; `payment_token` is a hash, not a signature. |
| `dark_shielded_pool` (program) | ✅ | STUB | Self-documented blockers: hash mismatch, root is a hash chain not a tree, recipient not bound, no trusted setup. Fails closed. |
| `dark_bn254_gate` (program) | ✅ | STUB | Scaffold; no real pairing path wired. |
| `dark-note-split-circuit` | ❌ | **MISSING** | The report's "#1 build this" — does not exist. |

## Fixes applied this pass
1. **`dark-zk-hook`** — verifier now **fails closed**: in stub mode it returns
   `HookError::StubVerifierDisabled` and can never emit an `approved` verdict.
   Removed the "first-in-world" over-claim from the docs. (12/12 tests.)
2. **`dark-imt-nullifier`** — `verify_non_membership` now binds the proof's
   `low_nullifier` to the genuine node in the tree, closing a forge path that let a
   crafted low node falsely prove non-membership. (17/17 tests.)

## What's worth building (in-lane, high-leverage)
The strategic thesis is sound and IS the project's lane: **financial privacy at the
x402 payment layer** — the gap every competitor (and Coinbase's own x402 papers)
flags. But the way to win it is **one real, audited primitive**, not 236 stubs.

Start from the two REAL crates (`dark-macaroons`, `dark-proof-of-innocence`) and make
ONE more genuinely work end-to-end on devnet + audited — e.g. a real BN254 Groth16
verify in `dark-zk-hook` (replace the fail-closed stub), or the missing
`dark-note-split-circuit` on top of a real shielded pool. Prove it like we prove
everything else: on devnet, before any claim.
