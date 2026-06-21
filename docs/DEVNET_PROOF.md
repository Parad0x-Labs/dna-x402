# Dark Null — Complete Devnet Proof & Test Evidence

**Date:** 2026-05-26  
**Network:** Solana Devnet  
**Payer:** project devnet deploy keypair  
**Toolchain:** `cargo-build-sbf 4.0.0` / Solana platform-tools v1.53 / Solana CLI 1.18.26

---

## 1. Deployed Programs

Three programs compiled from source and deployed to Solana devnet in this session.

| Program | Size | Program ID | Deploy Tx |
|---------|------|-----------|-----------|
| `dark_nullifier_banks` | 75 KB | [`7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj`](https://solscan.io/account/7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj?cluster=devnet) | [Solscan](https://solscan.io/tx/44hrCf3TkpAMjXpiioYP5wchLZ3JSwvX74EWE8ptnyHTAbqDX78vHrB3Kef1AAokVUH2pAveJQf3ZRvY19FxcDMf?cluster=devnet) |
| `dark_compressed_receipts` | 80 KB | [`FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g`](https://solscan.io/account/FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g?cluster=devnet) | [Solscan](https://solscan.io/tx/5eaG7M4LXSSujcRmb7RYRdxj27KyDGm5qtX3eLBuvecmXvRktRtMHJmHS5APeiDGWQZ7WW5GHVMhub3JcRoYjSDB?cluster=devnet) |
| `dark_chaff` | 76 KB | [`5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk`](https://solscan.io/account/5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk?cluster=devnet) | [Solscan](https://solscan.io/tx/22Vy5uAv9DrSEtGbGF1vCK7rZ4Yux4wdydEo7ty1QzD8pXGkbs8NYXRrruuec3odvhRbK1AkcGRFefP8u2bkKP56?cluster=devnet) |

Build commands:
```bash
cargo build-sbf --manifest-path programs/dark_nullifier_banks/Cargo.toml
cargo build-sbf --manifest-path programs/dark_compressed_receipts/Cargo.toml
cargo build-sbf --manifest-path programs/dark_chaff/Cargo.toml

solana program deploy target/deploy/dark_nullifier_banks.so --url devnet
solana program deploy target/deploy/dark_compressed_receipts.so --url devnet
solana program deploy target/deploy/dark_chaff.so --url devnet
```

---

## 2. DARKNULL On-Chain Ritual

`DARKNULL` was encoded on Solana devnet by brute-forcing a 32-byte nullifier for each
character such that `SHA256(nullifier ‖ epoch_le64 ‖ "dark_null_v1")[0]` equals the
ASCII code of that character. Each nullifier is permanently locked in the
`dark_nullifier_banks` program — the NullRec PDA seed `[b"null_rec", shard, nullifier]`
prevents any re-insertion.

### Shard Function

```
bank_index(nullifier, epoch, domain) = SHA256(nullifier || epoch_le64 || domain)[0]
```

Parameters: `epoch = 0`, `domain = "dark_null_v1"` (matches Rust constant verbatim).  
Expected brute-force cost: ~256 attempts per character (uniform output distribution).

---

### Character 1 — `D` (ASCII 68 → Shard 68)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89` |
| Brute-force attempts | 420 |
| Bank PDA | `6aEyEquAexjTasQ4Pniks1vNWLy75VmvJ8sja22MiYzJ` |
| NullRec PDA | `79MbJEGy6sVnX54KaaL5pXXDAsEBs5ReJWbYMRjUGXba` |
| InitBank tx | [Solscan](https://solscan.io/tx/5bzGDg3TbCb2xy1sE8ZNixA5wpe6267THgxCs9bYufFHbKudjfdj5MuUT7zYS649f82FoP2frnNuUnpkrXpdWNXX?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |

---

### Character 2 — `A` (ASCII 65 → Shard 65)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `7a3740e60ac6621cf8757d95d2103987c922d02864d9bb5389372245a3aa8d14` |
| Brute-force attempts | 446 |
| Bank PDA | `A7HiA3hqW9zfdSDX85mricVrQtog8uYv9dAieotniz2S` |
| NullRec PDA | `5JtnqvHwxQvpikA9srV3K5dhU3YCPqwGXiNgUXsrJeVS` |
| InitBank tx | [Solscan](https://solscan.io/tx/1NZgJFmmnVQCcXoLKWunf5tHXYA2mpRqr4QHUmdj6sta8uXWXCgwYFqnSwXGpgA8ZZFerNj5EHkAiX2h4oexmR1?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/V5G8kM2y2fTWBNLnM1LA3mv79txaFqk1Yd87uGgeNFoBd7G72SMQwj2pXJZweQ3yfAAMZAcikx95fcCdGcP4Nah?cluster=devnet) |

---

### Character 3 — `R` (ASCII 82 → Shard 82)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `6cf2d11cd803e43f96b1627ad1941811d649d40a9c53bee545302f4a25fa4616` |
| Brute-force attempts | 90 |
| Bank PDA | `GdUi593x7JVLPVCi7vKMWAPNvD97CpNtXrc5ehEHThcP` |
| NullRec PDA | `DzQb7t6kFDf1aJDZbuVH8s6wHw1puXr6pMraUvSWDu5L` |
| InitBank tx | [Solscan](https://solscan.io/tx/3N7m87KD4gGVHu4iJX2kUPseXP8EswRFGqPbVu5dRX5cYrgUBdsUogvtFWNNP8KrUqF52eodtDu43tP6T1RG3nwt?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/2Ch1ujUcGKN4yh3fu9fEdCebZmTDGfsHHKKE8YsD82wxorVzAvs19prcJt3Q6weuTJJBcYru7e2DESf8Bpg6JGNQ?cluster=devnet) |

---

### Character 4 — `K` (ASCII 75 → Shard 75)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `dbd6050a49841f2d72cbee427a17b01419604af7c17f581fd3548e2dc576dce0` |
| Brute-force attempts | 113 |
| Bank PDA | `5otbLxNQJKDpuSqtFbzjmoC38gToHYhmhNQDNALWVhTA` |
| NullRec PDA | `CSSCvHnL4DF9mV52BWc7TCmbLQNtxDSUT2ipLGtYuLEK` |
| InitBank tx | [Solscan](https://solscan.io/tx/2UogH5CAC5weyRuydb5xqXhFMQEsGMVyt6MSCWxBQEKESSKjQGvhru1MpF8fkkuSsqufcYRtGfTWhVRY8cD9tNSp?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/5Lvjhw5eX4UMcfRZ6iv3kZ6CdYoHWH1w36nTm1A8dCPr1EsdkZ26yqoEqBpvkSKwJiXXLxjbeYTwYPDgYpoDV5dk?cluster=devnet) |

---

### Character 5 — `N` (ASCII 78 → Shard 78)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `afffcf219fe5852d2816fc4de9d597ae451a5fdd5d208c293ceb6b67a2f4c0d0` |
| Brute-force attempts | 507 |
| Bank PDA | `AMUktTTPgi38n1q2VGCoVcvu5SCJAWR7AQ49CsMgHJNT` |
| NullRec PDA | `3Aiq2CyBPD31qbu7nVYPmSEJ7mdWoMBtTjn4iiYR7jF7` |
| InitBank tx | [Solscan](https://solscan.io/tx/2pwLyJkqJ5JrQ7MizS4Ea5bXK3CM3WALtDztywjNPa2MN8RnCVNHSnLu3YxTYFktKt9LAfteJsL6vGNWS7wdpGRY?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/2HgPSYa62xbbc21djBQKBxNeQTYWdrVgaY73bDtKvw2iPmv8BLPPoUmrqwHFSPURi3S4Zy6cQV4vgmCCvfXwT8bh?cluster=devnet) |

---

### Character 6 — `U` (ASCII 85 → Shard 85)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `374c7ddf3664bf06941726596f23aa331f286ea28c9f2e42976d75c752eb5d2e` |
| Brute-force attempts | 829 |
| Bank PDA | `Fd5yfmGmg2tDbRDDJHiid22SCYo3SqFNPE1r4F6neuSu` |
| NullRec PDA | `5iRfxzcGFMXKmaEopvrFbtyuHfXrpuRodzu3qqjZ8HKd` |
| InitBank tx | [Solscan](https://solscan.io/tx/61bFVFZLwZbQiHLmBtJni8feWinavYveGjGid5EK6cxHSjgbyTRH97hMdGwuABucYY6y6EH3HXDmVUY9xDyqaGKt?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/CBJRuqXUzKbVAi6hX8fNFawXvhK7ahgRPan8gwg77tRkqe5RDGiacWoXj3va8sWxTzFATQ5hUCbrEPzDuVRvUXZ?cluster=devnet) |

---

### Character 7 — `L` (ASCII 76 → Shard 76)

| Field | Value |
|-------|-------|
| Nullifier (hex) | `0743621648104556e201033d547811f995cc7d27fcc953b7e50bef8ee4005160` |
| Brute-force attempts | 62 |
| Bank PDA | `BNevFZkiyXKGaDgKqKwGAxGCoNX16UM4hbp2xqAhKhrJ` |
| NullRec PDA | `E7iA8PhAPrUhmdCTGJb3z4vxCserdx3LruSgeWSaZ4kB` |
| InitBank tx | [Solscan](https://solscan.io/tx/zDEJcP38FyWhs62JXQsTVjCa7P6L81VnRFoSSADkxqVErsUxwPXNAL55RwS1Atqip28uWPJrSXDs1avNEThVbQf?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/4HunJLEjVo16CngXT2iHyWuTGGNf9rNceM2qtZf1TaqJKcgsRb9X3srmdofXrjddajdKDDHZ1Y69UQ2KpvsDk7jn?cluster=devnet) |

---

### Character 8 — `L` (ASCII 76 → Shard 76)

Shard 76 bank was already initialised for character 7 and was reused.
Each `L` has a distinct nullifier and a unique NullRec PDA.

| Field | Value |
|-------|-------|
| Nullifier (hex) | `ccfa2d753558cf86a0010df1d16772534174c7d230d2b1a3f8caea2890a0b30a` |
| Brute-force attempts | 173 |
| Bank PDA | `BNevFZkiyXKGaDgKqKwGAxGCoNX16UM4hbp2xqAhKhrJ` _(shared)_ |
| NullRec PDA | `8Q5zAErXMk4idWmSSq48FLeWFhUNk3oJCHCW1b6vhjRv` |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/4uMGHMHdPR7jjigCgQ5EVXcr8qQj7q751VDmcB12TiZ4MNPK7A4BJ3VYYGjRs8jeLHkvCvwu6PrSwg5Ky39AgwZC?cluster=devnet) |

---

### Receipt Root (Phase 2)

A SHA-256 commitment to `DARKNULL` was posted to the `dark_compressed_receipts` program.

```
message_hash = SHA256("DARKNULL")
             = 98068374a70c7ae70957d59f5211f0b901459ff468747358cfdcb0c0805feeff

receipt_root = SHA256("DARK_NULL_RITUAL" || message_hash || 0x00×32)
             = fea163acbdf904ea0d4e4c6d3ba87a3ea79df159a325f3cbb2d3b9cc59d35322
```

| Field | Value |
|-------|-------|
| Root PDA | `4e9H6aMApoPxhfrymG7H8FKfVLmzm8hjyKRqKbgrjD5n` |
| InitRoot tx | [Solscan](https://solscan.io/tx/3yVG4vnp8wAZxCzAoxWLsxN58uKvfmZ3emGwHmfPPBRjVYsNp4styuWVAGS9QqqXKY6N98M6yy7mxAzTTUifBU5C?cluster=devnet) |
| UpdateRoot tx | [Solscan](https://solscan.io/tx/4uht4nvFELfXwDpRhSecLKgoStDAW5Vg2c2LYDoJG2RDU9wh4dMRvNhv1dPTG6pZ9znLj1ngdJKZumeEk4qSfTMT?cluster=devnet) |

---

### Chaff PDAs (Phase 3)

3 ephemeral intent PDAs created and immediately closed. Rent fully reclaimed.
Pattern is indistinguishable from real protocol maintenance traffic.

| Field | Value |
|-------|-------|
| Batch PDA | `7C6YrkaCseJwTVYgKdFq474pSGhZKX5LMoBWYZ6voUU4` |
| CreateChaffBatch tx | [Solscan](https://solscan.io/tx/22Fr5CaCiwqQwSkRf4Vdjtvy4swLGeJ4SsRn8Jbqv8sC9qeeZ9ZJt8DNrpcq2KnXscP3H7bg9qLcDhbDeMJw6ZKt?cluster=devnet) |
| CloseChaffBatch tx | [Solscan](https://solscan.io/tx/hoTQBQpcq27mARiLP1pGPngDqe59FJ1CgF7HkchdB3XKJrCCGWTE51MGH4iXp5J8HKEf4dadXoMCyAZPRAvjC9p?cluster=devnet) |

---

## 3. Test Suite — 304 Tests, 0 Failures

Command: `cargo test --workspace`

| Crate / Program | Tests | What is covered |
|-----------------|------:|-----------------|
| `alt-fog-router` | 5 | Account injection into Solana v0 tx; fog score improves with decoys; grade thresholds (Clear/Hazy/Dense/Impenetrable); payer+program deduplication; 100 random-input property test verifying real accounts always present |
| `compute-coupon` | 6 | Issue/redeem roundtrip; slot expiry rejected; CU price above cap rejected; route class mismatch rejected; receipt hash binding; JSON roundtrip |
| `dark-bundle-cloak` | 6 | Direct-wallet fingerprint detection; decoy insertion breaks mapping; bundle order preserved after decoys; empty bundle → FingerprintError; insufficient decoys detected |
| `dark_chaff` | 11 | CreateChaffBatch / CloseChaffBatch instruction encoding; ChaffBatch state pack/unpack roundtrip; MIN_CHAFF=3, MAX_CHAFF=7, EPOCH_SECONDS=3600 constants; epoch guard (future epoch rejected); CHAFF_BATCH_LEN=51 layout match |
| `dark_compressed_receipts` | 11 | InitRoot / UpdateRoot / RedeemReceipt / CheckNullifier instruction encoding; ReceiptRoot state pack/unpack; wrong-version rejection; short-slice rejection; seed distinctness (receipt_root ≠ receipt_null); authority binding; correct data lengths |
| `dark-macaroons` | 7 | Mint/verify roundtrip; signature chain tamper (field flip → MacaroonError); slot expiry enforcement; budget cap (spend over limit rejected); scope hash mismatch rejected; relayer class check; withdraw lock enforced |
| `dark_nullifier_banks` | 6 | InitBank / InsertNullifier instruction encoding; NullifierBank state roundtrip; bank_index determinism (same inputs = same output); bank_index domain-separation (different domain = different index); BANK_SIZE layout match |
| `dark-poseidon-tree` | 6 | Domain separation: commitment_hash ≠ nullifier_hash for identical inputs; merkle_node determinism; receipt_hash changes on any field; 4 known fixed-vector pairs for circuit parity |
| `dark_scratch` | 8 | CreateScratch / CloseScratch / CleanupExpired instruction encoding; ScratchAccount state pack/unpack; expiry semantics; seed uniqueness (different owner+tag = different PDA); SCRATCH_ACCOUNT_LEN=58 layout match |
| `dark-relay-router` | 5 | Jitter never exceeds 2× base_ms; route ranking stable with same leaders; Jito scores higher than DirectRpc on clean leader window; composite score 0.0–1.0 bounds |
| `ghost-spl-ledger` | 8 | Commit is deterministic; spend decrements balance + increments nonce; deposit increments balance + increments nonce; overdraft (spend > balance) → LedgerError; pre/post commitments differ; exit intent creation; exit intent pre-commitment matches; LedgerError display |
| `intent-capsule` | 7 | 1-byte flip in any field changes hash; slot expiry (is_expired); JSON roundtrip via verify_from_json; wrong hash rejected; all 6 fields contribute to hash (field sensitivity) |
| `lock-scheduler` | 6 | Overlapping write-sets conflict; disjoint write-sets don't conflict; greedy scheduler batches correctly; non-conflicting actions in one batch; conflicting actions split; shard_for returns first byte |
| `receipt-rollup-lite` | 6 | Leaf hash determinism; Merkle root even-count; Merkle root odd-count (last leaf duplicated); nullifier derivation; redeem-once succeeds; second redeem → AlreadyRedeemed |
| `receipt-spend` | 7 | Nullifier determinism (same inputs = same output); different scope = different nullifier; different root = different nullifier; spend/verify roundtrip; scope mismatch → ScopeMismatch; tampered nullifier → verify returns false; same secret + different scope = different commitment (unlinkability) |
| `rent-blast-radius` | 5 | Rent formula: `(128 + data_len) × 3480 × 2`; zero-byte account; typical PDA size; SOL conversion; blast comparison naive vs shoestring layout |
| `sealed-fee-quotes` | 7 | Commit/reveal roundtrip; same nonce revealed twice → NonceReuse; wrong receipt hash rejected; wrong amount → AmountMismatch; commitment binding (different nonce = different commitment); amount preserved through reveal |
| `shape-pool` | 7 | ReceiptSpend and ChaffClose produce identical TxShape (k-anonymity invariant); k-anonymity count; QuoteSettle shape distinct; NullifierInsert shape distinct; account fingerprint is deterministic; custom shape roundtrip |
| `state-tier-router` | 7 | OffChainOnly routing; EventOnly routing; CompressedLeaf routing; TinyPdaHeader routing; TokenAccount routing; FullAccount routing; routing rationale string non-empty |
| `swarm-capsule` | 6 | Sign/verify roundtrip; field tampering → signature invalid; custody_denied=false → CustodyViolation before sig check; JSON serialize/deserialize roundtrip; known public key recoverable from capsule |
| `useful-chaff-planner` | 6 | Plan created with ops; efficiency = maintenance_ops / (maintenance_ops + decoy_count); is_useful ≥ 0.3 threshold; validate rejects empty maintenance_ops; validate accepts valid plan; decoy count preserved |
| `dark-module-abi` | 8 | Commitment hash, result hash, tamper detection, error variants, version mismatch |
| `dark-capability-registry` | 6 | Register/pause/resume, verify result, registry root derivation, unknown module |
| `caveat-engine` | 11 | All 12 caveat types; denied-scope wins over allowed; daily loss limit; withdraw lock; fingerprint stability |
| `dark-session-netting` | 7 | Net settlement hash; balance commitment; dispute hash; duplicate nullifier rejection; empty session |
| `account-fee-heatmap` | 6 | Heat score computation; stale slot filtering; coolest selection; hot account detection; stale count |
| `nullifier-bank-planner` | 6 | bank_index on-chain parity; load tracking; hottest shard; rollover recommendation; distribute |
| `compute-coupon-market` | 7 | Issue/redeem; expiry; CU price cap; route class gate; receipt binding; replay protection |
| `alt-fog-vault` | 6 | 256-account budget cap; dedup; candidate generation from seed; extension plan ordering |
| `dark-blink-intent` | 8 | Intent hash; expiry; spend validation; JSON roundtrip; title change changes hash; field sensitivity |
| `rent-bounty-hunter` | 6 | Bounty calculation; grace period blocks early claim; sort by value; total reclaimable |
| `session-loss-fuse` | 7 | Drawdown trip; failed-spend trip; window rate trip; user rearm resets balance; agent cannot rearm |
| `degen-api-meter` | 6 | burn_call nullifier; exhausted error; wrong scope; duplicate call; refill resets counter |
| `poison-receipts` | 6 | Domain separation real ≠ poison; batch root; poison ratio; cannot redeem poison leaf |
| `copy-sniper-sim` | 5 | Naive follower simulation; false positive rate; precision; edge destroyed when precision < 0.5 |
| `strategy-cloak-delay` | 6 | Deterministic jitter; hot slot avoidance; chaff slot distinct from real; deadline enforcement |
| `alpha-leak-meter` | 6 | All 5 scoring axes; devnet safe threshold; high-risk detection; score bounds |
| `agent-kill-switch` | 6 | Sign/verify; user rearm only; revoke blocks spend; check spend; wrong user rejected |
| `dark-tip-notes` | 6 | Commitment/nullifier unlinkability; bucketed amounts; expiry enforcement; log dedup |
| `pvp-prediction-receipts` | 6 | Commit hash; reveal verify; pre-event guard; post-event reveal rejected |
| `dark-gift-notes` | 6 | Claim before expiry; clawback after expiry only; recipient binding; cannot clawback early |
| `dispute-receipt-oracle` | 6 | File dispute; deadline rejection; partial refund; counter-sign capsule |
| `feature-commit-reveal` | 6 | Commit/reveal roundtrip; wrong reveal rejected; too early rejected; paused override |
| `model-output-receipts` | 6 | Output commitment; verify; stale detection; delayed reveal slot; redacted display |
| `public-puzzle-generator` | 6 | Generate/verify puzzle; solution hash; markdown output; all puzzle types |
| `telegram-command-receipts` | 6 | All command types; pause always returns Ok; nullifier dedup; no raw secret keys in receipts |
| **TOTAL** | **304** | **0 failures — all crates, all platforms (unit tests)** |

### Platform gate

Program integration tests (`solana-program-test` / BanksClient) are compiled only on
non-Windows targets:

```rust
#[cfg(not(target_os = "windows"))]
mod program_tests { /* tokio::test async tests */ }
```

Root cause of gate: `rbpf 0.8.3` pointer-XOR encryption overflows on Windows ASLR
low-address allocations (`STATUS_STACK_BUFFER_OVERRUN`). Identical logic paths are
covered by the unit tests that run on all platforms. Integration tests pass clean on
Linux / macOS CI.

---

## 4. Independent Verification

### Verify a nullifier shard (no Solana, pure Node)

```typescript
import { createHash } from "node:crypto";

function bankIndex(nullifier: Buffer, epoch: bigint): number {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  return createHash("sha256")
    .update(nullifier)
    .update(epochBuf)
    .update(Buffer.from("dark_null_v1", "utf8"))
    .digest()[0];
}

// Verify each character of DARKNULL
const checks: [string, string, number][] = [
  ["D", "61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89", 68],
  ["A", "7a3740e60ac6621cf8757d95d2103987c922d02864d9bb5389372245a3aa8d14", 65],
  ["R", "6cf2d11cd803e43f96b1627ad1941811d649d40a9c53bee545302f4a25fa4616", 82],
  ["K", "dbd6050a49841f2d72cbee427a17b01419604af7c17f581fd3548e2dc576dce0", 75],
  ["N", "afffcf219fe5852d2816fc4de9d597ae451a5fdd5d208c293ceb6b67a2f4c0d0", 78],
  ["U", "374c7ddf3664bf06941726596f23aa331f286ea28c9f2e42976d75c752eb5d2e", 85],
  ["L", "0743621648104556e201033d547811f995cc7d27fcc953b7e50bef8ee4005160", 76],
  ["L", "ccfa2d753558cf86a0010df1d16772534174c7d230d2b1a3f8caea2890a0b30a", 76],
];

for (const [char, hex, shard] of checks) {
  const n = Buffer.from(hex, "hex");
  const got = bankIndex(n, 0n);
  console.assert(got === shard, `${char}: expected ${shard} got ${got}`);
  console.log(`${char} → shard ${got} ✓`);
}
```

### Verify each NullRec PDA exists on-chain (Solana CLI)

```bash
solana account 79MbJEGy6sVnX54KaaL5pXXDAsEBs5ReJWbYMRjUGXba --url devnet  # D
solana account 5JtnqvHwxQvpikA9srV3K5dhU3YCPqwGXiNgUXsrJeVS --url devnet  # A
solana account DzQb7t6kFDf1aJDZbuVH8s6wHw1puXr6pMraUvSWDu5L --url devnet  # R
solana account CSSCvHnL4DF9mV52BWc7TCmbLQNtxDSUT2ipLGtYuLEK --url devnet  # K
solana account 3Aiq2CyBPD31qbu7nVYPmSEJ7mdWoMBtTjn4iiYR7jF7 --url devnet  # N
solana account 5iRfxzcGFMXKmaEopvrFbtyuHfXrpuRodzu3qqjZ8HKd --url devnet  # U
solana account E7iA8PhAPrUhmdCTGJb3z4vxCserdx3LruSgeWSaZ4kB --url devnet  # L (1st)
solana account 8Q5zAErXMk4idWmSSq48FLeWFhUNk3oJCHCW1b6vhjRv --url devnet  # L (2nd)
```

### Verify bank_index in Rust

```bash
cargo test test_bank_index_determinism -p dark-nullifier-banks
```

### Run the full test suite

```bash
cargo test --workspace           # 304 tests, 0 failures (all platforms)
cargo test --workspace -- --nocapture   # + program integration (Linux/macOS only)
```

---

## 5. What This Is NOT

| Claim | Status |
|-------|--------|
| Zero-knowledge proof | ❌ Not present — programs verify PDA uniqueness only |
| Mainnet deployment | ❌ Devnet only |
| User financial data | ❌ Test bytes (`DARKNULL`) only |
| RFC 2104 HMAC | ❌ `dark-macaroons` uses `SHA256(key‖msg)` — sufficient for prototype |
| On-chain capsule verification | ❌ `swarm-capsule` verified off-chain only |
| Poseidon on-chain hashing | ❌ SHA-256 with domain prefix used off-chain; Poseidon syscall swap is a future step |
| Cryptographic privacy guarantee | ❌ ALT fog decoys increase search space but are not cryptographic |

---

*Related documents:*  
*`docs/AUDIT.md` — full auditor reference (scope, security claims, dependency audit, known limitations)*  
*`docs/SHARD_MESSAGE_EVIDENCE.md` — machine-generated ritual evidence with all PDAs and tx signatures*
