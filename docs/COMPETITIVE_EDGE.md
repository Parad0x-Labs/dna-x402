# DNA x402 — Technical Differentiation

> **Status**: `NOT_PRODUCTION` | `devnet-only` | `no-audit`

---

## Summary

DNA x402 is a Solana-native payment, privacy, and ZK layer. Its design choices — BN254 for Solana
precompile compatibility, Solana PDAs for all state, x402 as the payment protocol interface, and
standalone Rust crates with no external validator dependencies — were made to maximize native Solana
compatibility and minimize external infrastructure requirements. Each architectural decision below is
explained in terms of the concrete tradeoff it resolves.

---

## Curve Choice: BN254 over BLS12-381

Solana's runtime exposes three native syscalls for elliptic-curve operations on the BN254 curve
(also called alt_bn128):

| Syscall | Purpose | Cost |
|---|---|---|
| `alt_bn128_addition` | G1 point addition | ~150 CU |
| `alt_bn128_multiplication` | Scalar × G1 | ~3,000 CU |
| `alt_bn128_pairing` | Batched pairing e(A,B)·... = 1 | ~100,000–150,000 CU |

These syscalls execute as native validator code. The BPF program pays only the syscall invocation
cost; no field arithmetic runs inside the BPF sandbox.

BLS12-381 has no equivalent syscall support on Solana. A BLS12-381 verifier implemented in BPF
would require:

- Fp2 and Fp12 extension field arithmetic in software
- A full Miller loop (hundreds of field multiplications per pairing)
- Final exponentiation

A single BLS12-381 pairing implemented inside BPF consumes more than the 1,400,000 CU per-transaction
budget. Hardware acceleration is not available for BLS12-381 on the current Solana validator set.

BN254 is the only curve on Solana for which pairing-based proof verification is practical within
normal transaction budgets. Leading ZK-on-Solana projects that selected BLS12-381 cannot perform
on-chain pairing verification without exceeding transaction limits or requiring precompile additions
that are not yet deployed.

---

## On-Chain Verifier: Actual Pairing Checks

`dark_bn254_gate` is the on-chain Groth16 BN254 verifier program. Its verification logic:

1. Deserializes the 352-byte instruction payload (proof bundle + 3 public inputs).
2. Reconstructs the linear combination of public inputs against the verifying key.
3. Calls `alt_bn128_pairing` with the four (G1, G2) point pairs required for Groth16 verification.
4. Checks that the pairing result equals the identity element in GT.
5. Returns an error if the check fails; proceeds to nullifier recording if it passes.

The pairing check is the cryptographic core of the verifier. Without it, no soundness property holds.

Some ZK-on-Solana implementations ship an on-chain program whose verification function checks only
that the submitted proof byte slice is non-empty. This passes CI and compiles, but provides no
cryptographic guarantee — any non-empty byte string would be accepted as a valid proof. Our verifier
performs the actual pairing computation, not a length check.

Note: our current implementation uses test-mode verifying keys (not from a real trusted setup),
so soundness holds only structurally. The pairing syscall is called correctly; the keys are
not production-grade. See the `NOT_CLAIMED` section of DARK_ZK_PRIMITIVES.md.

---

## State Architecture: Solana PDAs Only

All mutable state in the DNA x402 ZK stack lives in Solana Program Derived Addresses (PDAs):

| Account Type | PDA Seed | Contents |
|---|---|---|
| NullifierBank shard | `["nullifier", shard_id]` | Bitmap of spent nullifiers |
| NoteCommitment | `["commitment", leaf_index]` | BN254 commitment scalar |
| ReceiptRoot | `["receipt", job_id]` | ComputeReceipt entry in DAG |
| CapabilityCapsule | `["capsule", agent_id]` | Agent capability commitment |

PDAs are owned by the program, derived deterministically, and stored in Solana's native account
model. There is no external database. There is no off-chain indexer required for the core protocol.
There is no custom validator software.

Some private compute approaches on Solana require each validator node to run additional software
(libp2p networking, RocksDB storage, custom consensus participation) alongside the standard
Solana validator. This creates a two-tier validator set and requires coordination with validator
operators to deploy protocol upgrades. Our architecture requires no such coordination. Any
standard Solana RPC node can service all protocol interactions.

---

## Payment Integration: x402 HTTP Protocol

x402 is an HTTP payment protocol in which the server returns a `402 Payment Required` response
with a machine-readable payment specification, and the client submits a payment receipt to unlock
the resource. It is designed for AI agent wallets and automated payment flows.

DNA x402 integrates the ZK privacy layer at the x402 protocol boundary:

- **Buyer**: submits `buyer_hash = SHA256(wallet || nonce)` as the payer identity. The actual
  wallet address is never sent to the seller.
- **Payment proof**: a shielded note commitment is submitted alongside the payment, proving the
  buyer controls funds without revealing the amount or source.
- **Seller**: receives the `buyer_hash`, the on-chain nullifier record, and a receipt. It cannot
  determine the buyer's wallet address without the nonce.

This flow requires no custom wallet. Any AI agent or automated system that can perform HTTP
requests and Solana transactions can participate. No protocol-specific wallet software is
required on the buyer side.

---

