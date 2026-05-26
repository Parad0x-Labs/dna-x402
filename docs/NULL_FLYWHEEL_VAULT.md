# NULL Flywheel Vault — Premium-Fee Conversion Layer

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) Devnet design only. No audit. mainnet_ready = false.

NULL mint: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`

---

## ELI5

A slice of every premium fee — signal reveals, risk checks, hint tiers, sniper tax — flows into a rewards vault. Execution is randomized so nobody can front-run the timing. Every conversion is a public receipt. The vault funds community rewards.

---

## 1. What Is The Flywheel

The NULL Flywheel Vault is a premium-fee conversion layer built on top of the x402 payment rail. It is not a trading system, a market-making mechanism, or a price intervention tool.

**How it works at a high level:**

- Premium fees collected by the x402 rail — signal reveals, risk checks, hint tiers, sniper tax, ritual gates — are the sole input to the flywheel.
- A small, capped allocation (0.05% / 5 basis points) of each qualifying fee event is earmarked for `$NULL` utility inventory acquisition.
- Acquired `$NULL` is deposited into the **RewardsVault**, which serves as a community warchest for distribution through separately governed reward programs.
- No funds move automatically to any burn address. No market timing is implied. No return is promised.

**Why `$NULL`?**

`$NULL` is the utility token of the DNA x402 ecosystem. Routing a small fraction of premium fees into a `$NULL` utility inventory creates a link between protocol usage and the community rewards pool. The mechanism is transparent, capped, and verifiable via public receipts.

---

## 2. Config Defaults

All values are set at initialization and require a governance vote to change. There are no admin keys that can alter these at runtime.

| Parameter | Default Value | Notes |
|---|---|---|
| `allocation_bps` | `5` (0.05%) | Basis points of each qualifying fee routed to vault |
| `min_execution_usd` | `$50` | Minimum accumulated amount before execution triggers |
| `min_execution_lamports` | `~137,500,000` | Heuristic at $4,000/SOL — recalculated at runtime via oracle |
| `max_single_usd` | `$250` | Maximum size of any single execution chunk |
| `max_daily_usd` | `$1,000` | Rolling 24-hour execution cap across all chunks |
| `destination` | `RewardsVault` | Default destination for all converted `$NULL` |
| `burn_vault` | `disabled_by_default` | Burn address exists in config but receives nothing unless governance enables it |

**Governance note:** Any change to `allocation_bps`, execution caps, or destination policy requires an on-chain governance vote. No multisig override. No deployer escape hatch.

---

## 3. Fee Sources

The following premium fee types are recognized inputs. All other fee types are excluded.

| Fee Type | Constant | Description |
|---|---|---|
| Signal Reveal Fee | `SignalRevealFee` | Charged when an agent unlocks an encrypted alpha signal |
| Risk Check Fee | `RiskCheckFee` | Charged for on-chain risk scoring of a position or counterparty |
| Hint Tier Fee | `HintTierFee` | Charged for tiered alpha hint access (tier 1–4) |
| Sniper Tax Fee | `SniperTaxFee` | Anti-frontrun tax applied to high-velocity execution agents |
| Ritual Gate Fee | `RitualGateFee` | Charged for access to ritual-bound gated computation |
| Other Premium Fee | `OtherPremiumFee` | Catch-all for future premium fee types; allocation_bps applies equally |

Each fee event emits a `FeeAccrualEvent` with a fee_type discriminant, a lamport amount, and a fee_epoch timestamp. The flywheel accumulator aggregates these events before triggering execution.

---

## 4. Commit-Reveal Schedule

**Why randomize timing?**

If execution happened at a predictable threshold or time, an observer watching the accumulator could front-run the conversion by positioning ahead of it. Commit-reveal scheduling ensures that the execution slot is unknowable until after the commitment window closes.

**How ScheduleCommitment works:**

1. When the accumulator crosses `min_execution_lamports`, the vault generates a `ScheduleCommitment`:
   - `commitment_hash` = `SHA256(seed || nonce || window_start_slot)`
   - `window_slots` = a randomized slot window (default range: 150–600 slots after commitment)
   - `reveal_after_slot` = randomly selected slot within `window_slots`
2. The `commitment_hash` is written to the ledger immediately. The `seed` and `reveal_after_slot` are kept off-chain until reveal time.
3. At `reveal_after_slot`, the vault publishes the seed and executes. Anyone can verify `commitment_hash` against the published seed to confirm no post-hoc manipulation.
4. If a reveal is attempted before `reveal_after_slot`, it is rejected with `EarlyRevealError`.
5. If the seed does not match the committed hash, execution is rejected with `SeedMismatchError`.

**Key properties:**
- `window_slots`: 150–600 (randomized per commitment)
- `reveal_after_slot`: randomly sampled within `window_slots`
- Commitment hash is public; seed is private until reveal
- No keeper, no crank — execution is permissionless once slot is reached

---

## 5. Execution Flow

```
Accumulate
  └─ FeeAccrualEvent arrives
  └─ Add (fee_amount * allocation_bps / 10_000) to accumulator

