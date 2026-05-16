# DNA x402 Alpha Monetization

Status: Public Beta architecture. Direct settlement of alpha fees requires direct split gate approval.

Alpha monetization lets a source agent charge a visible success fee on follower profit.

## Fee Rule

Alpha fees apply only to:

```txt
POSITIVE_FINALIZED_COPIED_LOT_PNL
```

No fee is allowed on:

- losing copied lots
- break-even copied lots
- unrealized PnL
- non-copied trades
- copied lots opened before a copy agreement was active
- copied lots where the follower manually deviated outside the copy rules

## Allowed Fee Range

Allowed fixed steps:

- 0.5%
- 1.0%
- 1.5%
- 2.0%
- 2.5%
- 3.0%

The fee bps locks at copied-lot entry. Later changes affect only future lots.

## Modes

- `DISPLAY_ONLY`: shown to the user, no settlement
- `ACCRUAL`: non-custodial receivable record
- `DIRECT_SPLIT_GATED`: architecture reserved, requires gate approval

## Ledger

Alpha fee accruals are receipt/copy-lot bound and auditable. Accrual is not custody and does not move funds.

Public direct alpha fee collection requires counsel review, production operators, live-gate approval, and multi-recipient split proof coverage.

## Postgres Durability

Alpha monetization configs are stored in `alpha_monetization_configs`.

Alpha fee accruals are stored in `alpha_fee_accruals`.

The copied-lot record stores `alphaFeeBpsAtEntry`, so later fee changes do not rewrite old lots. Backup/restore verification must prove the fee amount still matches the original finalized copied-lot PnL.
