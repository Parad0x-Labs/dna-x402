# Frontier Final Demo Flow

## 1. Overview

The `dark-frontier-final-demo` crate implements a 10-step end-to-end demo pipeline
that ties together every FRONTIER_FINAL primitive in a single local / mock
execution. No real SOL is transferred. No real ZK proofs are generated. The demo
is designed to be runnable entirely offline on any developer machine and to
produce a deterministic JSON output committed to a single `final_hash`.

The output schema is described in [Section 5](#5-output--distfrontier-finaldemo_runjson).

---

## 2. Step-by-Step Pipeline

Each step captures a deterministic hash of its output and records a `status`
(`ok`, `mock`, or `blocked`) and a human-readable `detail` string.

### Step 1 — x402 Payment Requirement

The server side produces an `X402PaymentRequirement` struct encoding the
payment terms: scheme, network, asset, amount in lamports, payee pubkey, and
an expiry slot. The raw resource URL is **not** stored — it is hashed into a
`scope_hash` so the requirement is URL-safe. The `requirement_hash` is the
step output. Status: **mock** (no real HTTP 402 is sent).

### Step 2 — x402 Payment Proof

The client constructs an `X402PaymentProof` referencing the `requirement_hash`
from Step 1. The `tx_signature` field is a `MOCK_SIG_*` string rather than a
real Solana tx signature. The `proof_hash` is the step output. Status: **mock**
(no real Solana transaction submitted).

### Step 3 — Mint DarkX402Receipt

`mint_receipt_note_after_payment` is called with the requirement and proof from
Steps 1-2. On success it returns a `DarkX402Receipt` containing a
`receipt_nullifier` (used in downstream steps) and a `receipt_id`. The
`receipt_id` is the step output. Status: **mock** (local hash computation only,
no on-chain account created).

### Step 4 — Compression Simulator — Leaf Insert

A `CompressedLeaf` is built from the receipt data (domain `Receipt`,
`nullifier_hash` = `receipt_nullifier` from Step 3) and inserted into a
`LocalMerkleSimulator`. The simulator updates an in-memory Merkle root. The
`new_root` is the step output. Status: **mock**. Note: `validity_proof_hash`
is always `[0;32]` — this is **NOT** real ZK compression. Light Protocol SDK
is not installed.

### Step 5 — Caveat Engine — Agent Macaroon Check

An `AgentCaveats` struct is built with permissive limits (max total spend 10M
lamports, max single spend 1M lamports, expires at slot 99,999). A
`SpendContext` is built with amount 500,000 lamports at slot 1,000. `check_caveats`
is called. If it returns `Ok(())`, status is **ok**. The step hash is a domain-tagged
hash over the `receipt_id`.

### Step 6 — Session Netting — 3 Spends → 1 Hash

A `Session` is built with 3 `SessionNote` entries (100,000 + 200,000 + 300,000
lamports). `net_settlement_hash()` collapses all three spends into a single
32-byte hash. Status: **ok**. Note: "3 spends → 1 hash" is the core privacy
property — an observer sees one hash, not individual spend amounts.

### Step 7 — Batch Auditor — No Duplicate Nullifiers

A `DarkBatchInput` is constructed with 3 receipt leaves and 3 distinct
nullifiers (including `receipt_nullifier` from Step 3). `audit_batch` checks
for duplicate nullifiers, poison leaves, and budget compliance. The
`batch_hash` is the step output. Status: **ok** when all checks pass.

### Step 8 — Mock Proof Verifier — ProofClaim + ProofReceipt

A `ProofClaim` with `system=Mock` is constructed. `build_mock_proof` produces
the expected proof bytes. `MockProofVerifier.verify` accepts the proof and
`mint_proof_receipt` returns a `ProofReceipt`. The `receipt_id()` of the
`ProofReceipt` is the step output. Status: **mock** (NOT a ZK verifier — mock
proof bytes only).

### Step 9 — Bonsol/RISC0 Adapter — Blocked Stub

`BonsolAdapter::new()` is created (toolchain_available = false).
`submit_execution_request` is called. It returns
`BonsolError::ToolchainBlocked(...)`. The `request_hash` of the execution
request is used as the step hash (deterministic even when blocked). Status:
**blocked**. This is the expected production path until the Bonsol CLI and
RISC Zero toolchain are installed.

### Step 10 — Public Puzzle Hash

A final puzzle hash is computed as:

```
puzzle_hash = SHA-256("dark_null_v1_demo_puzzle" || step1_hash || step2_hash || ... || step9_hash)
```

This commits to all prior step outputs in a single value. The `final_hash`
in `DemoRun` is computed similarly over all 10 step hashes:

```
final_hash = SHA-256("dark_null_v1_demo_final" || step1_hash || ... || step10_hash)
```

Status: **ok**. Note: this is not a mainnet proof page.

---

## 3. Status Indicators

| Symbol | Status    | Meaning                                                              |
|--------|-----------|----------------------------------------------------------------------|
| ok     | `ok`      | Step ran successfully; output captured deterministically.            |
| mock   | `mock`    | Real production equivalent not wired; mock/stub used.               |
| blocked | `blocked` | External toolchain required; step returned an explicit error.       |

---

## 4. Running the Demo

Run the tests (which exercise the full pipeline):

```bash
cargo test -p dark-frontier-final-demo -- --nocapture
```

To emit `DEMO_RUN.json`, call `run_demo()` from a `main.rs` and serialize it:

```rust
// Example main.rs (add [[bin]] to Cargo.toml if desired)
fn main() {
    let run = dark_frontier_final_demo::run_demo();
    let json = serde_json::to_string_pretty(&run).unwrap();
    std::fs::write("dist/frontier-final/DEMO_RUN.json", json).unwrap();
    println!("final_hash: {}", run.final_hash);
}
```

Or pipe from a test:

```bash
cargo test -p dark-frontier-final-demo test_demo_run_completes -- --nocapture 2>&1
```

---

## 5. Output — `dist/frontier-final/DEMO_RUN.json`

The JSON output has this schema:

```jsonc
{
  "mainnet_ready": false,          // always false — hardcoded invariant
  "network": "devnet-mock",        // run environment label
  "steps": [                       // array of 10 DemoStep objects
    {
      "step": 1,                   // 1-based index
      "name": "...",               // human-readable step name
      "status": "mock",            // "ok" | "mock" | "blocked"
      "hash": "aabbccdd...",       // hex-encoded 32-byte step output hash
      "detail": "..."              // human-readable description / caveats
    }
    // ...9 more steps
  ],
  "final_hash": "aabbccdd...",     // SHA-256 of all step hashes
  "blockers": [                    // explicit list of mainnet blockers
    "Bonsol toolchain not installed",
    "RISC Zero toolchain not installed",
    "Real ZK backend not wired",
    "Devnet tx verification requires RPC client"
  ],
  "public_summary": "...",         // one-line status
  "no_raw_secrets": true           // always true — verified by test
}
```

A placeholder file lives at `dist/frontier-final/DEMO_RUN.json`. Run the crate to
overwrite it with real output.

---

## 6. Not-Mainnet Notice

This demo runs entirely locally or against a devnet mock environment:

- **No real SOL is transferred.** All `tx_signature` values are `MOCK_SIG_*`
  strings. No Solana RPC is contacted.
- **Mock proof verifier is NOT a ZK verifier.** `MockProofVerifier` accepts
  only proofs that match the formula `SHA-256("MOCK_VALID" || public_inputs || circuit_id)`.
  It provides no cryptographic soundness guarantee.
- **Bonsol/RISC0 adapters are fail-closed stubs.** `BonsolAdapter::new()`
  always sets `toolchain_available = false`. Every method that requires the
  external toolchain returns `BonsolError::ToolchainBlocked`.
- **Compression simulator is NOT real Light Protocol.** `LocalMerkleSimulator`
  maintains an in-memory SHA-256 Merkle tree. The `validity_proof_hash` field
  is always `[0u8;32]`. No on-chain compressed account is created.
- **`mainnet_ready` is hardcoded to `false`** and is enforced by a dedicated
  test (`test_demo_mainnet_ready_false`).

---

## 7. Next Steps to Make Demo Real

1. **Install rzup / RISC Zero toolchain** — `dark-risc0-adapter` transitions
   from stub to live; real receipts can be generated and verified.

2. **Install Bonsol CLI** (`npm i -g @bonsol/cli` or build from source) —
   `BonsolAdapter` transitions from `ToolchainBlocked` to submitting real
   execution requests to the prover network.

3. **Install `@lightprotocol/stateless.js`** — `LightProtocolAdapter` in
   `dark-compression-core` transitions from `BackendUnavailable` to real ZK
   compression against a devnet photon indexer.

4. **Wire real devnet tx signature** — Replace `MOCK_SIG_*` in
   `X402PaymentProof.tx_signature` with an actual Solana devnet tx signature
   and add an RPC client call to verify it on-chain.

5. **Third-party audit** — After all adapters are live and devnet evidence is
   captured, a security audit unlocks the mainnet gate and `mainnet_ready` can
   be set to `true` in the release build.
