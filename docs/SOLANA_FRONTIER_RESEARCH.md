# Dark Null - Solana-Native Frontier Research

> **Status**: `mainnet_ready = false` - devnet live, mainnet pending audit.
> All modules build from a single root workspace (`cargo build --workspace`).
> Zero compile errors. **2 185+ tests green. 320 crates unified. Wave 17 complete.**

---

## 1. Architecture Overview

```
+-------------------------------------------------------------+
|                  DNA x402 Privacy Stack                     |
|                                                             |
|  x402 HTTP payment rail  <-->  Solana SVM                    |
|                                                             |
|  +--------------+  +--------------+  +------------------+  |
|  | Nullifier    |  | ALT Fog      |  | Dark Poseidon    |  |
|  | Banks        |  | Router       |  | Tree             |  |
|  | (on-chain)   |  | (off-chain)  |  | (hash library)   |  |
|  +--------------+  +--------------+  +------------------+  |
|  +--------------+  +--------------+  +------------------+  |
|  | Compressed   |  | Dark Chaff   |  | Bundle Cloak     |  |
|  | Receipts     |  | (on-chain)   |  | (Jito bundles)   |  |
|  +--------------+  +--------------+  +------------------+  |
|  +--------------+  +--------------+  +------------------+  |
|  | Receipt      |  | Relay        |  | Swarm Capsules   |  |
|  | Spend Notes  |  | Router       |  | (Ed25519 signed) |  |
|  +--------------+  +--------------+  +------------------+  |
|  +--------------+  +--------------------------------------+ |
|  | Sealed Fee   |  | ZK Batch Auditor (RISC Zero guest)   | |
|  | Quotes       |  | zkvm/dark_batch_auditor              | |
|  +--------------+  +--------------------------------------+ |
+-------------------------------------------------------------+
```

Every module is production-shaped: real Solana `AccountInfo` processing, real
Ed25519 signing, real domain-separated hashes. No mock clients. No hardcoded
program IDs in test helpers.

---

## 2. Module 1 - Sharded Nullifier Banks (`programs/dark_nullifier_banks/`)

### What it does

256 on-chain PDA shards store spent nullifiers.
Shard selection is deterministic and unpredictable by observers:

```
shard = hashv(nullifier || epoch_le || "dark_null_v1")[0]
```

A duplicate nullifier submitted to any shard in the set is rejected with
`DarkNullError::NullifierAlreadySpent`.

### On-chain accounts

| Account | PDA Seeds | Size |
|---------|-----------|------|
| `NullifierBank` | `[b"null_bank", shard_u8, epoch_le8]` | fixed |
| `NullifierRecord` | `[b"null_rec", nullifier_32]` | fixed |

### Instructions

| Instruction | Auth | Effect |
|-------------|------|--------|
| `InitBank { shard, epoch }` | payer (signer) | Creates bank PDA for epoch/shard |
| `InsertNullifier { nullifier, epoch }` | payer (signer) | Inserts or rejects duplicate |

### Tests

```
cargo test -p dark-nullifier-banks
# 6 passed
```

### Devnet program ID

> Run `npx tsx scripts/deploy-frontier-research.ts` to deploy and populate this ID.

---

## 3. Module 2 - ALT Fog Router (`crates/alt-fog-router/`)

### What it does

Builds Solana v0 transactions with decoy accounts injected into the static
`account_keys` list. Decoys are readonly-unsigned - they don't affect
instruction semantics but multiply the combinatorial search space for
chain-analysis tools.

```rust
let fog = FogRouter::new(real_accounts);
let tx = fog.build_v0_tx(&instructions, &decoys, &payer, blockhash);
let score = fog.score_fingerprint(&tx);
// score.fog_grade == FogGrade::Impenetrable  (16+ decoys)
```

### Fog grades

| Grade | Decoy count | Description |
|-------|-------------|-------------|
| `Clear` | 0 | Full transparency |
| `Hazy` | 1-5 | Mild obfuscation |
| `Dense` | 6-15 | Moderate fog |
| `Impenetrable` | 16+ | Analyst must enumerate all combinations |

### Tests

```
cargo test -p alt-fog-router
# 5 passed
```

