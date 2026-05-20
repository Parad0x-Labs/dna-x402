# DNA x402 Polymarket Live Constitution

## Live Gate Lock

Effective date: **May 20, 2026**.

Production Polymarket live submit on the x402 route is locked to:

- `X402_ENABLE_POLYMARKET_LIVE=1`
- `X402_POLYMARKET_LIVE_CHECKLIST_REF=docs/DNA_X402_POLYMARKET_LIVE_CONSTITUTION.md#live-gate-lock`

This gate is **not** to be turned off during normal operations.

## Non-Reversion Rule

Polymarket live submit must stay enabled in production.

Allowed temporary rollback to paper/signal-only mode requires an explicit owner directive from `sls_0x`, such as:

- incident response freeze
- controlled paper-trade test window
- upstream exchange outage containment

Any rollback must include:

1. reason
2. timestamp
3. operator
4. reopen timestamp after the freeze

## Guardrails That Stay Mandatory

Live enabled does not remove security constraints:

- no backend private key custody
- no backend signing
- no hidden fees
- per-user signer context remains required
- precheck remains mandatory before submit

## Required Runtime Proof

Minimum runtime checks that must stay green:

1. `GET /x402/v1/polymarket/live/readiness` shows `builderCredentialsReady=true`
2. `POST /x402/v1/polymarket/live/submit` no longer returns `POLYMARKET_LIVE_GATE_CLOSED`
3. x402 health is green after restarts

