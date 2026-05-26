# Dark Null Devnet Ritual — Shard Message Evidence

> **Message encoded:** `DARKNULL`
> **Network:** Solana Devnet
> **Epoch:** `0`
> **Domain:** `dark_null_v1`
> **Generated:** 2026-05-26T00:12:16.898Z
> **Mode:** ✅ LIVE — real devnet transactions

---

## What This Proves

Each character of `DARKNULL` is encoded by submitting a nullifier to the shard whose index
equals the ASCII code of that character.

**The shard is determined by the `bank_index` function:**

```
bank_index(nullifier, epoch, domain) = SHA256(nullifier || epoch_le64 || domain)[0]
```

Where:
- `nullifier` = random 32 bytes (brute-forced until first hash byte = target shard)
- `epoch_le64` = `0` encoded as 8-byte little-endian
- `domain` = `"dark_null_v1"` (UTF-8 bytes, matches program constant)
- Result = first byte of SHA-256 output (0–255)

The prover must search random nullifiers until the hash lands on the correct shard. Average: **~256 attempts per character**. Each nullifier is permanently locked on-chain by the `dark_nullifier_banks` program — the PDA seed `[b"null_rec", shard, nullifier]` prevents re-submission.

---

## Deployed Programs

| Program | Program ID |
|---------|-----------|
| `dark_nullifier_banks` | `7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj` |
| `dark_compressed_receipts` | `FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g` |
| `dark_chaff` | `5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk` |