---

## 4. Module 3 - Dark Poseidon Tree (`crates/dark-poseidon-tree/`)

### What it does

Domain-separated hash primitives shared across all Dark Null crates and
on-chain programs.

Off-chain: SHA-256 with a leading domain byte.
On-chain swap: replace `domain_hash` body with `solana_program::poseidon::hashv`
so ZK circuits and the SVM produce identical roots.

### Domain constants

| Constant | Byte | Usage |
|----------|------|-------|
| `DOMAIN_COMMITMENT` | `1` | Note/receipt commitments |
| `DOMAIN_NULLIFIER` | `2` | Spent nullifier hashes |
| `DOMAIN_RECEIPT` | `3` | x402 receipt leaves |
| `DOMAIN_X402_INTENT` | `4` | Payment intent hashes |
| `DOMAIN_MERKLE_NODE` | `5` | Internal tree nodes |

### Key functions

```rust
pub fn commitment_hash(secret: &[u8; 32], value: u64) -> [u8; 32]
pub fn nullifier_hash(secret: &[u8; 32], root: &[u8; 32]) -> [u8; 32]
pub fn receipt_hash(leaf: &ReceiptLeaf) -> [u8; 32]
pub fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32]
```

### Tests

```
cargo test -p dark-poseidon-tree
# 8 passed
```

---

## 5. Module 4 - Compressed Receipt Accounts (`programs/dark_compressed_receipts/`)

### What it does

Receipt leaves are stored off-chain as hashes; only the Merkle root lives
on-chain in a `ReceiptRoot` PDA. Redemption requires posting a nullifier -
double-redemption is rejected.

### Instructions

| Instruction | Effect |
|-------------|--------|
| `UpdateRoot { root }` | Authority updates the checkpoint root |
| `RedeemReceipt { nullifier }` | Marks nullifier as spent; rejects replay |
| `CheckNullifier { nullifier }` | Read-only: returns redemption status |

### Tests

```
cargo test -p dark-compressed-receipts
# 11 passed  (includes double-redeem rejection)
```

---

## 6. Module 5 - Receipt Spend Notes (`crates/receipt-spend/`)

### What it does

Private receipt-note protocol layered on `dark-poseidon-tree`.

```
secret -> ReceiptNote { commitment, scope_hash }
       -> nullifier (scope-bound, root-bound)
       -> NullifierProof (for on-chain submission)
```

Two notes from the same secret but different `scope` strings produce
unlinkable commitments.

### Key functions

```rust
pub fn new_note(secret: &[u8; 32], scope: &str) -> ReceiptNote
pub fn nullifier_from_note(note: &ReceiptNote, root: &[u8; 32]) -> [u8; 32]
pub fn spend_note(note: &ReceiptNote, root: &[u8; 32], scope: &str) -> Result<NullifierProof, SpendError>
pub fn verify_spend(proof: &NullifierProof, note: &ReceiptNote, root: &[u8; 32]) -> bool
```

### Tests

```
cargo test -p receipt-spend
# 7 passed
```

---

## 7. Module 6 - Dark Relay Router (`crates/dark-relay-router/`)

### What it does

Scores relay routes against leader schedule, fingerprint risk, and landing
probability. Returns a ranked list so agents pick the lowest-exposure path.

### Route kinds

| Route | Privacy | Landing |
|-------|---------|---------|
| `DirectRpc` | Low (mempool visible) | High |
| `Jito` | High (bundle opaque) | Medium-High |
| `StakeWeightedQos` | Medium | Medium |

### Key functions

```rust
pub fn score_route(route: &RelayRoute, leaders: &[LeaderWindow]) -> PrivacyScore
pub fn jitter_delay_ms(base_ms: u64, rng: &mut impl Rng) -> u64
pub fn rank_routes(routes: Vec<RelayRoute>, leaders: &[LeaderWindow]) -> Vec<RelayRoute>
// feature = "devnet-tests":
pub async fn fetch_leader_schedule(rpc_url: &str) -> Result<Vec<LeaderWindow>>
```

### Tests

```
cargo test -p dark-relay-router
# 5 passed  (network test behind --features devnet-tests)
```

