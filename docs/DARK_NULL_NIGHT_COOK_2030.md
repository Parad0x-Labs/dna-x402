# Dark Null Night Cook 2030
## Overview of all 17 Core Primitives + Extended Stack

> **North Star:** Dark Null is a private permission system for AI money.
> Users give agents caveated spending rights, not custody.

---

## Legend

- ✅ Implemented (Rust crate exists, tests passing)
- 📋 Doc-only (design complete, code pending)

---

## Primitive 1 — Dark Kernel / Rentless Program OS ✅

**Problem:** Every Solana program pays rent for a per-module PDA. With 50 modules, that's 50 minimum-rent accounts.

**Invention:** A single kernel program stores all module ABIs as versioned binary data in one checkpoint account. No per-module PDA; modules loaded from calldata.

**Rust modules:** `crates/dark-module-abi`

**Tests:** 14 — ABI determinism, version bump, upgrade authority, redaction.

**Demo command:**
```
cargo test -p dark-module-abi
```

**Rent impact:** Save ~0.002 SOL × module count vs. per-module PDA pattern.

---

## Primitive 2 — Agent Spending Macaroons v2 ✅

**Problem:** Giving an AI agent wallet access means handing over a signing key — catastrophic if compromised.

**Invention:** Layered macaroon tokens with caveats baked in: max spend, asset mint, expiry slot, recipient allow-list. The agent never holds a key — it holds a capability proof.

**Rust modules:** `crates/dark-macaroons`, `crates/caveat-engine`, `crates/dark-capability-registry`

**Tests:** 11 — caveat enforcement, third-party discharge, delegation chain.

**Demo command:**
```
cargo test -p dark-macaroons -p caveat-engine
```

**Rent impact:** No per-caveat PDA; caveats travel in transaction memo.

---

## Primitive 3 — Ghost SPL Ledger v2 ✅

**Problem:** Every new user needs a token account (0.002 SOL). With 10 k agents, that's 20 SOL just to open accounts.

**Invention:** A shared ledger PDA stores balances as a hash-map keyed by nullifier commitment. No per-user token account until actual withdrawal.

**Rust modules:** `crates/ghost-spl-ledger`

**Tests:** 8 — balance credit, debit, overflow guard, nullifier binding.

**Demo command:**
```
cargo test -p ghost-spl-ledger
```

**Rent impact:** 0 rent for users who never withdraw; 1 shared PDA amortised across all users.

---

## Primitive 4 — Receipt Rollup Without Rollup v2 ✅

**Problem:** Every agent action produces a receipt. 1000 receipts = 1000 PDAs = ~2 SOL/day in rent.

**Invention:** Receipts are hashed into a Merkle root and checkpointed as a single PDA per epoch. Off-chain archive holds the leaves.

**Rust modules:** `crates/receipt-rollup-lite`, `crates/dark-poseidon-tree`

**Tests:** 6 — root determinism, leaf inclusion, epoch boundary.

**Demo command:**
```
cargo test -p receipt-rollup-lite
```

**Rent impact:** 1000 receipts → 1 checkpoint PDA (~0.002 SOL). Saves >1.998 SOL/1000 receipts.

---

## Primitive 5 — Compute Coupon Market ✅

**Problem:** CU prices spike unpredictably. Agents that need guaranteed execution can't plan costs.

**Invention:** Off-chain coupon market where users pre-sell future CU slots at a fixed price. Coupons are verifiable receipts — no PDA per coupon.

**Rust modules:** `crates/compute-coupon`, `crates/compute-coupon-market`

**Tests:** 7 — coupon generation, double-use prevention, market clearing.

**Demo command:**
```
cargo test -p compute-coupon-market
```

**Rent impact:** No per-coupon PDA; coupons are memo-carried receipts.

---

## Primitive 6 — Writable Account Fee Heatmap ✅

**Problem:** Frequently written accounts cost more in write-lock fees during congestion.

**Invention:** Off-chain heatmap tracks write-frequency per account. Hot accounts routed to less-contested slots; cold paths kept clean.

**Rust modules:** `crates/account-fee-heatmap`

**Tests:** 6 — heat update, hot/cold classification, routing decision.

**Demo command:**
```
cargo test -p account-fee-heatmap
```

**Rent impact:** Avoids 2–5× fee surcharge on high-frequency accounts.

---

## Primitive 7 — Nullifier Bank Load Balancer v2 ✅

**Problem:** A single nullifier bank PDA becomes a write bottleneck at high throughput.

