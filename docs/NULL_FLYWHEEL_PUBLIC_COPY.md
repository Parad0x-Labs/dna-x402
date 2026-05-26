# NULL Flywheel Vault — Community Rewards from Protocol Fees

![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red) Devnet design only. No audit. mainnet_ready = false.

NULL mint: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`

---

## ELI5

A slice of every premium fee — signal reveals, risk checks, hint tiers, sniper tax — flows into a rewards vault. Execution is randomized so nobody can front-run the timing. Every conversion is a public receipt. The vault funds community rewards.

---

## How It Works

**Five steps, plain English:**

**1. Premium service fees are collected by the protocol.**

When agents or users access premium features — signal reveals, alpha access, sniper traps, hint tiers, ritual gates — the protocol charges a fee. These fees are the sole input to the flywheel.

**2. A small slice (0.05%) routes to a community rewards vault.**

Five basis points of each qualifying fee event flow into a `$NULL` utility inventory. This is a fixed, capped allocation set at launch. The vault is program-controlled — no individual can withdraw from it unilaterally.

**3. Execution timing is randomized and publicly committed — nobody knows when.**

Before any conversion happens, the vault publishes a commitment hash on-chain. The actual execution slot is randomly selected within a future window. Nobody — including the protocol operators — can predict or influence the exact execution slot. This means the timing cannot be front-run.

**4. Every conversion is a public receipt — verifiable by anyone.**

When execution completes, a receipt is written on-chain. The receipt contains the commitment hash, the revealed seed (so you can verify the pre-commitment), the execution slot, and the destination. You do not need to trust anyone — you can verify each execution against its pre-published commitment.

**5. The vault accumulates as a rewards warchest for community distribution.**

All converted `$NULL` sits in the RewardsVault — a community warchest. How those rewards are distributed is governed by a separate, community-controlled distribution program. The flywheel only fills the vault; it does not decide who gets what.

---

## What You Can Verify

Every execution is independently verifiable. Here is what is publicly available:

| Item | What It Proves |
|---|---|
| **Commitment hash** | The execution slot was committed to before it happened — no post-hoc selection |
| **Execution receipt** | The conversion happened at the stated slot, using the committed seed |
| **Epoch aggregate** | Total execution count for the period; all receipts are accounted for |

No trusted intermediary is required to verify any of these. All data is on-chain.

---

## What We Do Not Claim

We are explicit about what this system is not and what it does not promise:

- **No price outcome is guaranteed.** The flywheel does not seek, imply, or promise any effect on the market price of `$NULL` or any other asset.
- **No rewards are guaranteed.** The vault accumulates based on protocol usage. If fee volume is low, vault accumulation is low. There is no floor, no minimum, and no promise of a specific reward amount.
- **Not a yield product.** Holding `$NULL` does not entitle anyone to vault rewards. Reward distribution is a separate, governance-controlled program.
- **No buyback.** This is a premium-fee conversion with public receipts. It is not a repurchase program, a treasury buyback, or any equivalent mechanism.

---

## FAQ

**Is this a buyback?**

No. A premium-fee conversion routes a fraction of collected fees into a utility inventory stored in a program-controlled vault. There is no repurchase agreement, no promise to acquire tokens at any price, and no market intervention. It is a fee-to-vault conversion with public receipts.

**Does burning happen?**

No. The burn vault is disabled by default. No `$NULL` is sent to any burn address in the default configuration. Enabling a burn allocation requires an explicit on-chain governance vote, a proposal specifying the exact burn fraction, quorum and approval, and a minimum 7-day timelock. There is no automatic burn mechanic of any kind.

**Can the allocation rate be changed?**

Only through on-chain governance. There are no admin keys or multisig overrides that can alter the `allocation_bps`, execution caps, or destination policy at runtime.

**Who controls the RewardsVault?**

The RewardsVault is a program-controlled account. No individual wallet can withdraw from it. Distributions are handled by a separate reward distribution program with its own governance process.

**External review status**

No. This is a devnet design. No security audit has been performed. Do not treat this as production-ready software.

---

## Disclosure

This document is for informational purposes only. Nothing here constitutes financial advice, an offer of securities, a promise of returns, or a representation about token value. The NULL Flywheel Vault is a fee-routing utility for community rewards. It is not a financial product and makes no promises about outcomes.

---

> ![Status: NOT_PRODUCTION](https://img.shields.io/badge/status-NOT__PRODUCTION-red)
>
> **NOT_PRODUCTION — devnet only — no audit — mainnet_ready = false**
>
> NULL mint: `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`