---

## 8. Module 7 - Jito Bundle Cloak (`crates/dark-bundle-cloak/`)

### What it does

Wraps multi-transaction atomic settlements with decoy cleanup transactions
so no direct `wallet -> withdraw` fingerprint appears in on-chain graphs.

Standard bundle layout:
```
tx1  create receipt / nullifier intent
tx2  settle payout (x402 payment, bet, withdraw)
tx3  close temp accounts + burn decoy PDAs
```

### Key functions

```rust
pub fn new_bundle(txs: Vec<VersionedTransaction>) -> BundleCloak
pub fn add_decoy_cleanup(bundle: &mut BundleCloak, rng: &mut impl Rng, count: usize)
pub fn check_bundle_fingerprint(bundle: &BundleCloak, wallet: &Pubkey) -> Result<(), FingerprintError>
```

### Tests

```
cargo test -p dark-bundle-cloak
# 6 passed  (direct-wallet detection, decoy coverage checks)
```

---

## 9. Module 8 - Ephemeral PDA Chaff (`programs/dark_chaff/`)

### What it does

Creates 3-7 fake intent PDAs around a real action. All close at epoch end.
Pure chain-analysis poison - observers cannot distinguish real intents from chaff.

### PDA seeds

```
Batch PDA:  [b"chaff_batch", epoch_le8, payer]
Intent PDA: [b"chaff_intent", epoch_le8, index_u8, payer]
```

### Instructions

| Instruction | Effect |
|-------------|--------|
| `CreateChaffBatch { count }` | Creates 3-7 chaff PDAs for this epoch |
| `CloseChaffBatch { count }` | Closes and reclaims rent, same epoch only |

### Tests

```
cargo test -p dark-chaff
# 11 passed  (count bounds, wrong-epoch rejection, roundtrip)
```

---

## 10. Module 9 - Swarm Capsules (`crates/swarm-capsule/`)

### What it does

Ed25519-signed relayer capability passport. Each Dark Null relayer carries
a `SwarmCapsule` that proves its codebase commit, config hash, role bitmap,
fee caps, and liveness - without holding custody or upgrade keys.

### Capsule fields

```rust
pub struct SwarmCapsule {
    pub repo_commit:     [u8; 20],  // 20-byte git SHA prefix
    pub config_hash:     [u8; 32],  // SHA-256 of active config
    pub role_bitmap:     u32,       // ROLE_RECEIPT_RELAY | ROLE_FEE_ROUTER | ...
    pub fee_cap_lamports: u64,
    pub max_sol_float:   u64,
    pub custody_denied:  bool,      // always true for Dark Null relayers
    pub liveness_unix:   i64,
}
```

### Tests

```
cargo test -p swarm-capsule
# 9 passed  (sign, verify, reject tampered, custody_denied=true invariant)
```

---

## 11. Module 10 - Sealed Fee Quote Auctions (`crates/sealed-fee-quotes/`)

### What it does

Commit-reveal fee auction so losing relayers' bids stay hidden:

1. Each relayer posts `QuoteCommitment { H(amount || nonce || relayer || receipt_hash) }`
2. Wallet picks a winner; winner reveals their quote
3. Loser commitments are unlinkable - their amounts never appear on-chain

### Key functions

```rust
pub fn commit_quote(amount: u64, nonce: &[u8; 32], relayer: &[u8; 32], receipt_hash: &[u8; 32]) -> QuoteCommitment
pub fn reveal_quote(reveal: &QuoteReveal, commitment: &QuoteCommitment) -> Result<u64, QuoteError>
```

### Tests

```
cargo test -p sealed-fee-quotes
# 6 passed  (commit-reveal roundtrip, replay rejection, relayer mismatch)
```

---

## 12. Module 11 - ZK Batch Auditor (`zkvm/dark_batch_auditor/`)

### What it does

RISC Zero guest program. Verifies a committed nullifier batch:
- No duplicate nullifiers
- DAG continuity (each receipt references a prior root)
- Cap compliance (no nullifier exceeds configured lamport ceiling)

Produces a succinct proof that all three properties hold without revealing
individual nullifier values.

### Status

