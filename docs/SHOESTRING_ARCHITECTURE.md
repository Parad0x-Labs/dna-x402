# Dark Null Shoestring Architecture
> The enemy is rent bloat, oversized SBF deploys, and one-PDA-per-action design.

---

## The Brutal Thesis

The naive Solana developer reaches for a PDA every time they need to record anything. A receipt? PDA. A user signing up? PDA. An agent action? PDA. Each of those costs rent — typically 0.00089–0.002 SOL per account — and those accounts rarely get closed. A system that handles 10,000 agent API calls with per-call PDAs has burned somewhere between 9 and 20 SOL in rent before a single dollar of revenue lands. That is not a product; it is a money furnace dressed up as a protocol.

The shoestring pattern inverts the assumption. State lives on-chain only when it is mutable, contested, or must be enforced by a program. Everything else is an event log, a hash commitment, a compressed leaf, or simply an off-chain record. An agent system that batches 10,000 receipts into a Merkle root checkpointed once per epoch burns roughly 0.002 SOL total for that same workload — a 4,500x improvement. This document encodes the 12 rules that produce that outcome.

---

## State Tier Router

Every object in the system must be assigned a tier before any account is created. The default answer is always the cheapest tier that satisfies security requirements.

| Object Type | Tier | Why | Est. Cost |
|---|---|---|---|
| API call receipt | CompressedLeaf | Read-only proof, bulk volume | ~0.000001 SOL/receipt |
| User signup event | OffChainOnly | No on-chain enforcement needed | 0 SOL |
| Nullifier shard header | TinyPdaHeader | Mutable bitset root, enforced | ~0.00089 SOL (once) |
| Agent balance commitment | CompressedLeaf / commitment | Off-chain balance, on-chain root | ~0.000001 SOL |
| Vault (shared pool) | TokenAccount | SPL token account, required | ~0.002 SOL (once) |
| Epoch receipt checkpoint | TinyPdaHeader | 78 bytes, just hashes | ~0.00089 SOL/epoch |
| Per-user token account | FullAccount | **FORBIDDEN** unless absolutely required | ~0.002 SOL — avoid |
| Scratch session | RentReclaimingScratch | Ephemeral, closed at expires_at_slot | ~0.00089 SOL, returned |
| Shape pool descriptor | TinyPdaHeader | ALT references only | ~0.00089 SOL (once) |
| Compute coupon | OffChainOnly / EventOnly | Relayer-side verification | 0 SOL |

**Tier definitions:**

- **OffChainOnly** — never touches the chain. Stored in Postgres or local state. Use for events and logs.
- **EventOnly** — emitted as a program log or CPI event. Indexed off-chain. No account.
- **CompressedLeaf** — added to a concurrent Merkle tree via spl-account-compression. Proven by inclusion proof.
- **TinyPdaHeader** — on-chain PDA, ≤128 bytes, stores only hashes and roots. No blob data.
- **TokenAccount** — standard SPL token account. Only when actual SPL custody is required.
- **FullAccount (FORBIDDEN)** — >128 bytes of structured data on-chain. Requires explicit architectural sign-off.

---

## Rule 1: Program Size Budget

Every SBF binary has a size budget. Exceeding it burns deploy SOL and risks hitting the 10 MB loader limit.

**The problem with one fat Anchor monster:** A single Anchor program that handles receipts, nullifiers, vaults, and agent logic easily reaches 800 KB–2 MB compiled. At ~0.00288 SOL/KB, a 1 MB program costs ~2.95 SOL to deploy. That is unacceptable for an experimental system. Anchor's macros generate substantial boilerplate: IDL serialization, account validation, error enum expansion, and discriminator matching all bloat the binary.

**The micro-program pattern:**

```
dark_lite_core         ≤ 150 KB    (~0.43 SOL)   vault + auth only
dark_receipts          ≤ 200 KB    (~0.58 SOL)   checkpoint + compression
dark_nullifier_banks   ≤ 200 KB    (~0.58 SOL)   nullifier shard headers
dark_chaff             ≤ 150 KB    (~0.43 SOL)   scratch + cleanup bounties
```

Total deploy cost target: **≤ 2.0 SOL** for all programs combined.

