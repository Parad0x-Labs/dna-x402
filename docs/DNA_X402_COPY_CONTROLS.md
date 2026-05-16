# DNA x402 Copy Controls

Status: Public Beta architecture. Public unattended live copy trading is not in beta scope yet.

Follower controls are first-class. A source agent cannot force a follower to copy every action.

## Required Controls

Each copy agreement can define:

- watch, paper, user-confirmed, or gated Public Beta auto-copy mode
- copy buys
- copy sells
- copy exits
- minimum entry price
- maximum entry price
- maximum bet size
- maximum daily spend
- maximum open exposure
- maximum daily loss
- custom take profit
- custom stop loss
- allowed and blocked markets
- allowed and blocked categories
- maximum slippage
- maximum price drift
- approval thresholds
- expiry

## Decision Outcomes

The copy decision engine returns:

- `COPY`
- `SKIP`
- `REVIEW_REQUIRED`

Reason codes include:

- `ENTRY_PRICE_ABOVE_MAX`
- `COPY_SELLS_DISABLED`
- `MAX_BET_SIZE_EXCEEDED`
- `MAX_DAILY_SPEND_EXCEEDED`
- `MAX_OPEN_EXPOSURE_EXCEEDED`
- `APPROVAL_REQUIRED`
- `EMERGENCY_PAUSED`
- `LIVE_COPY_GATED`

## Safety Rule

`AUTO_COPY_PUBLIC_BETA` is still gated. If the Public Beta live-copy gate is not passed into the decision, the engine returns `LIVE_COPY_GATED`.

The backend makes a decision and records intent. It does not sign trades.

## Postgres Durability

Copy settings are stored in `copy_settings`.

Copy decisions are stored in `copy_decisions`.

Action/audit ledger entries are stored in `agent_action_ledgers`.

Restart verification must prove buy/sell/exit toggles, entry filters, custom TP/SL, risk caps, and emergency-pause behavior still apply after repository reload.

## Agent Builder Integration

Prompt-to-Agent and Guided Agent Builder can generate copy settings, but only as draft configuration.

The compiler maps phrases like:

```txt
only copy entries between 40c and 60c
max $5 per bet
stop after $25 daily loss
copy buys only
```

into structured copy settings. The draft must still pass policy validation and user confirmation before activation.

The builder rejects prompts that ask for unlimited auto-copy, emergency pause bypass, backend signing, or backend custody.
