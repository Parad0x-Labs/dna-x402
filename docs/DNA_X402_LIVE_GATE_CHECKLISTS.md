# DNA x402 Live Gate Checklists

Status: all dangerous gates are locked by default. This document is the written approval packet each gate must satisfy before enablement.

Every gate requires:

- named owner
- checklist completion date
- validation command evidence
- incident operator assigned
- rollback plan
- explicit launch approval
- counsel review reference where applicable
- monitoring alert routing reference

## Production Money Movement Gate

Required before enablement:

- live Postgres migration passed
- live Postgres concurrency tests passed
- Postgres backup/restore drill passed
- server mayhem passed
- webhook HTTP mayhem passed
- persistent Sybil relist test passed
- emergency pause tested
- monitoring live
- alert routing live
- legal/compliance review complete
- signer/custody review complete
- incident runbook complete
- admin operator assigned
- Public Beta primary operators assigned
- public-production backup operators assigned for emergency pause, monitoring/on-call, DB/backup, and release approval
- no critical/high audit findings
- testnet rehearsal complete
- direct split fee gate reviewed before any live paid Public Beta fee collection

Approval: `BLOCKED`

## Public Beta Agent/API Pilot Gate

This is the open Public Beta scope. It is not unlimited permissionless production.

Allowed in beta:

- public agent creation
- paper agents with 10,000 paper USDC
- public/private agent profiles
- follower-controlled copy settings
- alpha monetization in display/accrual mode
- paid APIs
- paid data feeds
- paid tools
- builder-monetized APIs with builder fees in `display_only` or accrual mode
- DNA 10 bps direct split required for live paid Solana USDC beta flows
- reviewed or capped beta builders
- Solana USDC only
- quote, commit, finalize, receipt, and paid retry
- visible fee waterfall
- receipt verification
- Telegram alerting
- emergency pause
- low-risk live payments with beta caps and client-side signing

Required before approval:

- production API URL recorded
- production docs/frontend URL recorded
- production Postgres provider and region recorded
- production Postgres migration/health/concurrency/backup passed with no skips
- production monitoring scrape/dashboard/rules/Telegram route passed
- final production dust drill passed
- public-production backup operators assigned for emergency pause, monitoring/on-call, DB/backup, and release approval
- external counsel response received
- counsel constraints folded into this checklist and the launch packet
- release commit recorded
- rollback plan recorded
- release approver recorded

Not in beta scope from this gate:

- live paid fee collection without DNA direct split provider and treasury proofs
- auto-sweep
- backend custody
- hidden fees
- unattended signing
- public netting
- physical goods
- high-risk categories
- Polymarket live movement
- broad multi-chain production settlement

Approval: `PUBLIC_BETA_OPEN_LIMITED_SCOPE`

## Small-Scale Real-Money Builder/API Pilot Gate

This gate is narrower than public production. It is approved only for owner-operated, low-traction, allowlisted real-money flows on the deployed Contabo route.

Allowed:

- reviewed or allowlisted builders and buyers only
- low-risk APIs, tools, and data feeds only
- Solana USDC only
- manual wallet signing only
- direct split DNA 10 bps collection only through provider and DNA treasury proofs
- buyer-visible fee waterfall before commit
- receipt-bound fee waterfall and split proof summary
- per-transaction cap: `100000` atomic USDC (`0.10 USDC`)
- daily drill/pilot cap: `5000000` atomic USDC (`5 USDC`)
- Telegram alert route watched by the primary operator
- emergency pause available
- HTTPS route only: `https://parad0xlabs.com/x402/`
- public raw port `8080` blocked by firewall
- public `/x402/metrics` blocked, local metrics available for monitoring
- scheduled `pg_dump` backup timer enabled with 14-day retention

Still blocked:

- permissionless seller onboarding
- broad public marketplace
- unattended signing
- backend key custody
- auto-sweep
- hidden fees
- Polymarket live movement
- public netting
- physical goods
- high-risk categories
- broad multi-chain settlement
- volume beyond the configured caps

Evidence:

- Contabo x402 route live at `https://parad0xlabs.com/x402/health`
- old `/opt/dna-x402` archived and new `/opt/dna-x402-next` active
- server `db:migrate`, `db:health`, `mayhem:x402:server`, and `db:backup:test:postgres` passed sequentially
- Telegram route passed from the server
- raw public `8080` access blocked after firewall update
- scheduled backup service `dna-x402-postgres-backup.service` passed
- timer `dna-x402-postgres-backup.timer` enabled

Owner: `Saulius`

Approval date: `2026-05-16`

Approval: `APPROVED_SMALL_SCALE_OWNER_OPERATED_REAL_MONEY_PILOT`

