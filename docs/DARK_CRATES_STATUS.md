# Dark-* crate library: status inventory

| | |
|---|---|
| Revision 2 | checked against `main` at `8743fd7f3e5d4ee3150cda25d2544e706661c1da`, 2026-10-06 |
| Revision 1 | original assessment dated 2026-06-06 (kept below, findings unchanged) |
| Scope | the Rust workspace of **this repository** (`crates/`, `programs/`). It does not describe the separate [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) program (`src/lib.rs`, Anchor, program `35GMe13…`), which has its own Groth16 verifier and its own evidence |
| Machine-readable | [`evidence/claims.json`](../evidence/claims.json), reviewer summary in [`REVIEW.md`](../REVIEW.md) |

The library is large and its maturity is not uniform. Most crates model data structures and flows with
SHA-256 in place of the named cryptographic operation. A small number call a real cryptographic dependency
or Solana syscall. Nothing below is a statement about a different repository.

## Status labels

| Label | Meaning |
|---|---|
| real-implementation | the named operation is implemented with a real dependency or syscall and tested |
| prototype | real logic, but a documented gap (missing path, single-party setup, devnet-only build) |
| scaffold | data structures and flow are present; the named cryptographic operation is not |
| hash-only stand-in | SHA-256 used where a signature, ECDH, range proof or folding step is named |
| mocked | declares itself a mock (`is_mock = true`) for tests and demos |
| fail-closed | verifier path exists but refuses every input in the current build |
| retired | deployment closed; records may remain readable |
| missing | named in an earlier report, no code exists |

## Counts at revision 2

Counted from tracked files only. Programs, crates, packages and demonstrated capabilities are separate
things and are counted separately.

| What | Count | Notes |
|---|---:|---|
| Crate directories under `crates/` | 332 | 241 named `dark-*`, 91 other names (revision 1 said 236 `dark-*`) |
| Root workspace member entries | 362 | 360 unique; `dark-commitment-chain` and `dark-htlc-receipt` are listed twice |
| Crates outside the root workspace | 4 | `x402/labs/polyglot/rust-agent`, `x402/sdk/rust/dna-x402-client`, `zkvm/dark_batch_auditor`, `zkvm/dark_batch_guest` |
| Program directories under `programs/` | 28 | revision 1 said 23; added since: `dark_registrar`, `x402_refund_escrow` |
| Programs deployed on devnet, 2026-10-06 | 21 of 28 | IDs and build hashes in [`evidence/devnet-programs-2026-10-06.json`](../evidence/devnet-programs-2026-10-06.json); test results for this deployment are pending |
| npm package manifests | 26 | 24 under `packages/` (5 private), 2 under `x402/`; publication status per package is in `evidence/claims.json` |
| Crates carrying a self-declared non-production marker | about 236 of 332 | union of `IS_STUB = true`, `is_mock`, `MAINNET_READY = false`, `mainnet_ready: false`, `NOT_PRODUCTION` (grep count, approximate) |
| Crates and programs calling a real cryptographic dependency | listed below | |

### Crates that call a real cryptographic dependency

| Crate | Dependency |
|---|---|
| `dark-groth16-core` | `solana_program::alt_bn128` pairing, addition, multiplication |
| `dark-shielded-verifier` | `alt_bn128` pairing, addition, multiplication (used by `dark-pool-sdk`) |
| `dark-kzg-verifier` | `alt_bn128` via `dark-groth16-core` |
| `dark-poseidon-real` | `light-poseidon`, `ark-bn254` on host; `poseidon::hashv` syscall on SBF |
| `dark-shielded-pool-core` | Poseidon via `dark-poseidon-real` |
| `dark-fedimint-ecash`, `dark-kvac`, `dark-x402-kvac`, `dark-stealth-ed25519` | `curve25519-dalek` |
| `compute-coupon`, `swarm-capsule`, `ritual-precompile-braid`, `ritual-bound-token-demo` | `ed25519-dalek` |
| `dark-macaroons`, `dark-blind-oracle` | `hmac` + `sha2` (RFC 2104) |

