# Dark Null 2030 Original Primitives
> Dark Null is not a wallet. It is a private permission system for AI money.

---

## Why These Are Original

These primitives are not copies of ZK research papers or rehashes of existing L2 designs. Each one exploits a specific constraint or capability of Solana that does not exist in the same form on Ethereum or other chains: concurrent Merkle trees with sub-lamport leaves, the slot-based clock and its relationship to account expiry, Address Lookup Tables as an anonymity tool, the compute unit market structure, and the fact that Solana has no mempool in the traditional sense. The combination of Rust-native off-chain computation, spl-account-compression, and a high-throughput chain that can process 50,000 TPS without rollups makes a class of design possible here that would require a rollup or a separate L2 on any other chain.

---

## Scoring Table

| Rank | Primitive | Innovation (1-10) | Impact (1-10) | Rust/Solana Doability (1-10) |
|---|---|---|---|---|
| 1 | No-Custody Agent Wallet via Spending Macaroons | 9 | 10 | 9 |
| 2 | Receipt Rollup Without a Rollup | 8 | 10 | 10 |
| 3 | Ghost SPL Virtual Token Accounts | 9 | 9 | 9 |
| 4 | Rentless Program OS / Dark Kernel | 10 | 8 | 6 |
| 5 | Compute Futures / Relay Coupons | 8 | 8 | 9 |
| 6 | Account Lock Scheduler | 7 | 9 | 10 |
| 7 | ALT Shape Mixer / Shape Pools | 8 | 7 | 9 |
| 8 | Useful Chaff Maintenance | 7 | 8 | 10 |
| 9 | Proof-Carrying UI Intent Capsules | 8 | 8 | 8 |
| 10 | State Futures / Compressed Slot Reservations | 9 | 7 | 6 |
| 11 | Nullifier Bloom Forest | 8 | 9 | 7 |
| 12 | Feature Commit-Reveal Activation | 7 | 7 | 8 |
| 13 | Anti-Honeypot Swarm Capsules | 8 | 8 | 8 |
| 14 | Diet Compiler: Anchor Dev → Pinocchio Prod | 9 | 8 | 6 |

---

## The Primitives

---

### 1. No-Custody Agent Wallet via Spending Macaroons

**Problem:** An AI agent needs to pay for API calls on behalf of a user. The naive solution gives the agent a funded keypair — which means the agent has full custody. If the agent is compromised, all funds are gone. If the user wants to revoke, they must rotate keys and hope the agent hasn't already drained the wallet. There is no standard revocation, no spending caps, no scope restriction.

**Why Solana makes this possible:** Solana's transaction model allows arbitrary instruction data and multi-signer schemes. A macaroon is a chain of HMAC-signed caveats — each caveat restricts what the token authorizes. The root key never leaves the user's device; the agent receives only a derived spending token. Verification is pure Rust crypto, no ZK needed.

**Rust modules (`crates/dark-macaroons`):**

```rust
pub struct Macaroon {
    pub root_key_id:  [u8; 32],   // identifies the root, never reveals it
    pub caveats:      Vec<Caveat>,
    pub signature:    [u8; 64],
}

pub enum Caveat {
    MaxAmount(u64),                // agent cannot spend more than N lamports
    ScopeHash([u8; 32]),           // agent can only pay for this scope
    ExpiresAtSlot(u64),            // token invalid after this slot
    NoWithdraw,                    // agent cannot initiate withdrawals
    RequireReceiptNote,            // every spend must produce a receipt note
}

pub fn mint(root_key: &[u8; 32], caveats: Vec<Caveat>) -> Macaroon;
pub fn verify(token: &Macaroon, root_key: &[u8; 32], context: &SpendContext) -> Result<()>;
pub fn attenuate(token: &Macaroon, new_caveat: Caveat) -> Macaroon; // add caveat without root key
```

**On-chain module (`dark_caveat_verify` — future):** A Solana program that verifies macaroon signatures in a transaction instruction. Enables on-chain enforcement of spending caps without custody transfer. Future work: integrate with `dark_lite_core` vault for per-macaroon spend limits enforced at the program level.

**First test:**
```rust
#[test]
fn agent_cannot_exceed_max_amount() {
    let root = [0u8; 32];
    let token = mint(&root, vec![Caveat::MaxAmount(1_000_000)]);
    let ctx = SpendContext { amount: 1_000_001, scope: None, slot: 0 };
    assert!(verify(&token, &root, &ctx).is_err());
}
```

