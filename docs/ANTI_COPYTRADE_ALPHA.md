# Dark Null Anti-Copytrading Alpha Receipts

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) `mainnet_ready = false` | No audit | Devnet design only

---

## What Is This

Dark Null Anti-Copytrading Alpha Receipts let an alpha-seller prove their trade history and PnL on-chain WITHOUT leaking their execution wallet or raw token identities. Subscribers pay an x402 micro-payment to unlock each trade reveal. Copycats get nothing until they pay.

The system gives traders a cryptographic commitment trail — you prove you called the trade *before* it moved, subscribers pay to see *what* you called, and nobody learns *who* you are or *which* exact token until they've already paid. The alpha stays yours until someone buys a reveal.

---

## The Problem It Solves

**Problem 1 — Solana's open execution history exposes everything.** Every swap on every major Solana DEX is indexed within seconds by services like Birdeye, Helius, and Step Finance. Any wallet that trades a token before it pumps is visible on-chain. Copy-traders write bots that watch for wallets with consistent PnL and mirror their next trade in the same block. There is no opt-out at the protocol layer.

**Problem 2 — Existing workarounds destroy performance attribution.** Using burner wallets, split wallets, or Jito bundles hides your trade from indexers — but it also hides your trade from anyone who might pay for your alpha. You cannot prove your historical PnL without revealing the wallet. You cannot sell a signal if you can't prove it's real. Alpha sellers are stuck: expose yourself to copycats, or prove nothing to potential subscribers.

**Problem 3 — Dark Null breaks the dilemma with cryptographic commitments.** The trader commits to a trade hash before the trade executes — wallet never stored, token mint never stored in plain form. After the trade settles, the reveal is sold via x402 micro-payment. Subscribers get the trade details; the raw wallet and raw mint never appear in any on-chain record. Performance attribution is preserved. Copycat bots get nothing actionable until the alpha has already moved.

---

## Architecture

### TraderSession

```
session_hash = SHA256(
    "dark-null-session-v1"
  || session_salt          // 32-byte random, chosen by trader at session open
  || wallet_pubkey_bytes   // 32 bytes — used in derivation but never stored
  || epoch.le              // u64 little-endian epoch number
)
```

The wallet public key is used as an input to the hash but is **never stored** in any on-chain account or receipt. Two sessions from the same wallet produce different session hashes due to the salt. The epoch field allows session rotation.

### TradeCommitment

```
commitment_hash = SHA256(
    "dark-null-trade-v1"
  || session_hash           // links to session without revealing wallet
  || token_hash             // SHA256(token_mint) — raw mint never stored
  || side_byte              // 0x00 = Buy, 0x01 = Sell
  || size_bucket            // u8: 0=dust, 1=small, 2=medium, 3=large, 4=whale
  || slot_hash              // SHA256(slot_bytes) — anchors to block time
  || created_at_unix.le     // u64 little-endian — prevents timestamp manipulation
)
```

`token_hash = SHA256(token_mint)` — the raw mint address is never stored anywhere in the commitment, only its hash. A subscriber who receives a reveal learns the token_hash; they can verify it against a known mint by computing the hash themselves, but they cannot reverse it without already knowing the mint.

### PnlCommitment

An epoch-level PnL proof aggregates all TradeCommitments in a session epoch into a single summary commitment:

```
pnl_commitment_hash = SHA256(
    "dark-null-pnl-v1"
  || session_hash
  || epoch.le
  || realized_pnl_bucket    // i8: bucketed PnL band, not raw SOL amount
  || trade_count.le         // u16 — number of trades in epoch
  || merkle_root            // root of commitment Merkle tree for epoch
)
```

This allows a trader to prove "I had a positive PnL in epoch N" without revealing the individual trade details or exact amounts.

### TradeReveal

A TradeReveal is the paid artifact:

```rust
pub struct TradeReveal {
    pub commitment_hash: [u8; 32],
    pub subscriber_hash: [u8; 32],  // all-zeros → WrongSubscriber error
    pub side: TradeSide,
    pub size_bucket: SizeBucket,
    pub slot_hash: [u8; 32],
    pub token_hash: [u8; 32],
    pub revealed_at: i64,
    pub replay_key: [u8; 32],
}
```

The `subscriber_hash` binds each reveal to a specific paying subscriber. An all-zeros subscriber_hash is rejected at creation time with `DarkNullError::WrongSubscriber`.

```
replay_key = SHA256("dark-null-replay-v1" || commitment_hash || created_at_unix.le)
```

The replay key is unique per reveal instance — the same commitment issued to two different subscribers produces different replay keys.

### ReceiptChain

The ReceiptChain is an append-only chain of commitment hashes forming a tamper-evident DAG:

```
chain_node_hash = SHA256(
    "dark-null-chain-v1"
  || prev_node_hash          // all-zeros for genesis
  || commitment_hash
  || sequence_number.le
)
```

`verify_chain_integrity()` walks the chain from genesis, recomputing each node hash and confirming the append-only property. Any tampering with a historical commitment breaks all downstream node hashes.

---

## x402 Integration

The paid reveal flow runs over x402 micro-payments. The sequence:

1. **Seller publishes commitment_hash** to a public feed — a tweet, a Telegram post, or an on-chain memo instruction. The commitment_hash commits to the trade without revealing it. Timestamp is public — the "I called this at slot N" claim is locked.

2. **Subscriber sends x402 payment** — approximately 0.001 SOL — to the seller's x402 relay endpoint. The payment references the commitment_hash as the resource identifier.

