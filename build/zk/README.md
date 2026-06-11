# shielded_withdraw v2 / v3 — ZK build pipeline (DEVNET pilot)

End-to-end pipeline that compiles the `shielded_withdraw` circuits, runs a
**single-party** trusted setup, generates real Groth16 proofs, and drives the
on-chain `dark_shielded_pool` program through a full devnet deposit → ZK-withdraw
flow.

## v3 — DARK RELAY RAIL (relayer + in-proof fee)

`shielded_withdraw_v3.circom` extends v2 with `relayer`, `fee`, `denomination` public
inputs and constraints `payout = denomination - fee`, `fee <= MAX_FEE (0.05 SOL)`,
`fee <= denomination`. The program does a 2-way payout (recipient `denom - fee`,
relayer `fee`) → a permissionless, incentive-bound relayer market.

```bash
cd build/zk
# circom v2.1.x must be the iden3 Rust circom (NOT the deprecated npm circom 0.5.x).
circom shielded_withdraw_v3.circom --r1cs --wasm --sym -l node_modules -o out

node run-setup-v3.mjs                 # single-party pilot VK (devnet)  -> out/...v3_vk.json
node vk-to-rust-v3.mjs                # -> crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs
cargo-build-sbf --manifest-path ../../programs/dark_shielded_pool/Cargo.toml
solana program deploy ../../target/deploy/dark_shielded_pool_program.so \
  --program-id ../../target/deploy/dark_shielded_pool_program-keypair.json --url devnet

node init-buckets-devnet.mjs <PROGRAM_ID>     # 0.1 / 1 / 10 SOL denomination buckets
node e2e-v3-devnet.mjs <PROGRAM_ID>           # full relayer-fee e2e -> evidence/dark-relay-rail-devnet.json
```

**VK mode.** `prove-v3.mjs` and the e2e/fusion scripts default to `--vk-mode ceremony`,
which uses the beacon-sealed multi-contribution key under
`ceremony/shielded_withdraw_v3/` — the VK the canonically deployed devnet program embeds
(`crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs`, `alpha_g1.x=2d4d9aa7…`). The
single-party **pilot** VK (`build/zk/out/shielded_withdraw_v3_vk.json`, `alpha_g1.x=2f881452…`)
verifies locally but is **rejected on-chain with `Custom(4)=ProofInvalid`**, so `--vk-mode pilot`
is refused by the e2e scripts. A pilot proof is only meaningful against a pool you built and
deployed yourself with the pilot VK (set `SWV3_ZKEY`/`SWV3_VK` explicitly for that local case).

Trustless VK (multi-party ceremony, public ptau + drand beacon):
`node ceremony/run-ceremony-v3.mjs --contribs 3 --power 14` (see `ceremony/CONTRIBUTING_V3.md`).

---

## v2 (legacy)

The v2 pipeline (`shielded_withdraw_v2.circom`, `run-setup.mjs`, `vk-to-rust.mjs`,
`prove.mjs`, `e2e-devnet.mjs`) remains for reference.

> **SINGLE-PARTY / DEVNET PILOT / NOT TRUSTLESS.** One party runs the entire
> ceremony, so whoever runs it could forge withdrawals. A multi-party ceremony
> with a pre-committed beacon + an external audit are required before any trust
> or mainnet use. `mainnet_ready = false` everywhere.

## Committed deliverables (regenerable)

Under `ceremony/shielded_withdraw_v2/`:

- `shielded_withdraw_v2_final.zkey` — proving key (final, single-party).
- `shielded_withdraw_v2_vk.json` — exported verification key.
- `shielded_withdraw_v2.wasm` — witness generator (for the prover).
- `transcript.json` — ceremony metadata + r1cs/zkey/vk sha256.
- `shielded_withdraw_v2.ascii.circom` — the exact source compiled (ASCII-stripped
  copy of the committed circuit; circom 2.1.9's parser rejects the non-ASCII
  comments and global `var`s in the original, so this build copy moves the domain
  constants into the template — logic is byte-identical).

The Rust verification key the program uses is
`crates/dark-groth16-core/src/shielded_withdraw_v2_vk.rs` (generated from the
vk.json by `vk-to-rust.mjs`).

The toxic waste (phase-1 + phase-2 entropy) is generated in-process and **never
written to disk**.

## Reproduce

Prereqs: `circom` 2.1.x (`cargo install --git https://github.com/iden3/circom`),
node 18+, the Solana CLI + `cargo-build-sbf`, a funded devnet wallet.

```bash
cd build/zk
npm install circomlib@2.0.5 snarkjs@0.7.5 @solana/web3.js@1.98.4

# 1. compile (ASCII-stripped copy; global vars moved into the template)
circom shielded_withdraw_v2.circom --r1cs --wasm --sym -l node_modules -o out

# 2. single-party trusted setup -> ceremony/shielded_withdraw_v2_final.zkey + out/...vk.json
node run-setup.mjs

# 3. vk.json -> Rust VK for dark-groth16-core
node vk-to-rust.mjs

# 4. build + deploy the program to devnet
cargo-build-sbf --manifest-path ../../programs/dark_shielded_pool/Cargo.toml
solana program deploy ../../target/deploy/dark_shielded_pool_program.so \
  --program-id ../../target/deploy/dark_shielded_pool_program-keypair.json --url devnet

# 5. full devnet e2e (deposit -> ZK-withdraw -> negative cases)
node e2e-devnet.mjs <PROGRAM_ID>
```

## Scripts

- `run-setup.mjs` — powers-of-tau (power 13) + phase-2 single-party contribution,
  exports the VK, sanity-verifies the zkey.
- `vk-to-rust.mjs` — vk.json → `crates/dark-groth16-core/src/shielded_withdraw_v2_vk.rs`.
- `prove.mjs <spec.json> <out.json>` — builds the witness, generates a real
  snarkjs proof, verifies it locally, and encodes it (256-byte EIP-197) for the
  on-chain verifier.
- `e2e-devnet.mjs <PROGRAM_ID>` — the deliverable: init → deposit×2 → real
  ZK-withdraw to a fresh address → double-spend / wrong-root / wrong-recipient
  reverts → evidence to `evidence/shielded-pool-devnet.json`. Reads each tx's
  on-chain `meta.err` (not just "confirmed") so a program-rejected tx is recorded
  as a revert, never a false green.

The prover spec is produced by the Rust binary
`dark-shielded-pool-core --bin witness_spec` (feature `witness-gen`), the single
source of truth: it builds the SAME incremental Poseidon tree the chain builds
(via `dark-poseidon-real`), so the circuit's `merkle_root`/`nullifier` public
signals byte-match the on-chain, syscall-computed values.

## What this proves

A real circom proof verified **on-chain** (alt_bn128 pairing syscall) against a
Merkle root the program built with the `sol_poseidon` syscall, and the
core/circuit-computed root byte-matched the on-chain root.

=> **on-chain Poseidon == circuit Poseidon, confirmed in-VM.**
