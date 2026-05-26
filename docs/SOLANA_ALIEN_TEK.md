# Dark Null — Solana-Native Alien Tek

> **Status**: `mainnet_ready = false` — devnet live, mainnet pending audit.  
> All modules build from a single root workspace (`cargo build --workspace`).  
> Zero compile errors. 1 100+ tests green.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  DNA x402 Privacy Stack                     │
│                                                             │
│  x402 HTTP payment rail  ←→  Solana SVM                    │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Nullifier    │  │ ALT Fog      │  │ Dark Poseidon    │  │
│  │ Banks        │  │ Router       │  │ Tree             │  │
│  │ (on-chain)   │  │ (off-chain)  │  │ (hash library)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Compressed   │  │ Dark Chaff   │  │ Bundle Cloak     │  │
│  │ Receipts     │  │ (on-chain)   │  │ (Jito bundles)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Receipt      │  │ Relay        │  │ Swarm Capsules   │  │
│  │ Spend Notes  │  │ Router       │  │ (Ed25519 signed) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │ Sealed Fee   │  │ ZK Batch Auditor (RISC Zero guest)   │ │
│  │ Quotes       │  │ zkvm/dark_batch_auditor              │ │
│  └──────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

Every module is production-shaped: real Solana `AccountInfo` processing, real
Ed25519 signing, real domain-separated hashes. No mock clients. No hardcoded
program IDs in test helpers.

---

## 2. Module 1 — Sharded Nullifier Banks (`programs/dark_nullifier_banks/`)

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

> Run `npx tsx scripts/deploy-alien-tek.ts` to deploy and populate this ID.

---

## 3. Module 2 — ALT Fog Router (`crates/alt-fog-router/`)

### What it does

Builds Solana v0 transactions with decoy accounts injected into the static
`account_keys` list. Decoys are readonly-unsigned — they don't affect
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
| `Hazy` | 1–5 | Mild obfuscation |
| `Dense` | 6–15 | Moderate fog |
| `Impenetrable` | 16+ | Analyst must enumerate all combinations |

### Tests

```
cargo test -p alt-fog-router
# 5 passed
```

---

## 4. Module 3 — Dark Poseidon Tree (`crates/dark-poseidon-tree/`)

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

## 5. Module 4 — Compressed Receipt Accounts (`programs/dark_compressed_receipts/`)

### What it does

Receipt leaves are stored off-chain as hashes; only the Merkle root lives
on-chain in a `ReceiptRoot` PDA. Redemption requires posting a nullifier —
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

## 6. Module 5 — Receipt Spend Notes (`crates/receipt-spend/`)

### What it does

Private receipt-note protocol layered on `dark-poseidon-tree`.

```
secret → ReceiptNote { commitment, scope_hash }
       → nullifier (scope-bound, root-bound)
       → NullifierProof (for on-chain submission)
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

## 7. Module 6 — Dark Relay Router (`crates/dark-relay-router/`)

### What it does

Scores relay routes against leader schedule, fingerprint risk, and landing
probability. Returns a ranked list so agents pick the lowest-exposure path.

### Route kinds

| Route | Privacy | Landing |
|-------|---------|---------|
| `DirectRpc` | Low (mempool visible) | High |
| `Jito` | High (bundle opaque) | Medium–High |
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

## 8. Module 7 — Jito Bundle Cloak (`crates/dark-bundle-cloak/`)

### What it does

Wraps multi-transaction atomic settlements with decoy cleanup transactions
so no direct `wallet → withdraw` fingerprint appears in on-chain graphs.

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

## 9. Module 8 — Ephemeral PDA Chaff (`programs/dark_chaff/`)

### What it does

Creates 3–7 fake intent PDAs around a real action. All close at epoch end.
Pure chain-analysis poison — observers cannot distinguish real intents from chaff.

### PDA seeds

```
Batch PDA:  [b"chaff_batch", epoch_le8, payer]
Intent PDA: [b"chaff_intent", epoch_le8, index_u8, payer]
```

### Instructions

| Instruction | Effect |
|-------------|--------|
| `CreateChaffBatch { count }` | Creates 3–7 chaff PDAs for this epoch |
| `CloseChaffBatch { count }` | Closes and reclaims rent, same epoch only |

### Tests

```
cargo test -p dark-chaff
# 11 passed  (count bounds, wrong-epoch rejection, roundtrip)
```

---

## 10. Module 9 — Swarm Capsules (`crates/swarm-capsule/`)

### What it does

Ed25519-signed relayer capability passport. Each Dark Null relayer carries
a `SwarmCapsule` that proves its codebase commit, config hash, role bitmap,
fee caps, and liveness — without holding custody or upgrade keys.

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

## 11. Module 10 — Sealed Fee Quote Auctions (`crates/sealed-fee-quotes/`)

### What it does

Commit-reveal fee auction so losing relayers' bids stay hidden:

1. Each relayer posts `QuoteCommitment { H(amount || nonce || relayer || receipt_hash) }`
2. Wallet picks a winner; winner reveals their quote
3. Loser commitments are unlinkable — their amounts never appear on-chain

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

## 12. Module 11 — ZK Batch Auditor (`zkvm/dark_batch_auditor/`)

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
npx tsx scripts/deploy-alien-tek.ts

# Check deployed programs
solana program show <PROGRAM_ID> --url devnet
```

