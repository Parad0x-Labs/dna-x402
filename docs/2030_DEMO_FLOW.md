# 2030 Demo Flow: Private Agent Money
> No custody. No per-call on-chain fees. No wallet popups.

---

## Step 0: Prerequisites

Before running the demo, verify the environment is ready.

**Rust / Cargo:**
```bash
cargo test --workspace
# Expected: all tests pass, including crates under crates/
```

**Devnet SOL:**
```bash
solana balance --url devnet
# Must show at least 3 SOL for program deploys + demo transactions
# If not: solana airdrop 2 --url devnet
```

**Node.js scripts (optional, for size checks):**
```bash
node scripts/check-sbf-size.mjs
# Expected: all programs within KB budget
```

**Environment:**
```bash
export SOLANA_CLUSTER=devnet
export ALLOW_MAINNET_DEPLOY=NO   # keep off for demo — devnet only
```

**What you do NOT need:**
- A browser wallet extension
- A per-user token account (no USDC ATA required — ghost SPL handles this)
- Any per-call transaction signing by the user

---

## Step 1: User Tops Up

The user makes one deposit transaction. This is the only wallet interaction in the entire demo.

**What happens:**
- User approves a single USDC transfer from their wallet to the shared vault
- The vault is a standard SPL token account owned by `dark_lite_core`
- The amount deposited becomes the user's off-chain virtual balance

**Transaction structure:**
```
Instructions:
  1. spl_token::transfer(user_ata → vault, amount)
  2. dark_lite_core::record_deposit(payer_hash, amount, salt)
     → emits: DepositEvent { payer_hash, amount, slot }
```

**On-chain result:**
- Vault balance increases by `amount`
- One event log emitted (not an account)
- Zero new accounts created

**Off-chain result:**
- `ghost-spl-ledger` creates a `VirtualBalance` commitment for this user
- Balance is signed by the ledger authority and stored in Postgres

**SOL cost:** ~0.000005 SOL (signature fee only — vault account already exists)

---

## Step 2: Ghost SPL Balance Created

Immediately after the deposit event is indexed, the off-chain ledger materializes the user's virtual balance.

**Off-chain computation (`crates/ghost-spl-ledger`):**
```rust
let salt = generate_salt();   // random 32 bytes, stored by user
let balance = create_virtual_balance(
    &user_pubkey,
    &USDC_MINT,
    &salt,
);
// balance.owner_hash = hash(user_pubkey || salt)
// balance.balance    = deposit_amount
// balance.nonce      = 0
// balance.signature  = ledger_authority.sign(hash(balance))
```

**What the chain sees:** Nothing. No new account. No transaction.

**What the user holds:** A `VirtualBalance` struct and the `salt` value. Together these prove ownership and balance. The ledger authority's signature makes the balance enforceable against the vault.

**Privacy property:** The chain only sees `payer_hash` (a blinded identifier). It does not see the user's pubkey in the deposit event — only the vault receives the real pubkey for SPL transfer purposes, and that is the standard SPL token program's business.

---

## Step 3: User Mints Caveated Agent Macaroon

The user delegates spending authority to the agent, with hard limits.

**Off-chain computation (`crates/dark-macaroons`):**
```rust
let root_key = user_root_key();   // stored locally, never transmitted

let token = mint(&root_key, vec![
    Caveat::MaxAmount(500_000),          // agent can spend max 500,000 lamports
    Caveat::ScopeHash(api_scope_hash),   // only for this API endpoint
    Caveat::ExpiresAtSlot(current_slot + 54_000),  // valid ~6 hours
    Caveat::NoWithdraw,                  // agent cannot initiate withdrawals
    Caveat::RequireReceiptNote,          // every spend must produce a receipt
]);
```

**The agent receives:** The `Macaroon` token. It cannot derive the root key from it. It can attenuate it further (add more restrictive caveats) but cannot expand it.

**What happens if the agent is compromised:** The attacker has a token that:
- Cannot spend more than 500,000 lamports total
- Cannot spend on other endpoints
- Expires in ~6 hours
- Cannot withdraw anything
- Leaves a receipt trail for every spend

**What the chain sees:** Nothing. The macaroon is a local cryptographic object.

---

## Step 4: Agent Buys API Call Using Receipt Note

The agent makes an API call and records it as a receipt note. No transaction occurs.

**Off-chain computation (`crates/receipt-rollup-lite`):**
```rust
// Agent verifies its own token before spending
let ctx = SpendContext {
    amount: 1_000,       // 1,000 lamports for this call
    scope: api_scope_hash,
    slot: current_slot,
};
verify(&token, &root_key_commitment, &ctx)?;

// Create the receipt note
let note = ReceiptNote {
    payer_commitment: token.root_key_id,
    payee_hash: hash(api_provider_pubkey),
    amount: 1_000,
    epoch: current_epoch,
    nonce: random_nonce(),
};
add_receipt(&mut epoch_tree, note);
```

