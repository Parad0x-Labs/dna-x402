# Polymarket Agent V1 Engineering Tickets

## 1. Phase 0 Proof
- Add live TS SDK spike under `x402/labs/polymarket-phase0`.
- Use `@polymarket/clob-client-v2`, `@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk`, and `viem` only inside the Phase 0 lab until audit risk is resolved.
- Prove deposit wallet creation, approval batch, pUSD transfer batch, `POLY_1271` order signing, builder code attachment, and withdrawal quote/confirm/address/transfer/status flow.
- Snapshot exact signed order payload fields and fixture-test maker, signer, funder, `signatureType`, API-key behavior, owner/session signer behavior, and builder code.
- Fail Phase 0 if SDK semantics contradict assumptions or cannot support browser-local signing.

## 2. Bridge/Funding
- Fetch `/supported-assets` live every time before deposit choices. Never hardcode supported tokens/minimums.
- Show Solana USDC first when supported. SOL is optional and quote/display-only.
- Bind quote, withdrawal address, recipient, token, chain, pUSD amount, min received, and quote expiry to one `WithdrawalIntent`.
- Invalidate intent on amount, recipient, token, chain change, or quote expiry.
- Create `/withdraw` address only after final user confirmation. Never reuse withdrawal addresses.
- Track bridge `/status` until pUSD is credited or withdrawal destination funds arrive.

## 3. Deposit Wallet/Trading
- Use deposit wallet as funder with `signatureType = 3 / POLY_1271`.
- Do not hardcode maker/signer/API-key assumptions before Phase 0 verifies exact TS SDK behavior.
- Validate geoblock, market active, orderbook enabled, token ID, side, tick/min size, neg-risk, balance, allowance, stale book, duplicate retry, rate limits, slippage, risk controls, builder code, and active local signer.
- Add idempotency for CLOB submit/cancel.

## 4. Ledger/Reconciliation
- Add Postgres ledger with uniqueness constraints for deposit address creation, withdrawal quote intent, withdrawal address creation, pUSD transfer relay batch, CLOB submit/cancel, copy fanout, ledger write, alpha fee assessment, and receipt write.
- Reconciliation jobs rebuild internal state from on-chain balances, CLOB state, bridge status, and then internal ledger.
- Internal ledger is reconstructable, not ultimate truth.

## 5. Copy Trading
- Copied fill creates lot with alpha/follower IDs, market/token IDs, side, size, entry price, fees, source signal, order/fill IDs, and receipt IDs.
- Partial exits close proportional lots.
- Manual follower exits finalize copied lots.
- Hold-to-resolution waits for redemption.
- Alpha fee is assessed only after positive finalized copied-lot PnL.
- Losing lots become `LOSS_NO_FEE`.

## 6. Safety/Compliance
- Add global trading kill switch, per-user pause, per-agent pause, per-market disable list, bridge outage mode, Polymarket API degraded mode, quote provider degraded mode, reconciliation queue, and admin audit log for emergency destination approval.
- Geoblock/compliance before agent creation, market display where required, manual order, auto-execution, copy subscription, alpha monetization, and deposits where legally required.
- Withdrawals remain available wherever legally possible.
- No bypass/VPN logic.

## 7. Browser UX
- Add deposit wallet onboarding, pUSD dashboard, market browser, manual trade, active-session automation, copy settings, withdrawal intent flow, and public alpha profile.
- Show estimated output and min received before withdrawal.
- Show active-session limitation before copy/auto trading.
- Use wording: deposit wallet, owner/session signer backup, pUSD balance, browser-local signing, active-session automation, estimated output / min received.

## 8. Tests/Regression
- Add blocker tests first for Phase 0 SDK, custody/security, withdrawal intent, fee model, copy ledger, trading validation, and bridge/funding.
- Run cumulative regression after every implemented slice.
- Keep TODO comments only at unsafe boundaries: wallet signing compatibility, CLOB SDK semantics, bridge quote expiry, withdrawal transfer reconciliation.
