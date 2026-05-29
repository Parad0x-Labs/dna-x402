# Stack Integration — Existing DNA x402 Primitives → NULL Miner Roles

> Every crate below exists today in this monorepo (`crates/` or `programs/`).
> This document maps them to their specific role in the NULL Miner architecture.
> No new Solana programs are required for MVP. ~70% of the logic already exists.

---

## The NULL Miner architecture in 7 layers

```
Layer 7 — Host yield (NULL token)
Layer 6 — Agent reputation + identity  
Layer 5 — Task completion proof
Layer 4 — Double-spend / double-claim prevention
Layer 3 — Task escrow + payment release
Layer 2 — Task market (posting + discovery)
Layer 1 — Task transport privacy
```

---

## Layer 1 — Task Transport Privacy

**Purpose:** Task content is encrypted to the matched node. Neither buyer nor other nodes see task content. Transaction graph is anonymized.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/dark-poseidon-tree/` | Domain-separated hash for task content commitment | `DOMAIN::X402_INTENT = 4`, task content → commitment |
| `crates/alt-fog-router/` | Builds v0 txs with decoy ALT accounts to fog the on-chain trace | `FogGrade::Impenetrable`, `rank_routes()` |
| `crates/dark-bundle-cloak/` | Cloaks task-claiming txs in Jito bundles, adds decoy cleanup txs | Rejects `DirectWalletMapping` |
| `crates/dark-relay-router/` | Routes task payout txs through optimal relay path (DirectRpc/Jito/SWQoS) | Scores against leader schedule + timing jitter |
| `programs/dark_chaff/` | Emits ephemeral PDA chaff (3–7 per epoch) to poison chain analysis | Closed at epoch end — makes task claiming transactions unidentifiable |

---

## Layer 2 — Task Market (posting + discovery)

**Purpose:** Enterprise posts task with USDC bounty. Agent discovers and claims it.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/bounty-blink-jobs/` | **Core task posting + claiming.** `BountyBlinkJob { job_id, reward_lamports, expires_at_slot, required_proof_hash, claimed, completed }` | `create_job()`, `claim_job()`, `complete_job()` |
| `crates/useful-chaff-market/` | Protocol-internal maintenance tasks (CloseExpired, CompactRoot, RotateEpoch, HealShard) — the first "mining" task type | `ChaffMarketJob`, `ChaffReceipt`, `privacy_cover_score` |
| `crates/sealed-fee-quotes/` | Commit-reveal auction for task pricing — prevents frontrunning on high-value task claims | `SealedQuote`, nonce-based replay protection, receipt-hash bound |
| `crates/dark-pool-sdk/` | Dark pool SDK — wraps task posting in the privacy layer | Task content ZK-commitment before posting |

**Extension needed:** Add external task kinds to `bounty-blink-jobs::JobKind`:
```rust
// Current kinds (protocol-internal):
// CloseExpiredAccount, CompileRitualPuzzle, FillShapePool, RevealAlphaCapsule,
// SubmitNullifier, RefreshFeeHeatmap, CompactReceiptRoot, VerifySessionRoot

// Add for NULL Miner:
RelayResidentialRequest,   // bandwidth proxy task
AppStoreDataLookup,        // iOS/Android ecosystem task
LocationAttestation,       // GPS proof-of-location task
SensorDataSample,          // passive sensor collection
```

---

## Layer 3 — Task Escrow + Payment Release

**Purpose:** USDC locked when task is posted. Auto-releases to agent on proof verification. Neither party needs to trust the other.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/dark-agent-escrow/` | **Core escrow.** Payer locks funds with `condition_hash`. Agent submits condition bytes. `verify_and_release()` checks hash match → `EscrowRelease`. | `EscrowDeposit`, `EscrowRelease`, `EscrowError` |
| `crates/dark-fee-escrow/` | Fee escrow variant — handles protocol margin split during release | Separates "to agent" vs "to protocol" on release |
| `crates/dark-private-escrow/` | Privacy-wrapped escrow — hides beneficiary until release | Used when agent identity must stay hidden even on release |
| `x402/` | x402 payment rail — task buyer pays into escrow via HTTP 402 | `Quote → Pay → Verify → Receipt` — USDC settlement on Solana |

**Integration point:** Extend `dark-agent-escrow::condition_hash` to accept a `ComputeReceipt::receipt_hash` as the condition. When agent submits the receipt, escrow verifies `SHA256("compute-receipt-v1" || ...) == condition_hash` and releases automatically.

---

## Layer 4 — Double-Spend / Double-Claim Prevention

**Purpose:** Prevent the same task being claimed twice, or the same proof submitted twice for payment.

| Crate/Program | Role | Key types/functions |
|---|---|---|
| `programs/dark_nullifier_banks` | **256-shard nullifier banks.** Shard = `H(nullifier||epoch||domain) % 256`. PDA: `[b"null_bank", shard, epoch_le]`. Insert = mark claimed. Duplicate insert = reject. | Prevents double-claim across 256 concurrent shards |
| `programs/dark_compressed_receipts` | `ReceiptRoot` on-chain. `RedeemReceipt` instruction. Double-spend guard on receipt hash. | Task completion receipt anchored once — cannot be replayed |
| `crates/dark-batch-nullifier/` | Batches nullifier submissions across multiple task completions | Efficiency layer for high-throughput mining |
| `crates/dark-imt-nullifier/` | Indexed Merkle Tree nullifier set | Alternative nullifier accumulator for ZK-provable set membership |

---

## Layer 5 — Task Completion Proof

**Purpose:** Agent proves it completed the task without revealing sensitive content.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/dark-compute-receipt/` | **Core proof of work.** `ComputeReceipt { receipt_hash, job_id, wasm_module_hash, input_commitment, output_commitment, instructions_used, compute_proof_hash, epoch }`. Linked in a DAG via `ReceiptChainNode`. | `compute_receipt_hash()`, `ReceiptChainNode` |
| `crates/receipt-spend/` | Private receipt-note protocol. `new_note(secret, scope) → commitment`. `spend_note → NullifierProof`. Scope-bound unlinkability. | Agent proves task completion without linking to previous tasks |
| `crates/dark-proof-of-work/` | SHA-256 computational PoW. `WorkStatement { difficulty }` → `WorkProof { nonce, work_hash, satisfies_difficulty }`. | For bandwidth/relay tasks: proof that real bytes were proxied |
| `crates/dark-competitive-proof/` | Proves work output is better than a baseline | For data quality tasks: proves output meets quality threshold |
| `zkvm/dark_batch_auditor/` | RISC Zero guest skeleton — batch-verifiable ZK proofs of task completion | Future: ZK proof that X bytes were relayed, or X app lookups were completed, without revealing which |