[View dark_nullifier_banks on Solscan](https://solscan.io/account/7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj?cluster=devnet)
[View dark_compressed_receipts on Solscan](https://solscan.io/account/FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g?cluster=devnet)
[View dark_chaff on Solscan](https://solscan.io/account/5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk?cluster=devnet)

---

## ASCII Shard Path

| Char | ASCII | Shard | Nullifier (first 8 bytes) | Attempts | InsertNullifier |
|------|-------|-------|--------------------------|----------|----------------|
| `D` | 68 | 68 | `61227192098dd2e1…` | 420 | [tx](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |
| `A` | 65 | 65 | `7a3740e60ac6621c…` | 446 | [tx](https://solscan.io/tx/V5G8kM2y2fTWBNLnM1LA3mv79txaFqk1Yd87uGgeNFoBd7G72SMQwj2pXJZweQ3yfAAMZAcikx95fcCdGcP4Nah?cluster=devnet) |
| `R` | 82 | 82 | `6cf2d11cd803e43f…` | 90 | [tx](https://solscan.io/tx/2Ch1ujUcGKN4yh3fu9fEdCebZmTDGfsHHKKE8YsD82wxorVzAvs19prcJt3Q6weuTJJBcYru7e2DESf8Bpg6JGNQ?cluster=devnet) |
| `K` | 75 | 75 | `dbd6050a49841f2d…` | 113 | [tx](https://solscan.io/tx/5Lvjhw5eX4UMcfRZ6iv3kZ6CdYoHWH1w36nTm1A8dCPr1EsdkZ26yqoEqBpvkSKwJiXXLxjbeYTwYPDgYpoDV5dk?cluster=devnet) |
| `N` | 78 | 78 | `afffcf219fe5852d…` | 507 | [tx](https://solscan.io/tx/2HgPSYa62xbbc21djBQKBxNeQTYWdrVgaY73bDtKvw2iPmv8BLPPoUmrqwHFSPURi3S4Zy6cQV4vgmCCvfXwT8bh?cluster=devnet) |
| `U` | 85 | 85 | `374c7ddf3664bf06…` | 829 | [tx](https://solscan.io/tx/CBJRuqXUzKbVAi6hX8fNFawXvhK7ahgRPan8gwg77tRkqe5RDGiacWoXj3va8sWxTzFATQ5hUCbrEPzDuVRvUXZ?cluster=devnet) |
| `L` | 76 | 76 | `0743621648104556…` | 62 | [tx](https://solscan.io/tx/4HunJLEjVo16CngXT2iHyWuTGGNf9rNceM2qtZf1TaqJKcgsRb9X3srmdofXrjddajdKDDHZ1Y69UQ2KpvsDk7jn?cluster=devnet) |
| `L` | 76 | 76 | `ccfa2d753558cf86…` | 173 | [tx](https://solscan.io/tx/4uMGHMHdPR7jjigCgQ5EVXcr8qQj7q751VDmcB12TiZ4MNPK7A4BJ3VYYGjRs8jeLHkvCvwu6PrSwg5Ky39AgwZC?cluster=devnet) |

---

## Detailed Nullifier Evidence

### Character 1: `'D'` (ASCII 68)

| Field | Value |
|-------|-------|
| Target shard | `68` |
| Nullifier (hex) | `61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89` |
| Brute-force attempts | 420 |
| Bank PDA | `6aEyEquAexjTasQ4Pniks1vNWLy75VmvJ8sja22MiYzJ` |
| NullRec PDA | `79MbJEGy6sVnX54KaaL5pXXDAsEBs5ReJWbYMRjUGXba` |
| InitBank tx | [Solscan](https://solscan.io/tx/5bzGDg3TbCb2xy1sE8ZNixA5wpe6267THgxCs9bYufFHbKudjfdj5MuUT7zYS649f82FoP2frnNuUnpkrXpdWNXX?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |

### Character 2: `'A'` (ASCII 65)

| Field | Value |
|-------|-------|
| Target shard | `65` |
| Nullifier (hex) | `7a3740e60ac6621cf8757d95d2103987c922d02864d9bb5389372245a3aa8d14` |
| Brute-force attempts | 446 |
| Bank PDA | `A7HiA3hqW9zfdSDX85mricVrQtog8uYv9dAieotniz2S` |
| NullRec PDA | `5JtnqvHwxQvpikA9srV3K5dhU3YCPqwGXiNgUXsrJeVS` |
| InitBank tx | [Solscan](https://solscan.io/tx/1NZgJFmmnVQCcXoLKWunf5tHXYA2mpRqr4QHUmdj6sta8uXWXCgwYFqnSwXGpgA8ZZFerNj5EHkAiX2h4oexmR1?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/V5G8kM2y2fTWBNLnM1LA3mv79txaFqk1Yd87uGgeNFoBd7G72SMQwj2pXJZweQ3yfAAMZAcikx95fcCdGcP4Nah?cluster=devnet) |

### Character 3: `'R'` (ASCII 82)

| Field | Value |
|-------|-------|
| Target shard | `82` |
| Nullifier (hex) | `6cf2d11cd803e43f96b1627ad1941811d649d40a9c53bee545302f4a25fa4616` |
| Brute-force attempts | 90 |
| Bank PDA | `GdUi593x7JVLPVCi7vKMWAPNvD97CpNtXrc5ehEHThcP` |
| NullRec PDA | `DzQb7t6kFDf1aJDZbuVH8s6wHw1puXr6pMraUvSWDu5L` |
| InitBank tx | [Solscan](https://solscan.io/tx/3N7m87KD4gGVHu4iJX2kUPseXP8EswRFGqPbVu5dRX5cYrgUBdsUogvtFWNNP8KrUqF52eodtDu43tP6T1RG3nwt?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/2Ch1ujUcGKN4yh3fu9fEdCebZmTDGfsHHKKE8YsD82wxorVzAvs19prcJt3Q6weuTJJBcYru7e2DESf8Bpg6JGNQ?cluster=devnet) |

### Character 4: `'K'` (ASCII 75)

| Field | Value |
|-------|-------|
| Target shard | `75` |
| Nullifier (hex) | `dbd6050a49841f2d72cbee427a17b01419604af7c17f581fd3548e2dc576dce0` |
| Brute-force attempts | 113 |
| Bank PDA | `5otbLxNQJKDpuSqtFbzjmoC38gToHYhmhNQDNALWVhTA` |
| NullRec PDA | `CSSCvHnL4DF9mV52BWc7TCmbLQNtxDSUT2ipLGtYuLEK` |
| InitBank tx | [Solscan](https://solscan.io/tx/2UogH5CAC5weyRuydb5xqXhFMQEsGMVyt6MSCWxBQEKESSKjQGvhru1MpF8fkkuSsqufcYRtGfTWhVRY8cD9tNSp?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/5Lvjhw5eX4UMcfRZ6iv3kZ6CdYoHWH1w36nTm1A8dCPr1EsdkZ26yqoEqBpvkSKwJiXXLxjbeYTwYPDgYpoDV5dk?cluster=devnet) |

### Character 5: `'N'` (ASCII 78)

| Field | Value |
|-------|-------|
| Target shard | `78` |
| Nullifier (hex) | `afffcf219fe5852d2816fc4de9d597ae451a5fdd5d208c293ceb6b67a2f4c0d0` |
| Brute-force attempts | 507 |
| Bank PDA | `AMUktTTPgi38n1q2VGCoVcvu5SCJAWR7AQ49CsMgHJNT` |
| NullRec PDA | `3Aiq2CyBPD31qbu7nVYPmSEJ7mdWoMBtTjn4iiYR7jF7` |
| InitBank tx | [Solscan](https://solscan.io/tx/2pwLyJkqJ5JrQ7MizS4Ea5bXK3CM3WALtDztywjNPa2MN8RnCVNHSnLu3YxTYFktKt9LAfteJsL6vGNWS7wdpGRY?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/2HgPSYa62xbbc21djBQKBxNeQTYWdrVgaY73bDtKvw2iPmv8BLPPoUmrqwHFSPURi3S4Zy6cQV4vgmCCvfXwT8bh?cluster=devnet) |

### Character 6: `'U'` (ASCII 85)

| Field | Value |
|-------|-------|
| Target shard | `85` |
| Nullifier (hex) | `374c7ddf3664bf06941726596f23aa331f286ea28c9f2e42976d75c752eb5d2e` |
| Brute-force attempts | 829 |
| Bank PDA | `Fd5yfmGmg2tDbRDDJHiid22SCYo3SqFNPE1r4F6neuSu` |
| NullRec PDA | `5iRfxzcGFMXKmaEopvrFbtyuHfXrpuRodzu3qqjZ8HKd` |
| InitBank tx | [Solscan](https://solscan.io/tx/61bFVFZLwZbQiHLmBtJni8feWinavYveGjGid5EK6cxHSjgbyTRH97hMdGwuABucYY6y6EH3HXDmVUY9xDyqaGKt?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/CBJRuqXUzKbVAi6hX8fNFawXvhK7ahgRPan8gwg77tRkqe5RDGiacWoXj3va8sWxTzFATQ5hUCbrEPzDuVRvUXZ?cluster=devnet) |

### Character 7: `'L'` (ASCII 76)

| Field | Value |
|-------|-------|
| Target shard | `76` |
| Nullifier (hex) | `0743621648104556e201033d547811f995cc7d27fcc953b7e50bef8ee4005160` |
| Brute-force attempts | 62 |
| Bank PDA | `BNevFZkiyXKGaDgKqKwGAxGCoNX16UM4hbp2xqAhKhrJ` |
| NullRec PDA | `E7iA8PhAPrUhmdCTGJb3z4vxCserdx3LruSgeWSaZ4kB` |
| InitBank tx | [Solscan](https://solscan.io/tx/zDEJcP38FyWhs62JXQsTVjCa7P6L81VnRFoSSADkxqVErsUxwPXNAL55RwS1Atqip28uWPJrSXDs1avNEThVbQf?cluster=devnet) |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/4HunJLEjVo16CngXT2iHyWuTGGNf9rNceM2qtZf1TaqJKcgsRb9X3srmdofXrjddajdKDDHZ1Y69UQ2KpvsDk7jn?cluster=devnet) |

### Character 8: `'L'` (ASCII 76)

| Field | Value |
|-------|-------|
| Target shard | `76` |
| Nullifier (hex) | `ccfa2d753558cf86a0010df1d16772534174c7d230d2b1a3f8caea2890a0b30a` |
| Brute-force attempts | 173 |
| Bank PDA | `BNevFZkiyXKGaDgKqKwGAxGCoNX16UM4hbp2xqAhKhrJ` |
| NullRec PDA | `8Q5zAErXMk4idWmSSq48FLeWFhUNk3oJCHCW1b6vhjRv` |
| InsertNullifier tx | [Solscan](https://solscan.io/tx/4uMGHMHdPR7jjigCgQ5EVXcr8qQj7q751VDmcB12TiZ4MNPK7A4BJ3VYYGjRs8jeLHkvCvwu6PrSwg5Ky39AgwZC?cluster=devnet) |


---

## Phase 2: Receipt Root

| Field | Value |
|-------|-------|
| Message | `DARKNULL` |
| Message hash | `98068374a70c7ae70957d59f5211f0b901459ff468747358cfdcb0c0805feeff` |
| Receipt root | `fea163acbdf904ea0d4e4c6d3ba87a3ea79df159a325f3cbb2d3b9cc59d35322` |
| Root PDA | `4e9H6aMApoPxhfrymG7H8FKfVLmzm8hjyKRqKbgrjD5n` |
| InitRoot tx | [Solscan](https://solscan.io/tx/3yVG4vnp8wAZxCzAoxWLsxN58uKvfmZ3emGwHmfPPBRjVYsNp4styuWVAGS9QqqXKY6N98M6yy7mxAzTTUifBU5C?cluster=devnet) |
| UpdateRoot tx | [Solscan](https://solscan.io/tx/4uht4nvFELfXwDpRhSecLKgoStDAW5Vg2c2LYDoJG2RDU9wh4dMRvNhv1dPTG6pZ9znLj1ngdJKZumeEk4qSfTMT?cluster=devnet) |

**Derivation:**
```
message_hash = SHA256("DARKNULL")
             = 98068374a70c7ae70957d59f5211f0b901459ff468747358cfdcb0c0805feeff

receipt_root = SHA256("DARK_NULL_RITUAL" || message_hash || 0x00...00)
             = fea163acbdf904ea0d4e4c6d3ba87a3ea79df159a325f3cbb2d3b9cc59d35322
```

---

## Phase 3: Chaff PDAs

| Field | Value |
|-------|-------|
| Chaff count | 3 |
| Epoch | 0 |
| Batch PDA | `7C6YrkaCseJwTVYgKdFq474pSGhZKX5LMoBWYZ6voUU4` |
| CreateChaffBatch tx | [Solscan](https://solscan.io/tx/22Fr5CaCiwqQwSkRf4Vdjtvy4swLGeJ4SsRn8Jbqv8sC9qeeZ9ZJt8DNrpcq2KnXscP3H7bg9qLcDhbDeMJw6ZKt?cluster=devnet) |
| CloseChaffBatch tx | [Solscan](https://solscan.io/tx/hoTQBQpcq27mARiLP1pGPngDqe59FJ1CgF7HkchdB3XKJrCCGWTE51MGH4iXp5J8HKEf4dadXoMCyAZPRAvjC9p?cluster=devnet) |

Chaff PDAs are created and immediately closed, reclaiming rent. They exist only to
produce transaction patterns indistinguishable from real protocol activity.

---

## Verification Instructions

### Verify a nullifier shard independently

```typescript
import { createHash } from "crypto";

function bankIndex(nullifier: Buffer, epoch: bigint): number {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const domain = Buffer.from("dark_null_v1", "utf8");
  return createHash("sha256")
    .update(nullifier)
    .update(epochBuf)
    .update(domain)
    .digest()[0];
}

// Example: verify the first character 'D' (ASCII 68)
const nullifier = Buffer.from("61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89", "hex");
console.assert(bankIndex(nullifier, 0n) === 68);
```

### Verify on-chain via Rust (existing test)

```bash
cargo test test_bank_index_deterministic --package dark-nullifier-banks
```

### Verify via Solana CLI

```bash
# Check the NullRec PDA exists (proof of insertion)
solana account 79MbJEGy6sVnX54KaaL5pXXDAsEBs5ReJWbYMRjUGXba --url devnet
```

---

## What Is NOT Claimed

- This is **not** a zero-knowledge proof
- The nullifiers encode test message bytes, **not** user financial data
- The receipt root is **deterministically constructed**, not user-generated
- Programs are on **devnet only** — no mainnet deployment
- This is **ritual/evidence**, not production cryptography