**SBF size gate:** The CI script `scripts/check-sbf-size.mjs` enforces these budgets automatically. Any program exceeding its KB budget fails the build. Use Pinocchio (not Anchor) for programs where the binary budget is tight. Pinocchio programs can compile to under 50 KB for simple logic.

**What to cut first:**
- Remove unused Anchor features (`#[account(mut)]` guards that are logic-level, not security-level)
- Avoid `msg!()` format strings in hot paths — each format arg adds ~100 bytes
- Split large instruction sets into separate programs with CPI calls
- Use `no_std` where possible in inner crates

---

## Rule 2: Receipts Are Not Accounts

The single most common rent-bloat mistake in Solana payment systems is creating one PDA per receipt.

**The wrong pattern:**
```
// FORBIDDEN
#[account]
pub struct Receipt {
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub nonce: [u8; 32],
}
// Creating this for every API call = ~0.00134 SOL per call
```

At 10,000 calls per day, this pattern burns ~13.4 SOL/day in rent — assuming accounts are never closed.

**The shoestring pattern:**

A receipt is a cryptographic note, not an account. It is a struct that exists off-chain, gets hashed, and its hash becomes a leaf in an epoch Merkle tree. The tree root is checkpointed on-chain in a TinyPdaHeader at epoch close.

```
ReceiptNote {
    payer_commitment: [u8; 32],   // hash(payer_pubkey || nonce)
    payee_hash:       [u8; 32],   // hash(payee_pubkey)
    amount:           u64,
    epoch:            u32,
    nonce:            [u8; 16],
}
```

The leaf = `hash(receipt_note)`. 10,000 receipts = 10,000 leaves = one 32-byte root stored in one 78-byte TinyPdaHeader costing ~0.00089 SOL. The 10,000x volume is handled off-chain by the `receipt-rollup-lite` crate.

**Proving a receipt:** The payer holds an inclusion proof (Merkle path) against the checkpoint root. This is sufficient to prove payment without any per-receipt account.

---

## Rule 3: Account Compression First

When on-chain state is required but read-mostly, use spl-account-compression (concurrent Merkle trees) instead of normal PDAs.

**Cost comparison for 1,000 user balance commitments:**

| Approach | Cost |
|---|---|
| 1,000 normal PDAs (78 bytes each) | ~0.89 SOL |
| 1 compressed tree with 1,000 leaves | ~0.01 SOL |
| Savings | ~98.9% |

**When to use compressed leaves:**
- Balance commitments that are updated infrequently
- Receipt archives (post-epoch)
- Agent permission grants (read-only after mint)
- Historical nullifier snapshots

**When compressed leaves are wrong:**
- State that must be modified atomically within a single transaction (use scratch account instead)
- State that needs CPI write access (compressed trees require proofs, not direct writes)

The `state-tier-router` crate provides `StateDecision::choose()` which encodes this logic and returns the recommended tier given mutation frequency and proof requirements.

---

## Rule 4: Rent-Reclaiming Scratch Accounts

Some operations require ephemeral mutable state — a lock, a batch accumulator, a session token. These should never become permanent accounts.

**Scratch account anatomy:**

```rust
pub struct ScratchAccount {
    pub discriminator:   [u8; 8],
    pub expires_at_slot: u64,      // enforced by program
    pub close_authority: Pubkey,   // who can close and claim lamports
    pub payload_hash:    [u8; 32], // what this scratch holds
    pub bump:            u8,
}
// Total: 8 + 8 + 32 + 32 + 1 = 81 bytes → ~0.00089 SOL rent
```

**Lifecycle:**
1. Created at session start with `expires_at_slot = current_slot + SESSION_SLOTS`
2. Program rejects any instruction referencing an expired scratch
3. After expiry, any caller can invoke `close_scratch(accounts)` and receive the rent lamports as a cleanup bounty
4. The `useful-chaff-planner` crate (Rule 8) schedules these closes automatically

**Cleanup bounty mechanics:** The program transfers the full rent (minus a small protocol fee) to whoever closes the expired scratch. This creates economic pressure to clean state — janitors compete to close stale accounts, keeping the chain tidy at zero cost to the protocol.

---

## Rule 5: Events as Database

Non-enforced state — anything the chain does not need to validate — should be emitted as a program log and indexed off-chain.

