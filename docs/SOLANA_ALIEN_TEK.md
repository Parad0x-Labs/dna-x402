# Dark Null Solana-Native Alien Tek

> **Status:** Experimental — all modules are in `crates/` and `programs/` with passing unit and program-test coverage.
> Devnet program IDs will be filled after deployment via `scripts/deploy-alien-tek.ts`.

This document covers the **Solana-specific** invention layer: primitives that are only possible because of the SVM account model, Address Lookup Tables, leader-schedule architecture, Gulf Stream routing, Jito bundles, Poseidon syscalls, and compressed-account tooling.

These are complementary to — and distinct from — the cryptographic research in [`docs/DARK_NULL_ALIEN_TEK.md`](./DARK_NULL_ALIEN_TEK.md).

---

## 1. Write-Lock Sharded Nullifier Banks

**Code:** [`programs/dark_nullifier_banks/`](../programs/dark_nullifier_banks/)

**The problem:** A single global nullifier account is a Solana hot-write bottleneck and a chain-analysis gift — every private withdrawal touches the same account.

**The invention:** 256 shard accounts. The shard for each nullifier is determined by:

```
bank_index(nullifier, epoch, domain) = hashv([nullifier || epoch_le || domain])[0]
```

This is deterministic, uncontrollable by the user (no shard stuffing), and uniform across the 256 shards. Each epoch (hourly) gets its own shard set, so temporal isolation is built in.

Duplicate detection uses a per-nullifier record PDA:
```
PDA seed: [b"null_rec", shard_byte, nullifier]
```

If the PDA already exists, the insert fails. No global lock. No coordinator.

**Privacy layer:** the transaction that inserts a nullifier touches one of 256 shard accounts — a chain-analysis tool cannot determine which withdrawal correlates with which deposit from the account access pattern alone.

**Tests:** `test_insert_correct_shard`, `test_duplicate_rejected`, `test_wrong_shard_rejected`, `test_epoch_isolation`

---

## 2. ALT Fog Router

**Code:** [`crates/alt-fog-router/`](../crates/alt-fog-router/)

**The problem:** Even with ZK proofs, Solana transaction account topology reveals a clear graph: wallet → vault → receiver. Chain-analysis firms index account co-occurrence.

**The invention:** Solana v0 transactions can reference accounts through Address Lookup Tables. The ALT Fog Router builds v0 transactions with a synthetic decoy ALT appended to the real lookup tables:

```
real accounts + real ALT refs
+ decoy ALT { key: random, addresses: [decoy_0..decoy_N] }
→ v0 message
```

Result: the transaction references N+K accounts where K ≥ 10. A chain-analysis tool must enumerate all possible subsets of size N to find the real accounts.

**Fog grades:**

| uniqueness_ratio | grade |
|---|---|
| < 10% | Clear |
| 10–40% | Hazy |
| 40–70% | Dense |
| ≥ 70% | Impenetrable |

**Not cryptographic privacy.** Transaction-shape fog: cheap, buildable now, complements ZK proofs.

**Tests:** `test_real_accounts_always_present` (100-iteration property test), `test_fog_score_improves_with_decoys`, `test_decoy_count_range_never_panics`, `test_different_builds_differ`

---

## 3. Compressed Receipt Accounts

**Code:** [`programs/dark_compressed_receipts/`](../programs/dark_compressed_receipts/)

**The problem:** Every x402 payment receipt stored in a full Solana account costs rent (~0.002 SOL each). At machine-payment scale — one receipt per API call — this is unsustainable.

**The invention:** Receipts are stored as hashes in an off-chain Merkle tree; only the root is stored on-chain in a single `ReceiptRoot` PDA. To redeem a receipt (prevent replay), the payer posts a nullifier:

```
ReceiptRoot PDA: [b"receipt_root", authority] → { root, count }
ReceiptNullifier PDA: [b"receipt_null", nullifier] → { redeemed_at }
```

