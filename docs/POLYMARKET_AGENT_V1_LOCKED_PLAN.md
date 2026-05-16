# Polymarket Agent V1 Locked Plan

## Locked V1 Rules
1. No production money movement before Phase 0 passes.
2. No backend private key/session key storage.
3. No backend signing.
4. No hosted unattended trading in V1.
5. V1 copy/auto trading only runs while the user has an active browser session and local signer available.
6. pUSD/USD is the only accounting balance.
7. Solana USDC is the default funding/withdrawal UX.
8. SOL is quote/display-only unless executing a live bridge quote.
9. Polymarket trading uses a user-owned deposit wallet controlled by an owner/session signer.
10. Use deposit wallet as funder with `POLY_1271` / `signatureType = 3`.
11. Exact CLOB v2 maker, signer, funder, API-key, owner/session-signer semantics must be proven by live TS SDK fixture before production.
12. Builder fee is 0 bps at launch.
13. DNA per-order notional fee is off in V1.
14. Alpha fee is 2% of positive finalized copied-lot PnL only.
15. Withdrawals are quote-bound intents.
16. `/withdraw` address creation happens only after final user confirmation, never during quote preview.
17. Withdrawal addresses must never be reused.
18. Compliance blocks restricted trading/copy/monetization/market access. Withdrawals remain available wherever legally possible.
19. No bypass/VPN logic.
20. Internal ledger is reconstructable and is not ultimate source of truth over on-chain/CLOB/bridge state.

## Product Plan
- Master wallet proves website ownership. Polymarket trading uses a user-owned deposit wallet controlled by an owner/session signer.
- Backend may store public addresses, deposit wallet address, settings, signed payload hashes, already-signed payloads for relay, and safe Polymarket data.
- Backend is forbidden from storing owner keys, session keys, seed phrases, decrypted signers, wallet dumps, or signing CLOB orders/pUSD transfers.
- Browser keeps owner/session signer local, shows pUSD as source of truth, discloses active-session copy trading, and requires explicit withdrawal confirmation.
- Withdrawals remain available wherever legally possible. Compliance gates block restricted trading, copy subscriptions, auto-execution, alpha monetization, market access where required, and deposits where legally required. Only legally required sanctions/risk controls may block withdrawals.

## Core Models
- `WithdrawalIntent`: `id`, `userId`, `agentId`, `depositWallet`, `sourceAmountPusd`, `destinationChain`, `destinationToken`, `recipientAddress`, `quoteId`, `quotePayloadHash`, `quoteExpiresAt`, `minReceived`, `estimatedReceived`, `fees`, `slippage`, `withdrawalAddress`, `pUsdTransferTxHash`, `status`, `createdAt`, `updatedAt`.
- `DepositStatus`: `DRAFT`, `ASSET_SELECTED`, `ADDRESS_CREATED`, `TX_DETECTED`, `BRIDGE_PENDING`, `PUSD_CREDITED`, `RECONCILED`, `BELOW_MINIMUM`, `WRONG_CHAIN_OR_UNSUPPORTED`, `FAILED`, `SUPPORT_NEEDED`.
- `WithdrawalStatus`: `DRAFT`, `QUOTED`, `USER_CONFIRMED`, `WITHDRAW_ADDRESS_CREATED`, `AWAITING_USER_TRANSFER`, `PUSD_TRANSFER_SIGNED`, `PUSD_TRANSFER_CONFIRMED`, `BRIDGE_PENDING`, `DESTINATION_RECEIVED`, `RECONCILED`, `QUOTE_EXPIRED`, `ROUTE_UNAVAILABLE`, `LIQUIDITY_EXHAUSTED`, `FAILED`, `SUPPORT_NEEDED`.
- `OrderStatus`: `DRAFT`, `VALIDATED`, `SIGNED`, `SUBMITTED`, `ACCEPTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `EXPIRED`, `REJECTED`, `RECONCILED`.
- `CopyLotStatus`: `OPENED`, `PARTIALLY_CLOSED`, `CLOSED`, `REDEEMED`, `PNL_FINALIZED`, `ALPHA_FEE_ASSESSED`, `ALPHA_FEE_PAID`, `ALPHA_FEE_UNPAID`, `LOSS_NO_FEE`.
- Source-of-truth order: on-chain pUSD/conditional-token balances, Polymarket CLOB orders/fills/positions, bridge `/status`, internal Postgres ledger, UI cache.

## Phase 0 Exit Criteria
- Deposit wallet creation works through the official/current SDK path.
- `POLY_1271 / signatureType 3` order signing works.
- Exact maker/signer/funder/API-key/owner-session semantics are proven and captured in fixture tests.
- Deposit wallet is confirmed as funder.
- Builder code attachment is proven in signed order payload.
- Approval batch and pUSD transfer batch work.
- Withdrawal works: quote -> final user confirmation -> withdraw address -> signed pUSD transfer -> status tracking.
- Phantom/EVM compatibility decision is documented.
- No backend key storage/signing path exists.
- Red tests are in place for all blocker risks.

## Source Checks
- Deposit wallet and `POLY_1271`: https://docs.polymarket.com/trading/deposit-wallets
- Bridge deposit: https://docs.polymarket.com/trading/bridge/deposit
- Supported assets: https://docs.polymarket.com/trading/bridge/supported-assets
- Bridge quote: https://docs.polymarket.com/trading/bridge/quote
- Bridge withdraw: https://docs.polymarket.com/trading/bridge/withdraw
- Bridge status: https://docs.polymarket.com/trading/bridge/status
- Builder fees: https://docs.polymarket.com/builders/fees
- Geoblock: https://docs.polymarket.com/api-reference/geoblock
