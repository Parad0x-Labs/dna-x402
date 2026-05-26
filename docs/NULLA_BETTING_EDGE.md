# Nulla Betting Edge — Dark Null Degen Primitives for Sealed Picks and Alpha Protection

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) Devnet design only. No audit. mainnet_ready = false.

---

## ELI5

Pick is locked before the match. Pay to reveal it. Copy-bots get bait. After the match, everyone can verify we didn't fake the call.

---

## What This Is

A set of cryptographic primitives that lets Nulla run a provably honest signal and alpha service. Every pick is sealed in a hash commitment before the event. Subscribers pay a small x402 fee to unlock the reveal. Non-paying copy-bots are served worthless decoys — and their payment becomes protocol revenue. Post-game, the commitment is public and verifiable by anyone.

This is not gambling infrastructure. There are no odds-makers, no pooled bets, no guaranteed returns, no casino mechanics. It is a credibility and access-control layer for an analyst publishing picks.

---

## The Full Flow

```
1. Analyst locks pick before kickoff
   → public_commitment_hash published on-chain / Telegram

2. Subscriber pays 0.001 SOL via x402
   → receives: pick side + confidence + odds snapshot hash

3. Copy-bot tries without subscriber credential
   → receives: decoy reveal (useless fake)
   → pays: sniper tax (0.001 SOL → protocol revenue)

4. User buys hint tier from clue ladder
   → tier 1: vague directional clue
   → tier 2: formation / injury context
   → tier 3: full model signal

5. Match ends — post-game reveal posted to proofboard
   → commitment_hash verified against sealed pick
   → anyone can confirm pick was sealed before kickoff
   → analyst wallet never published — only hashed

6. Solver who closed expired chaff or did protocol job
   → earns fee rebate receipt
   → redeemable for future priority routing
```

---

## Crates

### `sealed-pick-x402-wall` — 9 tests

The core sealed pick protocol. Analyst seals a pick with a cryptographic commitment before the event. Subscribers pay to get the reveal after the event starts.

**What it proves:**
- Public commitment hash is derived entirely from the sealed pick data — cannot be forged retroactively
- Raw pick side is never stored in the public commitment — only a hash of all fields combined
- Wrong subscriber is rejected at the reveal step
- Duplicate reveal replay is rejected
- The reveal can be independently verified against the original commitment

**Why it matters:**
Any analyst can post a commitment hash before a match and charge for the reveal after. The commitment is binding — they cannot change the side they "called" after seeing the result. This is cryptographic credibility, not trust.

---

### `copy-sniper-tax-trap` — 5 tests

Turns copy-bots from a threat into a revenue source. The public alpha feed contains a mix of real commitments and decoy commitments. Real subscribers have a credential that routes them to the real reveal. Unknown bots paying x402 get a decoy — and their payment is split between protocol and seller.

**What it proves:**
- Valid subscriber credential routes to real reveal
- Unknown party without credential receives decoy
- Decoy reveal does not verify against the real pick commitment (cannot be used to reconstruct the real call)
- Sniper tax receipt minted with 10% protocol fee and 90% seller fee

**Why it matters:**
Copy-bots currently have no cost. They watch wallets, mirror trades, and extract value for free. This primitive puts a price on guessing. The more they probe, the more they pay. Wrong probes pay the protocol.

---

### `hint-ladder-market` — 5 tests

A clue ladder for sealed picks. Each tier unlocks more context about the sealed pick. Tier 1 is cheap and vague. Tier 3 is expensive and specific. The pot grows with every hint purchase. Fees split automatically between seller and protocol.

**What it proves:**
- Hints cannot be purchased before payment
- Higher tier index always means more revealing
- Duplicate purchase of same tier is rejected
- Pot grows with each purchase
- Fee split is correct: configurable seller percentage, remainder to protocol

