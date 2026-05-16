# DNA x402 Solana Trading Agent Vertical

Status: Public Beta paper, signal, and user-confirmed swap intent architecture. Public autonomous token trading is not in beta scope yet.

## Public Beta Scope

- paper token strategies
- signal-only recommendations
- user-confirmed swap intents
- public-key-only agent wallet registration
- copy filters for token/category risk

## Required Controls

Solana token trading integrations must enforce:

- user-owned wallet
- client-side signing
- no backend private key
- no backend signing
- token risk tier
- max spend
- max daily spend
- max open exposure
- max slippage
- emergency pause

## Never Allowed

- backend custody
- backend signing
- hidden fees
- auto-sweep

## Not In Beta Scope Yet

- public autonomous token trading
- unlimited auto-copy
- success fee on unrealized PnL

Public Beta auto-copy requires caps, Telegram monitoring, Helius RPC, user-controlled risk filters, and explicit gate reference.