**What is forbidden to claim:** This is not a hardware wallet. It is not a multisig. It does not prevent a compromised agent from replaying the token before expiry. The `ExpiresAtSlot` caveat limits the blast radius of a compromise to the expiry window.

**Estimated cost impact:** Zero on-chain cost per spend. The macaroon is verified off-chain or in a program instruction that reads no mutable accounts. Spending cap enforcement: ~5,000 CU per verify if done on-chain.

---

### 2. Receipt Rollup Without a Rollup

**Problem:** Payment systems need receipts. Receipts need to be auditable, tamper-evident, and provable to third parties. The standard Solana approach creates one PDA per receipt — 0.00134 SOL per receipt, never reclaimed, accumulating forever.

**Why Solana makes this possible:** `spl-account-compression` provides concurrent Merkle trees with ~50 ns leaf inserts (off-chain) and cheap on-chain root checkpoints. A 1,000,000-leaf tree costs roughly the same to checkpoint as a 1-leaf tree: one 78-byte TinyPdaHeader.

**Rust modules (`crates/receipt-rollup-lite`):**

```rust
pub struct EpochTree {
    pub epoch_id:   u32,
    pub leaves:     Vec<[u8; 32]>,   // hash(ReceiptNote) per receipt
    pub root:       [u8; 32],
}

pub struct ReceiptNote {
    pub payer_commitment: [u8; 32],
    pub payee_hash:       [u8; 32],
    pub amount:           u64,
    pub epoch:            u32,
    pub nonce:            [u8; 16],
}

pub fn add_receipt(tree: &mut EpochTree, note: ReceiptNote);
pub fn compute_root(tree: &EpochTree) -> [u8; 32];
pub fn prove_inclusion(tree: &EpochTree, leaf_index: usize) -> MerklePath;
pub fn verify_inclusion(root: &[u8; 32], note: &ReceiptNote, path: &MerklePath) -> bool;
```

**On-chain footprint:** One `ReceiptCheckpoint` PDA per epoch. 78 bytes. ~0.00089 SOL. Stores only `epoch_id`, `root`, `receipt_count`, `closed_at_slot`.

**Rollup mechanics:** Receipts accumulate off-chain during an epoch. At epoch close, the x402 server calls `checkpoint_epoch()` on `dark_compressed_receipts`. The transaction includes the final root and count. The program verifies the instruction signer is the authorized checkpointer and writes the PDA.

**What is forbidden to claim:** This is not a ZK rollup. There is no validity proof. The root is trusted-checkpointer-attested, not cryptographically proven by a verifier circuit. Users can verify their own inclusion proof against the checkpoint root, but cannot prove the root itself is valid without trusting the checkpointer.

**Estimated cost impact:** 10,000 receipts per day → ~0.00089 SOL/epoch × 4 epochs/day = ~0.00356 SOL/day. Naive approach: 10,000 × 0.00134 = 13.4 SOL/day. **Savings: ~99.97%.**

---

### 3. Ghost SPL Virtual Token Accounts

**Problem:** Real SPL token accounts cost ~0.002 SOL each and require the user to hold the token mint's account. An agent system that creates one token account per user per supported token burns 0.002 × users × tokens SOL before any payments occur.

**Why Solana makes this possible:** SPL token semantics can be emulated off-chain using balance commitments. A shared vault holds the actual tokens. Individual balances are tracked as signed commitments in the off-chain ledger, with periodic on-chain roots for dispute resolution.

**Rust modules (`crates/ghost-spl-ledger`):**

```rust
pub struct VirtualBalance {
    pub owner_hash:   [u8; 32],   // hash(owner_pubkey || salt)
    pub mint:         Pubkey,
    pub balance:      u64,
    pub nonce:        u64,
    pub signature:    [u8; 64],   // signed by ledger authority
}

pub struct BalanceProof {
    pub commitment: [u8; 32],     // hash(VirtualBalance)
    pub merkle_path: MerklePath,  // inclusion in current balance root
}

pub fn create_virtual_balance(owner: &Pubkey, mint: &Pubkey, salt: &[u8; 32]) -> VirtualBalance;
pub fn credit(balance: &mut VirtualBalance, amount: u64, authority_key: &[u8; 64]) -> Result<()>;
pub fn debit(balance: &mut VirtualBalance, amount: u64, authority_key: &[u8; 64]) -> Result<()>;
pub fn generate_proof(ledger_root: &[u8; 32], balance: &VirtualBalance) -> BalanceProof;
```

