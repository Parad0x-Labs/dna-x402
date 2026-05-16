# DNA x402 Public Beta Acceptance

Status: `PUBLIC_BETA_PILOT`

DNA x402 Agent Beta is open for public users to create and test agents, paper strategies, public profiles, copy settings, builder APIs, and low-risk capped live payments. This is not unlimited permissionless production.

## Open In Public Beta

- account or wallet connection
- paper agents with 10,000 paper USDC
- client-side generated, user-owned agent wallets
- public/private agent profiles
- PnL, ROI, win rate, average entry price, median entry price, drawdown, volume, and sample-size badges
- copy settings for buys, sells, exits, entry range, TP/SL, max bet, daily spend, daily loss, and open exposure
- paper copy and user-confirmed copy flows
- alpha monetization in visible display/accrual mode
- builder preview for paid APIs, tools, and data feeds
- low-risk Solana USDC API/tool/data-feed payments with caps
- visible fee waterfall and receipt verification
- proof/audit feed

## Live Money Beta Scope

Allowed only with hard caps and monitoring:

- low-risk API/data-feed/tool payments
- Solana USDC
- manual client-side signing
- DNA 10 bps direct split is required for live paid Solana USDC beta flows once the direct split beta gate is enabled
- small per-transaction cap
- small daily spend/loss/exposure caps
- Telegram monitoring
- emergency pause
- no backend keys
- no backend signing

Suggested defaults:

```env
X402_PUBLIC_BETA_MAX_TX_USD=25
X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD=250
X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD=50
X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD=100
```

## Not In Beta Scope Yet

- unlimited live trading
- public unattended autonomous betting
- unrestricted Polymarket live movement
- unrestricted Solana autonomous trading
- physical goods
- high-risk categories
- public netting
- broad multi-chain production settlement
- live paid Public Beta fee collection without direct split fee gate approval

## Never Allowed

- backend private key custody
- backend signing
- hidden fees
- auto-sweep

## Required Runtime Flags

```env
X402_ENABLE_PUBLIC_BETA=1
X402_PUBLIC_BETA_GATE_REF=PUBLIC_BETA_AGENT_PILOT_2026

X402_ENABLE_AGENT_CREATION=1
X402_ENABLE_PAPER_AGENTS=1
X402_ENABLE_PUBLIC_AGENT_PROFILES=1
X402_ENABLE_COPY_SETTINGS=1
X402_ENABLE_ALPHA_MONETIZATION=1

X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK=1
X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE=1
X402_PUBLIC_BETA_BACKEND_SIGNING=0
X402_PUBLIC_BETA_BACKEND_CUSTODY=0

X402_PUBLIC_BETA_MAX_TX_USD=25
X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD=250
X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD=50
X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD=100

X402_ENABLE_BACKEND_KEY_CUSTODY=0
X402_ENABLE_UNATTENDED_SIGNING=0
X402_ENABLE_PUBLIC_NETTING=0
X402_ENABLE_PHYSICAL_GOODS=0
X402_ENABLE_HIGH_RISK_CATEGORIES=0
X402_ENABLE_POLYMARKET_LIVE=0
```

## Acceptance Checks

- Public Beta flag enables agent creation.
- Agent Builder prompt mode creates policy-checked drafts.
- Agent Builder guided mode creates policy-checked drafts.
- Agent Builder templates create policy-checked drafts.
- Agent Builder public/cloneable recipes clone into new drafts.
- Agent Builder confirmation requires risk-summary acknowledgement.
- Unsafe Agent Builder prompts are rejected.
- Public Beta flag enables paper agents.
- Public Beta flag enables public profiles.
- Public Beta flag enables copy settings.
- Public Beta flag enables alpha monetization.
- Low-risk live beta flow enforces caps.
- Backend private keys are rejected.
- Backend signing is rejected.
- Hidden fees are rejected.
- Emergency pause blocks live beta flow.
- High-risk categories are not in beta scope yet.
- Public Polymarket autonomous live trading is not in beta scope yet.
- Public Solana autonomous trading is not in beta scope yet.

## Correct Status

DNA x402 is entering Public Beta for agents, builder APIs, paper trading, copy controls, public profiles, and low-risk capped live payments. Users can create agents, test strategies, publish profiles, configure copy rules, and monetize alpha through visible receipt-bound fees. Live paid Solana USDC beta flows require DNA 10 bps direct split with provider and DNA treasury proofs before finalize. Backend custody, backend signing, hidden fees, unrestricted autonomous live trading, physical goods, public netting, and high-risk categories are not in beta scope.