**Use case:**
Before a big match, Nulla posts a sealed pick and three hint tiers. Tier 1 (500 lamports): "Home advantage is a factor." Tier 2 (1,500 lamports): "Starting 11 has no key absences." Tier 3 (5,000 lamports): "Model confidence 4/5, implied probability 62%." Subscribers buy as much context as they want. The pick itself stays sealed until after the event.

---

### `betting-proofboard` — 6 tests

Public board of sealed picks with post-game verification. Pre-game entries record the commitment hash, event slot, and analyst identity (hashed — never raw wallet). Post-game entries attach the reveal hash and mark the entry as verified.

**What it proves:**
- Pre-game commitment accepted and stored correctly
- Post-game reveal verified against original commitment
- Stale reveals (past deadline) are detected and flagged
- Fake reveals that don't match the original commitment are rejected
- Analyst wallet identity is hashed — raw wallet never appears in the board
- Paid user count increments correctly

**Why it matters:**
The proofboard is the auditable history. After a season, anyone can verify which picks were sealed before which events, how many paid subscribers received each reveal, and whether any reveals were late or fake. This is the credibility record.

---

### `fee-rebate-for-solvers` — 5 tests

Protocol jobs (close expired chaff, verify receipt roots, refresh fee weather) earn fee rebate receipts. Accumulate receipts for priority routing access or fee discounts.

**What it proves:**
- Valid job completion creates a rebate within cap
- Expired rebates cannot be claimed
- Rebate cannot exceed the declared cap
- Duplicate job cannot earn double rebate
- Receipt hash is deterministic

---

### `betting-alpha-receipts` — 8 tests

The betting-market equivalent of `dark-alpha-receipts`. Session → commitment → paid reveal, scoped to sports and esports markets. Market identity stored as SHA-256 hash only — raw market ID never in any receipt.

**What it proves:**
- Session hash deterministic from (salt, analyst, season)
- Market commitment covers all fields — changing any one changes the hash
- Wrong subscriber rejected
- Raw market ID absent from reveal receipt (hash-only storage)
- Confidence bucket and odds snapshot are both bound into the commitment

---

### `nulla-betting-edge-demo` — demo binary

Runs the complete DARK_NULL_BETTING_DEGEN_EDGE_V1 flow end-to-end and writes evidence to `dist/nulla/NULLA_BETTING_EDGE_DEMO.json`.

```bash
cargo run -p nulla-betting-edge-demo --bin nulla_betting_edge_demo
```

**Output confirms:**
1. Pick sealed before event — public commitment hash published
2. Real subscriber paid and received reveal — commitment verified, raw side absent
3. Copy-sniper trapped — decoy served, sniper tax paid, decoy invalid against real commitment
4. Hint tier purchased — tier 2 reveals more, pot grows, fees split 90/10
5. Proofboard updated — post-game reveal verified, analyst wallet hidden
6. Solver claimed fee rebate receipt
7. Betting alpha receipt — raw market absent, reveal verifies

All 7 steps: proven.

---

## Additional Degen Primitives in This Release

### `fee-weather-market` — 8 tests

Solana has "fee weather." Some writable accounts are hot (high priority fee demand). Some are cold and cheap. This crate scores account heat, computes route weather, selects the coldest route, and mints a savings receipt when a cheaper path is found.

**Use case:** Before a large swap, check fee weather on the candidate routes. If Route A is 4x hotter than Route B for the same output, take Route B. Savings receipt minted. Protocol takes 10% of verified savings.

---

### `ritual-mev-insurance` — 7 tests

User pays a small premium for a protected send. If the transaction lands outside the expected slot window or with slippage above the declared maximum, a claim coupon is issued for a refund or free-retry credit.

**Use case:** Bettors and signal subscribers hate missing a price window. "Protected send" gives them a product: pay 0.0005 SOL premium, get guaranteed-within-bounds delivery or a credit. No false promises about defeating MEV — just a transparent insurance model.

---

### `token-arcade-factory` — 7 tests