Names that look cryptographic but are not: `dark-zk-hook` and `dark-x402-e2e-demo` mention `alt_bn128` only
in comments; `dark-poseidon-tree` and `dark-poseidon-safe` fall back to SHA-256; `dark-hash-core` uses its
`poseidon-mock` feature. Crates named `*-stub` or `*-mock` (`dark-groth16-stub`, `dark-plonk-stub`,
`dark-zk-snark-stub`, `dark-zk-rollup-stub`, `dark-x402-client-mock`, `dark-x402-server-mock`) depend only on
`sha2`/`serde`.

## Per-entry status (revision 1 entries, re-checked)

"Invoked path" is what calls the exported API in this repository. "none" means the crate is a workspace
member that no program, package or other crate depends on.

| Entry | Revision 1 label | Revision 2 label | Real dependency | Invoked path | Later evidence |
|---|---|---|---|---|---|
| `dark-macaroons` | real | real-implementation | `hmac` 0.13 + `sha2`; RFC 4231 test vector (`src/lib.rs`). MAC comparison is not constant-time | none | — |
| `dark-proof-of-innocence` | real | real-implementation of sorted-set non-membership; hash-based, not zero-knowledge (verifier holds the set); self-declares `NOT_PRODUCTION` | `sha2` | none | — |
| `dark-blind-oracle` | scaffold (real HMAC) | **prototype, HMAC-SHA256 (fixed after revision 2).** Revision 2 found the attestation was `SHA256(domain, oracle_pubkey, blinded_commitment)`, recomputable from public fields and so forgeable. It is now HMAC-SHA256 under the oracle secret over the commitment and timestamp; `verify_attestation` needs the secret and compares in constant time. A MAC, not a signature: only a key holder can verify. RFC 4231 vector and a forgery-rejection test in `src/lib.rs` | `hmac` 0.13 + `sha2` | none in Rust; `x402/tests/dark-null.blind-oracle.test.ts` mirrors it in TypeScript | — |
| `dark-x402-commit-reveal` | scaffold | scaffold (`IS_STUB = true`); commit/reveal logic complete, no on-chain anchor | `sha2` | none | — |
| `dark-zk-hook` | fail-closed (fixed 2026-06-06) | fail-closed: `verify_hook_proof` returns `StubVerifierDisabled` | `sha2` | none | — |
| `dark-imt-nullifier` | verify hardened (2026-06-06) | prototype: low node bound to the tree; Merkle root not depth-fixed and the inclusion path is still open | `sha2` | none | — |
| `dark-nova-receipt` | hash stand-in | hash-only stand-in: `step_proof` is SHA-256, no Nova/IVC fold | `sha2` | none | — |
| `dark-x402-stealth` | hash stand-in | hash-only stand-in: "ECDH" is SHA-256. The unsupported "First Solana implementation" source comment was removed after revision 2 | `sha2` | none | replaced in practice by `crates/dark-stealth-ed25519` (curve25519-dalek): [`evidence/zk/nullpay-stealth-ed25519-killtest.json`](../evidence/zk/nullpay-stealth-ed25519-killtest.json) (off-chain, 7/7) |
| `dark-x402-private-intent` | hash stand-in | hash-only stand-in: SHA-256 commitment; range check needs the amount revealed | `sha2` | none | — |
| `dark-x402-session-key` | hash stand-in | hash-only stand-in: `payment_token` is a hash, not a signature | `sha2` | none | — |
| `programs/dark_shielded_pool` | scaffold, fails closed | **prototype.** Real Groth16 verify over `alt_bn128` (`dark-groth16-core`) with Poseidon (`dark-poseidon-real`). At this commit the guard `#[cfg(not(feature = "devnet"))] if !vk.mainnet_ready` is active because the VK is a single-party devnet key and `Cargo.toml` declares no `devnet` feature, so every withdraw proof is refused | `dark-groth16-core`, `dark-poseidon-real`, `dark-shielded-pool-core` | `build/zk/*.mjs` devnet scripts | historical (program since closed): [`evidence/shielded-pool-devnet.json`](../evidence/shielded-pool-devnet.json) (2026-06-09, v2 circuit, 6 scenarios with signatures, before the guard); [`evidence/zk/shielded-withdraw-v3-hardening-devnet.json`](../evidence/zk/shielded-withdraw-v3-hardening-devnet.json) (2026-06-22, circuit fix, no transaction). Redeployed to devnet 2026-10-06 as `FmLWnMKA…`, built with a `devnet` feature that is not yet in this commit; results pending |
| `programs/dark_bn254_gate` | scaffold | **fail-closed.** Real Groth16 verify (`groth16_verify` with `null_proof_vk`), refused while `vk.mainnet_ready` is false (single-party ceremony) | `dark-groth16-core` | `programs/dark_bn254_gate/tests/integration.rs` | historical (program since closed): [`evidence/zk/dark-bn254-gate-mainnet-beta.json`](../evidence/zk/dark-bn254-gate-mainnet-beta.json) (2026-05-31, one verified proof on mainnet-beta before the guard); not part of the 2026-10-06 devnet deployment |
| `dark-note-split-circuit` | missing | missing: no tracked file | — | — | — |

