# DNA x402 Polymarket Agent Vertical

Status: Public Beta paper, signal, and user-confirmed intent architecture. Autonomous public live Polymarket trading is not in beta scope yet.

## Public Beta Scope

- paper agents
- signal-only agents
- copied-lot ledger for simulated copied bets
- user-confirmed live intent design
- alpha fee accrual on positive finalized copied-lot profit

## Required Records

For Polymarket-style copied bets, store:

- market ID
- side / outcome
- entry price
- entry size
- final resolution
- realized PnL
- copied-lot ID
- alpha fee bps at entry

## Never Allowed

- backend signing
- backend private keys

## Not In Beta Scope Yet

- unattended public live betting
- withdrawals without explicit user intent
- public Polymarket live movement
- success fee on unrealized PnL
- fake PnL or fake win-rate ranking

Public Polymarket live movement needs separate counsel review, operator readiness, risk gates, explicit user signing, and live-gate approval.
