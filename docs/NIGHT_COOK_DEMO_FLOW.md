# Night Cook Demo Flow — 14 Steps

> All steps run on devnet or local test validator. No mainnet SOL required.
> This flow demonstrates the full Dark Null primitive stack end-to-end.

---

## Prerequisites

```
cargo test --workspace          # All local unit tests pass
solana config set --url devnet  # Switch CLI to devnet
```

---

## Step 1 — Boot the Dark Kernel

**What happens:** Deploy the `dark_kernel_lite` program (placeholder) to local test validator.

**What it proves:** Modules can be registered without per-module PDAs. Module ABI is stored in a single checkpoint account.

```
cargo test -p dark-module-abi
```

---

## Step 2 — Mint Agent Macaroons

**What happens:** The operator mints a set of agent macaroons using `dark-macaroons`. Each macaroon specifies: max spend = 0.01 SOL, asset = USDC, expiry = slot + 10 000.

**What it proves:** Agents receive caveated spending rights. No private key is shared. Macaroon can be delegated without escalating privilege.

```
cargo test -p dark-macaroons -p caveat-engine
```

---

## Step 3 — Open Ghost SPL Ledger

**What happens:** The ghost ledger PDA is initialised. 5 simulated users are credited balances off-chain using nullifier commitments — no token accounts opened.

**What it proves:** 5 users can hold balances at zero additional rent cost. The ledger handles credit, debit, and overflow guard.

```
cargo test -p ghost-spl-ledger
```

---

## Step 4 — Issue Compute Coupons

**What happens:** 100 compute coupons are generated and signed by the operator. Coupons are distributed to agents as memo receipts.

**What it proves:** Agents can pre-purchase CU guarantees without any on-chain PDA per coupon. Double-use prevention works via nullifier check.

```
cargo test -p compute-coupon-market
```

---

## Step 5 — Run Chaff Cycle

**What happens:** The `useful-chaff-planner` selects 10 noise transactions. Each carries a useful oracle update. The chaff program records the micro-work on devnet.

**What it proves:** Privacy noise transactions recover their cost via micro-work. Chaff is indistinguishable from legitimate oracle traffic.

```
cargo test -p useful-chaff-planner
```

---

## Step 6 — Submit Intent Capsule via Blink

**What happens:** An agent submits an intent capsule ("buy 10 USDC at max 0.0001 SOL/unit"). The capsule is signed and broadcast as a Blink memo transaction.

**What it proves:** Intent state lives off-chain. Only settlement hits the chain. No per-intent PDA created.

```
cargo test -p intent-capsule -p dark-blink-intent
```

---

## Step 7 — Execute Netted Session Payment

**What happens:** The operator simulates 100 micro-payments within a session. The session netting crate produces a single net hash. One settlement transaction is broadcast.

**What it proves:** 100 micro-payments collapse to 1 on-chain transaction. Session netting saves 99× transaction fees.

```
cargo test -p dark-session-netting
```

---

## Step 8 — Shard Nullifier Banks

**What happens:** 500 nullifiers are generated. The load balancer assigns each to one of 4 bank shards based on hash prefix. Epoch rollover is simulated.

**What it proves:** High-throughput nullifier insertion does not bottleneck on a single PDA. Shard assignment is deterministic and verifiable.

```
cargo test -p nullifier-bank-planner
```

---

## Step 9 — Reclaim Expired Rent

**What happens:** The rent bounty hunter scans a list of abandoned accounts (mocked on devnet). Reclaim transactions are broadcast. Operator earns bounty_bps of reclaimed lamports.

**What it proves:** The system actively reduces on-chain rent waste. Bounty mechanism aligns incentives for rent hygiene.

```
cargo test -p rent-bounty-hunter
node scripts/find-rent-bounties.mjs
```

---

## Step 10 — Deploy Poison Receipts for Copy-Sniper

**What happens:** 3 fake signal receipts are generated with embedded nullifiers. A simulated copy-trader consumes one. The poison is detected and logged.

**What it proves:** Copying agents can be identified and excluded from future signal feeds. No extra chain state required for detection.

```
cargo test -p poison-receipts -p copy-sniper-sim
```

---

## Step 11 — Commit Model Output Receipt

**What happens:** A mock AI model produces a signal. The model output is hashed into a `ModelOutputReceipt`. The commitment is stored as a transaction memo.

**What it proves:** The signal source (model version, prompt policy, input) is verifiably bound to the output hash. The receipt can be audited without revealing model internals.

```
cargo test -p model-output-receipts
```

---

## Step 12 — Launch Public Puzzle

**What happens:** A `ShardAscii` puzzle is generated with message = "DARKNULL2026". The puzzle is posted as markdown to a public channel. First solver to submit the correct solution hash wins a coupon.

**What it proves:** Viral marketing can be run with verifiable fairness. No private keys or secrets are embedded in the puzzle. Solution verification is trustless.

```
cargo test -p public-puzzle-generator
```

---

## Step 13 — Process Telegram Bot Commands

**What happens:** A Telegram bot receives `/signal`, `/bet`, `/pause`, and `/tip` commands from users. Each command is verified against a `CommandReceipt`. `/pause` is approved immediately regardless of scope.

**What it proves:** Bot commands are scope-controlled without storing user state on-chain. The `/pause` safety command can never be gatekept.

```
cargo test -p telegram-command-receipts
```

---

## Step 14 — Run Cost Constitution Check

**What happens:** The cost constitution script scans all source files for forbidden patterns: `per-user PDA`, `per-receipt PDA`, `rent bomb`. It checks each crate has a `lib.rs`. Exits 0 if clean.

**What it proves:** The entire codebase complies with the Dark Null anti-rent-bomb constitution. CI-safe.

```
node scripts/check-cost-constitution.mjs
```

---

## Summary

| Step | Primitive | Proves |
|---|---|---|
| 1 | Dark Kernel | Rentless module registration |
| 2 | Agent Macaroons | Caveated spending, no key sharing |
| 3 | Ghost SPL Ledger | Zero-rent user balances |
| 4 | Compute Coupons | Guaranteed CU, no PDA per coupon |
| 5 | Useful Chaff | Cost-neutral privacy noise |
| 6 | Intent Capsule | Off-chain intent, single settlement |
| 7 | Session Netting | 100 payments = 1 tx |
| 8 | Nullifier Banks | High-throughput, sharded |
| 9 | Rent Bounty | Active rent reclamation |
| 10 | Poison Receipts | Copy-sniper detection |
| 11 | Model Output Receipt | AI signal provenance |
| 12 | Public Puzzle | Verifiable viral marketing |
| 13 | Telegram Receipts | Scoped bot commands |
| 14 | Cost Constitution | Automated rent-bomb check |

_All steps are devnet prototypes. No mainnet deployment implied._