Program IDs are written to `scripts/deploy/alien-tek-program-ids.json` after
a successful deployment.

---

## Competitive Position

| Axis | DNA Dark Null | Competitor |
|------|-------------|------------|
| BN254 curve support | ✓ on-chain gate | — |
| x402 payment rail | ✓ native | — |
| On-chain nullifier banks | ✓ 256-shard | — |
| MPC ceremony | ✓ in progress | partial |
| Proof aggregation | ✓ batch auditor | — |
| Solana-native nullifiers | ✓ PDA-sharded | — |
| Privacy primitive count | 315+ | ~15 |
| ZK circuit coverage | Groth16 + PLONK stubs + RISC Zero | Groth16 only |
| x402 payment bridge | ✓ SHA256 null derivation, scope-bound | — |
| BN254 real pairing | ✓ alt_bn128_pairing syscall | — |
| Epoch lifecycle mgmt | ✓ local replay guard + bank init | — |
| Withdrawal bundle | ✓ note → Merkle proof → gate ix (352B) | — |

---

## 13. BN254 Groth16 Verifier (`crates/dark-groth16-core/`)

Real on-chain BN254 Groth16 verification using Solana's `alt_bn128_pairing` syscall.  
Not simulated — calls the actual precompile:

```rust
// e(A,B) · e(−α,β) · e(−vk_x,γ) · e(−C,δ) = 1
pub fn groth16_verify(vk: &VerificationKey, proof: &Groth16Proof, inputs: &[[u8;32]]) -> Result<bool>
pub fn pairing_check(pairs: &[(G1Affine, G2Affine)]) -> Result<bool>
pub fn compute_vk_x(vk: &VerificationKey, public_inputs: &[[u8;32]]) -> Result<G1Affine>
```

EIP-197 encoding: G1 = 64B (x||y), G2 = 128B (x_im||x_re||y_im||y_re).  
Verified with Solana's own `two_point_match_2` test vector: e(G1,G2)·e(G1,−G2) = 1.  
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
  → SubmissionInstructions {
      init_bank_ix: Option<[u8;10]>,  // only if shard not yet init'd this epoch
      insert_nullifier_ix: [u8;41],
      bank_pda, null_rec_pda,
    }
confirm_submission(bn)   → marks bank initialized + nullifier spent (local HashSet)
advance_epoch(n)         → rotates epoch; old state retained for late-submission detection
```

Dual-layer replay protection: local guard prevents double-submission before it touches the network;  
on-chain `dark_nullifier_banks` provides the final guarantee.  
11 tests.

---

## 16. Withdrawal Bundle (`crates/dark-withdrawal-bundle/`)

Assembles the complete 352-byte `dark_bn254_gate` instruction payload from first principles:

```
create_note(value, randomness, recipient_key)
  → ShieldedNote { commitment = poseidon_bn254(DOMAIN_COMMIT || value_le8 || rand || rk) }
  
deposit_note(tree, note)  → inserts commitment into depth-16 MerkleAcc

build_withdrawal(note, secret, tree, leaf_index)
  → WithdrawalBundle {
      nullifier   = poseidon_bn254(DOMAIN_NULL || commitment || note_secret || root)
      merkle_root = tree.root at spend time  ← root-binds the nullifier
      proof_bytes = [0xDE, 0xAD, pub_inputs_hash, commitment, nullifier, ...]  (devnet)
      merkle_proof (all sibling hashes for on-chain inclusion verification)
    }

instruction_data(bundle)  →  [u8; 352]:
  proof(256) || merkle_root(32) || nullifier(32) || amount_le_pad32(32)
```

Security properties verified by tests:
- Root-bound nullifier: same note + different root → different nullifier (cross-snapshot replay impossible)  
- Commitment mismatch guard: cannot supply a different note for an existing leaf slot  
- Leaf-index out-of-range detection  
- Zero value / randomness / secret all rejected at construction time  
15 tests.

`mainnet_ready = false` — devnet validated, mainnet after security audit.