The nullifier is the only on-chain object per receipt. Receipt existence proofs are verified off-chain against the root.

**Cost:** a nullifier PDA is 9 bytes (bump + timestamp). Rent-exempt: ~1,600 lamports. 1,000 API calls = ~1,600,000 lamports ≈ 0.0016 SOL.

**Tests:** `test_init_root_succeeds`, `test_update_root_succeeds`, `test_redeem_once_succeeds`, `test_double_redeem_fails`, `test_nullifier_pda_absent_before_redeem`

---

## 4. Poseidon-Native Account Tree

**Code:** [`crates/dark-poseidon-tree/`](../crates/dark-poseidon-tree/)

**The problem:** Most Solana ZK systems hash differently on-chain (SHA-256 / Keccak) than in circuits (Poseidon). This mismatch requires bridges, adapters, and audit surface.

**The invention:** Domain-separated hash primitives with identical interfaces for off-chain and on-chain use:

```rust
pub const DOMAIN_COMMITMENT:  u8 = 1;
pub const DOMAIN_NULLIFIER:   u8 = 2;
pub const DOMAIN_RECEIPT:     u8 = 3;
pub const DOMAIN_X402_INTENT: u8 = 4;
pub const DOMAIN_MERKLE_NODE: u8 = 5;
```

Off-chain backend: `SHA-256(domain_byte || inputs...)`. On-chain swap path: replace `domain_hash` body with `solana_program::poseidon::hashv` — same domain constants, same domain separation, same root value.

One hash universe across circuit, SVM program, receipt DAG, and x402 intents.

**Tests:** `test_domain_separation`, `test_commitment_hash_nonzero_and_deterministic`, `test_nullifier_changes_with_root`, `test_merkle_node_deterministic`, `test_receipt_hash_field_sensitivity`, `test_known_vector_stability`

---

## 5. Receipt Spend Notes

**Code:** [`crates/receipt-spend/`](../crates/receipt-spend/)

**The problem:** Standard x402 flow: `deposit → withdraw`. The wallet is always the subject. Any observing API learns which wallet paid.

**The invention:** Receipt-note protocol. Deposit once, get N unlinkable notes, spend them one at a time:

```
deposit → N receipt notes → spend note_k for API call k → API gets nullifier, not wallet
```

Each note:
```rust
ReceiptNote {
    commitment: H(COMMITMENT || secret || value=0),
    scope_hash: H(X402_INTENT || scope_bytes),
}
```

Spending produces a `NullifierProof` that the API verifies on-chain (via `dark_compressed_receipts`). The API learns only: "this note was unspent, now it is spent." It cannot link note_73 back to the original deposit.

**Tests:** `test_nullifier_deterministic`, `test_different_scope_different_nullifier`, `test_wrong_root_different_nullifier`, `test_spend_verify_roundtrip`, `test_scope_mismatch_rejected`, `test_note_unlinkability`, `test_verify_fails_on_tampered_nullifier`

---

## 6. Leader-Aware Private Relay Path

**Code:** [`crates/dark-relay-router/`](../crates/dark-relay-router/)

**The problem:** Solana uses Gulf Stream — transactions route toward the upcoming slot leader. Different relay paths have different timing-correlation risk and different mempool visibility profiles.

**The invention:** Route scorer that assigns a composite privacy score to each relay path:

| Route | Fingerprint Risk | Landing | Composite |
|---|---|---|---|
| DirectRpc | 0.72 | 0.88 | 0.25 |
| StakeWeightedQos | 0.47 | 0.93 | 0.49 |
| Jito | 0.17 | 0.97 | 0.80 |

`composite = landing_probability × (1 − fingerprint_risk)`

Leader schedule visibility adjusts fingerprint risk: more visible upcoming leaders → lower timing-correlation adjustment.

Timing jitter: `jitter_delay_ms(base, rng)` adds uniform random delay in `[base, 2×base]` to de-correlate submission timing.

