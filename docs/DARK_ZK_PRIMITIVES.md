# DARK_ZK_PRIMITIVES_V1

> **Status badges**: `NOT_PRODUCTION` | `devnet-only` | `no-audit`

---

## Overview

DARK_ZK_PRIMITIVES_V1 is a Solana-native zero-knowledge layer built on BN254 Groth16, providing
shielded note commitments, private payment flows via x402, and WASM compute receipts anchored on-chain.
The stack is composed of standalone Rust crates targeting Solana BPF for on-chain components and
native `x86_64` for off-chain proof bundle construction. All components run on Solana devnet;
no production keys, no trusted setup artifacts, and no mainnet deployments exist.

---

## Why BN254 on Solana

Solana exposes three precompile syscalls for elliptic-curve arithmetic on the BN254 (alt_bn128) curve:

| Syscall | Operation | Approx. CU Cost |
|---|---|---|
| `alt_bn128_addition` | Point addition on G1 | ~150 CU |
| `alt_bn128_multiplication` | Scalar multiplication on G1 | ~3,000 CU |
| `alt_bn128_pairing` | Batched pairing check e(A,B) = e(C,D)... | ~100,000–150,000 CU |

These syscalls are implemented at the validator level as native code, meaning the BPF program pays only
the syscall cost — no elliptic-curve arithmetic runs inside BPF itself.

BLS12-381 does not have equivalent syscall support on Solana. A verifier using BLS12-381 would need to
implement field arithmetic, extension-field towers, and Miller loop computation entirely inside a BPF
program. BPF programs are limited to 1,400,000 CU per transaction; a BLS12-381 pairing from scratch
inside BPF exceeds this budget by a large margin and is not hardware-accelerated.

BN254 is the correct curve for Solana. Our `dark_bn254_gate` program delegates all pairing checks to
the `alt_bn128_pairing` syscall, keeping on-chain verification within ~150,000 CU.

---

## Architecture Diagram

```
Off-chain                                On-chain (Solana BPF)
─────────────────────────────────────────────────────────────────
  [dark-shielded-client]
        │
        │  create_note(secret, amount)
        ▼
  [dark-poseidon-bn254]
   commitment = H_COMMITMENT(secret, amount)
        │
        │  prepare_withdrawal(note, merkle_path)
        ▼
  [dark-bn254-circuit]
   constraint simulation (no proving keys)
        │
        │  256-byte proof bundle
        ▼
  [dark-bn254-proof-gen]
   build_withdraw_instruction_data()          ──────────────►  [dark_bn254_gate]
   → 352-byte instruction payload                               alt_bn128_pairing()
                                                                pairing check passes
                                                                       │
                                                                       ▼
                                                              [dark-shielded-pool-core]
                                                               nullifier recorded in PDA
                                                                       │
                                                                       ▼
                                                              [dark-compute-receipt]
                                                               ReceiptRoot DAG updated
```

---

## Crate Inventory

| Crate Name | Layer | Tests | Description |
|---|---|---|---|
| `dark-poseidon-bn254` | Hashing | Unit | SHA-256 domain-separated BN254 scalar field hashing |
| `dark-bn254-circuit` | Circuit | Unit | Groth16 withdrawal constraint simulation |
| `dark-bn254-proof-gen` | Proof | Unit | Off-chain 256-byte proof bundle + 352-byte instruction builder |
| `programs/dark_bn254_gate` | On-chain | Integration | Groth16 BN254 verifier via alt_bn128 syscalls |
| `dark-shielded-pool-core` | Pool | Unit | Note commitment scheme, nullifier tracking, double-spend guard |
| `dark-shielded-client` | SDK | Unit | 3-function client: create_note, prepare_withdrawal, build_withdraw_instruction_data |
| `dark-private-x402` | Payment | Unit | x402 payment with shielded buyer identity |
| `dark-anon-signal` | Signal | Unit | Anonymous alpha signal purchase; seller receives commitment only |
| `agent-shielded-capsule` | Agent | Unit | AI agent capability capsule with ZK commitment |
| `dark-wasm-compute` | Compute | Unit | Private WASM compute with committed I/O |
| `dark-compute-receipt` | Receipt | Unit | Compute job receipt anchored in audit DAG |
| `dark-compute-capsule` | Compute | Unit | Capability-gated WASM execution |
| `dark-note-compression` | Compression | Unit | ZK note compression model: 128 bytes → 32 bytes |
| `dark-zk-complete-demo` | Demo | Binary | End-to-end 7-step demo binary |