This approval is not counsel approval and not public production approval. If traction rises beyond the tiny caps or onboarding becomes public/permissionless, pause expansion until public-production backup operators, counsel review, PITR/managed backup policy, release tag, and explicit public live-gate approval are complete.

## Polymarket Live Movement Gate

Required before enablement:

- no backend private keys
- browser-local signer only
- deposit wallet reconciliation
- withdrawal intent flow
- copied-lot fee tests
- finalized PnL fee tests
- user-visible fee waterfall
- CLOB credential isolation
- market risk validation
- explicit user signing
- legal review

Approval: `BLOCKED`

## Public Netting Gate

Required before enablement:

- trusted bilateral config
- credit limits
- collateral or settlement limit
- settlement window
- dispute process
- counterparty risk score
- admin freeze
- no public untrusted netting

Approval: `BLOCKED`

## Physical Goods Gate

Required before enablement:

- seller verification
- blocked goods policy
- shipping/tracking model
- payout freeze
- dispute/refund flow
- manual review
- tax profile
- legal review

Approval: `BLOCKED`

## High-Risk Category Gate

Required before enablement:

- category-specific policy
- seller KYB/KYC if needed
- legal review
- monitoring
- manual review
- appeal process
- explicit launch approval

Approval: `BLOCKED`

## Multi-Chain Settlement Gate

Required before enablement:

- verifier adapter tests
- chain RPC health
- token registry review
- depeg handling
- wrong-chain/wrong-token tests
- bridge risk disclosure if bridge enabled

Approval: `BLOCKED`

## Direct Split Fee Gate

Public Beta DNA 10 bps direct split is implemented and real-mainnet dust-tested. Live paid Solana USDC beta flows must use direct split and remain restricted to low-risk capped flows with Helius RPC, Telegram alerts, client-side signing, and explicit `X402_DIRECT_SPLIT_GATE_REF`.

Required before public direct collection of DNA, builder, affiliate, or alpha fee lines:

- counsel review complete
- public-production backup operators assigned
- external alert routing live
- direct split proof validator tests passed
- HTTP finalize tests require provider and DNA treasury proofs
- server mayhem covers missing DNA proof
- server mayhem covers missing builder proof
- server mayhem covers wrong DNA treasury recipient
- server mayhem covers wrong builder recipient
- server mayhem covers underpaid DNA treasury proof
- server mayhem covers proof replay
- server mayhem covers fee waterfall tamper
- receipt records `COLLECTED_DIRECT_SPLIT` only after all required proofs pass
- no auto-sweep
- no backend fee wallet custody
- no SOL-equivalent threshold sweep
- fee waterfall visible to buyer before commit
- explicit launch approval recorded

Approval: `BLOCKED`

## Config Rule

Production config cannot enable a dangerous capability without an explicit environment flag and a checklist reference in the release packet. All dangerous `X402_ENABLE_*` reads must go through the centralized runtime gate config module. Tests must keep defaults locked, hard-reject backend key custody and unattended signing, and verify emergency pause overrides enabled flags.

Direct split fee collection requires `X402_ENABLE_DIRECT_SPLIT_FEES=1` and `X402_DIRECT_SPLIT_GATE_REF`. Production-like Public Beta live paid flows additionally require `X402_PLATFORM_FEE_MODE=direct_split`, `X402_PLATFORM_FEE_BPS=10`, `X402_PLATFORM_FEE_TREASURY`, Helius RPC, Telegram alerts, client-side signing, and transaction/daily caps. Legacy `FEE_BPS`, `BASE_FEE_ATOMIC`, and `MIN_FEE_ATOMIC` must be zero when canonical direct split platform fees are enabled. Display-only and accrual-only builder fee lines are allowed for Public Beta when visible, capped, and receipt-bound; DNA platform fee display/accrual is only for demos or explicitly non-live environments.

## Agent Wallet / Copy Trading Gate

Current status: `PUBLIC_BETA_AGENT_CONTROL_PLANE`

Allowed:

- paper agents
- signal-only agents
- user-confirmed live intents
- public-key-only agent wallet registration
- follower-controlled copy settings
- copied-lot ledger
- alpha fee display/accrual on positive finalized copied-lot profit

Never allowed:

- backend wallet generation
- backend private key custody
- backend signing

Not in beta scope until separate approval:

- public unattended live copy trading
- public Polymarket live movement
- public autonomous token trading
- unlimited auto-copy
- success fee on unrealized PnL

Required before enabling live auto-copy beyond Public Beta caps:

- counsel review
- explicit copy-trading gate owner
- public-production backup operators
- production monitoring route
- emergency pause operator
- user-owned wallet signing proof
- follower risk limit UI
- copy decision mayhem coverage
- copied-lot PnL audit coverage
- alpha fee audit coverage
- jurisdiction/category policy review

Approval: `BLOCKED`
