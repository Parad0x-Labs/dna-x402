# Polymarket Multi-User Builder Flow Handover

## Scope Completed

This handover covers backend hardening for Polymarket multi-user order flow using:

- one shared server-side builder credential set for header/signing metadata
- per-user deposit wallet signer semantics for each live order
- no backend custody and no backend signing

## What Was Implemented

1. **Phase 0 env alias support + diagnostics**
- [phase0-env.ts](/G:/DNA x402/x402/labs/polymarket-phase0/phase0-env.ts)
- [phase0-browser-server.ts](/G:/DNA x402/x402/labs/polymarket-phase0/phase0-browser-server.ts)
- [`.env.local.example`](/G:/DNA x402/x402/labs/polymarket-phase0/.env.local.example)

Added env alias support:

- `POLY_BUILDER_CODE` -> `POLYMARKET_BUILDER_CODE`
- `POLYMARKET_API_KEY` -> `POLYMARKET_BUILDER_API_KEY`
- `POLYMARKET_API_SECRET` -> `POLYMARKET_BUILDER_SECRET`
- `POLYMARKET_API_PASSPHRASE` -> `POLYMARKET_BUILDER_PASSPHRASE`

Added one-pass missing-var diagnostics and explicit readiness reporting.

2. **Multi-user live precheck module**
- [live.ts](/G:/DNA x402/x402/src/polymarket/live.ts)

Added:

- shared builder env readiness snapshot
- live-order extra env visibility (`POLYMARKET_PRIVATE_KEY`, `DEPOSIT_WALLET_ADDRESS`)
- per-user order precheck wrapper around existing Polymarket validation
- enforced no backend signer material in payload

3. **Server endpoints for runtime checks**
- [server.ts](/G:/DNA x402/x402/src/server.ts)

Added endpoints:

- `GET /v1/polymarket/live/readiness`
- `POST /v1/polymarket/live/order-precheck`

4. **Exports + docs**
- [index.ts](/G:/DNA x402/x402/src/index.ts) exports `./polymarket/live.js`
- [README.md](/G:/DNA x402/x402/README.md) now includes the Polymarket multi-user precheck section

## Tests Added

- [polymarket.phase0-env.test.ts](/G:/DNA x402/x402/tests/polymarket.phase0-env.test.ts)
- [polymarket.live-order-precheck.test.ts](/G:/DNA x402/x402/tests/polymarket.live-order-precheck.test.ts)

## Regression Commands Run

```bash
npm test -- tests/polymarket.phase0-env.test.ts tests/polymarket.live-order-precheck.test.ts tests/polymarket.trading-phase0.test.ts tests/guard.config.test.ts
npm run typecheck:x402
```

Both passed at handover time.

## Current Readiness Reality

- Builder credentials can be resolved from legacy and alias env names.
- Server now supports per-user precheck API for live order envelopes.
- Live execution is still gated by broader product/runtime policies and Phase 0 exit requirements.
- This work does **not** enable backend signing or shared-funds custody.

## Recommended Next Step

1. Wire website agent runtime to call `POST /v1/polymarket/live/order-precheck` before any live submit attempt.
2. Pass per-user `depositWallet`, `funder`, `signatureType`, and session-signer availability into precheck.
3. Keep builder credentials shared on server, but keep order signing per-user.