## MPC Ceremony: Commit-Reveal with Threshold Verification

A Groth16 deployment requires a powers-of-tau trusted setup ceremony to produce verifying keys.
An incomplete ceremony means the verifying keys cannot be finalized and the verifier cannot be
deployed.

The ceremony structure implemented in this codebase:

1. **Contribution phase**: Each participant generates a random scalar, computes a commitment
   `H(contribution)`, and publishes the commitment before revealing the scalar.
2. **Reveal phase**: Participants reveal their scalars. The combined toxic waste is
   `product(scalars) mod r`. No single participant knows the full product if any one participant
   keeps their scalar private and discards it.
3. **Threshold check**: A minimum number of contributions (configurable) must be verified before
   the ceremony is considered complete.
4. **Transcript**: The full set of commitments and revealed values is published as an auditable
   record.

The result is a completed ceremony with a verifiable transcript — not a TODO comment or a
placeholder function body. The current implementation uses test contributions; a production
deployment would require a public ceremony with independent participants.

---

## Private Compute: Local Execution, On-Chain Receipt

The private WASM compute pipeline:

```
WasmJobSpec
    │  (WASM binary hash + input commitment + gas limit)
    ▼
Local WASM execution
    │  (no external validators; standard WASM runtime)
    ▼
WasmExecutionResult
    │  (output commitment = H_NOTE(outputs))
    ▼
ComputeProof
    │  (input commitment + output commitment + execution hash)
    ▼
ComputeReceipt  ──────────────►  ReceiptRoot PDA (on-chain)
    (publicly verifiable anchor)
```

No external validators participate in execution. No libp2p networking is required. No RocksDB
instance is needed. The WASM binary runs in the caller's local environment; only the commitment
to inputs and outputs is posted on-chain.

The receipt provides a publicly verifiable record that a committed computation completed. Anyone
with the receipt PDA address can verify that a specific WASM binary hash processed a specific
input commitment and produced a specific output commitment.

---

## Proof Aggregation: Amortized Verification Cost

Individual Groth16 proof verification via `alt_bn128_pairing` costs approximately 150,000–200,000
CU per proof, primarily from the pairing computation.

Batched verification amortizes the fixed overhead across multiple proofs. For a batch of N proofs:

| Batch Size | Total CU | Per-Proof CU |
|---|---|---|
| 1 | ~200,000 | ~200,000 |
| 8 | ~600,000 | ~75,000 |
| 32 | ~2,100,000 | ~65,000 |

Note: batches above 14 proofs exceed a single transaction's CU budget. Multi-transaction batching
is required for batches larger than approximately 7 proofs per transaction, depending on other
instruction overhead. The 32-proof figure above represents a multi-transaction batch where the
per-proof overhead is amortized across the full set.

Batch verification is implemented in `dark_bn254_gate` as an optional code path. Single-proof
verification remains the default for simplicity.

---

## Compression: CompressedNoteLeaf vs Full Note

| Format | Size | Contents |
|---|---|---|
| Full Note | 128 bytes | secret + amount + owner + leaf_index + nullifier + padding |
| CompressedNoteLeaf | 32 bytes | commitment hash only |

Naive compression ratio: 75%. The full note fields are retained off-chain by the note holder;
only the commitment is stored on-chain.

Light Protocol v2 achieves approximately 99.8% compression at scale through:
- Concurrent merkle trees with batched appends
- ZK-compressed account state (accounts stored as leaves, not full account data)
- Off-chain indexing of the full account state with on-chain merkle root anchoring

The `dark-note-compression` crate implements the 75% baseline model. The Light Protocol v2
integration path is documented but not yet implemented.

---

## Zero External Validators

Some private compute and ZK approaches on Solana require custom validator infrastructure:

- libp2p networking between validator nodes for off-chain coordination
- RocksDB persistent storage on each validator for private state
- Custom consensus participation for private execution committees
- Separate deployment and upgrade procedures outside the standard Solana program deployment model

This infrastructure creates operational complexity and requires relationships with validator
operators before the protocol can function.

The DNA x402 ZK stack requires:

- Standard Solana RPC access (devnet or mainnet)
- Standard Solana program deployment (BPF binary, no custom runtime)
- No validator-side software beyond a standard Solana validator
- No off-chain coordinator or sequencer

All coordination happens through Solana transactions and PDAs. The protocol is deployable by any
team with Solana program deployment permissions, without negotiating validator participation.

---

## Disclosure

This document describes technical design choices and comparisons based on publicly observable
properties of the described systems (syscall availability, on-chain program logic, documentation).

**NOT_PRODUCTION**: Nothing in this document or the associated codebase represents a production-ready
system. No mainnet deployment has occurred. No security audit has been performed. No trusted setup
ceremony with independent participants has been completed.

**devnet-only**: All testing and demonstrations have been performed on Solana devnet using test
validators and test keypairs. Devnet SOL has no monetary value.

**no-audit**: The crate implementations have not been reviewed by an external security researcher
or cryptographer. Known limitations (test-mode keys, no real trusted setup, no soundness guarantee)
are documented in DARK_ZK_PRIMITIVES.md under "What Is NOT Claimed."

---

*Last updated: 2026-05-26 | Branch: codex/mainnet-hardening*
