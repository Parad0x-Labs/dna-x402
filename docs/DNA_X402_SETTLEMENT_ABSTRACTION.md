# DNA x402 Settlement Abstraction

Date: 2026-05-15

## Purpose

Solana USDC remains the default enabled path, but the quote model must not be hardcoded to one chain forever.

## Implemented Model

`SettlementOption` supports:

- chain
- token symbol
- token address or mint
- amount
- recipient
- expiry
- verifier
- bridge requirement
- estimated bridge time
- estimated fees
- risk flags

Supported schema chains:

- Solana
- Base
- Arbitrum
- Polygon
- Ethereum

## Rules

- Unavailable chains are removed from quote options.
- Tokens with block-level depeg flags are removed.
- Warn-level depeg flags remain visible as risk flags.
- Wrong chain, token, or recipient is rejected.

## Production Default

Only Solana is enabled by default until additional verifier adapters pass tests.