**Invention:** Multiple nullifier bank shards — hash of nullifier determines shard. Epoch roll-over handled by planner crate.

**Rust modules:** `crates/nullifier-bank-planner`, Solana program `programs/dark_nullifier_banks`

**Tests:** 6 — shard assignment, epoch rollover, bank exhaustion guard.

**Demo command:**
```
cargo test -p nullifier-bank-planner
```

**Rent impact:** Prevents epoch-rollover cost spikes; amortises bank rent across shards.

---

## Primitive 8 — Shape Pool Marketplace ✅

**Problem:** Transactions with unique shape fingerprints are trivially de-anonymised on-chain.

**Invention:** Shared transaction skeletons ("shapes") brokered off-chain. Multiple unrelated agents reuse the same shape, blending into a crowd.

**Rust modules:** `crates/shape-pool`

**Tests:** 7 — shape hash, shape reuse, fingerprint collision score.

**Demo command:**
```
cargo test -p shape-pool
```

**Rent impact:** Shared tx skeleton reduces per-tx overhead; no per-shape PDA.

---

## Primitive 9 — ALT Fog Vaults ✅

**Problem:** Address Lookup Tables (ALTs) cost 0.001 SOL each. One per session is expensive.

**Invention:** Fog vault crates maintain reusable ALT sets. ALTs are pre-loaded with common hot addresses and shared across agents.

**Rust modules:** `crates/alt-fog-vault`, `crates/alt-fog-router`

**Tests:** 6 — vault sharing, fog routing, staleness pruning.

**Demo command:**
```
cargo test -p alt-fog-vault
```

**Rent impact:** Reusable fog sets amortise ALT cost across sessions. Each ALT serves 100+ agents.

---

## Primitive 10 — Useful Chaff v2 ✅

**Problem:** Privacy transactions need noise transactions. Naive noise wastes SOL.

**Invention:** Chaff transactions carry useful micro-work (e.g. oracle price updates, heartbeat pings) so the rent/fee cost is recovered by the chaff producer.

**Rust modules:** `crates/useful-chaff-planner`, Solana program `programs/dark_chaff`

**Tests:** 6 — chaff work scoring, profitability gate, reclaim path.

**Demo command:**
```
cargo test -p useful-chaff-planner
```

**Rent impact:** Chaff producers earn back rent via micro-work rewards.

---

## Primitive 11 — Intent Capsule v2 ✅

**Problem:** Expressing "I want to buy X at most Y price" requires storing state on-chain, costing rent.

**Invention:** Intent capsules are signed off-chain messages with a commitment hash. Broadcast via Blink. Matched off-chain; only the settlement hits the chain.

**Rust modules:** `crates/intent-capsule`, `crates/dark-blink-intent`

**Tests:** 7 — capsule hash, slot expiry, settlement proof.

**Demo command:**
```
cargo test -p intent-capsule
```

**Rent impact:** No PDA per intent; only one settlement account per matched pair.

---

## Primitive 12 — Proof of No-Custody Capsule 📋

**Problem:** Proving an agent does NOT hold a key (for regulatory or trust purposes) is currently impossible.

**Invention:** Multi-party commitment scheme: agent signs a hash that proves it could not have derived the private key. Verifiable off-chain; capsule pinned to chain as a memo.

**Rust modules:** _(pending)_

**Tests:** 6 planned

**Demo command:** TBD

**Rent impact:** Off-chain proof; no PDA required.

---

## Primitive 13 — Solana Fee Firewall v2 📋

**Problem:** A compromised agent can drain a wallet via fee escalation (priority fee attacks).

**Invention:** A firewall instruction prepended to every agent transaction. Checks max-fee policy stored in a single shared PDA. Reverts the transaction if fees exceed the limit.

**Rust modules:** _(pending)_

**Tests:** 0 planned

**Demo command:** TBD

**Rent impact:** Prevents rent bombs from malicious fee escalation.

---

## Primitive 14 — Dark Session Netting ✅

**Problem:** 100 micro-payments = 100 on-chain transactions = 100 × fee overhead.

**Invention:** Payments within a session are netted off-chain. Only the net settlement hits the chain at session close. One transaction per session, regardless of internal payment count.

**Rust modules:** `crates/dark-session-netting`

**Tests:** 7 — net balance, overflow guard, session hash binding.

**Demo command:**
```
cargo test -p dark-session-netting
```

**Rent impact:** 100 spends = 1 settlement hash. Saves 99 transaction fees per session.

---