**On-chain footprint:** One shared vault token account per supported mint. One `BalanceRoot` TinyPdaHeader per epoch. Zero per-user token accounts.

**Ghost account lifecycle:**
1. User deposits USDC to shared vault (real SPL transfer, one tx)
2. Ledger authority creates `VirtualBalance` off-chain, signs it
3. Agent debits virtual balance on each API call
4. Epoch close: balance commitments rolled into `BalanceRoot`
5. User withdrawal: ledger verifies balance, initiates real SPL transfer from vault

**What is forbidden to claim:** Ghost balances are custodial at the vault level. The vault authority can theoretically freeze or redirect funds. This is not a trustless self-custody system. It is a low-cost custodial balance layer with cryptographic audit trails.

**Estimated cost impact:** 1,000 users × 3 tokens = 3,000 SPL accounts avoided = ~6 SOL saved at creation time.

---

### 4. Rentless Program OS / Dark Kernel

**Problem:** Every Solana program is deployed as a large buffer account. The deployer pays rent on the program account forever (or until the program is closed). For a system with many small programs, this is a fixed cost that must be paid upfront.

**Why Solana makes this possible:** Solana's upgradeable loader (BPFLoader2) allows program accounts to be closed and rent reclaimed after deprecation. A "Dark Kernel" approach keeps the core kernel tiny (< 50 KB) and loads feature modules as ephemeral CPI targets that can be upgraded or replaced without redeploying the kernel.

**Programs (`programs/dark_kernel` — future):**

The kernel owns three responsibilities: (1) authority verification, (2) fee routing, and (3) CPI dispatch to registered feature modules. Feature modules are separate programs registered in a kernel registry account. The kernel itself never changes; features are upgraded independently.

**Benefit:** The kernel binary stays under 50 KB indefinitely. Feature programs can be closed and rent reclaimed when features are deprecated. Total program rent is bounded by the number of active feature programs, not the total history of deployed features.

**Current status:** Not yet implemented. Requires careful design of the CPI dispatch mechanism to avoid becoming an authority-delegation footgun.

**What is forbidden to claim:** This is not a hypervisor. It does not provide isolation between feature programs — a malicious feature program can still drain accounts it has authority over.

---

### 5. Compute Futures / Relay Coupons

**Problem:** Relayers pay transaction fees upfront. Users (or agents) owe the relayer for those fees. The naive solution is to pay relayers synchronously in the same transaction — which creates ordering and tip auction complexity.

**Why Solana makes this possible:** Solana's compute unit pricing is predictable within a short time window. A relayer can issue a compute coupon — a signed commitment to relay a specific transaction class at a specific CU price cap — and be reimbursed asynchronously from the vault.

**Rust modules (`crates/compute-coupon`):**

```rust
pub struct ComputeCoupon {
    pub relayer:          Pubkey,
    pub max_cu_price:     u64,       // microlamports per CU
    pub max_cu_budget:    u32,       // CU limit
    pub valid_until_slot: u64,
    pub tx_class_hash:    [u8; 32],  // hash of allowed instruction set
    pub signature:        [u8; 64],
}

pub fn issue(relayer_key: &[u8; 64], class_hash: [u8; 32], max_cu_price: u64, valid_slots: u64) -> ComputeCoupon;
pub fn redeem(coupon: &ComputeCoupon, actual_cu_used: u32, payer: &Pubkey) -> RedemptionClaim;
pub fn verify(coupon: &ComputeCoupon, class_hash: &[u8; 32], slot: u64) -> Result<()>;
```

**Redemption flow:** Relayer submits transaction, records `actual_cu_used`. At batch settlement, relayer presents `RedemptionClaim` to the vault for reimbursement. The vault pays at `min(coupon.max_cu_price, actual_cu_price) × actual_cu_used`.

**What is forbidden to claim:** Compute coupons do not guarantee relay. A relayer can refuse to relay even with a valid coupon. They are soft commitments, not on-chain obligations.

---

### 6. Account Lock Scheduler

**Problem:** Concurrent nullifier insertions to the same shard account cause transaction failures due to account write conflicts. The standard response is to retry — but retry storms under load can cause cascading failures.

**Why Solana makes this possible:** Solana's deterministic slot timing (400 ms slots) allows a lock scheduler to assign insertions to non-conflicting slots in advance. The scheduler knows which shard each nullifier maps to and can batch non-conflicting insertions into the same transaction.

**Rust modules (`crates/lock-scheduler`):**

