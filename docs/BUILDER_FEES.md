# Builder Fees

Builder fees let integrators monetize services built on DNA x402 while DNA's platform fee stays protected.

Public Beta DNA direct split status: `implemented behind explicit gate`.

Unapproved public direct collection status: `not in beta scope yet`.

## Supported Public Beta Modes

- `display_only`
- `builder_accrual`
- DNA platform fee `direct_split` for approved capped low-risk beta flows only

## Not In Beta Scope Yet

- public direct builder fee collection
- public 10 bps collection without explicit direct split gate approval
- auto-sweep
- backend custody
- hidden fees

## Fee Waterfall

Every fee line is visible and receipt-bound:

- `PROVIDER_AMOUNT`
- `DNA_PLATFORM_FEE`
- `BUILDER_FEE`
- `AFFILIATE_FEE`
- `ALPHA_SUCCESS_FEE`

## Direct Split

Direct split collection is implemented for gated Public Beta fee lines. Finalize requires every required payment proof before issuing a receipt.

Current approved Public Beta direct split scope:

- seller/provider proof
- DNA treasury proof
- low-risk API/data-feed/tool listings
- allowlisted wallets
- tiny caps
- Helius RPC
- Telegram alerts
- explicit `X402_DIRECT_SPLIT_GATE_REF`

Public direct builder fee collection is not in beta scope until counsel review, backup operators, production evidence, and explicit direct split fee gate approval are complete.

## Example Quote Copy

```txt
Seller receives: 99.40 USDC
DNA fee: 0.10 USDC
Builder fee: 0.50 USDC
Total: 100.00 USDC
```
