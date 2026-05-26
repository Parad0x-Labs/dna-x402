# ZK Proof Verification Plan

## Current State (mock/local only)

Dark Null programs currently verify:
- PDA uniqueness (nullifier not double-spent)
- Receipt/nullifier PDA existence
- Authority signatures

They do NOT verify ZK proofs. This document describes the architecture
and upgrade path.

## What Is Real Now

- Typed `ProofVerifier` trait with `ProofClaim` + `ProofVerificationResult`
- `MockProofVerifier`: accepts proof == SHA256("MOCK_VALID" || public_inputs || circuit_id)
- `RejectAllVerifier`: fail-closed default
- Typed stubs for Groth16Bn254, Risc0Receipt, BonsolExecution
- `dark_proof_gate_lite` program: records externally-verified claims behind authority sig
- 18 tests passing across dark-proof-core + dark-proof-receipts

## What Is NOT Real

- No Groth16 BN254 verification (requires groth16-solana crate + on-chain verifier key)
- No RISC Zero receipt verification (requires RISC Zero toolchain)
- No Bonsol execution verification (requires Bonsol CLI + deployed execution program)
- dark_proof_gate_lite is NOT a ZK verifier — it records claims, not proofs

## Upgrade Path

### A. Groth16 BN254 Verifier
1. Install groth16-solana or equivalent
2. Deploy on-chain verification key account
3. Wire `Groth16VerifierStub` → real verifier using on-chain VK
4. Evidence required: `dist/alien-final/evidence/zk_verifier_real.json`

### B. Bonsol Execution Verifier
1. Install Bonsol CLI (`npm i -g @bonsol/cli` if available)
2. Register execution request on Solana devnet
3. Wait for Bonsol prover to generate execution receipt
4. `BonsolVerifierStub` → `BonsolVerifier` with receipt verification
5. Evidence required: `dist/alien-final/evidence/bonsol_real.json`

### C. RISC Zero Receipt Verifier
1. Install rzup: `curl -L https://risczero.com/install | bash && rzup install`
2. Build guest program in zkvm/dark_batch_guest/
3. Generate receipt from host-side prove() call
4. Verify receipt on-chain via RISC Zero Solana verifier
5. Evidence required: `dist/alien-final/evidence/risc0_real.json`

## Required Evidence Before Public Claim

Any public claim of "ZK verified" requires:
- `dist/alien-final/evidence/zk_verifier_real.json` containing:
  - proof system name
  - verification key hash
  - test proof receipt hash
  - on-chain tx signature

Until this file exists, public wording must say:
"ZK proof verification interface exists with mock verifier — real backend not yet wired"