## Primitive 15 — Dispute Receipt Oracle ✅

**Problem:** Off-chain agents disagree on a trade outcome. Bringing the dispute on-chain requires a per-dispute PDA.

**Invention:** Disputes are encoded as hash commitments. The oracle posts a single signed resolution to a shared oracle log PDA. No per-dispute state.

**Rust modules:** `crates/dispute-receipt-oracle`

**Tests:** 6 — dispute hash, oracle signature, resolution log.

**Demo command:**
```
cargo test -p dispute-receipt-oracle
```

**Rent impact:** No per-dispute PDA; shared oracle log amortises across all disputes.

---

## Primitive 16 — Feature Commit-Reveal ✅

**Problem:** Announcing a new agent feature on-chain before launch reveals the strategy to competitors.

**Invention:** Feature hash committed on-chain at T-0. Feature itself revealed at T+N via a reveal transaction. Verifiable that the feature was decided before market move.

**Rust modules:** `crates/feature-commit-reveal`

**Tests:** 6 — commit hash, reveal verification, pre-reveal opacity.

**Demo command:**
```
cargo test -p feature-commit-reveal
```

**Rent impact:** No per-feature PDA; commit stored as memo; reveal is a single instruction.

---

## Primitive 17 — Dark Blink Rituals ✅

**Problem:** Blink-based actions lack verifiable proof that the user held the required credential at time of click.

**Invention:** Blink payload includes a macaroon receipt hash. The Blink verifier checks the hash before surfacing the action. No chain state per blink click.

**Rust modules:** `crates/dark-blink-intent`

**Tests:** 7 — blink hash, credential gate, replay resistance.

**Demo command:**
```
cargo test -p dark-blink-intent
```

**Rent impact:** No chain state per blink; credentials verified off-chain.

---

## Extended Primitives (Night Cook Additions) ✅

### 18 — Rent Bounty Hunting (`crates/rent-bounty-hunter`)
Reclaims lamports from expired/abandoned accounts. Finders earn a bounty percentage.

### 19 — Copy-Sniper Poison Receipts (`crates/poison-receipts`, `crates/copy-sniper-sim`)
Fake signals with embedded nullifiers detect and poison copy-traders. 11 tests.

### 20 — Strategy Cloak Delays (`crates/strategy-cloak-delay`)
Off-chain timing obfuscation for signal release. No on-chain state.

### 21 — Degen Session Loss Fuse (`crates/session-loss-fuse`)
Off-chain circuit breaker: halts agent if session loss exceeds threshold.

### 22 — Dark Tip Notes (`crates/dark-tip-notes`)
Bearer tip notes with nullifiers instead of PDAs. 6 tests.

### 23 — PvP Prediction Receipts (`crates/pvp-prediction-receipts`)
Commit-reveal predictions for on-chain PvP games. No per-prediction PDA.

### 24 — Dark Gift Notes (`crates/dark-gift-notes`)
Private gift-card style bearer notes. No per-gift PDA.

### 25 — Model Output Receipts (`crates/model-output-receipts`) ✅
Verifiable binding of AI model output to a receipt. Proves which model produced a signal. 6 tests.

### 26 — Public Puzzle Generator (`crates/public-puzzle-generator`) ✅
Generates viral on-chain puzzles for marketing. Solution hashes are verifiable. 6 tests.

### 27 — Telegram Command Receipts (`crates/telegram-command-receipts`) ✅
Macaroon-scoped Telegram bot commands. `/pause` always allowed (safety). 6 tests.

### 28 — Degen API Meter (`crates/degen-api-meter`)
Off-chain per-call usage meter. No per-call PDA.

### 29 — Agent Kill Switch (`crates/agent-kill-switch`)
Off-chain revocation registry. Agent stops responding when kill-switched.

### 30 — Alpha Leak Meter (`crates/alpha-leak-meter`)
Off-chain scoring of signal quality over time. No on-chain state per measurement.

---

## North Star

> **Dark Null is a private permission system for AI money.**
> Users give agents caveated spending rights, not custody.
> Every primitive above exists to enforce that guarantee while minimising Solana rent and fee overhead.

---

## Implementation Status Summary

| Category | Count |
|---|---|
| Fully implemented crates | 25+ |
| Test functions | 150+ |
| Solana programs | 4 |
| Doc-only primitives | 2 (Primitives 12, 13) |
| Mainnet-ready | 0 (devnet prototype) |

_All primitives are devnet prototypes. No mainnet deployment has occurred._
