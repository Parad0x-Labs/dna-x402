# SnarkPack Batch Proof Settlement

**Status:** `SPEC` | `devnet-pending` | `SIMD-0302 dependency`  
**Updated:** 2026-06-01  
**Author:** Parad0x Labs

---

## 1. What SnarkPack Does

SnarkPack is a Groth16 proof aggregation scheme introduced by Gauthier-Diamant et al. (2021). It
aggregates **N independent Groth16 proofs** into a single aggregate proof that can be verified with
**O(log N) pairings** instead of O(N).

### Verification complexity

| Approach | Pairings per verification |
|---|---|
| Naive: verify N proofs individually | O(N) — linear |
| SnarkPack aggregate | O(log N) — logarithmic |

For N=100 agent payment proofs: 100 individual pairings collapse to ~7 pairings in the aggregate
verify step (plus constant-overhead inner-product argument checks).

### Core mechanism

SnarkPack builds on the **GIPA** (Generalized Inner Product Argument) protocol with a KZG-style
commitment scheme over BN254. The aggregator:

1. Collects N Groth16 proofs `{(A_i, B_i, C_i)}` and their public inputs `{x_i}`.
2. Commits to the proof vectors using a structured reference string (SRS) with G1 and **G2** elements.
3. Produces a single aggregate proof `(A_agg, B_agg, C_agg, T, U, IP)` where `T` and `U` are
   KZG commitments and `IP` is the inner-product argument.
4. The on-chain verifier checks the aggregate using `O(log N)` pairing equations.

The aggregation step is **entirely off-chain**. The on-chain verifier only receives and checks the
final aggregate proof.

---

## 2. How It Fits Our Stack

### Current state

`dark_bn254_gate` verifies **one Groth16 proof per transaction**. Per `DARK_ZK_PRIMITIVES.md`, a
single BN254 pairing check via the `alt_bn128_pairing` syscall costs approximately 100,000–150,000
CU. Each verification transaction therefore consumes ~150,000–200,000 CU.

For 100 concurrent agent payment proofs (e.g., 100 agents settling x402 micro-payments in one
block), the naive approach requires 100 separate transactions, totalling ~20,000,000 CU across the
block.

### With SnarkPack

A SnarkPack aggregate of 100 Groth16 proofs verifies in **one transaction** with O(log 100) ≈ 7
pairing checks. Estimated CU cost: ~700,000–1,050,000 CU — well within Solana's 1,400,000 CU
per-transaction limit.

```
Off-chain aggregator                         On-chain (Solana BPF)
─────────────────────────────────────────────────────────────────────
  100 agent x402 payment proofs
  {(A_i, B_i, C_i), pub_inputs_i}
           │
           ▼
  snarkpack_aggregate()
  → aggregate_proof (one blob)
  → aggregate_pub_inputs (merged)
           │
           ▼ one Solana tx
                                         [dark_bn254_snarkpack_gate]
                                           uses alt_bn128_pairing
                                           O(log N) pairings
                                           ~1M CU total
                                           emits: BatchSettlementRecord
```

### Throughput improvement

| Metric | Naive (per-proof) | SnarkPack (N=100) |
|---|---|---|
| Transactions per batch | 100 | 1 |
| CU consumed | ~20,000,000 | ~1,000,000 |
| Solana fees (est.) | ~100x | ~1x |
| Block space used | ~100 slots | ~1 slot |

This is the critical scaling unlock for the **Dark NULL Privacy Layer**: agents can settle payment
proofs in bulk without flooding the mempool with individual verification transactions.

---

## 3. What's Needed

### 3a. Off-chain SnarkPack aggregator

A Node.js / Rust binary that:

- Accepts N Groth16 proof bundles (matching our existing 256-byte proof format from
  `dark-bn254-proof-gen`).
- Loads the SnarkPack SRS (a structured reference string with G1 and G2 commitment keys — can be
  derived from the Powers of Tau ceremony output already in `evidence/ceremony/`).
- Runs the GIPA reduction to produce the aggregate proof blob.
- Outputs: `{ aggregate_proof: Uint8Array, merged_pub_inputs: Uint8Array[], srs_digest: string }`.

Reference implementation: `bls_on_chains/snarkpack` (Gauthier-Diamant, MIT license) — Rust crate,
wraps BN254 via `ark-bn254`.

### 3b. New on-chain verifier: `dark_bn254_snarkpack_gate`

A new Solana BPF program (separate from the existing `dark_bn254_gate`) that:

- Accepts: `(aggregate_proof, merged_pub_inputs, N, srs_digest)` in instruction data.
- Calls `alt_bn128_pairing` syscall for each of the O(log N) pairing checks.
- Validates the KZG commitments `T` and `U` against the SRS digest.
- On success: emits a `BatchSettlementRecord` log with `{ batch_id, n_proofs, settler, timestamp }`.
- On failure: returns a program error, rolling back the batch.

The verifier does **not** need G2 scalar multiplication for the final pairing check — it uses the
precomputed G2 commitment keys from the SRS. However, G2 ops are needed in the aggregation step
(see Section 5).

### 3c. SRS distribution

The SnarkPack SRS is a one-time setup artifact (can reuse our existing Powers of Tau output up to
the degree needed). It must be:

