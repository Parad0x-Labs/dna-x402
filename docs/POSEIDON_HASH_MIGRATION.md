# Poseidon Hash Migration Plan

## Why v1 Ritual Stays SHA-256

The DARKNULL on-chain ritual (live on devnet) uses:
  SHA256(nullifier || epoch_le64 || "dark_null_v1")[0]

This formula is permanently committed to devnet. Changing the hash function
would invalidate all existing NullRec PDAs and the DARKNULL ritual.

v1 formula remains SHA-256 forever. It is the canonical on-chain nullifier formula.

## Why v2 Needs Poseidon Parity

ZK circuits (Groth16, PLONK, RISC Zero) are designed to verify Poseidon hashes
efficiently. SHA-256 in-circuit is 100-1000× more expensive than Poseidon.

v2 Dark Null (circuit-bound) must use Poseidon for:
- commitment hashes (inside ZK proof)
- nullifier hashes (inside ZK proof)
- receipt tree nodes (inside ZK proof)

## Feature Flags

| Feature | Behavior | When to use |
|---------|----------|-------------|
| `sha256-fallback` (default) | SHA-256 domain-separated | All tests, devnet v1 ritual |
| `poseidon-mock` | SHA-256 with POSEIDON_MOCK prefix | Deterministic unit tests for v2 API |
| `poseidon-real` | Real solana_program::poseidon::hashv | BLOCKED — BPF runtime required |

## Test Commands

```bash
# SHA-256 backend (all platforms):
cargo test -p dark-hash-core

# Poseidon mock (all platforms):
cargo test -p dark-hash-core --features poseidon-mock

# Real Poseidon (BLOCKED — BPF runtime required):
# cargo test -p dark-hash-core --features poseidon-real
# BLOCKER: solana_program::poseidon::hashv is only available inside BPF VM
# Status: BLOCKED until Light Protocol or RISC Zero verifier is wired
```

## Upgrade Path

1. **Current (v1):** SHA-256 on-chain, SHA-256 with domain prefix off-chain
2. **v2 (planned):** Poseidon syscall on-chain via `solana_program::poseidon::hashv`
3. **Circuit parity:** dark-hash-core PoseidonRealHasher will match circuit hash

## Blockers for Real Poseidon

- `solana_program::poseidon::hashv` is a BPF syscall — only callable inside a deployed program
- Host-side tests cannot call it directly
- Solution: test via `solana-program-test` BanksClient (requires Linux/macOS due to rbpf 0.8.3 Windows bug)