The only cross-repository link is a shared artifact: `evidence/zk/vk.json` here is byte-identical to
`Dark-Null-Protocol/circuits/vk.json` (SHA-256 `6abfff44…3d63a`), and `dark-groth16-core/src/null_proof_vk.rs`
was generated from it. Neither repository depends on the other's Rust code.

## Rules

- A security gate or verifier without a working verifier must refuse (fail closed), never approve.
- Do not describe a scaffold, hash-only stand-in or mocked crate as a working primitive, as "first", or as
  reviewed by a third party. Keep it behind `IS_STUB` / `MAINNET_READY` gates for testing.
- When a crate progresses, change its row here and its record in `evidence/claims.json` in the same commit,
  and link the evidence.

## Revision 1 (2026-06-06), preserved

Original text, with status words mapped to the labels above. Counts are as of that date.

> The repo has a large `dark-*` crate library (236 crates) plus 23 on-chain programs. The scale is real;
> the maturity is not uniform. Many crates are scaffolds: correct data structures and tests, but the
> claimed cryptographic operation (ZK verify, ECDH, range proof, Nova fold, Merkle inclusion) is not
> implemented.
>
> An internal engineering report (2026-06-06) described 10 of these as "first-in-existence" primitives. A
> code review of the named crates found that claim overstated: most are scaffolds. This file exists so that
> nobody, human or agent, ships, builds on, or markets a scaffold as a working primitive.

| Crate | Exists | Status on 2026-06-06 | Notes on 2026-06-06 |
|---|---|---|---|
| `dark-macaroons` | yes | real | RFC 2104 HMAC, caveat enforcement, test vectors |
| `dark-proof-of-innocence` | yes | real | sorted-set non-membership, witness validation |
| `dark-blind-oracle` | yes | scaffold | described then as "real HMAC"; revision 2 found SHA-256 only (see above) |
| `dark-x402-commit-reveal` | yes | scaffold | sound logic; on-chain anchor program not deployed |
| `dark-zk-hook` | yes | fail-closed (fixed 2026-06-06) | was `approved: true` for any non-zero proof (forgeable); now returns `StubVerifierDisabled` |
| `dark-imt-nullifier` | yes | hardened (fixed 2026-06-06) | `verify_non_membership` binds the low node to the real tree (was forgeable); inclusion path open |
| `dark-nova-receipt` | yes | hash-only stand-in | `step_proof` is SHA-256, not a Nova/IVC fold |
| `dark-x402-stealth` | yes | hash-only stand-in | "ECDH" is domain-separated SHA-256, not Curve25519 |
| `dark-x402-private-intent` | yes | hash-only stand-in | SHA-256 commitments, no range proof |
| `dark-x402-session-key` | yes | hash-only stand-in | session checks real; `payment_token` is a hash, not a signature |
| `dark_shielded_pool` (program) | yes | scaffold, fails closed | self-documented blockers then: hash mismatch, root was a hash chain not a tree, recipient not bound, no trusted setup |
| `dark_bn254_gate` (program) | yes | scaffold | no pairing path wired then |
| `dark-note-split-circuit` | no | missing | named "build this first" in the report; does not exist |

Fixes applied on 2026-06-06: `dark-zk-hook` made fail-closed (12/12 tests) and `dark-imt-nullifier`
`verify_non_membership` bound to the genuine tree node (17/17 tests).