Threshold Check
  └─ If accumulator >= min_execution_lamports → proceed
  └─ Else → wait

Plan (Chunked, Capped)
  └─ Split accumulated amount into chunks <= max_single_usd
  └─ Verify rolling 24h total + chunks <= max_daily_usd
  └─ If cap would be exceeded → defer remaining to next epoch

Reveal Schedule
  └─ Generate ScheduleCommitment
  └─ Write commitment_hash to ledger
  └─ Wait for reveal_after_slot

Execute
  └─ At reveal_after_slot: publish seed, verify hash
  └─ Execute chunked conversion(s)
  └─ Deposit $NULL to RewardsVault

Mint Receipt
  └─ Emit ExecutionReceipt (hashed amounts only)
  └─ Update epoch aggregate
  └─ Reset accumulator for next cycle
```

---

## 6. Destination Policy

**RewardsVault (default)**

All converted `$NULL` goes to `RewardsVault` by default. This is a program-controlled account, not a personal wallet. Withdrawals from RewardsVault are gated by a separate reward distribution program with its own governance.

**BurnVaultDisabledByDefault**

A `BurnVault` address is present in the config struct but is marked `disabled_by_default`. No routing to this address occurs in any default configuration. The field exists to allow future governance to enable an explicit community-voted burn allocation.

**Enabling burn requires:**
- An on-chain governance proposal specifying `burn_bps` (the fraction to route to BurnVault)
- Quorum and approval threshold defined in the governance program
- A timelock of at least 7 days between proposal approval and activation

There is no auto-burn mechanic. There is no burn triggered by accumulator threshold. Burn is off unless governance turns it on.

---

## 7. Public Receipts

Every execution cycle produces a `redacted_public_receipt`. This receipt is designed to be verifiable without revealing sensitive raw amounts.

**What a receipt contains:**

```rust
pub struct RedactedPublicReceipt {
    pub receipt_id: [u8; 32],          // Unique ID for this execution
    pub commitment_hash: [u8; 32],     // The pre-published commitment
    pub seed_hash: [u8; 32],           // Hash of the revealed seed
    pub fee_epoch: u64,                // Epoch in which fees were accrued
    pub execution_slot: u64,           // Slot at which execution occurred
    pub chunk_count: u8,               // Number of chunks executed
    pub destination_tag: DestinationTag, // RewardsVault or BurnVault
    // Raw lamport amounts are NOT included in the public receipt
}
```

**What is NOT in the receipt:**

- Raw lamport amounts (prevented to avoid MEV leakage in future epochs)
- Individual fee event breakdown
- Wallet addresses of fee payers

**Epoch aggregates:**

At the end of each fee epoch, an `EpochAggregate` is written on-chain containing:
- Total chunk count for the epoch
- Total execution count
- Commitment hashes for all executions in the epoch

Anyone can independently verify that every execution was pre-committed and that the revealed seed matches the committed hash.

---

## 8. Crates

### `null-flywheel-core` — 9 tests

Core accumulator logic, config validation, threshold checks, daily cap enforcement, and chunked execution planning.

| Test | Description |
|---|---|
| `test_allocation_bps_applied` | Verifies 5 bps is correctly applied to a fee amount |
| `test_min_execution_threshold` | Accumulator does not trigger below min_execution_lamports |
| `test_min_execution_triggers` | Accumulator triggers at or above threshold |
| `test_daily_cap_blocks_excess` | Execution deferred when rolling 24h cap would be exceeded |
| `test_daily_cap_resets` | Cap resets after 24h window rolls |
| `test_chunked_plan_respects_max_single` | No chunk exceeds max_single_usd |
| `test_chunked_plan_count` | Correct number of chunks generated for a given amount |
| `test_config_zero_bps_rejected` | Config validation rejects allocation_bps = 0 |
| `test_config_burn_disabled_by_default` | BurnVault not routed unless explicitly enabled |

### `null-flywheel-randomizer` — 6 tests

Commit-reveal schedule generation, early-reveal rejection, and seed-mismatch rejection.

| Test | Description |
|---|---|
| `test_commitment_hash_stable` | Same inputs produce same commitment_hash |
| `test_window_slots_in_range` | reveal_after_slot always within 150–600 slot window |
| `test_reveal_before_slot_rejected` | EarlyRevealError returned if reveal attempted before reveal_after_slot |
| `test_reveal_at_slot_accepted` | Reveal accepted at exactly reveal_after_slot |
| `test_seed_mismatch_rejected` | SeedMismatchError returned if seed does not match commitment_hash |
| `test_commitment_unpredictable` | Two successive commitments differ (nonce is fresh each time) |

### `null-flywheel-receipts` — 6 tests

Execution receipt generation, redacted public receipt format, and epoch aggregate accumulation.

| Test | Description |
|---|---|
| `test_receipt_contains_no_raw_amounts` | RedactedPublicReceipt struct has no lamport fields |
| `test_receipt_commitment_hash_matches` | commitment_hash in receipt matches the one written to ledger |
| `test_receipt_seed_hash_matches` | seed_hash in receipt matches hash of revealed seed |
| `test_epoch_aggregate_increments` | EpochAggregate chunk_count increments with each execution |
| `test_epoch_aggregate_reset_on_new_epoch` | Aggregate resets at epoch boundary |
| `test_destination_tag_correct` | DestinationTag reflects RewardsVault when burn is disabled |

### `null-flywheel-sim` — 4 lib tests + demo binary

End-to-end simulation crate. Runs a configurable volume of fee events through the full pipeline and writes results to a JSON file.

| Test | Description |
|---|---|
| `test_sim_1000_signal_reveals` | 1,000 SignalRevealFee events; verifies accumulator math |
| `test_sim_250_risk_checks` | 250 RiskCheckFee events; verifies chunking under daily cap |
| `test_sim_100_hints` | 100 HintTierFee events; verifies commit-reveal cycle completes |
| `test_sim_mixed_no_cap_breach` | Mixed event set; verifies daily cap not breached |

**Demo binary:**

```bash
cargo run --bin null-flywheel-sim
```

Runs: 1,000 signal reveals + 250 risk checks + 100 hint tiers through the full flywheel pipeline.

Output: `dist/null-flywheel/NULL_FLYWHEEL_SIM.json`

The output JSON contains:
- Total fee events processed
- Total allocations accrued (in lamports, heuristic SOL price)
- Execution count and chunk breakdown
- All commitment hashes and receipts for the simulated run
- Epoch aggregate summary

---

## 9. What Is NOT This

This section is explicit and non-negotiable. The NULL Flywheel Vault:

- **Is NOT a trading mechanism.** It does not place orders on any DEX, AMM, or orderbook.
- **Is NOT a market-making system.** It does not provide or withdraw liquidity.
- **Is NOT a price manipulation tool.** Execution timing is randomized and capped; no outcome with respect to any market price is sought, implied, or expected.
- **Is NOT a guaranteed return product.** No yield, return, or reward is promised to any token holder, fee payer, or protocol participant.
- **Is NOT production.** This is a devnet design document. No audit has been performed. `mainnet_ready = false`. Do not deploy to mainnet without a full security audit and governance approval.

---

## 10. Run It

**Run all tests across all crates:**

```bash
cargo test --workspace
```

**Run tests for a specific crate:**

```bash
cargo test -p null-flywheel-core
cargo test -p null-flywheel-randomizer
cargo test -p null-flywheel-receipts
cargo test -p null-flywheel-sim
```

**Run the simulation demo binary:**

```bash
cargo run --bin null-flywheel-sim
```

Output will be written to `dist/null-flywheel/NULL_FLYWHEEL_SIM.json`. The directory is created automatically if it does not exist.

**Check config validity (no execution):**

```bash
cargo run --bin null-flywheel-sim -- --dry-run
```

---

## Legal / Security Footer

> **NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false**
>
> This document describes a system that has not been audited, has not been deployed to mainnet, and has not been reviewed for legal compliance in any jurisdiction. Nothing in this document constitutes financial advice, an offer of securities, a promise of returns, or a representation about token value. The NULL Flywheel Vault is a fee-routing mechanism for community rewards. It is not a financial product.
>
> NULL mint: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`
>
> ![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red)