```rust
pub struct LockSchedule {
    pub epoch:  u32,
    pub slots:  Vec<SlotWindow>,
}

pub struct SlotWindow {
    pub slot_range: (u64, u64),
    pub ops:        Vec<NullifierInsert>,
    pub shard_ids:  Vec<u8>,       // which shards are written in this window
}

pub fn schedule(ops: Vec<NullifierInsert>, current_slot: u64) -> LockSchedule;
pub fn validate_no_conflicts(window: &SlotWindow) -> bool;
```

**Conflict avoidance rule:** Two `NullifierInsert` operations conflict if and only if they write to the same `shard_id`. The scheduler bins operations by shard and produces slot windows where each window touches each shard at most once.

**Estimated throughput:** With 256 shards and 400 ms slots, the scheduler can process up to 256 non-conflicting nullifier inserts per slot without any retries.

---

### 7. ALT Shape Mixer / Shape Pools

**Problem:** Transaction graph analysis can link payer → payee by analyzing which accounts appear together in transactions over time. Even if individual accounts are pseudonymous, the co-occurrence graph leaks behavioral patterns.

**Why Solana makes this possible:** Address Lookup Tables (ALTs) allow transactions to reference accounts by 1-byte index rather than 32-byte pubkey. This means all settlement transactions can reference the same ALT containing a large pool of accounts — making them look structurally identical on-chain.

**Rust modules (`crates/shape-pool`):**

```rust
pub struct ShapePool {
    pub alt_address: Pubkey,
    pub accounts:    Vec<Pubkey>,   // all possible accounts in the pool
}

pub struct CanonicalShape {
    pub program_id:      u8,   // ALT index
    pub vault:           u8,   // ALT index
    pub nullifier_shard: u8,   // ALT index
    pub receipt_tree:    u8,   // ALT index
}

// All ReceiptSpend transactions use this exact instruction shape
pub fn build_receipt_spend_tx(
    pool: &ShapePool,
    shape: &CanonicalShape,
    spend_data: &SpendData,
) -> Transaction;
```

**Camouflage property:** Every `ReceiptSpend` transaction has identical instruction structure: same program, same ALT, same account index positions. The only varying bytes are in the instruction data (the spend payload). An observer sees a stream of structurally identical transactions — they cannot tell which ones are user A vs user B.

**What is forbidden to claim:** This is not anonymity. It is transaction graph camouflage. A determined adversary with access to off-chain data can still deanonymize by correlating amounts and timing.

---

### 8. Useful Chaff Maintenance

**Problem:** Scratch accounts, expired sessions, and stale PDAs accumulate on-chain. Nobody cleans them because there is no incentive. The protocol pays rent forever on dead state.

**Why Solana makes this possible:** Solana allows any program to close an expired account if the program defines a permissionless close instruction with a rent refund to the caller. This creates a built-in economic incentive for cleanup.

**Rust modules (`crates/useful-chaff-planner`):**

```rust
pub enum MaintenanceOp {
    CloseExpiredScratch { account: Pubkey, expected_lamports: u64 },
    CloseEmptyNullifierShard { shard_id: u8, expected_lamports: u64 },
    ReclaimStaleCompressedTree { tree: Pubkey, expected_lamports: u64 },
}

pub struct MaintenancePlan {
    pub ops:            Vec<MaintenanceOp>,
    pub total_reclaim:  u64,    // lamports to be returned
    pub estimated_gas:  u64,    // CU cost of all ops
}

pub fn plan(accounts: Vec<AccountMeta>, current_slot: u64) -> MaintenancePlan;
pub fn is_profitable(plan: &MaintenancePlan, cu_price: u64) -> bool;
```

**Planner logic:** The planner fetches the accounts it knows about (scratch accounts, nullifier shards), checks `expires_at_slot` against `current_slot`, and builds a `MaintenancePlan` of all closeable accounts. It only emits operations that are net-profitable after gas costs.

**Integration with dark_chaff program:** The `dark_chaff` Solana program defines `close_expired_scratch(accounts)` which verifies `expires_at_slot < current_slot` and transfers rent to the transaction fee payer. No authority required — permissionless after expiry.

---

### 9. Proof-Carrying UI Intent Capsules

**Problem:** A user's UI intent ("I want to pay for this API call") and the on-chain transaction that executes it are separated in time and context. A malicious frontend can substitute a different transaction for the one the user thought they were signing.