- Stored on-chain as a Solana account (or via ZK Compression to reduce rent cost).
- Referenced by `srs_digest` (SHA-256 of the SRS bytes) in every batch settlement instruction.
- Version-locked: upgrading the SRS requires a governance vote (future work).

### 3d. Batch sequencer (off-chain coordinator)

A lightweight off-chain service that:

- Subscribes to the x402 payment event stream.
- Collects incoming agent payment proofs until `N >= MIN_BATCH_SIZE` (suggest 10) or a
  `BATCH_TIMEOUT` (suggest 500ms) fires.
- Runs the aggregator, submits one settlement tx to Solana.
- Posts receipts back to agents.

---

## 4. BN254 Curve Compatibility

SnarkPack is defined over pairing-friendly curves. The reference implementation uses BN254
(alt_bn128) — the same curve as our existing `dark_bn254_gate`.

Solana syscall compatibility:

| Syscall | Used by | Available on Solana |
|---|---|---|
| `alt_bn128_addition` | Aggregate proof construction (off-chain) | Yes (on-chain G1 ops) |
| `alt_bn128_multiplication` | Aggregate proof construction (off-chain) | Yes |
| `alt_bn128_pairing` | On-chain aggregate verifier | Yes — our primary path |

The on-chain verifier only calls `alt_bn128_pairing`. No new syscalls are required for the
verification step itself. BN254 is confirmed compatible — no curve migration needed from the
existing `dark_bn254_gate` stack.

---

## 5. Open Question: SIMD-0302 G2 Operations

### The dependency

The SnarkPack **aggregation step** (off-chain) requires G2 scalar multiplication to construct the
KZG commitments `T` and `U`. Off-chain, this runs in native Rust via `ark-bn254` — no Solana
syscall needed. This is not a blocker for shipping the off-chain aggregator.

However, if we ever want to run the aggregation **on-chain** (e.g., for trustless batch proving
with on-chain coordination), we need G2 scalar multiplication as a Solana syscall.

**SIMD-0302** proposes `alt_bn128_g2_mul` and `alt_bn128_g2_add` syscalls for BN254 G2
operations. As of 2026-06-01, SIMD-0302 is **not yet active** on devnet or mainnet.

### Impact on our plan

| Component | SIMD-0302 needed? | Can ship without? |
|---|---|---|
| Off-chain aggregator | No — uses `ark-bn254` in native Rust | Yes |
| On-chain `dark_bn254_snarkpack_gate` verifier | No — only G1 pairings | Yes |
| On-chain aggregation (future trustless mode) | Yes | No |
| Trustless batch coordinator on-chain | Yes | No |

**Decision:** Ship the off-chain aggregator + on-chain verifier now using existing syscalls.
Trustless on-chain aggregation is a post-SIMD-0302 milestone.

### Monitoring

- SIMD-0302 PR: `solana-foundation/solana-improvement-documents` (track for activation).
- When SIMD-0302 activates on devnet: update `dark_bn254_snarkpack_gate` to support on-chain
  aggregation mode.

---

## 6. Relationship to Existing Docs

| Doc | Relationship |
|---|---|
| `DARK_ZK_PRIMITIVES.md` | Base stack — BN254 syscalls, `dark_bn254_gate`, proof format |
| `GOBLIN_ENGINEERING_ROADMAP.md` | SnarkPack is implied by Priority-1 BLS aggregation pattern |
| `ZK_PROOF_VERIFICATION_PLAN.md` | Upstream verification plan this batch settlement extends |
| `DNA_X402_SETTLEMENT_ABSTRACTION.md` | Settlement layer that batch records feed into |
| `SIMD_0064_REVIVAL_PR.md` | Sibling effort — single-tx inclusion proofs vs. batch payment proofs |

---

## 7. Implementation Milestones

| Milestone | Owner | Blocker | Target |
|---|---|---|---|
| M1: Off-chain aggregator stub (`06-snarkpack-demo.mjs`) | Parad0x Labs | None | Done |
| M2: SRS derivation from existing ceremony output | Parad0x Labs | Ceremony artifacts | Q3 2026 |
| M3: `dark_bn254_snarkpack_gate` program (devnet) | Parad0x Labs | M2 | Q3 2026 |
| M4: Batch sequencer service | Parad0x Labs | M3 | Q3 2026 |
| M5: Mainnet deploy + agent SDK integration | Parad0x Labs | Audit | Q4 2026 |
| M6: On-chain aggregation (trustless mode) | Parad0x Labs | SIMD-0302 activation | TBD |

---

## 8. References

- Gauthier-Diamant, N., Maller, M., Belling, N. et al. "SnarkPack: Practical SNARK Aggregation."
  IACR ePrint 2021/529. https://eprint.iacr.org/2021/529
- Solana syscall `alt_bn128_pairing`: https://docs.solana.com/developing/builtins/syscalls
- SIMD-0302 (BN254 G2 ops): `solana-foundation/solana-improvement-documents` SIMD-0302
- SIMD-0388 (BLS12-381, related): active on devnet epoch 1059
- `dark_bn254_gate` program: see `docs/DARK_ZK_PRIMITIVES.md` and `programs/dark_bn254_gate/`
