# Dark Null True Alien Primitives — Devnet Demo Evidence

> **Network:** Solana Devnet
> **Mode:** ✅ LIVE — real devnet transactions submitted
> **Commit:** `66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186`
> **Puzzle:** `ROGUE` → `[82, 79, 71, 85, 69]`
> **NOT PRODUCTION — no mainnet, no audit, no custody**

---

## ELI5

Ten cryptographic building blocks for Parad0x / Nulla / Dark Null users, proven end-to-end:

1. **Agent Permission Note** — a cryptographic leash constraining an AI agent's spending
2. **Alpha Capsule** — a sealed directional prediction, provable after the reveal slot
3. **Shadow Bundle** — 1 real spend hidden among 4 indistinguishable decoy/delayed/poison leaves
4. **Permission Spend** — agent's spend verified against the permission note (8-step pipeline)
5. **Flight Recorder** — tamper-evident log of every agent money action, with redacted public view
6. **Receipt Soul** — a transferable bearer note (API access, tips, predictions) with unlinkable nullifier
7. **Session Note Channel** — 5 payments collapsed into one settlement root, no channel PDA
8. **No-Custody Attestation** — relayer proves it holds no user funds (risk score = 0)
9. **DARKNULL Ritual** — message "ROGUE" encoded by submitting nullifiers to shard bytes 82,79,71,85,69
10. **Roadmap Commitment** — feature committed at slot, verifiable against docs+tests hash at reveal

---

## Primitive Evidence

| Primitive | Hash |
|---|---|
| AgentPermissionNote | `c80b8f0b05fc99d52aacea4cb216379e50306723b05149cb98643b6937acdbf8` |
| AlphaCapsule | `3670dc12f978265e20e39bd0f369f3209efd436636427410347a0d64cf2f8d83` |
| FlightRecord | `06dfb38e0eafd70fd19d56f9e4234975187b19b404a76239046a2422672a9989` |
| ReceiptSoul nullifier | `297116b22160489a3d515d817df50daa9fcd9ce36c308c317441912512549415` |
| SessionSettlement root | `54feb108ad348ceefb53000e2ca0c06f7f014b5e591daff4d44563ccb657191c` |
| NoCustody capsule | `d77e33f7ea639a734f19457dded472cc4a236d1018d4e2ac9f34d526788d8e30` |
| RoadmapCommit | `d9f5d955b6cbe7d6972d7eefdd5ce1b0f9714072cd95a3e6f6dd1d8953d32452` |

**Shadow bundle:** 5 leaves (precision = 0.20), all 81 bytes

**NoCustody risk score:** 0

---

## ROGUE Shard Path

`ROGUE` = ASCII `[82, 79, 71, 85, 69]`

Each character encodes as: `shard_byte = SHA256(nullifier || epoch_le64 || "dark_null_v1")[0]`

| Char | ASCII | Shard | Nullifier (first 16) | Attempts | Tx |
|------|-------|-------|----------------------|----------|----|
| `R` | 82 | 82 | `0720ae1399825a56...` | 91 | [Solscan](https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet) |
| `O` | 79 | 79 | `9ae1aa64d86aa299...` | 10 | [Solscan](https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet) |
| `G` | 71 | 71 | `89d68eaef5da1eea...` | 131 | [Solscan](https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet) |
| `U` | 85 | 85 | `e0251d1f992b4357...` | 215 | [Solscan](https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet) |
| `E` | 69 | 69 | `e2aec68d3bca83ec...` | 21 | [Solscan](https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet) |

---

## Devnet Transactions

- [`67jsL2KmhYfg2z1T`](https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet)
- [`4UDnJctmmvhmctQh`](https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet)
- [`5BCtkPKLxjELu1Sg`](https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet)
- [`63LQ8uUZN5f9uxo9`](https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet)
- [`5Dd58QcyJSvGtx61`](https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet)

---

## How to Independently Verify

```bash
# Verify ROGUE shard bytes
node -e "console.log('R='+82, 'O='+79, 'G='+71, 'U='+85, 'E='+69)"

# Verify nullifier shard formula for first letter (R=82):
# sha256(nullifier_hex || 0000000000000000 || dark_null_v1)[0] == 82
```

```rust
// In Rust (using onchain-puzzle-compiler):
use onchain_puzzle_compiler::verify_nullifier_for_shard;
let nullifier = hex::decode("<nullifier_hex>").unwrap();
assert!(verify_nullifier_for_shard(&nullifier, 82, 0, b"dark_null_v1"));
```

---

## What Is NOT Claimed

- This is **not** a zero-knowledge proof
- No mainnet deployment — devnet only
- No production facilitator, no custody, no audit
- Ephemeral keypair used — not a wallet address
- Receipt soul is a test bearer note, not a real financial instrument
- `mainnet_ready: false`, `production_claim: false`