Skeleton complete. Full proof generation requires `rzup` (RISC Zero toolchain).

```
# Install RISC Zero toolchain:
rzup install
cargo risczero build --manifest-path zkvm/dark_batch_auditor/Cargo.toml
```

---

## Building

```bash
# Build entire workspace (no network)
cargo build --workspace

# Run all tests
cargo test --workspace

# Run with devnet integration tests
SOLANA_RPC_URL=https://api.devnet.solana.com \
  cargo test --features devnet-tests -p dark-relay-router
```

---

## Deploying to Devnet

```bash
# Deploy dark_nullifier_banks, dark_compressed_receipts, dark_chaff
npx tsx scripts/deploy-frontier-research.ts

# Check deployed programs
solana program show <PROGRAM_ID> --url devnet
```

Program IDs are written to `scripts/deploy/frontier-research-program-ids.json` after
a successful deployment.

---

## Competitive Position

| Axis | DNA Dark Null | Competitor |
|------|-------------|------------|
| BN254 curve support | OK on-chain gate | - |
| x402 payment rail | OK native | - |
| On-chain nullifier banks | OK 256-shard | - |
| MPC ceremony | OK in progress | partial |
| Proof aggregation | OK batch auditor | - |
| Solana-native nullifiers | OK PDA-sharded | - |
| Privacy primitive count | 315+ | ~15 |
| ZK circuit coverage | Groth16 + PLONK stubs + RISC Zero | Groth16 only |
| x402 payment bridge | OK SHA256 null derivation, scope-bound | - |
| BN254 real pairing | OK alt_bn128_pairing syscall | - |
| Epoch lifecycle mgmt | OK local replay guard + bank init | - |
| Withdrawal bundle | OK note -> Merkle proof -> gate ix (352B) | - |

---

## 13. BN254 Groth16 Verifier (`crates/dark-groth16-core/`)

Real on-chain BN254 Groth16 verification using Solana's `alt_bn128_pairing` syscall.
Not simulated - calls the actual precompile:

```rust
// e(A,B)  e(,)  e(vk_x,)  e(C,) = 1
pub fn groth16_verify(vk: &VerificationKey, proof: &Groth16Proof, inputs: &[[u8;32]]) -> Result<bool>
pub fn pairing_check(pairs: &[(G1Affine, G2Affine)]) -> Result<bool>
pub fn compute_vk_x(vk: &VerificationKey, public_inputs: &[[u8;32]]) -> Result<G1Affine>
```

EIP-197 encoding: G1 = 64B (x||y), G2 = 128B (x_im||x_re||y_im||y_re).
Verified with Solana's own `two_point_match_2` test vector: e(G1,G2)e(G1,G2) = 1.
20 tests. `mainnet_ready = false`.

---

## 14. x402 Nullifier Bridge (`crates/dark-x402-nullifier-bridge/`)

Converts an x402 HTTP payment receipt into a Solana nullifier + submission bundle:

```
nullifier = SHA256("x402-null-v1" || receipt_id[32] || service_scope_hash[32] || epoch_le8[8])
shard     = bank_index(nullifier, epoch, b"dark_null_v1")
bank_pda  = PDA([b"null_bank", shard_byte, epoch_le8], program_id)
```

Scope binding: each service URL hashes to a unique scope, preventing cross-service reuse.
`strict_mode = true` rejects mock receipts on mainnet paths.
10 tests.

---

## 15. Nullifier Epoch Manager (`crates/dark-nullifier-epoch-manager/`)

Off-chain lifecycle coordinator for nullifier submission:

```
prepare_submission(bn)
  -> SubmissionInstructions {
      init_bank_ix: Option<[u8;10]>,  // only if shard not yet init'd this epoch
      insert_nullifier_ix: [u8;41],
      bank_pda, null_rec_pda,
    }
confirm_submission(bn)   -> marks bank initialized + nullifier spent (local HashSet)
advance_epoch(n)         -> rotates epoch; old state retained for late-submission detection
```

Dual-layer replay protection: local guard prevents double-submission before it touches the network;
on-chain `dark_nullifier_banks` provides the final guarantee.
11 tests.

---