3. **Relay verifies payment receipt** — the x402 relay checks the on-chain payment confirmation and calls `create_paid_reveal(commitment, subscriber_hash, timestamp)` on behalf of the seller.

4. **Subscriber receives TradeReveal** — the reveal contains: `side` (Buy/Sell), `size_bucket` (dust/small/medium/large/whale), `slot_hash`, and `token_hash`. They do not receive the raw wallet or raw mint unless the seller chooses to include them separately.

5. **Subscriber verifies** — given the original commitment_hash and the reveal fields, the subscriber can recompute the commitment_hash and confirm the reveal is authentic. If the hash matches, the trade claim is verified.

The relay never holds private keys. The seller's wallet signs the reveal creation transaction locally.

---

## Security Properties

### Wallet Unlinkability
The session_hash is derived from the wallet pubkey but the pubkey is never stored. Two sessions from the same wallet produce different session hashes (due to session_salt). An adversary observing the on-chain commitment chain cannot link it to a wallet without the session_salt.

### Token Unlinkability
`token_hash = SHA256(token_mint)` — the raw mint address never appears in any commitment, reveal, or chain node. A subscriber who receives a reveal learns the token_hash. They can test a specific mint hypothesis by computing SHA256(candidate_mint) and comparing, but they cannot enumerate all possible Solana tokens to brute-force the mint — the search space is too large for non-targeted attacks.

### Replay Protection
Each reveal carries a `replay_key = SHA256("dark-null-replay-v1" || commitment_hash || created_at_unix.le)`. The same commitment cannot be re-issued at a different timestamp without producing a different replay_key. The subscriber can detect re-issued reveals.

### Subscriber Gating
An all-zeros subscriber_hash is rejected with `DarkNullError::WrongSubscriber` at reveal creation time. The subscriber_hash binds a reveal to the specific paying subscriber — a reveal issued to subscriber A cannot be presented as having been issued to subscriber B.

### PnL Integrity
`verify_pnl_card_clean()` checks that no PnL card contains fake entries: no duplicate commitment_hashes in the same epoch, no self-referential entries, no pnl_bucket values outside the defined range.

### Chain Integrity
`verify_chain_integrity()` walks the full ReceiptChain, recomputing each node hash from (prev_hash, commitment_hash, sequence_number). Any modification to any historical node breaks all downstream hashes. The chain is append-only by construction — there is no delete or update operation.

---

## Daily Use Case

**Day 1:** Alpha degen opens a new TraderSession. The session_hash is derived from their wallet and a fresh random salt. The salt is stored locally (never on-chain). They begin trading.

**Day 2–7:** For each significant trade, they create a TradeCommitment before submitting the swap. The commitment_hash is posted to their Telegram channel immediately — subscribers see the hash and timestamp but nothing else.

**Day 8:** A subscriber pays 0.001 SOL via x402 to unlock the reveal for a specific commitment_hash. They receive the TradeReveal: the trade was a Buy, size_bucket Large, token_hash `abc123...`. The subscriber verifies the reveal matches the original hash.

**Day 14:** The trader publishes a PnlCommitment for the week's epoch. Subscribers can verify the epoch had net positive realized PnL without seeing individual trade sizes.

**Day 30:** The trader has a verified on-chain record of 30 days of trade commitments, with subscriber-verified reveals available for each. They can sell subscriptions at a higher rate — the performance record is provable without ever revealing the wallet.

**CT communities** use this flow for paid alpha groups. The group leader posts commitment_hashes publicly; members pay x402 per reveal. Non-paying followers can see the commitment timestamps proving the alpha was called before the move, but cannot see the token or side until they pay.

---

## Limitations

- **NOT audited.** This codebase has not been reviewed by any security firm. Do not use for real funds.
- **NOT mainnet.** All design targets Solana devnet. `mainnet_ready = false`.
- **SHA-256, not Poseidon.** Real ZK systems on Solana use Poseidon (ZK-friendly hash). This system uses SHA-256 as a structural proxy. It does not generate real zero-knowledge proofs.
- **No real ZK proofs.** The system uses commitment-reveal patterns and hash chains, not zero-knowledge proofs. The "privacy" guarantee is one-way hash unlinkability, not cryptographic zero-knowledge.
- **Token hash is one-way but not zero-knowledge.** A determined adversary who already has a candidate mint can compute SHA256(mint) and compare against a stored token_hash to confirm a match. This is a verification oracle, not a ZK commitment. The protection is practical obscurity, not formal ZK privacy.
- **Session salt custody is critical.** If the session_salt is lost, the session cannot be proved. If the session_salt is leaked, the wallet-to-session link is exposed.
- **Size bucketing reduces precision.** Trade size is reported as a bucket (dust/small/medium/large/whale), not an exact amount. This prevents size-based reverse engineering but also limits the precision of the alpha signal.

---

## Crate

```
crates/dark-alpha-receipts
```

16 tests, all passing.

```sh
cargo test -p dark-alpha-receipts
```

Key types: `TraderSession`, `TradeCommitment`, `PnlCommitment`, `TradeReveal`, `ReceiptChain`, `DarkNullError`

Key functions: `create_trader_session()`, `create_trade_commitment()`, `create_paid_reveal()`, `verify_reveal()`, `verify_pnl_card_clean()`, `verify_chain_integrity()`

---

*Dark Null Anti-Copytrading Alpha Receipts — NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false*
