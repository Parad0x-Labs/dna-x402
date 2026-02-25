# PROGRAMMABILITY READINESS REPORT

Generated: 2026-02-17T11:27:45.306Z
Base URL: http://127.0.0.1:55789
Cluster: devnet
Mode: local
Anchoring expected: true
Overall: PASS

## Environment
- Git commit: bd2939b332c79dbad5c604fc8adb5aca52fe1bb0
- Git dirty: true
- Node: v20.20.0
- npm: 10.8.2
- Solana CLI: solana-cli 3.0.15 (src:42c10bf3; feat:3604001754, client:Agave)

## Primitive Matrix

| Primitive | 402 Flow | Pay Verify | Receipt Verify | Anchor Confirm | Fee Correct | Tx-Size Budget | Pause Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixed_price_tool | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| usage_metered_tool | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| surge_priced_tool | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| english_auction | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| dutch_auction | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| sealed_bid_commit_reveal | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| prediction_market_binary | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| reverse_auction | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| subscription_stream_gate | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| bundle_reseller_margin | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

## Tx/CU
- Single anchor bytes: 244
- Single anchor ix data bytes: 34
- Single anchor accounts/signatures: 4/1
- Single anchor ALT: true
- Batch(32) bytes: 1230
- Compute single/batch32: 13556/19386

## Analytics Semantics
- FAST count: 20
- VERIFIED count: 10
- VERIFIED <= FAST: PASS
- Definition: VERIFIED means fulfilled receipt with anchored=true and verificationTier=VERIFIED (on-chain anchor confirmed).

## Invariant Notes
- Rate limit guard: PASS
- Pause flags: PASS
- Payment verifier reason: wrong mint: expected usdc-mint
- Payment verifier reason: wrong recipient: expected recipient-wallet
- Payment verifier reason: underpaid: observed 20 expected >= 100
- Payment verifier reason: payment proof too old
- Payment verifier reason: wrong recipient: wrong-recipient

## Primitive Signatures
- fixed_price_tool: payment=netting-ledger, anchor=4VyAtvQyu2WmPnqDX3Bs2KNodZrDkwEYhqfwBaoTmao4DHq9Fcvcyn8NEhauszmVNBFJXhfmT9iY93x5SerfmJA2, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- usage_metered_tool: payment=netting-ledger, anchor=3jfd6N61Fx8iQTpDVD51km162p1tPrEcb61Km2rzy1mTnMMsRhkg4Qv8ZbW4hwmyULLZGQVk3353pB4TSmL4hdd4, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- surge_priced_tool: payment=netting-ledger, anchor=2aRXNQf99AUow19UxRRnBZfJWEJsWRDZpb4np2mE72DMS2GbL1zWE6zr8q677HgDGuobVK9nwiy4gxF7yu78zWyn, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- english_auction: payment=netting-ledger, anchor=46rmmwpiKisYzPoTx1xYtCW7Gavj5sgDkugtZgHMGu9Fi78Qw6ZcuUYWKdSavt72gM1xvsvK8ezbppHLrgkL9fKC, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- dutch_auction: payment=netting-ledger, anchor=ZWR7U2z7ngkntGsaUFWJc5Vk5rZovzg2odevSA2H6wPjnuaAUjUivDePF5pcg7C3SR5yb18DbhMBbJvFJviL3g5, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- sealed_bid_commit_reveal: payment=netting-ledger, anchor=2uvsXw3b6L1Y8XhoA8AVtJ6j5ezieJ55skQ2LvUZ9iw2HuMDEzaZrrMd2KDAasLgn6FACREZQ8H7ioytRe8KDyef, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- prediction_market_binary: payment=netting-ledger, anchor=5N2BdYkecyLtWgjU9CQsn6XdUSRAQPNxjFF1oNZEDb7vVT8AHC7umQXgUBkkDTp8udBbBENtv74t9mYvMSQFUFQa, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- reverse_auction: payment=netting-ledger, anchor=4o8CCbfqfh9aE1zHM3c7LV7oc2AywTNF1R1T5rNBgdPZf7gkRG8r7pyiz86fE6uQwrSikJKVCXGppKjB8bL98Bmm, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- subscription_stream_gate: payment=stream-959fb18e82c8ba655862235833d1df3da941c30c, anchor=3xfF4PEiPnhjskP1szYk1a7Pkw7yx43yvhcAYNLRcrdxzfXavvDNvVB2AY3ZszZWm376bukXBFRcM5b86d3Rxtqb, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035
- bundle_reseller_margin: payment=netting-ledger, anchor=2AdW4sf2ZXoZqUQXjQTq7fyve5twMBo9d6mdeK1m2GVaCBmXTyUNq2SzxabhXpkwLGdGNTqX5jSHdfqUuqHTtvgX, bucket=5CBtaYDM8THUnQYeagYhyXNDycGNsKCHNcFfXykGSYyQ, bucketId=492035

## Boundary
- Seller-defined logic: pricing, auction resolution, market strategy.
- Protocol rails: payment verification, receipt integrity, anchoring confirmation, and market safety controls.
- x402 flow: unpaid request returns 402 requirements, client pays, retries, then receives 200 + receipt.