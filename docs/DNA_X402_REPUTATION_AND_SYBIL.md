# DNA x402 Reputation And Sybil Resistance

Date: 2026-05-15

## Purpose

Wallet-only identity is too weak. Reputation must bind to seller profiles, linked wallets, domains, verified seller status, bond state, receipt history, disputes, refunds, fulfillment quality, and policy strikes.

## Implemented Model

`SellerProfile` tracks:

- primary wallet
- linked wallets
- agent slugs
- verified domains
- optional email/OAuth verification flags
- KYC/KYB state
- bond state
- policy strikes
- disputes and refunds
- fulfilled and failed fulfillment counts
- fulfilled volume
- suspension state

`sellerTrustSnapshot` produces:

- risk tier
- trust badges
- fulfilled-volume confidence
- ranking penalty

## Badges

- `NEW`
- `VERIFIED_DOMAIN`
- `VERIFIED_SELLER`
- `BONDED`
- `FAST_FULFILLER`
- `HIGH_DISPUTE_RATE`
- `POLICY_STRIKE`
- `SUSPENDED`
- `ANCHOR_VERIFIED`

## Rules

- New wallets do not inherit trust automatically.
- Slug changes do not clear profile strikes.
- Reports alone should not auto-kill a seller without thresholds or review.
- Bonded sellers get a badge but slashing remains admin/dispute controlled.
- Suspended sellers cannot publish or quote once policy integration blocks them.