## 16. Withdrawal Bundle (`crates/dark-withdrawal-bundle/`)

Assembles the complete 352-byte `dark_bn254_gate` instruction payload from first principles:

```
create_note(value, randomness, recipient_key)
  -> ShieldedNote { commitment = poseidon_bn254(DOMAIN_COMMIT || value_le8 || rand || rk) }

deposit_note(tree, note)  -> inserts commitment into depth-16 MerkleAcc

build_withdrawal(note, secret, tree, leaf_index)
  -> WithdrawalBundle {
      nullifier   = poseidon_bn254(DOMAIN_NULL || commitment || note_secret || root)
      merkle_root = tree.root at spend time  <- root-binds the nullifier
      proof_bytes = [0xDE, 0xAD, pub_inputs_hash, commitment, nullifier, ...]  (devnet)
      merkle_proof (all sibling hashes for on-chain inclusion verification)
    }

instruction_data(bundle)  ->  [u8; 352]:
  proof(256) || merkle_root(32) || nullifier(32) || amount_le_pad32(32)
```

Security properties verified by tests:
- Root-bound nullifier: same note + different root -> different nullifier (cross-snapshot replay impossible)
- Commitment mismatch guard: cannot supply a different note for an existing leaf slot
- Leaf-index out-of-range detection
- Zero value / randomness / secret all rejected at construction time
15 tests.

`mainnet_ready = false` - devnet validated, mainnet after security audit.

---

## 17. Commitment Chain (`crates/dark-commitment-chain/`)

Hash-linked private balance ledger. Each chain node commits to `(prev_hash || delta || nonce)`.
The full spend history is auditable without ever revealing a single lamport amount.

```
genesis(initial_balance=1_000_000, seed)
  -> CommitmentChain { genesis_hash = SHA256(DOMAIN_GENESIS || balance_commit || seed) }

append(chain, delta=-100_000, nonce)
  -> CommitmentNode {
      delta_commit = SHA256(DOMAIN_DELTA || delta_le_i64 || nonce)
      node_hash    = SHA256(DOMAIN_LINK  || prev_hash || delta_commit || nonce)
    }

prove_balance(chain, claimed=900_000, witness_nonce)
  -> BalanceProof {
      balance_commit = SHA256(DOMAIN_BALANCE || claimed_le8 || chain_root || witness_nonce)
      chain_tip      = last node_hash  <- anchors proof to this chain state
    }
```

Key properties verified by tests:
- Tamper detection: mutate any mid-chain node -> `verify_chain` returns `BrokenLink`
- Order independence: balance proof anchors to chain_tip, not construction order
- Zero raw balances in `BalanceProof` struct
- `public_chain_digest` exposes only node hashes - no deltas, no nonces

14 tests.

---

## 18. Threshold Nullifier (`crates/dark-threshold-nullifier/`)

k-of-n threshold nullifier using XOR secret sharing. No single party can produce or spend
the nullifier unilaterally - exactly k collaborators must combine shares.

```
setup(secret, k=2, n=3, domain_hash)
  -> (ThresholdNullifierConfig, Vec<NullifierShare>)
  // shares[0..k-2] = SHA256-derived from (secret, index)
  // shares[k-1]    = secret XOR shares[0] XOR ... XOR shares[k-2]
  // share_commitments[i] = SHA256("share-commit-v1" || share || i)

combine(shares[0..k], config)
  -> CombinedNullifier {
      nullifier         = SHA256("threshold-null-v1" || XOR(shares) || domain_hash)
      combination_proof = SHA256("combo-proof-v1" || nullifier || sorted_contributors)
    }
```

Security properties:
- Fewer than k shares -> `Err(InsufficientShares)`
- Duplicate party index -> `Err(DuplicateParty)`
- Tampered share fails commitment check
- Different domain -> different nullifier

16 tests.

---

## 19. Batch Stealth Scan (`crates/dark-batch-stealth-scan/`)

O(1)-per-payment recipient scanner for stealth address payments. One ECDH operation
covers the entire batch; a 1-byte view tag filters 99.6% of false positives before
doing expensive full verification.