**Why Solana makes this possible:** Solana transaction signatures are deterministic commitments to a specific instruction set. An intent capsule is a signed commitment to the intended transaction hash, created before the transaction is built. The agent verifies the capsule matches the transaction before submitting.

**Rust modules (`crates/intent-capsule`):**

```rust
pub struct IntentCapsule {
    pub intent_hash:     [u8; 32],   // hash of the user's stated intent
    pub constraints:     Vec<IntentConstraint>,
    pub user_signature:  [u8; 64],
    pub created_at_slot: u64,
    pub expires_at_slot: u64,
}

pub enum IntentConstraint {
    MaxAmountLamports(u64),
    RequiredProgram(Pubkey),
    ForbiddenAccount(Pubkey),
    RequiredInstruction(Vec<u8>),    // first N bytes of instruction data
}

pub fn create(intent: &UserIntent, user_key: &[u8; 64]) -> IntentCapsule;
pub fn verify_transaction(capsule: &IntentCapsule, tx: &Transaction) -> Result<()>;
pub fn is_expired(capsule: &IntentCapsule, current_slot: u64) -> bool;
```

**Commit-reveal flow:**
1. User states intent in UI (natural language or form)
2. UI creates `IntentCapsule` from intent + constraints, user signs it
3. Agent builds transaction matching the capsule
4. `verify_transaction()` confirms the tx satisfies all constraints
5. Agent submits; capsule is stored as an audit record

**What is forbidden to claim:** Intent capsules do not prevent a malicious agent from building a transaction that technically satisfies the capsule constraints while still doing something the user would not want. Constraints must be specific to be protective.

---

### 10. State Futures / Compressed Slot Reservations

**Problem:** Hot accounts (nullifier shards, shared vault) contend under load. A payment that arrives at slot N might need to modify the same shard as 50 other payments. Only one wins; the rest retry.

**Why Solana makes this possible:** Solana's slot structure is deterministic. A "state future" reserves a write slot in advance — the holder of the future has a guaranteed non-conflicting window to write to a specific account.

**Routing layer (`crates/state-tier-router` as routing layer — future slot market):**

The `state-tier-router` crate will expose a `SlotReservation` type that acts as a soft reservation for a specific shard in a specific slot window. The slot market (future work) allows holders of high-priority operations to bid for non-conflicting slots.

**Current capability:** The router already handles tier decisions and shard assignment. The slot reservation mechanism is tracked as future work, pending the maturity of the Solana priority fee market.

---

### 11. Nullifier Bloom Forest

**Problem:** Checking whether a nullifier has been spent requires reading a nullifier shard account. With 256 shards, each read is a separate account fetch. Under high throughput, the read load on nullifier shards can become a bottleneck.

**Why Solana makes this possible:** A two-layer filter — probabilistic Bloom filter for fast rejection + exact bitset for final confirmation — can dramatically reduce the number of exact account reads. The Bloom layer catches 99%+ of "definitely not spent" queries without touching the shard accounts.

**Architecture (future: two-layer Bloom+exact, on-chain bitset):**

Layer 1 (off-chain): In-memory Bloom filter, updated at each epoch checkpoint. False positive rate: 0.1%. A nullifier that tests negative in the Bloom filter is definitely unspent — no account read needed.

Layer 2 (on-chain): Exact bitset in nullifier shard headers. Queried only when Bloom filter says "possibly spent." The bitset is the canonical source of truth.

**Expected throughput improvement:** Under 1,000 spend-check queries/second, the Bloom filter handles ~990 without account reads. Only ~10 queries hit the on-chain shard per second — a 100x reduction in hot account reads.

---

### 12. Feature Commit-Reveal Activation

**Problem:** Deploying a new feature in a live protocol is dangerous. The deploy transaction reveals the new program binary to the world before the feature is activated. Adversaries can analyze the binary and front-run the activation.

**Why Solana makes this possible:** Solana's upgradeable loader allows deploying a program buffer without activating it. A commit-reveal scheme deploys the hash of the new binary in one epoch, waits an epoch, then reveals and activates.

**Protocol (deploy hash, wait epoch, reveal — future):**

1. `commit_epoch_N`: Publish `hash(new_program_binary)` to a TinyPdaHeader. Do not deploy binary.
2. Wait: one full epoch (~6 hours) passes. Validators and community can review the commitment.
3. `reveal_epoch_N+1`: Deploy binary to buffer. Program verifies `hash(binary) == committed_hash`. Activate upgrade.

