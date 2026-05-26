# Dark Null True Alien Primitives

> 10 product primitives for Parad0x / Nulla / Dark Null users.
> No compliance modules. No bank features. No generic "verify tx" plumbing.
> All primitives are local-first, privacy-preserving, and cryptographically linked to the Dark Null receipt layer.

---

## 1. `crates/agent-permission-notes/` — Caveated Agent Spending Rights

**What it is:** A cryptographic leash for AI agents that handle SOL or tokens. An `AgentPermissionNote` encodes spending limits, expiry, scope restrictions, withdrawal bans, and a kill switch — all hashed together so rotation invalidates all prior spend proofs.

**Why Parad0x / Nulla users care:** AI trading agents, DeFi bots, and automated wallet helpers need hard cryptographic constraints, not trust. This primitive makes "the agent may spend up to 0.1 SOL per slot, never withdraw, expire in 1000 slots" a verifiable claim rather than a policy comment.

**Key types:**
```rust
pub struct AgentPermissionNote {
    pub agent_id_hash: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub scope_hashes: Vec<[u8; 32]>,
    pub max_lamports_per_spend: u64,
    pub max_total_lamports: u64,
    pub expires_at_slot: u64,
    pub allow_withdraw: bool,
    pub kill_switch_hash: [u8; 32],
}
pub struct PermissionSpend { permission_hash, scope_hash, lamports, slot, nullifier }
```

**Key invariant:** `note_hash()` covers all fields including scope vector. Rotating any field (scope, cap, expiry) produces a new hash, invalidating all existing `PermissionSpend` proofs built against the old note. Two agents issuing identical-looking notes get different hashes because `issuer_hash` differs.

**Spend check pipeline (8 steps):**
1. Verify `spend.permission_hash == note.note_hash()`
2. Kill switch not triggered
3. Not expired
4. Single-spend ≤ max_lamports_per_spend
5. Total ≤ max_total_lamports
6. Scope not in withdrawal scope (if !allow_withdraw)
7. Scope not in denied_scope_hashes
8. Scope in allowed_scope_hashes

**Tests:** 11 — rotation invalidation, two-agent separation, kill-switch, expiry, withdrawal scope, underpayment.

---

## 2. `crates/spend-shadows/` — Controlled Shadow Bundles

**What it is:** A shadow bundle contains 1 real leaf and N shadow leaves (decoys, delays, poison, maintenance). All leaves use the same 81-byte canonical encoding so they are indistinguishable by size. Chain analysts see N+1 identical-looking leaves and cannot determine which is the real spend.

**Why Parad0x / Nulla users care:** Onchain spend patterns identify traders. A shadow bundle makes the true spend invisible inside a set of plausible alternatives — delayed settlements, maintenance actions, poison traps, and decoys all occupy the same bytes.

**Leaf types:**
```rust
pub enum ShadowKind { Real, Decoy, Delayed { reveal_slot: u64 }, Poison, Maintenance }
pub struct ShadowLeaf { pub kind: ShadowKind, pub leaf_hash: [u8; 32], pub reveal_slot: u64, pub maint_hash: [u8; 32], pub expiry: u64 }
```

**Canonical encoding:** `[kind:1][leaf_hash:32][reveal_slot:8][maint_hash:32][expiry:8]` = 81 bytes. Every leaf type encodes to exactly 81 bytes; zeros fill unused fields.

**Copy-sniper precision formula:** `1.0 / bundle.public_leaves.len()` — adding one decoy halves attacker precision.

**Redemption rules:**
- `Poison` → `can_redeem()` always returns `Err(PoisonTrap)` — attempting redemption flags the redeemer
- `Delayed { reveal_slot }` → `can_redeem()` requires `current_slot >= reveal_slot`
- `Decoy` / `Maintenance` → always allowed (no chain-state side effects)

**Tests:** 8 — canonical size, copy-sniper math, poison trap, delayed timing, real spend isolation.

---

## 3. `crates/agent-flight-recorder/` — Cryptographic Black-Box Log

**What it is:** A tamper-evident log of every money action an AI agent takes. Each `FlightRecord` chains to the previous via `previous_flight_hash`, covers model output, spend receipt, scope, lamports, and slot. A `RedactedFlightView` strips the model output and spend receipt so agents can share accountability logs without leaking trade secrets.

**Why Parad0x / Nulla users care:** When an AI agent loses money, "the model decided" is not an audit trail. This primitive produces a cryptographic record linking model output hash → spend → outcome, chainable across an entire session, with a private reveal path for full transparency when needed.