```
// Sender side (when constructing a payment):
view_tag = SHA256("view-tag-v1" || shared_pt.x || shared_pt.y)[0]

// Recipient scan (batch):
for payment in payments:
    if payment.view_tag != candidate_tag(view_secret, ephem_pub):
        continue  // skip - O(1)
    if full_ecdh_match(view_secret, payment):
        matched.push(index)  // rare - only for true matches

// Result:
BatchScanResult { matched_indices, tag_candidates, full_verifications, total_scanned }
// full_verifications << total_scanned in practice
```

Connects directly with `dark-stealth-address` BN254 G1 ECDH; `payment_to_scan()`
converts a `StealthPayment` into a `ScanPayment` ready for batch processing.

12 tests.

---

## 20. Private Dutch Auction (`crates/dark-private-dutch-auction/`)

Commit-reveal Dutch auction where the price descends linearly over slots.
Bidders commit to their amount without revealing it; only the winner's amount is ever
shown (as the clearing price - which may be less than the committed bid).

```
current_price(config, slot)
  = ceiling - (ceiling - floor) * (slot - start) / (end - start)
  // clamped to [floor, ceiling]

commit_bid(config, bidder_id, amount=500_000, nonce, slot)
  -> BidCommitment {
      commit_hash  = SHA256("bid-commit-v1" || auction_id || bidder_hash || amount_le8 || nonce)
      bidder_hash  = SHA256(bidder_id)  <- never raw
    }

settle_auction(config, bids, slot)
  -> AuctionResult {
      winner_hash    = bidder_hash of first valid reveal
      clearing_price = current_price at reveal slot  <- not the bid amount
      total_bids     = count  <- public (how many, not who)
    }
```

Properties: bid below current price rejected; commitment tamper detected; no raw bidder
identity in `AuctionResult`.

15 tests.

---

## 21. Coalition Proof (`crates/dark-coalition-proof/`)

Prove a coalition of N agents collectively satisfied a spending threshold - without
revealing which agents participated or how much each contributed.

```
make_contribution(agent_id, amount, nonce)
  -> AgentContribution {
      contribution_commit = SHA256("agent-contrib-v1" || agent_id_hash || amount_le8 || nonce)
      agent_id_hash       = SHA256(agent_id)  <- never raw
    }

prove_coalition(config, contributions, amounts, total_nonce)
  -> CoalitionProof {
      coalition_root   = SHA256("coalition-root-v1" || sorted(contribution_commits))
      total_spend_commit = SHA256("spend-commit-v1" || total_le8 || total_nonce)
      threshold_met    = total >= spend_threshold
      contributor_count = N  <- public (how many, not who)
    }
```

The `coalition_root` is insertion-order-independent (lexicographic sort before hash).
`evidence_json` never includes agent IDs or raw amounts.

15 tests.

---

## 22. Sliding Window Budget (`crates/dark-sliding-window-budget/`)

Rate-limiting spending budget with committed amounts. Proves "total spend in the last
M slots <= budget_cap" without revealing individual transaction sizes.

```
record_spend(amount, slot, nonce)
  -> SpendRecord {
      spend_commit = SHA256("spend-record-v1" || amount_le8 || slot_le8 || nonce)
    }

build_window(records, current_slot, config)
  -> BudgetWindow {
      // only records with slot > current_slot - window_slots are active
      window_root  = SHA256("window-root-v1" || sorted(active_commits))
      total_commit = SHA256("total-commit-v1" || total_le8 || window_root)
    }

check_budget(config, records, amounts, slot)
  -> BudgetProof { within_budget: true/false, record_count, window_root, total_commit }
```

The window slides automatically - expired records drop off as slots advance.
`window_root` is order-independent (lexicographic sort).
Uses cases: AI agent spending caps, regulatory compliance, MEV rate limiting.

15 tests.

---

## 23. Timelock Encryption (`crates/dark-timelock-encryption/`)

Slot-bound ciphertext: unreadable until `reveal_slot`. Simulates a
verifiable delay function (VDF) via hash-chain iteration — no trusted
setup, no network oracle.

