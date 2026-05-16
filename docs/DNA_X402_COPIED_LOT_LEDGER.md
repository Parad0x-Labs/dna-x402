# DNA x402 Copied Lot Ledger

Status: Public Beta architecture.

Every copied trade creates a copied lot record. This makes copy performance auditable and prevents fake PnL or retroactive fee edits.

## Copied Lot Fields

Each copied lot records:

- source agent
- follower agent
- copy settings ID
- source action ID
- market ID
- side
- entry price
- entry size
- copy mode
- alpha fee bps at entry
- follower take-profit / stop-loss override
- status
- realized PnL after finalization

## Finalization

A copied lot can be finalized once.

Outcomes:

- `CLOSED_WIN`
- `CLOSED_LOSS`
- `CLOSED_BREAK_EVEN`
- `CANCELLED`
- `EXPIRED`

Alpha fee accrual is created only for positive finalized copied-lot profit.

## Anti-Abuse

Rejected:

- re-finalizing a copied lot
- charging alpha fee on losses
- charging alpha fee on unrealized PnL
- changing fee bps after entry for old lots
- fake win-rate ranking without average entry price and sample-size badges

## Postgres Durability

Copied lots are stored in `copied_lots`.

Paper accounts are stored in `paper_agent_accounts`.

Public/private agent profile stats are stored in `agent_profiles`.

Agent action events are stored in `agent_action_ledgers`.

Backup/restore verification must prove:

- copied lots survive restore
- finalized copied lots cannot be finalized again
- winning copied lots keep their alpha accrual
- losing copied lots do not create alpha accrual
- restored records contain no private-key-shaped fields