**Key types:**
```rust
pub struct FlightRecord {
    pub agent_id_hash: [u8; 32],
    pub model_output_hash: [u8; 32],
    pub spend_receipt_hash: [u8; 32],
    pub scope_hash: [u8; 32],
    pub lamports_spent: u64,
    pub outcome_hash: [u8; 32],
    pub slot: u64,
    pub previous_flight_hash: [u8; 32],
}
pub struct RedactedFlightView { pub agent_id_hash, pub scope_hash, pub lamports_spent, pub outcome_hash, pub slot, pub previous_flight_hash, pub record_hash }
```

**Chain invariant:** The first record in a session must have `previous_flight_hash == [0u8; 32]`. Each subsequent record must include the previous record's `compute_hash()`. `chain_valid(&records)` verifies the full linked sequence.

**Private reveal:** `verify_private_reveal(records, root_hash)` re-derives the chain root from the full records and confirms it matches the published `root_hash` — proving the redacted view is accurate without publishing every record.

**Tests:** 9 — hash sensitivity (each field), chain linking, chain break detection, redaction (confirms private fields absent), private reveal.

---

## 4. `crates/receipt-souls/` — Disposable Bearer Notes

**What it is:** Unified bearer note type covering tips, API access tokens, gifts, and prediction tickets. A `ReceiptSoul` has a type tag, value, expiry, transfer policy, and redemption policy. Its nullifier preimage intentionally excludes `issuer_hash` — the issuer is undetectable from a spent nullifier.

**Why Parad0x / Nulla users care:** Tips, API keys, content access, and prediction tickets are conceptually the same thing: a transferable right to one claim. This primitive unifies them under one type with unlinkable nullifiers — a redeemed API token does not reveal who issued it.

**Soul types:**
```rust
pub enum SoulType { Tip, ApiAccess, Gift, PredictionTicket }
pub enum TransferPolicy { Transferable, RecipientBound, OneHopOnly, SoulboundAfterClaim }
pub enum RedemptionPolicy { StandardSpend, BurnAfterRead }
```

**Nullifier privacy:** `soul_nullifier = SHA256("dark_null_v1_soul_nullifier" || soul_id_hash || holder_hash || expiry_slot_le)` — `issuer_hash` is NOT in the preimage. A spent nullifier is indistinguishable across different issuers.

**Transfer chain:** `OneHopOnly` souls can transfer exactly once; further transfer returns `Err(TransferExhausted)`. `SoulboundAfterClaim` souls cannot transfer after redemption is recorded.

**Tests:** 9 — nullifier determinism, issuer unlinkability, type-based nullifier separation, expired soul rejection, transfer policies, burn-after-read.

---

## 5. `crates/alpha-capsules/` — Time-Locked Sealed Alpha

**What it is:** A capsule for sealing a directional bet, signal, or alpha prediction. The side (long/short/neutral) is committed with a salt before the reveal slot. Confidence is encoded as a `ConfidenceBucket` (1–5). After the reveal slot passes, anyone with the salt can verify the original committed side.

**Why Parad0x / Nulla users care:** Prediction markets, signal services, and alpha-sharing communities need proof-of-prior-prediction without the ability to fake commitment after the fact. This primitive makes "I called the top at slot X" a cryptographic fact rather than a screenshot.

**Key types:**
```rust
pub struct AlphaCapsule { pub issuer_hash, pub side_commitment, pub confidence, pub model_hash, pub market_hash, pub sealed_at_slot, pub reveal_slot, pub session_hash }
pub struct ConfidenceBucket(pub u8);  // 1-5
pub struct CapsuleReveal { pub capsule_hash, pub revealed_side, pub side_commitment, pub salt, pub revealed_at_slot }
```

**Side commitment:** `SHA256("dark_null_v1_alpha_side" || side_bytes || salt)` — deterministic, hiding, binding.

**Reveal rules:** `verify_reveal(capsule, side, salt, current_slot)` — (1) current_slot ≥ reveal_slot, (2) recompute commitment from side + salt, (3) must match `capsule.side_commitment`. Returns `Err(TooEarly)` or `Err(SideCommitmentMismatch)`.

**Tests:** 10 — before-reveal rejection, correct reveal, wrong salt rejection, wrong side rejection, confidence bounds (0 and 6 fail), capsule hash field sensitivity, confidence isolation.

---

## 6. `crates/chaff-economy/` — Productive Chaff