---

## Hashing Scheme

All scalar field elements are produced via SHA-256 with a single prepended domain byte, then reduced
modulo the BN254 scalar field order `r`:

```
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

Hash formula:

```
H_domain(inputs...) = SHA256( [domain_byte] || inputs... ) mod r
```

Domain separation table:

| Domain Byte | Constant Name | Used For |
|---|---|---|
| `0x01` | `DOMAIN_COMMITMENT` | Note commitment: H(secret, amount) |
| `0x02` | `DOMAIN_NULLIFIER` | Nullifier: H(secret, leaf_index) |
| `0x03` | `DOMAIN_WITHDRAW` | Withdrawal circuit public input |
| `0x04` | `DOMAIN_NOTE` | Full note hash (secret, amount, owner) |

Rationale: distinct domain bytes prevent cross-context collisions between commitment and nullifier
hashes derived from the same secret. This is a minimal, auditable separation scheme with no
external dependencies.

---

## Proof Format

### 256-Byte Proof Bundle

The proof bundle produced by `dark-bn254-proof-gen` follows a fixed layout:

| Bytes | Field | Notes |
|---|---|---|
| 0–63 | `A` (G1 point) | 32-byte x + 32-byte y, uncompressed |
| 64–191 | `B` (G2 point) | 64-byte x (Fp2) + 64-byte y (Fp2), uncompressed |
| 192–255 | `C` (G1 point) | 32-byte x + 32-byte y, uncompressed |

All coordinates are big-endian, consistent with the Solana `alt_bn128_pairing` syscall input format.

### 352-Byte Withdraw Instruction Layout

The full instruction data passed to `dark_bn254_gate` is:

| Bytes | Field | Notes |
|---|---|---|
| 0–255 | Proof bundle | A + B + C as above |
| 256–287 | `nullifier_hash` | 32-byte BN254 scalar |
| 288–319 | `commitment` | 32-byte BN254 scalar |
| 320–351 | `withdraw_hash` | 32-byte BN254 scalar (public input) |

Total: 352 bytes. The on-chain program deserializes this layout, extracts the public inputs, and
passes the proof bytes to `alt_bn128_pairing`.

---

## Shielded Pool Protocol

The shielded pool operates in four steps:

**Step 1 — Deposit**

The depositor calls `dark-shielded-client::create_note(secret, amount)`. The client computes:

```
commitment = H_COMMITMENT(secret, amount)
```

The commitment is submitted on-chain and stored in a NoteCommitment PDA. The depositor retains
the secret off-chain. The on-chain record contains only the commitment — no amount, no identity.

**Step 2 — Store Commitment**

`dark-shielded-pool-core` appends the commitment to the merkle-like commitment accumulator stored
across NoteCommitment PDAs. A `leaf_index` is assigned and returned to the depositor.

**Step 3 — Withdraw**

The depositor calls `prepare_withdrawal(note, leaf_index)`. The client:
1. Computes `nullifier = H_NULLIFIER(secret, leaf_index)`
2. Simulates withdrawal circuit constraints
3. Assembles the 352-byte instruction via `build_withdraw_instruction_data()`
4. Submits the instruction to `dark_bn254_gate`

The gate program performs the pairing check. On success, the nullifier is recorded in a
NullifierBank PDA. Any attempt to reuse the same nullifier is rejected with a double-spend error.

**Step 4 — Verify Receipt**

After withdrawal, `dark-compute-receipt` appends a receipt entry to the ReceiptRoot DAG PDA.
The receipt is publicly verifiable: it records the nullifier hash and a timestamp. No amount
or identity is revealed.

---

## Private x402 Payment Flow

`dark-private-x402` extends the x402 HTTP payment protocol with shielded buyer identity.

The buyer identity is derived as:

```
buyer_hash = SHA256(wallet_pubkey || nonce)
```

The five-step flow:

1. **Request**: The buyer sends an x402 payment request including `buyer_hash` and the payment amount.
2. **Commitment**: The client generates a note commitment for the payment amount and attaches it to the request.
3. **Proof Assembly**: `dark-bn254-proof-gen` builds the 352-byte instruction proving the note is valid and unspent.
4. **On-chain Settlement**: `dark_bn254_gate` verifies the proof. The nullifier is recorded, preventing double-spend.
5. **Receipt**: The seller receives only the `buyer_hash` and the on-chain receipt. The buyer's wallet address is never exposed to the seller.

This flow is compatible with AI agent wallets: the agent provides `buyer_hash` at request time, and the
receiving service cannot link it to a specific wallet without knowledge of the nonce.

---

## Private WASM Compute

`dark-wasm-compute` provides committed-I/O private computation. The four-step protocol:

**Step 1 — Job Spec**

The caller constructs a `WasmJobSpec` containing:
- WASM binary hash (SHA-256)
- Input commitment: `H_NOTE(inputs...)`
- Maximum gas limit

**Step 2 — Execution**

The WASM binary executes locally. Outputs are produced deterministically from committed inputs.
No external validator is involved in execution.

**Step 3 — Proof**

A `ComputeProof` is assembled containing:
- Input commitment
- Output commitment: `H_NOTE(outputs...)`
- Execution hash (WASM binary hash || input hash)

**Step 4 — Receipt DAG**

`dark-compute-receipt` anchors the `ComputeProof` into the ReceiptRoot DAG on-chain. The receipt
is a publicly verifiable record that a committed computation completed. The actual inputs and outputs
remain off-chain; only the commitments are stored on-chain.

---

## ZK Compression Model

`dark-note-compression` implements a compression model that reduces note storage overhead:

| Format | Size | Fields Included |
|---|---|---|
| Full Note | 128 bytes | secret (32) + amount (8) + owner (32) + leaf_index (8) + nullifier (32) + padding (16) |
| Compressed Note Leaf | 32 bytes | commitment hash only |

Savings calculation:

```
Naive savings = (128 - 32) / 128 = 75%
```

This is the naive model implemented in `dark-note-compression`. It stores only the commitment hash
and discards the remaining fields, which must be retained off-chain by the note holder.

For reference: Light Protocol v2 achieves approximately 99.8% compression at scale through
concurrent merkle tree batching and ZK-compressed account state. The `dark-note-compression`
model is a 75% baseline; integration with Light Protocol v2 is a future path, not a current
implementation.

---

## What Is NOT Claimed

This section is a precise list of limitations. Read it carefully before building on this stack.

- **No production deployment.** Nothing in this stack has been deployed to Solana mainnet.
  All testing has occurred on Solana devnet using test validators.

- **No audit.** No security audit, cryptographic review, or external code review has been
  performed on any crate in this stack. Do not use in production without a full audit.

- **No real proving keys.** `dark-bn254-circuit` and `dark-bn254-proof-gen` simulate Groth16
  constraints and assemble proof-shaped byte bundles. There are no actual proving keys, no
  trusted setup, and no soundness guarantee. The proof bundles are structurally valid inputs
  to the pairing syscall but do not constitute a sound zero-knowledge proof system.

- **No soundness.** Without a real trusted setup and verifying keys, the current implementation
  does not provide the zero-knowledge or soundness properties of Groth16. A verifier with
  the right key material could accept or reject any proof arbitrarily.

- **No privacy guarantee on-chain.** On a public blockchain, on-chain data (PDAs, account
  contents, transaction history) is visible to anyone. The privacy properties of this stack
  depend on the cryptographic soundness of the proof system, which is not established here.

- **No MPC ceremony.** The commit-reveal contribution scheme in the codebase is a structural
  model. A real Groth16 deployment requires a completed powers-of-tau ceremony with a
  verifiable transcript. That ceremony has not been run.

- **Devnet test mode only.** All network interaction targets Solana devnet. Connection parameters,
  program IDs, and account seeds are set for devnet. Mainnet deployment requires a separate
  review and deployment process.

---

*Last updated: 2026-05-26 | Branch: mainnet-hardening*