**What belongs in event logs:**
- User signup metadata (name, contact, preferences)
- Agent action history (what the agent did, when, with what params)
- Error context and debug traces
- Fee distribution records (after the math is already enforced on-chain)
- Reputation signals and behavioral scores

**The indexer contract:** The off-chain Postgres indexer (x402 server) subscribes to program logs via `getProgramAccounts` polling or a Geyser plugin. Events are parsed and stored in structured tables. The on-chain footprint is zero.

**What is forbidden in event-only data:** Do not attempt to prove event-only data with on-chain proofs. If you need provability, elevate the object to CompressedLeaf tier and generate an inclusion proof. Events are convenience records, not cryptographic commitments.

---

## Rule 6: Tiny Account Headers + Off-Chain Blobs

When a PDA is required, it stores only hashes — never raw blobs, strings, or variable-length data.

**AgentHeader pattern (64 bytes on-chain):**

```rust
pub struct AgentHeader {
    pub discriminator:    [u8; 8],
    pub agent_id_hash:    [u8; 32],  // hash(agent_pubkey || salt)
    pub config_root:      [u8; 32],  // Merkle root of off-chain config blob
    pub balance_root:     [u8; 32],  // Merkle root of virtual balance state
    pub nonce:            u64,
    pub bump:             u8,
}
// Total: 8 + 32 + 32 + 32 + 8 + 1 = 113 bytes → ~0.00134 SOL
```

The actual agent configuration (endpoint URLs, rate limits, permission scopes, metadata) lives in a content-addressed blob store (IPFS or a pinned Arweave entry). The `config_root` on-chain commits to it cryptographically.

**Updating the header:** When config changes, compute the new Merkle root off-chain, submit one transaction to update `config_root`. The transaction is ~200 bytes. The blob never touches the chain.

**Storage cost comparison for 1 KB config blob:**

| Approach | Cost |
|---|---|
| Store full 1 KB on-chain | ~0.0088 SOL |
| Store 32-byte root + blob off-chain | ~0.00134 SOL |
| Savings | ~85% |

---

## Rule 7: Lazy Materialization

Do not create any on-chain account until the user actually needs mutable on-chain state.

**The wrong pattern (eager):**
```
user connects wallet → create AgentHeader PDA → create NullifierShard PDA → ...
// Burns ~0.004 SOL before user does anything
```

**The shoestring pattern (lazy):**
```
user connects wallet → nothing happens on-chain
user tops up vault  → vault state updated (shared account, already exists)
user requests first agent action → still nothing on-chain
first epoch close   → TinyPdaHeader checkpoint created (first real spend)
```

**Lazy materialization gates:**
- `AgentHeader` PDA: created only on first epoch checkpoint
- `NullifierShardHeader` PDAs: created only when the first nullifier for that shard is inserted
- Scratch accounts: created only when a session requiring atomic state is opened

This defers the rent cost until the user has demonstrated actual value. A user who connects but never transacts costs zero on-chain SOL.

---

## Rule 8: Batch Settlement Sessions

Per-call on-chain settlement is the worst possible design. Every API call that triggers a transaction costs: slot time, a signature fee (~0.000005 SOL), and any account rent.

**The batch model:**

```
Session start:   user tops up shared vault (1 tx, once)
During session:  N receipt notes created off-chain (0 txs)
Epoch close:     1 checkpoint tx bundles all N receipts into a root
Nullifier batch: M non-conflicting nullifier inserts in 1 tx via lock-scheduler
```

For N=1,000 receipts in an epoch, the on-chain cost is ~2 transactions total regardless of N.

**Epoch sizing:** The epoch length is a tunable parameter. Shorter epochs (1 hour) give faster finality for proofs. Longer epochs (24 hours) reduce checkpoint overhead. Default: 6-hour epochs.

**Checkpoint transaction structure:**

```
Instructions:
  1. verify_epoch_root(tree_id, new_root, receipt_count)
  2. update_nullifier_shard(shard_id, batch_ops[])
  3. emit EpochClosed { epoch_id, root, count, timestamp }
```

This is one transaction, one signature fee, one lamport for the log.

---

## Rule 9: Minimal Program Split (Not Anchor Monster)