---

## Layer 6 — Agent Reputation + Identity

**Purpose:** Agent builds reputation over time. Higher reputation = access to higher-value tasks. Identity is ZK — no wallet address linkable.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/dark-agent-passport/` | **ZK identity for mining agents.** Reputation 0–1000: base (volume) + diversity (breadth) + longevity (time) + volume multiplier. Stealth addresses. Selective disclosure. | `PassportScore`, `derive_stealth_address()` |
| `crates/dark-reputation-score/` | Standalone reputation scoring — feeds into Passport | Score components, badge thresholds |
| `crates/dark-reputation-badge/` | On-chain badges: FAST_P95, FULFILLMENT_99, TOP_SELLER_24H, PROOF_ANCHORED | Badge mint on threshold crossing |
| `crates/dark-reputation-ring/` | Ring-signature reputation proofs — prove you're in a high-rep cohort without revealing which member | "I am a gold-tier node" proof without deanonymization |
| `crates/swarm-capsule/` | Ed25519-signed capability capsule: `repo_commit`, `config_hash`, `role_bitmap`, `fee_cap_lamports`, `custody_denied`. Proves node is safe to trust. | Node broadcasts capability to task market |

---

## Layer 7 — Host Yield (NULL Token)

**Purpose:** Phone owner (not the agent) earns NULL tokens for hosting the agent — providing uptime, residential IP, and trusted execution environment.

| Crate | Role | Key types/functions |
|---|---|---|
| `crates/null-flywheel-core/` | **Existing NULL reward engine.** Currently: 5bp of qualifying premium fees → NULL community rewards. | Extend: `TaskCompletion` event → NULL mint to host address |
| `crates/null-flywheel-receipts/` | Receipts proving flywheel distributions | Append `NullMinerTaskReceipt` as a new receipt type |
| `crates/null-flywheel-sim/` | Simulation/backtesting for flywheel economics | Test NULL emission rate vs. task revenue scenarios |
| `crates/dark-staking-rewards/` | NULL staking → higher task tier access | Stake NULL → unlock higher-value task categories |
| `crates/dark-null-token/` | NULL token mint + program interface | `mint_to_host()` — new instruction for task completion reward |

**Extension needed in `null-flywheel-core`:** Add `TaskCompletionEvent` → NULL mint path alongside the existing `PremiumFeeEvent` path. The split: agent gets USDC (from escrow), host gets NULL (from flywheel). Rate: configurable % of task USDC value → converted to NULL at spot price via Flywheel.

---

## Passive Agent Loop — existing `sleep-earn-watcher`

The `crates/sleep-earn-watcher/` crate **already implements the autonomous scanning loop**:

```rust
pub enum WatcherJobKind {
    RentSweeper,
    ChaffMarket,     // ← already earning from useful-chaff-market!
    RitualPuzzle,
    AlphaReveal,
    SessionCleanup,
    ShapeFill,
}

pub fn scan_jobs(available: Vec<WatcherJob>, config: &WatcherConfig) -> Vec<WatcherJob> {
    // filters by: allowed_kinds, min_reward, reward > cost
}

pub fn build_execution_plan(jobs: Vec<WatcherJob>, config: &WatcherConfig) -> WatcherPlan {
    // rate-limited, dry-run safe, profit-estimated
}
```

**The passive mining loop is already built.** Add `WatcherJobKind::NullMiner(TaskKind)` variants and wire to the new external task types. The scan → plan → execute loop needs zero architectural changes.

---

## What does NOT need to be built from scratch

- ZK identity system ✅ (`dark-agent-passport`)
- Escrow + conditional release ✅ (`dark-agent-escrow`)
- Double-claim prevention ✅ (`dark_nullifier_banks` program)
- Task market (post + claim) ✅ (`bounty-blink-jobs`)
- Passive agent loop ✅ (`sleep-earn-watcher`)
- NULL token reward engine ✅ (`null-flywheel-core`)
- Privacy / fog layer ✅ (`alt-fog-router`, `dark-bundle-cloak`, `dark_chaff`)
- Proof of work ✅ (`dark-compute-receipt`, `dark-proof-of-work`)
- x402 payment rail ✅ (`x402/` package)
- Reputation badges ✅ (`dark-reputation-badge`)
