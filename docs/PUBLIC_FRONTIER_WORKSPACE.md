# Public Frontier Workspace

DNA x402 is the canonical public repository for the agent-commerce and Solana primitive workspace. Dark Null Protocol is the canonical public repository for the privacy-settlement proof nucleus.

This split keeps the stack usable:

- DNA x402 owns fast x402 payment flows, agent commerce, receipt anchoring, routing, monetization, and the large Rust primitive workspace.
- Dark Null Protocol owns the Groth16 circuit/artifact/verifier path, payout-bound withdraw v2, private x402 receipt envelope, manifest binding, and proof/release gates.
- Shared integration happens through the DNA Dark Null privacy path and the Dark Null private x402 receipt wrapper.

## Public Inventory

Current public DNA x402 workspace:

| Surface | Public path | Count |
|---|---:|---:|
| Cargo workspace members | `Cargo.toml` | 343 |
| Cargo crate entries | `crates/*` entries in `Cargo.toml` | 311 |
| tracked crate directories | `crates/` | 309 |
| Solana program entries | `programs/*` entries in `Cargo.toml` | 10 |
| tracked program directories | `programs/` | 10 |
| TypeScript x402 package | `x402/` | 1 |
| public builder site | `site/` | 1 |
| local agent/admin UI | `site-agent/` | 1 |

The crate count differs by two because two workspace entries are represented through package paths that do not create separate tracked top-level crate folders.

## Promoted Modules Now Public

The modules called out in the local workspace handoff are present on `main` in `Parad0x-Labs/dna-x402`:

| Module | Public path | Role |
|---|---|---|
| `alt-fog-router` | `crates/alt-fog-router/` | account-shape routing and account-lock camouflage scoring |
| `dark-poseidon-tree` | `crates/dark-poseidon-tree/` | Poseidon-style tree primitive surface |
| `receipt-spend` | `crates/receipt-spend/` | receipt-bound spend primitive |
| `dark-relay-router` | `crates/dark-relay-router/` | relayer route planning |
| `dark-bundle-cloak` | `crates/dark-bundle-cloak/` | bundle-shape privacy primitive |
| `swarm-capsule` | `crates/swarm-capsule/` | signed relayer/prover/indexer capsule model |
| `sealed-fee-quotes` | `crates/sealed-fee-quotes/` | sealed quote commitment primitive |
| `agent-permission-notes` | `crates/agent-permission-notes/` | caveated agent spend permissions |
| `session-note-channel` | `crates/session-note-channel/` | session-scoped note channel primitive |
| `ritual-memo-capsule` | `crates/ritual-memo-capsule/` | memo-bound ritual capsule primitive |
| `ritual-precompile-braid` | `crates/ritual-precompile-braid/` | precompile-composition proof surface |
| `spend-shadows` | `crates/spend-shadows/` | spend redaction/shadowing primitive |
| `receipt-souls` | `crates/receipt-souls/` | long-lived receipt identity primitive |
| `no-custody-attestation` | `crates/no-custody-attestation/` | no-custody evidence capsule |
| `alpha-capsules` | `crates/alpha-capsules/` | paid alpha reveal primitive |
| `chaff-economy` | `crates/chaff-economy/` | useful decoy-work economy primitive |
| `dark-x402-nullifier-bridge` | `crates/dark-x402-nullifier-bridge/` | x402 receipt to nullifier bridge |
| `onchain-puzzle-compiler` | `crates/onchain-puzzle-compiler/` | puzzle-to-on-chain-check compiler |
| `roadmap-commitments` | `crates/roadmap-commitments/` | public commitment tracking primitive |
| `sealed-pick-x402-wall` | `crates/sealed-pick-x402-wall/` | paid sealed pick reveal wall |
| `true-frontier-devnet-demo` | `crates/true-frontier-devnet-demo/` | composed devnet evidence structure |
| `dark-zk-complete-demo` | `crates/dark-zk-complete-demo/` | shielded-pool integration demo surface |
| `agent-flight-recorder` | `crates/agent-flight-recorder/` | agent action receipt chain |
| `dark-stealth-note` | `crates/dark-stealth-note/` | stealth note primitive |
| `dark_chaff` | `programs/dark_chaff/` | ephemeral PDA chaff program |

## Dark Null Integration Points

DNA x402 connects to Dark Null through:

- `docs/DARK_NULL_PRIVACY_PATH.md`
- `docs/DARK_NULL_FRONTIER.md`
- `docs/DARK_NULL_FRONTIER_RESEARCH.md`
- `crates/dark-x402-nullifier-bridge/`
- `crates/dark-private-x402/`
- `crates/dark-x402-core/`
- `crates/dark-x402-devnet-verify/`
- `x402/src/` seller, buyer, guard, receipt, and anchoring surfaces

Dark Null Protocol connects back through:

- `docs/DNA_X402_INTEGRATION.md`
- `docs/PRIVATE_X402_PAYMENTS.md`
- `swarm/x402.mjs`
- `tests/x402-private-payments.test.mjs`

## Verification Commands

Run from the repository root:

```bash
npm run check:style
npm --prefix x402 run security:scan
npm --prefix x402 run build
npm --prefix x402 test
npm run acceptance:builder
npm run acceptance:agents
npm run acceptance:degen-mode
cargo test --workspace --locked
```

Last local validation on 2026-05-27:

- style scan passed
- secret scan passed
- x402 TypeScript build passed
- x402 Vitest suite passed: 264 files passed, 5 skipped; 1429 tests passed, 8 skipped
- site build passed
- site-agent build passed
- acceptance builder passed: 4 tests
- acceptance agents passed: 5 example acceptances
- acceptance degen mode passed: 7 tests
- Rust workspace passed with `cargo test --workspace --locked`
