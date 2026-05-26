# Bonsol / RISC Zero Proof Layer

## What Runs Locally

- `dark-batch-auditor-core`: Full batch audit logic in normal Rust. 10 tests passing.
  - No duplicate nullifier check
  - Receipt root (poison excluded)
  - Session netting correctness
  - Model output root
  - Caveat budget check
- `dark-bonsol-adapter`: Typed Bonsol adapter, fail-closed. 6 tests passing.
- `dark-risc0-adapter`: Typed RISC Zero adapter, fail-closed. 6 tests passing.
- `zkvm/dark_batch_guest/`: Guest-compatible batch logic with 4 local tests.

## What Requires Bonsol

- `BonsolAdapter::submit_execution_request()` — requires Bonsol CLI
- Real execution receipt from Bonsol prover network
- On-chain verification via Bonsol verifier program on devnet

### Install Bonsol (if available):
```bash
npm i -g @bonsol/cli
# or see: https://github.com/anagrambuild/bonsol
```
Status: BLOCKED — Bonsol CLI not installed in this environment.

## What Requires RISC Zero

- `Risc0Adapter::prove_batch()` — requires RISC Zero toolchain
- Building `zkvm/dark_batch_guest/` as a real zkVM ELF
- Generating a real STARK/SNARK receipt

### Install RISC Zero:
```bash
curl -L https://risczero.com/install | bash
rzup install
```
Status: BLOCKED — rzup not installed in this environment.

## How to Run Proof Generation (when installed)

```bash
# RISC Zero (requires rzup):
cd zkvm/dark_batch_guest
cargo +risc0 build --release
# Host side prove:
# risc0_zkvm::default_prover().prove(env).unwrap()

# Bonsol (requires CLI):
bonsol build --zk-program-path zkvm/dark_batch_guest
bonsol execute --input <input_file>
```

## Evidence Before Claiming Integration

To claim "Bonsol integrated":
→ `dist/frontier-final/evidence/bonsol_real.json` must exist with real tx sig

To claim "RISC Zero integrated":
→ `dist/frontier-final/evidence/risc0_real.json` must exist with receipt hash

**Current public wording allowed:**
"Verifiable batch-auditor interface exists with typed adapters for Bonsol and RISC Zero.
Local audit logic is tested. Both adapters fail-closed until toolchain is installed."

**Forbidden until evidence exists:**
"Bonsol integrated" / "RISC Zero integrated" / "ZK verified"