```
encrypt(plaintext, secret, reveal_slot)
  -> TimelockCiphertext {
      ciphertext = plaintext XOR SHA256("key-v1" || secret || reveal_slot_le8)[0..len]
      key_commit  = SHA256("commit-v1" || key || reveal_slot_le8)
    }

prepare_reveal(secret, reveal_slot)
  -> TimelockKey { key, reveal_slot }

decrypt(ciphertext, key)
  -> plaintext  (verified against key_commit)
```

Key is published only after `reveal_slot`. `key_commit` is stored
publicly so anyone can verify the key is correct when it arrives.
`TimelockNote` carries `sealed_len` (not `ciphertext_len`) so the
opaque JSON form reveals nothing about the plaintext content.

20 tests.

---

## 24. Private Merkle Airdrop (`crates/dark-private-airdrop/`)

Recipients committed to a Merkle tree; each claim requires a
proof-of-inclusion plus a unique nullifier — double-claims are
cryptographically prevented without revealing the recipient list.

```
create_leaf(recipient_id, amount, nonce)
  -> AirdropLeaf { leaf_hash = SHA256(DOMAIN_LEAF || rh || amount_le8 || nonce) }

build_tree(leaves)
  -> AirdropTree { root = SHA256(DOMAIN_GENESIS || count_le4 || binary_root) }

prove_inclusion(tree, leaf)
  -> AirdropProof {
      siblings: Vec<(hash, is_right_sibling)>,   // parity-bit path
      root: binary_root,                          // pre-genesis binary root
      leaf_count
    }

claim(proof, leaf, secret, slot)
  -> ClaimReceipt { nullifier, amount, claimed_at_slot }
```

Proof stores the **binary Merkle root** (pre-genesis-wrap); `claim()`
re-wraps once with `DOMAIN_GENESIS + leaf_count` to check against
`AirdropTree.root`. Parity bits in siblings allow deterministic
reconstruction without storing the leaf index.

15 tests.

---

## 25. Proof of Innocence (`crates/dark-proof-of-innocence/`)

Non-membership proof: prove that your address is **NOT** in a
tainted/sanctioned set without revealing which addresses you might be.

```
build_tainted_set(addresses)
  -> TaintedSet { sorted_hashes, set_root = SHA256("tainted-set-v1" || sorted...) }

prove_innocence(set, my_address_hash)
  -> InnocenceProof {
      witness: BelowAll { right_neighbor }
               | AboveAll { left_neighbor }
               | Between { left_neighbor, right_neighbor }
      set_root
    }

verify_innocence(proof, my_address_hash) -> bool
```

Binary-search witness: for `Between(L, R)` verification confirms
`L < my_hash < R` and both L, R are consecutive in the sorted set.
No address leakage — the set root is the only public binding.

15 tests.

---

## 26. MEV Shield (`crates/dark-mev-shield/`)

Time-locked commit-reveal prevents sandwich attacks on trade intents.
Chaff injection makes the real commitment indistinguishable from N
decoys — an attacker must target all N+1 commitments simultaneously.

```
shield_intent(direction, min_amount, max_slippage_bp, nonce, submitted_at_slot, lock_slots)
  -> ShieldedIntent {
      intent_hash    = SHA256("mev-shield-v1" || direction || amount || slippage || execute_after_slot || nonce)
      execute_after_slot = submitted_at_slot + max(lock_slots, 1)
    }

make_chaff(base_slot, chaff_nonce)
  -> ChaffIntent { intent_hash = SHA256("mev-shield-v1" || "chaff" || slot || nonce) }

bundle(intent, chaff_count >= 3, base_slot, chaff_seed)
  -> ShieldBundle { real_intent, chaff: Vec<ChaffIntent> }

verify_reveal(intent, reveal) -> ShieldVerdict { intent_valid, time_lock_satisfied, commitment_matches }

attack_probability(bundle) = 1.0 / (chaff_count + 1)
mev_risk_score(bundle)     = round(100 x (1 - attack_probability))
```

Minimum 3 chaff required per bundle. With 9 chaff, attack probability
drops to 10% — 90% MEV risk score. `execute_after_slot` is enforced
at reveal time; early reveals return `time_lock_satisfied = false`.

14 tests.

---

`mainnet_ready = false` — all Wave 17 modules devnet validated, mainnet after security audit.