**Benefit:** The activation window allows for emergency cancellation if the binary hash is flagged. The commitment is binding but not irreversible — the deployer can abandon the reveal at cost of one wasted commitment transaction.

---

### 13. Anti-Honeypot Swarm Capsules

**Problem:** A malicious API endpoint can impersonate a legitimate service to collect agent payments without delivering the promised compute. Agents have no way to verify service authenticity before paying.

**Why Solana makes this possible:** A swarm capsule is a signed attestation from a quorum of known-good agents that a given endpoint has been verified. The capsule is distributed via gossip and cached locally. An agent checks the swarm capsule before paying a new endpoint.

**Rust modules (`crates/swarm-capsule` — already built):**

```rust
pub struct SwarmCapsule {
    pub endpoint_hash:   [u8; 32],   // hash(endpoint_url || pubkey)
    pub attestations:    Vec<SwarmAttestation>,
    pub quorum_reached:  bool,
    pub valid_until:     u64,
}

pub struct SwarmAttestation {
    pub agent_id:    [u8; 32],
    pub verified_at: u64,
    pub signature:   [u8; 64],
}

pub fn attest(capsule: &mut SwarmCapsule, agent_key: &[u8; 64], slot: u64);
pub fn is_safe(capsule: &SwarmCapsule, min_quorum: usize) -> bool;
pub fn has_honeypot_signal(capsule: &SwarmCapsule) -> bool;
```

**Honeypot signal:** If any attesting agent records a `payment_made: true, service_received: false` event, the capsule is flagged. Subsequent agents skip payment pending re-verification by a fresh quorum.

---

### 14. Diet Compiler: Anchor Dev → Pinocchio Prod

**Problem:** Anchor is the best developer experience on Solana, but its macros produce bloated binaries. Pinocchio is a minimal framework that produces tiny binaries but has a painful developer experience. Production deploys want Pinocchio binaries; development wants Anchor ergonomics.

**Why Solana makes this possible:** Solana program ABIs (account discriminators, instruction data layout) are stable contracts. A compiler pass that takes an Anchor program definition and produces a semantically equivalent Pinocchio program with the same ABI preserves client compatibility while dramatically reducing binary size.

**Architecture (future: same ABI, minimal binary):**

The diet compiler is a proc-macro or build script that:
1. Reads the Anchor `#[program]` definition
2. Strips macro-generated boilerplate (IDL gen, repr wrappers, error enum expansion)
3. Emits a Pinocchio-compatible instruction handler with identical account discriminators
4. Verifies ABI equivalence via a generated test

**Expected binary size reduction:** Anchor programs typically compile to 400–1,200 KB. Equivalent Pinocchio programs for the same logic: 40–150 KB. A 3-5x reduction in deploy SOL cost.

**Current status:** Conceptual. Requires significant tooling investment. Likely the last primitive to be implemented, after all core logic is validated in Anchor.

---

## The Build-First Stack

The three primitives that combine into a full working product — right now, without any future work:

**Layer 1 — Spending Macaroons (dark-macaroons):** The agent receives a caveated spending token. It can pay for API calls up to the cap, within the scope, before expiry. No custody transfer. No key exposure.

**Layer 2 — Receipt Rollup (receipt-rollup-lite):** Every API call produces a ReceiptNote off-chain. Receipts accumulate in an epoch tree. At epoch close, one checkpoint transaction commits the root. The user can prove any payment with an inclusion proof.

**Layer 3 — Ghost SPL Ledger (ghost-spl-ledger):** The shared vault holds real USDC. Individual balances are virtual commitments. No per-user token accounts. Deposits and withdrawals go through the vault; internal transfers are pure off-chain balance updates.

These three layers together provide: no-custody agent spending, cryptographically auditable receipts, and token account savings — with a combined on-chain footprint of approximately 3 accounts and ~2 SOL in program deploys.

---

## What Is Forbidden to Claim

The following claims are prohibited in all public-facing documentation, demos, pitches, and social posts:

- **production-ready** — this system has not been audited or run at scale
- **audited** — no professional security audit has been completed
- **end-to-end private** — transaction metadata (amounts, timing, shard indices) is observable on-chain
- **mainnet-ready** — the system is experimental; mainnet use is at deployer's risk
- **solved custody** — ghost SPL balances are custodial at the vault level
- **zero-knowledge proven** — no ZK circuits are wired up; the zkVM integration is aspirational
- **fully private** — see "end-to-end private" above
- **no leakage** — the system leaks timing and amount patterns; it reduces, not eliminates, leakage