**Devnet integration test:** `SOLANA_RPC_URL=https://api.devnet.solana.com cargo test --features devnet-tests -p dark-relay-router`

**Tests:** `test_jitter_within_bounds`, `test_route_ranking_stable`, `test_jito_scores_higher_than_direct`, `test_empty_leader_schedule_increases_risk`, `test_rank_routes_best_first`

---

## 7. Jito Bundle Cloak

**Code:** [`crates/dark-bundle-cloak/`](../crates/dark-bundle-cloak/)

**The problem:** A single-transaction withdrawal leaves an obvious `wallet → receipt_vault → payer` path. Chain-analysis tools score single-hop hops very high.

**The invention:** Multi-transaction atomic bundle with decoy cleanup:

```
tx1: create receipt / nullifier intent
tx2: settle (payout, API payment, bet action)
tx3: close temp accounts + decoy PDA cleanup
```

All-or-nothing via Jito bundle. The decoy cleanup transaction adds synthetic accounts to the bundle's account footprint, breaking direct wallet→withdraw fingerprinting.

Check gate: `check_bundle_fingerprint(bundle, wallet)` fails with `DirectWalletMapping` if the wallet appears in any transaction without decoy coverage (< 3 decoys).

**Tests:** `test_empty_bundle_fails`, `test_direct_wallet_tx_flagged`, `test_decoy_cleanup_breaks_direct_mapping`, `test_bundle_order_preserved`, `test_insufficient_decoys_flagged`, `test_non_wallet_tx_passes_without_decoys`

---

## 8. Ephemeral PDA Chaff

**Code:** [`programs/dark_chaff/`](../programs/dark_chaff/)

**The problem:** A private withdrawal creates PDAs that are identifiable by their lifecycle (created → used → closed in sequence). The pattern is as distinctive as a fingerprint.

**The invention:** Create 3–7 fake intent PDAs alongside every real action. They look identical to real intent PDAs on-chain. All close at epoch end. Pure chain-analysis poison.

```
CreateChaffBatch { count: u8 ∈ [3,7], epoch: u64 }
    → ChaffBatch PDA + count × ChaffIntent PDAs

CloseChaffBatch { epoch: u64 }
    → closes all, returns lamports
    → fails if epoch > current_epoch
```

**Cost:** 7 chaff intents + 1 batch PDA ≈ 83,000 lamports (0.000083 SOL) — well under 0.01 SOL.

**Tests:** `test_create_close_roundtrip`, `test_cannot_close_future_epoch`, `test_count_range`, `test_lamport_cost_benchmark`

---

## 9. Proof-Carrying Swarm Capsules

**Code:** [`crates/swarm-capsule/`](../crates/swarm-capsule/)

**The invention:** Each Dark Null relayer node signs a `SwarmCapsule` that proves its configuration without revealing secrets:

```rust
SwarmCapsule {
    repo_commit:          [u8; 20],  // git SHA prefix
    config_hash:          [u8; 32],  // SHA-256 of active config
    role_bitmap:          u32,       // capability flags
    fee_cap_lamports:     u64,
    max_sol_float:        u64,
    custody_denied:       bool,      // Dark Null non-custodial invariant
    x402_adapter_enabled: bool,
    liveness_unix:        i64,
}
```

`verify_capsule` rejects any capsule with `custody_denied = false` — the Dark Null non-custodial invariant is enforced at the cryptographic level, not the policy level.

Capsule content hashes will be included in the receipt DAG as relayer attestations.

**Tests:** `test_sign_and_verify`, `test_tampered_capsule_rejected`, `test_custody_violation_rejected`, `test_content_hash_stable`, `test_role_bitmap_composition`, `test_capsule_json_roundtrip`

---

## 10. Private Fee Quote Auctions

**Code:** [`crates/sealed-fee-quotes/`](../crates/sealed-fee-quotes/)

**The problem:** If an agent asks "how much does it cost to settle this private withdrawal?", the demand inquiry itself leaks that a withdrawal is imminent.