Token-2022 supports many extensions (Transfer Hook, Transfer Fee, Memo Transfer, CPI Guard, Non-Transferable, etc.) but some combinations are incompatible. This factory checks compatibility and estimates launch cost.

**Templates:**
- Meme token with fee (Transfer Fee + Metadata)
- Hunt token with hook (Transfer Hook + Memo Transfer)
- Soulbound badge (Non-Transferable + Metadata)
- Hint-pass token (Transfer Hook + Transfer Fee)
- Ritual-bound token (Transfer Hook + Memo Transfer + CPI Guard)

**Use case:** Pick a template, launch a Token-2022 experiment for ~0.01 SOL in rent instead of 2–5 SOL for a custom program deploy. The factory checks extension compatibility before launch so you don't waste rent on a broken mint.

---

### `rent-graveyard-index` — 6 tests

Public leaderboard of dead Solana accounts with reclaimable rent. Score each grave by lamports and idle time. Rank and publish. Bounty is 10% of recovered lamports to the closer.

**Use case:** "Top 100 dead accounts this week — 0.12 SOL recoverable from your wallet." Degens hunt graves, close them, climb the leaderboard, earn. The index makes the graveyard visible and competitive.

---

### `blink-work-board` — 6 tests

Blink-based on-chain job board. Jobs are hash commitments with a proof requirement and a SOL reward. Workers complete the job by submitting the proof. Each job is a Blink URL.

**Jobs:** Close expired chaff, solve ritual messages, reveal alpha capsules, verify receipt roots, refresh fee weather, fill shape pools.

**Use case:** Post a job as a Blink link. Anyone who does the work and submits valid proof claims the reward. No escrow service. No off-chain coordination. The link is the job board and the payment system.

---

### `shape-subscription` — 6 tests

Pay to make your transactions look like everyone else's. A shape pass makes your transaction fingerprint blend into the common ritual skeleton. K-anonymity scored: how many other transactions look identical to yours.

**Use case:** Before posting a signal or executing a swap, buy a shape pass. Your transaction gets wrapped in the common 5-instruction ritual skeleton with chaff filler. Copy-snipers watching the mempool see one of hundreds of identical shapes, not your specific intent.

---

### `p-token-roi-bot` — 6 tests

Given your daily transfer volume, this computes whether migrating to P-token account format (SIMD-0266) is worth the engineering cost. Returns daily CU saved, lamports saved, break-even in days, and a migration checklist.

**Numbers (from helius.dev/blog/solana-p-token):**
- Transfer: 79 CU vs 4,645 CU legacy (98.3% reduction)
- TransferChecked: 111 CU vs 6,200 CU legacy (98.2% reduction)
- CloseAccount: 120 CU vs 4,240 CU legacy (97.2% reduction)

**Use case:** Paste your token volume. Get a modelled ROI before writing migration code.

---

### `confidential-amount-watch` — 6 tests

Checks the readiness of the Token-2022 Confidential Transfer extension. NOT claiming it's live — this is a readiness checker and compatibility matrix. Guards against live/production claims in downstream docs.

**Why it exists:** Confidential Transfer hides amount, not route. Combined with a ritual gate, it enables "you can see the ceremony, not the size." This crate ensures that capability is documented accurately and cannot be overclaimed.

---

## What Is NOT This

- Not a sportsbook. No pooled bets. No odds-making. No guaranteed returns.
- Not a casino. No house edge products. No random outcome mechanics without review-grade VRF.
- Not a copy-trade tool. The sniper trap is defensive — it reveals nothing real to bots.
- Not a financial advisor. Picks are analyst output. Past sealed picks do not predict future results.
- Not production. devnet only. No audit. mainnet_ready = false.

---

## Run It

```bash
# All tests
cargo test --workspace

# Demo binary
cargo run -p nulla-betting-edge-demo --bin nulla_betting_edge_demo

# Claim scanner
node scripts/check-degen-claims.mjs
```

---

*NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false*