**What the chain sees:** Nothing. The receipt exists only in memory and Postgres.

**The user's virtual balance:** Debited by 1,000 lamports in the off-chain ledger. The `VirtualBalance.nonce` increments and the ledger authority re-signs.

**Scalability:** This step costs zero SOL regardless of how many times it runs. 10,000 API calls = 10,000 receipt notes = zero transactions.

---

## Step 5: Receipt Enters Rollup Root

As each receipt note is added, the epoch tree root evolves.

**Off-chain computation (`crates/receipt-rollup-lite`):**
```rust
let leaf = hash(note);          // deterministic: hash(ReceiptNote fields)
epoch_tree.leaves.push(leaf);
let new_root = compute_root(&epoch_tree);  // recompute Merkle root
```

**The user's proof:** At any point, the user can call `prove_inclusion(&epoch_tree, leaf_index)` to get a Merkle path. This path proves their specific receipt exists in the current epoch tree.

**The epoch tree is not on-chain yet.** It lives in memory and Postgres. The root is checkpointed at epoch close (Step 6's outcome, triggered by Step 7).

**Proof validity window:** Inclusion proofs are valid against the checkpoint root once the epoch closes. Before that, they are valid against the in-memory root — useful for real-time auditing by the user's own client.

---

## Step 6: Lock Scheduler Batches Settlement

At epoch close, the lock scheduler plans the checkpoint transaction to avoid shard contention.

**Off-chain computation (`crates/lock-scheduler`):**
```rust
// Collect all nullifier inserts for this epoch
let ops: Vec<NullifierInsert> = collect_epoch_nullifiers();

// Schedule into non-conflicting slot windows
let schedule = schedule(ops, current_slot);

// Validate no two ops in the same window hit the same shard
for window in &schedule.slots {
    assert!(validate_no_conflicts(window));
}
```

**Result:** A `LockSchedule` containing slot windows, each window containing nullifier inserts that write to non-overlapping shards. No retries needed — conflicts are eliminated before submission.

**For the demo:** With a small epoch (< 256 unique nullifier shards touched), the entire epoch's nullifier batch fits in one slot window, one transaction.

---

## Step 7: Shape Pool Builds Camouflaged Transaction

The checkpoint transaction is built using the canonical `ReceiptSpend` shape from the shape pool.

**Off-chain computation (`crates/shape-pool`):**
```rust
let shape = CanonicalShape {
    program_id:      ALT_INDEX_DARK_RECEIPTS,
    vault:           ALT_INDEX_VAULT,
    nullifier_shard: ALT_INDEX_SHARD_0,
    receipt_tree:    ALT_INDEX_TREE_0,
};

let tx = build_receipt_spend_tx(&pool, &shape, &SpendData {
    epoch_id:       current_epoch,
    receipt_root:   compute_root(&epoch_tree),
    receipt_count:  epoch_tree.leaves.len() as u32,
    nullifier_ops:  schedule.slots[0].ops.clone(),
});
```

**What the chain sees:**
- A transaction using the canonical ALT
- Account indices in the standard ReceiptSpend positions
- Instruction data containing the epoch root and nullifier batch
- Structurally identical to every other settlement transaction in the system

**The camouflage property:** An observer watching the chain sees a stream of identical-shaped transactions. They cannot tell from structure alone which epochs contain which users' receipts.

---

## Step 8: Compute Coupon Pays Relayer

The relayer who submits the checkpoint transaction is compensated via a compute coupon.

**Coupon issuance (pre-epoch, by vault authority, `crates/compute-coupon`):**
```rust
let coupon = issue(
    &relayer_keypair,
    RECEIPT_SPEND_CLASS_HASH,    // only valid for ReceiptSpend transactions
    5_000,                       // max 5,000 microlamports per CU
    54_000,                      // valid for ~6 hours
);
```

**Redemption (post-transaction, by relayer):**
```rust
let claim = redeem(&coupon, actual_cu_used, &vault_pubkey);
// Claim is presented to vault at next settlement batch
// Vault pays: min(5_000, actual_cu_price) × actual_cu_used microlamports
```

**Demo shortcut:** For the devnet demo, the relayer is the same keypair as the checkpointer. The coupon flow is demonstrated as a unit test:

```bash
cargo test -p compute-coupon -- relayer_coupon_roundtrip
```

**What this solves:** Relayers do not need to trust that they will be reimbursed in the same transaction. The coupon is an off-chain promise backed by the vault balance. The async reimbursement model allows batching relayer payments too.

---

## Step 9: Useful Chaff Closes Expired Scratch Accounts

Between epoch settlements, the useful-chaff-planner identifies and closes any expired scratch accounts.

**Off-chain computation (`crates/useful-chaff-planner`):**
```rust
let known_scratches = fetch_scratch_accounts_from_db();
let plan = plan(known_scratches, current_slot);

if is_profitable(&plan, current_cu_price) {
    println!("Closing {} expired scratch accounts, reclaiming {} lamports",
        plan.ops.len(), plan.total_reclaim);
    submit_maintenance_batch(&plan);
}
```

**On-chain result:**
```
Instructions per maintenance tx:
  1. dark_chaff::close_expired_scratch(scratch_account_1)
     → transfers lamports to tx fee payer (the janitor)
  2. dark_chaff::close_expired_scratch(scratch_account_2)
  ...up to 10 closes per tx (CU budget permitting)
```

**Who runs this:** Any party — the protocol team, a third-party janitor bot, or the relayer itself. The cleanup bounty (rent refund) compensates the janitor automatically.

**For the demo:** Run the planner manually:
```bash
cargo test -p useful-chaff-planner -- plan_selects_expired
```

---

## Step 10: Public Dashboard Shows Only Roots/Hashes

The demo concludes with a view of what is actually on-chain after the full flow.

**Accounts on-chain (after full epoch cycle):**

| Account | Type | Contents | Size |
|---|---|---|---|
| Shared USDC Vault | SPL TokenAccount | Vault balance | ~165 bytes |
| ReceiptCheckpoint (epoch N) | TinyPdaHeader | `epoch_id, root, receipt_count, closed_at_slot` | 78 bytes |
| NullifierShardHeader[0] | TinyPdaHeader | `shard_id, bitset_root, insert_count` | 78 bytes |
| NullifierShardHeader[1] | TinyPdaHeader | same structure | 78 bytes |
| Program accounts (×4) | Programs | SBF bytecode | ~800 KB total |

**What is NOT on-chain:**
- User identities or pubkeys
- Per-call receipt accounts
- Per-user token accounts
- Agent configuration blobs
- Virtual balance structs
- Compute coupons
- Macaroon tokens
- Intent capsules

**The chain shows:** Epoch roots and nullifier shard headers. An observer can verify that some number of receipts were processed in an epoch and some number of nullifiers were inserted. They cannot reconstruct who paid whom, for what, or how much per individual call.

---

## What The Chain Sees

| Slot | Event | On-Chain Data |
|---|---|---|
| Epoch start | Nothing | No change |
| During epoch | API calls × N | No change |
| Epoch close | Checkpoint tx | `ReceiptCheckpoint.root` updated |
| Epoch close | Nullifier batch | `NullifierShardHeader.bitset_root` updated |
| Maintenance | Scratch closes | Expired scratch accounts removed |
| Anytime | Deposit | Vault balance increased, event log emitted |

**The invariant:** The chain holds commitments, not content. Every user-identifiable datum lives off-chain, behind the off-chain indexer's auth layer.

---

## Running the Demo Locally

```bash
# Step 0: verify all tests pass
cargo test --workspace

# Expected output includes:
# test dark_macaroons::tests::agent_cannot_exceed_max_amount ... ok
# test receipt_rollup_lite::tests::ten_thousand_receipts_one_root ... ok
# test ghost_spl_ledger::tests::virtual_balance_roundtrip ... ok
# test lock_scheduler::tests::no_shard_conflicts_in_window ... ok
# test shape_pool::tests::canonical_shape_deterministic ... ok
# test compute_coupon::tests::relayer_coupon_roundtrip ... ok
# test useful_chaff_planner::tests::plan_selects_expired ... ok
# test intent_capsule::tests::verify_transaction_matches_intent ... ok
# ... 70+ tests pass

# Step 1: check SBF size budgets (requires cargo build-sbf first)
# cargo build-sbf  # builds Solana programs
node scripts/check-sbf-size.mjs

# Step 2: check SOL burn estimate
MAX_DEPLOY_SOL=2.0 MAX_TOTAL_RENT_SOL=0.5 node scripts/sol-burn-firewall.mjs

# Step 3: verify no overblown claims in docs
node scripts/check-2030-claims.mjs
```

**What a passing run looks like:**
```
Running 73 tests across 10 crates
...
test result: ok. 73 passed; 0 failed; 0 ignored

SBF binaries in target/deploy:
  dark_nullifier_banks.so: 187.4 KB | ~0.5397 SOL | OK
  dark_compressed_receipts.so: 192.1 KB | ~0.5532 SOL | OK
  dark_chaff.so: 141.8 KB | ~0.4084 SOL | OK

All programs within size budget.

Rent estimates:
  NullifierShardHeader (x256): 0.0327 SOL
  ReceiptCheckpoint (x1): 0.0001 SOL
  ScratchAccount typical (x10): 0.0009 SOL

SOL Burn Summary:
  Programs to deploy: ~1.5013 SOL
  Account rent (est): ~0.0337 SOL
  Total: ~1.5350 SOL

SOL burn within budget. Approved.

Scanning 85 markdown files for overblown claims...
No forbidden claims found.
```