**What it is:** Chaff PDAs that do real maintenance work and earn rewards instead of being pure noise. A `ChaffJob` specifies a maintenance action (close expired account, compact receipt root, prune old nullifiers, heal shard gaps, rebalance shards). A `ChaffMarket` lists available jobs; `best_job()` picks the highest-reward valid job.

**Why Parad0x / Nulla users care:** Dark Null already creates chaff PDAs as chain-analysis poison. This primitive makes chaff economically self-sustaining — chaff creators earn rent reclaim or protocol rewards instead of just paying for noise. This turns chain-analysis poisoning from a cost into a revenue stream.

**Job types:**
```rust
pub enum ChaffJobKind { CloseExpiredAccount, CompactReceiptRoot, PruneOldNullifiers, HealShardGap, RebalanceShard }
pub struct ChaffJob { pub kind, pub maintenance_target_hash, pub reward_lamports, pub expires_at_slot }
```

**Validity rule:** A job is valid iff `maintenance_target_hash != [0u8; 32]` AND `reward_lamports > 0`. Zero-hash targets are sentinel/placeholder jobs and must not be dispatched.

**Default rewards:** `CloseExpiredAccount` → 10_000 lamports, `CompactReceiptRoot` → 12_000, `PruneOldNullifiers` → 8_000, `HealShardGap` → 9_000, `RebalanceShard` → 7_500.

**Tests:** 9 — valid job selection, invalid job rejection, zero-hash rejection, best job picking, chaff execution record, concurrent execution detection.

---

## 7. `crates/session-note-channel/` — Payment Channel Without a Channel PDA

**What it is:** A bilateral payment channel where each payment is a note nullifier instead of a signed channel update. Settlement produces a deterministic root by sorting all nullifiers and hashing them — no channel account, no on-chain state until settlement. A `SessionNoteChannel` tracks the note sequence; `settle_session()` produces the final root.

**Why Parad0x / Nulla users care:** Traditional payment channels require a locked PDA and a closing transaction. This primitive makes N payments collapsible into a single settlement hash — no PDA, no custody, no on-chain state for the duration of the session. The channel lives entirely in memory until the payer decides to settle.

**Key types:**
```rust
pub struct SessionNote { pub session_hash, pub note_hash, pub scope_hash, pub lamports, pub index, pub nullifier }
pub struct SessionNoteChannel { pub session_hash, pub channel_capacity_lamports, pub notes: Vec<SessionNote> }
pub struct SessionSettlement { pub session_hash, pub settlement_root, pub total_notes, pub total_spent }
```

**Nullifier formula:** `SHA256("dark_null_v1_session_note" || session_hash || index_le4 || scope_hash)` — deterministic, no network required.

**Settlement:** Sort all nullifiers lexicographically, then hash the sorted sequence to produce `settlement_root`. Same notes in any insertion order produce the same root.

**Tamper detection:** `settle_session()` returns `Err(BalanceExceeded)` if `total_spent > channel_capacity_lamports`.

**Tests:** 10 — nullifier determinism, settlement root consistency, order independence, balance overflow detection, empty channel settlement, note index separation.

---

## 8. `crates/onchain-puzzle-compiler/` — Ritual Transaction Plans

**What it is:** Compile a message into a sequence of Solana transaction steps — a "ritual" — where each step hashes to a specific shard byte of the DARKNULL formula. Supports shard-by-value, shard-by-ASCII-letter, and shard-by-bit-pattern targeting. Produces a `RitualPlan` that can be serialized and shared.

**Why Parad0x / Nulla users care:** Dark Null already has the DARKNULL ritual (shard = SHA256(nullifier || epoch || domain)[0]). This primitive makes it programmable — you can write a message like "DARK NULL" and get back a plan for 9 transactions whose shard bytes spell out the message in ASCII. The ritual becomes a signed, verifiable onchain artifact.

**DARKNULL formula:** `shard_byte = SHA256(nullifier || epoch_le64 || domain)[0]`
- Domain is a **suffix** byte, not a prefix
- Known vector: nullifier=`6122...6dc89`, epoch=0, domain=`0x00` → shard=68=`'D'`

**Shard targeting modes:**
```rust
pub enum ShardTarget { ByValue(u8), ShardAscii(char), ByBitPattern { mask: u8, expected: u8 } }
pub struct RitualStep { pub step_index, pub target, pub nullifier, pub epoch, pub domain, pub shard_byte }
pub struct RitualPlan { pub ritual_hash, pub steps: Vec<RitualStep>, pub compiled_at_slot }
```

