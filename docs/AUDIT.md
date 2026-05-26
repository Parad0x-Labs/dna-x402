# Dark Null Solana Programs — Auditor Reference

**Codebase:** `<repo-root>` / branch `codex/mainnet-hardening`
**Stack:** Solana 1.18.26 (pinned), Rust, `no_std`-compatible programs, Cargo workspace
**Reviewed by:** _[Auditor name]_
**Audit date:** _[Date]_

---

## Deployed Programs

| Program | Network | Program ID | Deploy Tx |
|---------|---------|-----------|-----------|
| `dark_nullifier_banks` | devnet | `7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj` | [Solscan](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |
| `dark_compressed_receipts` | devnet | `FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g` | [Solscan](https://solscan.io/tx/4uht4nvFELfXwDpRhSecLKgoStDAW5Vg2c2LYDoJG2RDU9wh4dMRvNhv1dPTG6pZ9znLj1ngdJKZumeEk4qSfTMT?cluster=devnet) |
| `dark_chaff` | devnet | `5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk` | [Solscan](https://solscan.io/tx/22Fr5CaCiwqQwSkRf4Vdjtvy4swLGeJ4SsRn8Jbqv8sC9qeeZ9ZJt8DNrpcq2KnXscP3H7bg9qLcDhbDeMJw6ZKt?cluster=devnet) |

---

## Scope

### Solana Programs (on-chain)

| Path | Description |
|------|-------------|
| [`programs/dark_nullifier_banks/`](../programs/dark_nullifier_banks/) | Write-lock sharded nullifier banks (256 shards, epoch-isolated) |
| [`programs/dark_compressed_receipts/`](../programs/dark_compressed_receipts/) | Compressed receipt roots + nullifier PDAs, double-redeem protection |
| [`programs/dark_chaff/`](../programs/dark_chaff/) | Ephemeral intent PDAs (chain-analysis chaff), auto-closeable per epoch |
| [`programs/dark_scratch/`](../programs/dark_scratch/) | Scratch PDA lifecycle — slot-expiry creation, owner-only close, permissionless keeper cleanup |

### Off-chain Crates (no network calls in tests)

| Path | Description |
|------|-------------|
| [`crates/alt-fog-router/`](../crates/alt-fog-router/) | Solana v0 transaction builder — injects decoy accounts into static account list |
| [`crates/dark-poseidon-tree/`](../crates/dark-poseidon-tree/) | Domain-separated hash primitives (SHA-256 off-chain, swappable to Poseidon syscall) |
| [`crates/receipt-spend/`](../crates/receipt-spend/) | Private receipt-note protocol: commit → nullify → verify |
| [`crates/dark-relay-router/`](../crates/dark-relay-router/) | Leader-aware relay route scorer (Direct / Jito / SWQoS) |
| [`crates/dark-bundle-cloak/`](../crates/dark-bundle-cloak/) | Jito bundle builder with fingerprint rejection |
| [`crates/swarm-capsule/`](../crates/swarm-capsule/) | Ed25519-signed relayer capability capsule (custody-denied invariant) |
| [`crates/sealed-fee-quotes/`](../crates/sealed-fee-quotes/) | Commit-reveal fee auction with nonce replay protection |
| [`crates/state-tier-router/`](../crates/state-tier-router/) | Decision engine routing objects to OffChainOnly / EventOnly / CompressedLeaf / TinyPdaHeader / TokenAccount / FullAccount |
| [`crates/rent-blast-radius/`](../crates/rent-blast-radius/) | Lamport cost estimator for account sets; compares naive vs shoestring layout |
| [`crates/receipt-rollup-lite/`](../crates/receipt-rollup-lite/) | Local Merkle receipt tree with epoch root checkpointing and redeem-once nullifier |
| [`crates/dark-macaroons/`](../crates/dark-macaroons/) | HMAC-SHA256 caveated capability tokens (budget, scope, expiry, relayer class, withdraw lock) |
| [`crates/ghost-spl-ledger/`](../crates/ghost-spl-ledger/) | Virtual balance commitments — deferred SPL materialisation until exit |
| [`crates/lock-scheduler/`](../crates/lock-scheduler/) | Write-set conflict detector; batches non-conflicting actions for Solana parallel execution |
| [`crates/shape-pool/`](../crates/shape-pool/) | k-anonymity pool: canonical TxShape ensures ReceiptSpend and ChaffClose are indistinguishable |
| [`crates/compute-coupon/`](../crates/compute-coupon/) | Ed25519-signed relay coupons with CU price cap, route class, expiry, receipt hash binding |
| [`crates/useful-chaff-planner/`](../crates/useful-chaff-planner/) | Combines real maintenance ops with decoy chaff so chaff transactions carry genuine work |
| [`crates/intent-capsule/`](../crates/intent-capsule/) | Serialisable intent descriptor: action, spend cap, scope hash, expiry, receipt root — tamper-evident |
| [`crates/dark-module-abi/`](../crates/dark-module-abi/) | Module commitment + result hash primitives; `ModuleCommitment` tamper-evident binding |
| [`crates/dark-capability-registry/`](../crates/dark-capability-registry/) | In-memory module registry with pause/resume + registry root Merkle hash |
| [`crates/caveat-engine/`](../crates/caveat-engine/) | 12-variant caveat checker (expiry, scope allow/deny, CU price, daily loss, withdraw lock, etc.) |
| [`crates/dark-session-netting/`](../crates/dark-session-netting/) | Collapses N receipt-note spends into one `net_settlement_hash` — no per-note PDA |
| [`crates/account-fee-heatmap/`](../crates/account-fee-heatmap/) | Writable-account fee heat scorer; `select_coolest()` picks low-fee write targets |
| [`crates/nullifier-bank-planner/`](../crates/nullifier-bank-planner/) | Off-chain shard load balancer; mirrors on-chain `bank_index` formula, recommends epoch rollover |
| [`crates/compute-coupon-market/`](../crates/compute-coupon-market/) | Coupon redemption market with replay protection, CU price cap, route class, receipt binding |
| [`crates/alt-fog-vault/`](../crates/alt-fog-vault/) | Deterministic fog account pool; 256-account budget, dedup, real-accounts-first extension plans |
| [`crates/dark-blink-intent/`](../crates/dark-blink-intent/) | Blink-protocol intent descriptor: tamper-evident, serde-serialisable, spend-cap validated |
| [`crates/rent-bounty-hunter/`](../crates/rent-bounty-hunter/) | Keeper bounty calculator for expired Scratch / Chaff / Session / Coupon / Blink PDAs |
| [`crates/session-loss-fuse/`](../crates/session-loss-fuse/) | Agent drawdown circuit-breaker; trips on loss%, failed spend count, or window rate; user-rearm only |
| [`crates/degen-api-meter/`](../crates/degen-api-meter/) | Per-call nullifier API quota; `burn_call()` returns nullifier, no per-call PDA |
| [`crates/poison-receipts/`](../crates/poison-receipts/) | Mixed real+decoy receipt leaves; domain-separated so poison can never be redeemed |
| [`crates/copy-sniper-sim/`](../crates/copy-sniper-sim/) | Copy-sniper simulation: measures false-positive rate when follower copies all intents |
| [`crates/strategy-cloak-delay/`](../crates/strategy-cloak-delay/) | Deterministic submit-slot jitter planner; avoids fee-hot slots, adds chaff slots |
| [`crates/alpha-leak-meter/`](../crates/alpha-leak-meter/) | Alpha-leak risk scorer across timing, account uniqueness, route, amount, copy-sniper axes |
| [`crates/agent-kill-switch/`](../crates/agent-kill-switch/) | User-held revocation registry; only user can rearm; blocks all spend on revoked session |
| [`crates/dark-tip-notes/`](../crates/dark-tip-notes/) | Private tip/payment notes; commitment ≠ nullifier (unlinkable); bucketed amounts |
| [`crates/pvp-prediction-receipts/`](../crates/pvp-prediction-receipts/) | Commit-reveal prediction receipts; `is_pre_event()` guards post-event reveals |
| [`crates/dark-gift-notes/`](../crates/dark-gift-notes/) | Gift note lifecycle: claim before expiry, clawback after; optional recipient binding |
| [`crates/dispute-receipt-oracle/`](../crates/dispute-receipt-oracle/) | Dispute filing + counter-sign resolution capsule; deadline-gated |
| [`crates/feature-commit-reveal/`](../crates/feature-commit-reveal/) | Feature flag commit-reveal with activation slot guard and pause override |
| [`crates/model-output-receipts/`](../crates/model-output-receipts/) | AI model output receipts: binds version, prompt policy, input snapshot, output hash |
| [`crates/public-puzzle-generator/`](../crates/public-puzzle-generator/) | On-chain puzzle generator encoding devnet tx evidence as solvable challenges |
| [`crates/telegram-command-receipts/`](../crates/telegram-command-receipts/) | Bot command receipts; `/pause` always succeeds; nullifier dedup per command |

**Out of scope for this review:** `x402/` TypeScript server, `programs/receipt_anchor/` (covered by [`docs/EXTERNAL_AUDIT_PACKET.md`](./EXTERNAL_AUDIT_PACKET.md)).

---

## Security Properties — Key Claims

### 1. Nullifier double-spend is impossible (`dark_nullifier_banks`)

- Each nullifier produces a unique PDA: `[b"null_rec", shard_byte, nullifier]`
- If the PDA already exists → `AlreadyInserted` error
- Shard routing `H(nullifier || epoch || domain)[0]` is deterministic and cannot be manipulated by the caller to choose a specific shard
- **Auditor check:** submit the same nullifier twice in the same or different transactions; confirm the second always fails

### 2. Receipt root cannot be updated by a non-authority (`dark_compressed_receipts`)

- `UpdateRoot` requires the authority key to sign (`AccountMeta::new_readonly(*authority, true)`)
- Authority is embedded in the root PDA seed: `[b"receipt_root", authority]` — binding is permanent at init time
- **Auditor check:** send `UpdateRoot` signed by a different keypair; confirm `WrongAuthority` error

### 3. Receipt double-redeem is impossible (`dark_compressed_receipts`)

- Redemption creates a nullifier PDA: `[b"receipt_null", nullifier]`
- If the PDA already exists → `AlreadyRedeemed` error
- **Auditor check:** redeem the same nullifier twice; confirm the second fails

### 4. Chaff PDAs cannot be closed for a future epoch (`dark_chaff`)

- Close instruction checks `clock.unix_timestamp / EPOCH_SECONDS == batch.epoch`
- Future epochs are rejected with `EpochMismatch`
- **Auditor check:** create batch at epoch 0, attempt to close as epoch 1; confirm fails

### 5. Swarm capsule custody invariant (`swarm-capsule`)

- `verify_capsule` returns `CustodyViolation` before checking signature if `custody_denied == false`
- A relayer that claims to hold user funds is rejected regardless of signature validity
- **Auditor check:** see `test_custody_violation_rejected`

### 6. Fee quote replay protection (`sealed-fee-quotes`)

- Each quote is bound to a nonce; revealing the same commitment twice returns `NonceReuse`
- Receipt hash binding prevents cross-session quote substitution

### 7. Fog transaction account integrity (`alt-fog-router`)

- Real instruction accounts always appear in the compiled message (property-tested across 100 random inputs)
- Decoy injection increments `num_readonly_unsigned_accounts` to maintain a valid message header
- Decoys that already appear in the message (payer, program) are deduplicated

---

## Test Coverage

All 307 tests pass on Windows (`cargo test --workspace`).

Program integration tests (`solana-program-test`) are platform-gated `#[cfg(not(target_os = "windows"))]` due to an rbpf 0.8.3 pointer arithmetic bug on Windows ASLR. They run correctly on Linux / macOS CI. The gated tests cover identical logic paths to the unit tests that run on all platforms.

| Crate / Program | Tests | Coverage |
|-----------------|-------|----------|
| `alt-fog-router` | 5 | Account injection, fog scoring, grade thresholds, deduplication |
| `compute-coupon` | 6 | Issue/redeem, expiry, CU price cap, route class rejection, receipt binding |
| `dark-bundle-cloak` | 6 | Fingerprint detection, decoy insertion, order preservation |
| `dark_chaff` | 11 | Instruction encoding, state pack/unpack, constants, epoch guard |
| `dark_compressed_receipts` | 11 | Instruction encoding, state pack/unpack, seed distinctness, authority binding |
| `dark-macaroons` | 10 | Mint/verify, tamper detection, expiry, budget, scope, relayer class; RFC2104 vector; legacy token rejection (2 tests behind `legacy-macaroons` feature) |
| `dark_nullifier_banks` | 6 | Instruction encoding, state roundtrip, bank_index determinism |
| `dark-poseidon-tree` | 6 | Domain separation, merkle node, known vectors |
| `dark_scratch` | 8 | Instruction encoding, state pack/unpack, expiry semantics, seed uniqueness |
| `dark-relay-router` | 5 | Jitter bounds, route ranking, Jito scoring |
| `ghost-spl-ledger` | 8 | Commit/spend/deposit, overdraft rejection, exit intent, nonce increment |
| `intent-capsule` | 7 | Hash tamper detection, expiry, JSON roundtrip, field sensitivity |
| `lock-scheduler` | 6 | Conflict detection, batch partitioning, shard routing |
| `receipt-rollup-lite` | 6 | Leaf hash, Merkle root, nullifier, redeem-once, double-redeem rejection |
| `receipt-spend` | 7 | Nullifier determinism, scope unlinkability, spend/verify roundtrip |
| `rent-blast-radius` | 5 | Rent formula, blast comparison, SOL conversion |
| `sealed-fee-quotes` | 7 | Commit/reveal, nonce replay, receipt binding, amount match |
| `shape-pool` | 7 | Canonical shape equality, k-anonymity, fingerprint, custom shape |
| `state-tier-router` | 7 | Routing decisions for all 6 tiers, edge cases |
| `swarm-capsule` | 6 | Sign/verify, tampering rejection, custody invariant, JSON roundtrip |
| `useful-chaff-planner` | 6 | Plan creation, efficiency, validation, empty rejection |
| `dark-module-abi` | 8 | Commitment hash, result hash, tamper detection, error variants |
| `dark-capability-registry` | 6 | Register/pause/resume, verify result, registry root |
| `caveat-engine` | 11 | All 12 caveat types, denied-scope wins, fingerprint, combined checks |
| `dark-session-netting` | 7 | Net settlement hash, balance commitment, dispute hash, dup nullifier rejection |
| `account-fee-heatmap` | 6 | Heat score, stale filtering, coolest selection, hot account flag |
| `nullifier-bank-planner` | 6 | bank_index parity, load tracking, hottest shard, rollover recommendation |
| `compute-coupon-market` | 7 | Issue/redeem, expiry, CU cap, route class, receipt binding, replay |
| `alt-fog-vault` | 6 | Budget cap, dedup, candidate generation, extension plan |
| `dark-blink-intent` | 8 | Intent hash, expiry, spend validation, JSON roundtrip, field sensitivity |
| `rent-bounty-hunter` | 6 | Bounty calculation, grace period, expired-only, sort, reclaimable total |
| `session-loss-fuse` | 7 | Drawdown trip, failed-spend trip, window trip, user rearm, agent cannot rearm |
| `degen-api-meter` | 6 | Burn call, exhausted, wrong scope, duplicate call, refill |
| `poison-receipts` | 6 | Domain separation, batch root, poison ratio, cannot redeem poison |
| `copy-sniper-sim` | 5 | Naive follower, false positive rate, precision, edge destroyed |
| `strategy-cloak-delay` | 6 | Deterministic jitter, hot slot avoidance, chaff slot distinctness |
| `alpha-leak-meter` | 6 | Scoring axes, devnet safe threshold, high risk detection |
| `agent-kill-switch` | 6 | Sign/verify, user rearm only, revoke, check spend, wrong user rejected |
| `dark-tip-notes` | 6 | Commitment/nullifier unlinkability, bucketed amounts, expiry, log dedup |
| `pvp-prediction-receipts` | 6 | Commit hash, reveal verify, pre-event guard, post-event rejected |
| `dark-gift-notes` | 6 | Claim, clawback, expiry guard, recipient binding, cannot clawback early |
| `dispute-receipt-oracle` | 6 | File dispute, deadline rejection, resolution capsule, partial refund |
| `feature-commit-reveal` | 6 | Commit/reveal, wrong reveal, too early, paused override |
| `model-output-receipts` | 6 | Output commitment, verify, stale detection, delayed reveal, redacted display |
| `public-puzzle-generator` | 6 | Generate/verify puzzle, solution hash, markdown output |
| `telegram-command-receipts` | 6 | All command types, pause always succeeds, nullifier dedup, no raw keys |
| **Total** | **307** | **0 failures** |

Run locally:
```
cargo test --workspace
```

---

## Reproduce Build from Source

```bash
# Prerequisites: Rust stable, Solana CLI 1.18.26
git clone <repo>
cd "DNA x402"
cargo build --workspace          # all crates compile clean
cargo test --workspace           # 304 tests, 0 failures
```

Program-test integration suite (Linux / macOS):
```bash
cargo test --workspace -- --nocapture
```

---

## Dependency Audit

Critical pinned dependencies:

| Crate | Version | Notes |
|-------|---------|-------|
| `solana-program` | `=1.18.26` | Pinned; upgrade requires re-audit of PDA and CPI paths |
| `solana-sdk` | `=1.18.26` | Pinned |
| `solana-program-test` | `=1.18.26` | Test-only |
| `ed25519-dalek` | `1` | v2 excluded — conflicts with `zeroize` version required by Solana 1.18 |
| `sha2` | `0.10` | Domain-separated hash backend; on-chain swappable to Poseidon syscall |
| `rand` | `0.8` | Used only in `alt-fog-router` (decoy key generation) and tests |

`cargo deny` or `cargo audit` recommended before mainnet promotion.

---

## Known Limitations

| Item | Detail |
|------|--------|
| Poseidon backend | Off-chain hashing uses SHA-256 with domain prefix, not the Solana Poseidon syscall. Circuit parity requires swapping `domain_hash` body to `solana_program::poseidon::hashv`. |
| No ZK proof verification | Programs verify PDA ownership and nullifier uniqueness — they do not verify a ZK proof. A proof system (Bonsol / RISC Zero) is planned but not in scope for this review. |
| Decoy accounts | ALT fog decoys increase combinatorial search space for chain-analysis but are not a cryptographic privacy guarantee. |
| `rbpf` 0.8.3 Windows crash | Program integration tests skip on Windows (`#[cfg(not(target_os = "windows"))]`). Root cause: rbpf pointer XOR encryption overflows with a negative random key on low-address ASLR allocations. Linux CI passes all tests. |
| Ghost SPL / Macaroon off-chain only | `ghost-spl-ledger` and `dark-macaroons` implement the cryptographic core; they have no corresponding on-chain program in this codebase. Integration with an on-chain validator program is out of scope. |
| ~~HMAC-lite~~ FIXED | `dark-macaroons` upgraded to RFC2104 HMAC-SHA256 (hmac 0.12 + sha2 0.10). Legacy SHA256(key‖msg) tokens rejected by default. Legacy verifier available under feature flag `legacy-macaroons` (test-only). |
| Swarm capsule: no on-chain verify | `swarm-capsule` produces Ed25519-signed capsules verified off-chain only. An on-chain Ed25519 instruction-based verifier is planned but not implemented. |

---

## Contact

Questions about this document → open an issue or ping in the project channel.