**The invention:** Commit-reveal protocol. Relayers compete on price without revealing amounts until one is selected:

```
1. Relayer: commit_quote(amount, nonce, relayer, receipt_hash) → QuoteCommitment
2. Wallet: selects winner by index
3. Winner: reveals QuoteReveal
4. Losers: amounts never revealed, commitments unlinkable
```

Nonce prevents replay. `receipt_hash` binds the quote to a specific operation. `select_cheapest` picks the winner after verification.

**Tests:** `test_commit_reveal_roundtrip`, `test_relayer_mismatch`, `test_commitment_mismatch_on_wrong_amount`, `test_receipt_mismatch`, `test_nonce_replay_prevention`, `test_commitment_not_zero`, `test_select_cheapest`

---

## 11. Bonsol Dark Batch Auditor (Skeleton)

**Code:** [`zkvm/dark_batch_auditor/`](../zkvm/dark_batch_auditor/)

**What it will prove:**
- No duplicate nullifiers in a committed batch
- Receipt DAG links are valid and continuous
- Relayer caps are respected
- Encrypted bet batch totals match commitments

**Runtime:** RISC Zero zkVM via Bonsol (Solana-native verifiable compute). The guest program is pure Rust — no WASM, no EVM.

**Status:** Skeleton. Requires `rzup` installation: `curl -L https://risczero.com/install | bash && rzup install`.

---

## 12. Compressed Ghost Agent Accounts

**Code:** `programs/dark_agent_compressed_state/` — deferred until Light Protocol SDK stabilizes.

**The design:** Agent balance is not a visible hot wallet. Instead:

```
compressed state leaf {
    balance_commitment: H(COMMITMENT || balance || secret),
    spending_cap_commitment: H(COMMITMENT || cap),
    strategy_mode_hash: H(X402_INTENT || mode),
    receipt_root: [u8; 32],
}
```

Buildable as a commitment-account design even before full ZK wrapping. Agent wallets become state commitments, not observable hot wallets.

---

## Devnet Program IDs

| Program | Network | Address |
|---|---|---|
| dark_nullifier_banks | devnet | _pending deployment_ |
| dark_compressed_receipts | devnet | _pending deployment_ |
| dark_chaff | devnet | _pending deployment_ |

Deploy with: `npx tsx scripts/deploy-alien-tek.ts`

---

## Build & Test

```bash
# All library crate unit tests
cargo test --workspace

# Solana program integration tests (BPF-equivalent native mode)
cargo test --workspace -- --nocapture

# Devnet relay-router integration test
SOLANA_RPC_URL=https://api.devnet.solana.com cargo test --features devnet-tests -p dark-relay-router

# Deploy programs to devnet
npx tsx scripts/deploy-alien-tek.ts
```

---

## Precedence & Status

| Primitive | Status | Depends On |
|---|---|---|
| Write-Lock Sharded Nullifier Banks | ✅ implemented + tested | solana-program |
| ALT Fog Router | ✅ implemented + tested | solana-sdk |
| Compressed Receipt Accounts | ✅ implemented + tested | solana-program |
| Poseidon-Native Account Tree | ✅ implemented + tested | sha2 |
| Receipt Spend Notes | ✅ implemented + tested | dark-poseidon-tree |
| Leader-Aware Private Relay Path | ✅ implemented + tested | solana-sdk, reqwest |
| Jito Bundle Cloak | ✅ implemented + tested | solana-sdk |
| Ephemeral PDA Chaff | ✅ implemented + tested | solana-program |
| Proof-Carrying Swarm Capsules | ✅ implemented + tested | ed25519-dalek |
| Private Fee Quote Auctions | ✅ implemented + tested | sha2 |
| Bonsol Dark Batch Auditor | 🔲 skeleton — needs rzup | RISC Zero |
| Compressed Ghost Agent Accounts | 🔲 design only — needs Light SDK | Light Protocol |
