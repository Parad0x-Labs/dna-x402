# Polymarket Phase 0 Phantom EVM Compatibility

Date: 2026-05-15

## Decision

Phantom EVM is supported for the current Polymarket Agent V1 browser-local signing path.

## Evidence

- Browser-local owner signer connected through Phantom EVM.
- Wallet switched from Ethereum mainnet to Polygon `137`.
- Deposit wallet was derived by the official Polymarket relayer SDK path.
- `POLY_1271` no-submit order signature succeeded.
- Signed fixture recorded `signatureType = 3`.
- Signed fixture recorded maker and signer as the deposit wallet.
- Builder code was attached to the signed order payload.
- No order was posted.
- No pUSD transfer happened.
- Deposit wallet deployment returned a relayer result with transaction hash present.

## Snapshot Files

- `<repo-root>\reports\polymarket-phase0\2026-05-14T21-10-18-000Z-browser-local.json`
- `<repo-root>\reports\polymarket-phase0\2026-05-14T21-10-43-546Z-browser-local.json`

## Remaining Blockers

- Approval batch must be proven with user confirmation.
- pUSD transfer batch must be proven with user confirmation.
- Withdrawal quote -> final confirmation -> withdraw address -> pUSD transfer -> status tracking must be proven before live withdrawals.
- Live order posting remains blocked until funding, approval, balance, allowance, and reconciliation gates are green.