**Tests:** 12 — known DARKNULL vector ('D'=68), all ASCII targets A–Z solvable, bit-pattern matching, ritual hash sensitivity, step count matching message length, invalid char rejection.

---

## 9. `crates/no-custody-attestation/` — Anti-Honeypot Capsule

**What it is:** A signed attestation that a relayer, agent, or bridge does not hold custody of user funds. The `NoCustodyAttestation` must declare all four `DeniedKeyClass` variants present: `Withdraw`, `Transfer`, `Mint`, `Approve`. Missing any class or having `custody_denied=false` scores 100 risk. Each missing class adds 25 risk points.

**Why Parad0x / Nulla users care:** Relayers and bridges are honeypots if they accumulate user funds. This primitive makes the no-custody claim cryptographically attestable and machine-verifiable — a relayer that cannot produce a valid attestation fails the risk check before routing.

**Key types:**
```rust
pub enum DeniedKeyClass { Withdraw, Transfer, Mint, Approve }
pub struct NoCustodyAttestation {
    pub attester_hash: [u8; 32],
    pub denied_key_classes: Vec<DeniedKeyClass>,
    pub custody_denied: bool,
    pub attested_at_slot: u64,
    pub expires_at_slot: u64,
    pub attestation_hash: [u8; 32],
}
```

**Risk score formula:**
- `custody_denied=false` → 100 (maximum, circuit-breaker)
- Otherwise: `25 × (4 − present_class_count)`
- All 4 classes present + custody_denied=true → 0 (safe)

**Attestation hash covers:** all fields including `denied_key_classes` sorted by variant index — ordering is deterministic.

**Tests:** 9 — full attestation (risk=0), missing one class (risk=25), missing two (risk=50), custody_denied=false (risk=100), expired attestation rejection, attestation hash field sensitivity, relayer comparison.

---

## 10. `crates/roadmap-commitments/` — Cryptographic Feature Prophecy

**What it is:** Commit to a planned feature now (feature hash = SHA256(docs_hash || tests_hash)) and reveal it later when shipped. The reveal checks that the current slot is before the deadline, then verifies the feature hash matches, then checks the claim hash. A stale reveal (past deadline) is rejected to prevent retroactive claim of unshipped features.

**Why Parad0x / Nulla users care:** DAOs, protocols, and agent systems that publish roadmaps need proof that a shipped feature matches the one promised — not a rewrite to fit the outcome. This primitive makes roadmap commitments machine-verifiable and deadline-enforced.

**Key types:**
```rust
pub struct RoadmapCommitment {
    pub feature_hash: [u8; 32],      // SHA256("dark_null_v1_feature" || docs_hash || tests_hash)
    pub committed_at_slot: u64,
    pub deadline_slot: u64,
    pub commitment_hash: [u8; 32],   // SHA256(feature_hash || committed_at_slot_le || deadline_slot_le)
}
pub struct FeatureReveal { pub docs_hash, pub tests_hash, pub claim_hash, pub revealed_at_slot }
```

**Reveal pipeline:**
1. `revealed_at_slot > deadline_slot` → `Err(StaleReveal)` (past deadline)
2. Recompute `feature_hash` from `docs_hash + tests_hash` — must match commitment
3. Verify `claim_hash` matches expected pattern

**Tests:** 9 — correct reveal, stale reveal rejection, wrong docs hash, wrong tests hash, deadline enforcement, commitment hash field sensitivity, two-feature separation.

---

## Summary

| Crate | Tests | What it enables |
|---|---|---|
| agent-permission-notes | 11 | Cryptographic spending leash for AI agents |
| spend-shadows | 8 | Shadow bundles: 1 real + N indistinguishable leaves |
| agent-flight-recorder | 9 | Tamper-evident log of every agent money action |
| receipt-souls | 9 | Unified transferable bearer notes (tips/keys/gifts/bets) |
| alpha-capsules | 10 | Time-locked sealed prediction with confidence |
| chaff-economy | 9 | Chaff PDAs that earn rewards doing real maintenance |
| session-note-channel | 10 | Payment channel without a channel PDA |
| onchain-puzzle-compiler | 12 | Compile messages into DARKNULL ritual tx plans |
| no-custody-attestation | 9 | Anti-honeypot capsule for relayers/agents |
| roadmap-commitments | 9 | Cryptographic feature prophecy: commit now, reveal later |
| **Total** | **96** | |

All 10 crates: no network required, no external dependencies beyond `sha2` + `serde`, all tests pass locally, all linked to Dark Null receipt / nullifier layer.
