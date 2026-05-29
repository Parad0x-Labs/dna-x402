# Solana Alien Tek

Cryptographic primitives for the Dark NULL privacy layer: domain-separated SHA-256
hashes, Merkle node construction, commitment/nullifier/receipt derivation, and a
Poseidon-compatible swap path for on-chain SVM use.

Crates: `crates/dark-poseidon-tree`, `crates/dark-hash-core`.

---

## Formal Verification (Kani)

### Installation

```bash
cargo install --locked kani-verifier
cargo kani setup
```

### Harnesses (`crates/dark-poseidon-tree/src/lib.rs`, `#[cfg(kani)] mod kani_proofs`)

| Harness | Command |
|---|---|
| `domain_hash_never_panics` | `cargo kani --harness domain_hash_never_panics` |
| `commitment_hash_never_panics` | `cargo kani --harness commitment_hash_never_panics` |
| `nullifier_hash_never_panics` | `cargo kani --harness nullifier_hash_never_panics` |
| `merkle_node_never_panics` | `cargo kani --harness merkle_node_never_panics` |
| `domain_constants_all_distinct` | `cargo kani --harness domain_constants_all_distinct` |
| `commitment_includes_value_in_preimage` | `cargo kani --harness commitment_includes_value_in_preimage` |

Run all at once:

```bash
cargo kani --tests  # runs every #[kani::proof] harness in the crate
```

### What each proof establishes

- **`domain_hash_never_panics`** — For any `domain: u8` and any 32-byte input, the
  function completes without a panic, bounds violation, or arithmetic overflow.
- **`commitment_hash_never_panics`** — Same guarantee over the full `(secret, value)`
  input space (all u64 values, all 32-byte secrets).
- **`nullifier_hash_never_panics`** — Panic-freedom for all `(secret, root)` pairs.
- **`merkle_node_never_panics`** — Panic-freedom for all `(left, right)` node inputs.
- **`domain_constants_all_distinct`** — Proves exhaustively that the five domain bytes
  (`COMMITMENT=1`, `NULLIFIER=2`, `RECEIPT=3`, `X402_INTENT=4`, `MERKLE_NODE=5`) are
  all pairwise distinct, making cross-context collisions structurally impossible.
- **`commitment_includes_value_in_preimage`** — When `value_a ≠ value_b`, the byte
  sequences fed to SHA-256 are provably different, so the value is not silently dropped
  from the preimage.

### Out of scope

- **SHA-256 collision resistance** — requires a cryptographic hardness assumption; Kani
  cannot prove this.
- **On-chain BPF / SVM runtime behaviour** — Kani operates on native Rust; the Solana
  Poseidon syscall swap-path is not exercised by these harnesses.
- **Circom circuit correctness** — circuit constraints live outside this crate.