Programs are split by mutation domain, not by feature. The rule: a program that only needs to write to one account type should never be in the same binary as a program that writes to a different account type.

**The four micro-programs:**

| Program | Responsibility | Max Size |
|---|---|---|
| `dark_lite_core` | Vault auth, deposit/withdraw gates | 150 KB |
| `dark_compressed_receipts` | Epoch checkpoints, receipt tree ops | 200 KB |
| `dark_nullifier_banks` | Nullifier shard headers, insert/verify | 200 KB |
| `dark_chaff` | Scratch lifecycle, cleanup bounties | 150 KB |

**What is forbidden:** A program that reads from nullifier shards AND writes receipts AND manages vaults. That is an Anchor monster. The blast radius of a bug in one domain must not compromise another.

**CPI boundaries:** Programs talk to each other via CPI only when security requires it. Most cross-program communication is off-chain: build a transaction client-side that calls multiple programs in one transaction without any CPI.

---

## Rule 10: Rent Blast Radius Before Merge

Every pull request that introduces new account types or modifies existing account sizes must include a rent blast radius table in the PR description.

**Required fields:**

```
## Rent Blast Radius

| Metric | Value |
|---|---|
| naive_sol | X.XXXX SOL (if we used full accounts) |
| shoestring_sol | X.XXXX SOL (with this PR's approach) |
| savings_sol | X.XXXX SOL |
| accounts_avoided | N |
| new_on_chain_accounts | N (with size breakdown) |
| deploy_delta_sol | X.XXXX SOL (program size change) |
```

PRs that add new FullAccount types without justification are blocked. PRs that decrease accounts_on_chain are celebrated.

The `scripts/check-sbf-size.mjs` script enforces the program size side of this. The rent math is computed manually using the `rent-blast-radius` crate's `estimate()` function.

---

## Shoestring Crate Inventory

New crates added under `crates/` to support shoestring architecture:

| Crate | Purpose | Status |
|---|---|---|
| `state-tier-router` | `StateDecision::choose()` — routes any object to the correct tier | Building |
| `rent-blast-radius` | `estimate(bytes, count)` — computes SOL cost for account sets | Building |
| `receipt-rollup-lite` | Off-chain receipt tree, epoch root generation, proof generation | Building |
| `dark-macaroons` | Spending macaroons with caveats — no-custody agent wallets | Building |
| `ghost-spl-ledger` | Virtual SPL balance commitments without real token accounts | Building |
| `lock-scheduler` | Batches non-conflicting nullifier inserts, avoids account contention | Building |
| `shape-pool` | ALT shape mixer — all settlement txs use canonical ReceiptSpend shape | Building |
| `compute-coupon` | Relayer compute futures — issue/redeem at capped CU price | Building |
| `useful-chaff-planner` | Plans scratch account close operations, schedules cleanup bounty calls | Building |
| `intent-capsule` | Proof-carrying UI intent capsules — commit-reveal for agent actions | Building |

---

## Launch Under 1 SOL Target

For the experimental devnet / early mainnet launch, total on-chain cost must stay under 1 SOL.

**What goes on-chain (≤ 1 SOL budget):**

- Shared vault token account: ~0.002 SOL (once)
- 4 program deploys: ~2.0 SOL total — **split across epochs, not all at once**
- NullifierShardHeaders (×16 shards initially): 16 × 0.00089 = ~0.014 SOL
- EpochCheckpoint PDAs (×1 active at a time): ~0.00089 SOL
- Scratch accounts: ~0 net (rent returned on close)

**What stays off-chain:**
- All receipt notes (stored in Postgres + content-addressed store)
- User signup records
- Agent configuration blobs
- Compute coupon state
- Virtual balance ledger (ghost-spl-ledger)
- All event/log data

**What uses compression:**
- Historical receipt archives (post-epoch, 10,000+ leaves per tree)
- Agent permission grant records
- Historical balance snapshots

**The 1 SOL gate:** The `scripts/sol-burn-firewall.mjs` script enforces a hard limit on estimated SOL spend before any mainnet deploy is authorized. Set `ALLOW_MAINNET_DEPLOY=YES` and `MAX_TOTAL_RENT_SOL=0.5` to gate on rent specifically.
