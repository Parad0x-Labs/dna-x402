# DNA x402 Production Launch Approval

Date: 2026-05-15

Status: `STAGING_PRODUCTION_ROUTE_LIVE_BLOCKED_NOT_PUBLIC_PRODUCTION_APPROVED`

This packet is the single release approval record for moving from Public Beta evidence to Public Beta Pilot and then limited public production approval.

Current decision: DNA x402 is not approved for public production launch until the evidence fields below are filled, counsel constraints are folded into the gates, public-production backup operators are assigned, and the narrow live gate is explicitly approved.

## Production Environment

| Field | Value | Status |
| --- | --- | --- |
| Production API URL | `https://parad0xlabs.com/x402/` | `PASSED_HTTPS_ROUTE_PUBLIC_BETA` |
| Production frontend/docs URL | `https://parad0xlabs.com/` now hosts the existing site; DNA x402 public subpage remains pending | `PARTIAL_EXISTING_SITE_ONLY` |
| Production server provider | Contabo VPS `vmi2972758` / `207.180.199.56` | `PASSED_STAGING_PRODUCTION_DEPLOY` |
| Production server region | Contabo VPS region from account panel still needs final release entry | `PENDING_ACCOUNT_CONFIRMATION` |
| Production Postgres provider | Local PostgreSQL 16 on Contabo VPS | `PASSED_STAGING_PRODUCTION_DRILL_MANAGED_DB_NOT_YET` |
| Production Postgres region | Same VPS as API | `PASSED_SINGLE_NODE_PUBLIC_BETA_ONLY` |
| Backup method | Native `pg_dump` / `psql` restore drill on Contabo VPS | `PASSED_STAGING_PRODUCTION_DRILL` |
| Backup schedule | systemd timer `dna-x402-postgres-backup.timer`, daily at `03:10 UTC`, 14-day retention | `PASSED_SMALL_SCALE_PILOT` |
| PITR status | `NOT_ENABLED`; native daily `pg_dump` is active but managed PITR remains required for broad public production | `PARTIAL_SMALL_SCALE_ONLY` |
| Monitoring URL | Local `/metrics` available on server; public `/x402/metrics` blocked; Telegram route passed | `PARTIAL_ALERT_ROUTE_PASSED_COLLECTOR_URL_PENDING` |
| Telegram ops group | `DNA x402 Ops Alerts` | `PASSED_EXTERNAL_ROUTE_PUBLIC_BETA` |
| Helius RPC configured | configured from server secret environment, redacted | `PASSED_PUBLIC_BETA` |
| Emergency pause route | x402 service reachable at `https://parad0xlabs.com/x402/`; admin route still restricted by app config | `PARTIAL_ROUTE_LIVE_OPERATOR_DRILL_REQUIRED` |
| Rollback plan | restore previous systemd unit and archived `/opt/dna-x402` deployment from `/root/dna-x402-backups`; revert Nginx `/x402/` block from timestamped backup | `DOCUMENTED_BASIC_ROLLBACK` |
| Release commit | `contabo-preflight` deployment bundle, not a tagged release commit | `BLOCKED_RELEASE_TAG_REQUIRED` |
| Release version | `dna-x402@1.1.0` | `PASSED_PUBLIC_BETA` |
| Release approver | `sls_0x` | `PUBLIC_BETA_ASSIGNED_PUBLIC_BACKUP_REQUIRED` |
| Launch date | `PENDING_PUBLIC_APPROVAL` | `BLOCKED` |
| Launch scope | `Public Beta Agent/API Pilot` | `PUBLIC_BETA_OPEN_LIMITED_SCOPE; PUBLIC_PRODUCTION_APPROVAL_PENDING` |

## Evidence Collection Command

Use this command only after the production/staging-production environment exists and the required environment variables are set:

```bash
npm --prefix x402 run production:evidence -- --yes-production-evidence
```

If the environment is incomplete and a blocked report is needed for audit traceability:

```bash
npm --prefix x402 run production:evidence -- --allow-blocked-report
```

The generated report is saved under `reports/production-launch/<timestamp>-production-evidence/production-launch-evidence.redacted.json`.

The command redacts database credentials, Helius credentials, Telegram secrets, and token-like URL query parameters. A `PASS` evidence report is still not a launch approval; it only proves the deployment facts are present and reachable. Counsel response, backup operators, final dust drill, and explicit live-gate approval are still required.

## Staging-Production Deployment Evidence

Date: 2026-05-16

Environment classification: `PUBLIC_BETA_STAGING_PRODUCTION`

Public HTTPS route:

- `https://parad0xlabs.com/x402/health` returns the deployed x402 health response through Cloudflare/Nginx.
- `https://parad0xlabs.com/x402/metrics` returns `404`; public metrics exposure is intentionally blocked.
- Local metrics remain available at `http://127.0.0.1:8080/metrics` for collectors.

Server evidence:

- systemd service: `dna-x402.service`
- working directory: `/opt/dna-x402-next`
- entrypoint: `/usr/bin/node /opt/dna-x402-next/dist/server.js`
- port: `8080`
- old deployment archived at `/root/dna-x402-backups/opt-dna-x402-disabled-20260516T083240Z`
- existing website Docker stack on ports `80` and `443` remained active and was not replaced

Runtime gate evidence:

- `NODE_ENV=staging`
- `X402_PLATFORM_FEE_MODE=direct_split`
- `X402_PLATFORM_FEE_BPS=10`
- `X402_ENABLE_DIRECT_SPLIT_FEES=1`
- `X402_DIRECT_SPLIT_GATE_REF=PUBLIC_BETA_DIRECT_SPLIT_CONTABO_2026_05_16`
- `X402_ENABLE_PROD_MONEY=0`
- `X402_ENABLE_PUBLIC_MARKETPLACE=0`
- backend key custody and unattended signing remain disabled
- allowlisted real-chain signer and dust caps are configured

Validation evidence run on the Contabo VPS:

- `npm run db:migrate`: passed, no pending migrations
- `npm run db:health`: passed with 29 tables and no missing tables
- `npm run mayhem:x402:server`: passed sequentially after DB health
- `npm run db:backup:test:postgres`: passed with native backup at `/opt/dna-x402-next/.runtime/postgres-backups/dna-x402-postgres-2026-05-16T08-34-20-965Z.sql`
- `npm run monitoring:test:telegram -- --human-seen`: passed and saved `/opt/reports/monitoring/2026-05-16T08-33-25-257Z-telegram-route`

Additional hardening on 2026-05-16:

- public raw `8080` was removed from UFW allow rules
- only the Nginx Docker bridge/subnet can reach `8080`
- public `https://parad0xlabs.com/x402/metrics` returns `404`
- local `http://127.0.0.1:8080/metrics` remains available for collectors
- scheduled backup service `dna-x402-postgres-backup.service` passed
- scheduled backup timer `dna-x402-postgres-backup.timer` is enabled
- latest scheduled backup evidence: `/opt/dna-x402-next/.runtime/scheduled-postgres-backups/dna-x402-postgres-2026-05-16T08-53-29-165Z.sql`

This deployment evidence proves the Public Beta route is live and hardened enough for capped low-risk real-money builder/API beta flows. It does not approve broad permissionless production because counsel review, public-production backup operators, managed PITR or equivalent production backup policy, final release tag/commit, and explicit expanded live-gate approvals are still incomplete.

## Small-Scale Real-Money Pilot Decision

Decision: `APPROVED_SMALL_SCALE_OWNER_OPERATED_REAL_MONEY_PILOT`

Scope:

- reviewed/allowlisted builders and buyers only
- low-risk APIs, tools, and data feeds only
- Solana USDC only
- manual wallet signing only
- direct split DNA 10 bps collection through provider and DNA treasury proofs
- Public Beta per-transaction cap: `$200`
- Public Beta daily spend cap: `$1,500`
- Public Beta daily loss cap: `$300`
- Public Beta open exposure cap: `$500`
- historical direct split dust-drill cap: `100000` atomic USDC (`0.10 USDC`) per transaction and `5000000` atomic USDC (`5 USDC`) per day; drill caps are not the normal buyer-agent/service-agent payment ceiling
- Telegram route watched by the primary operator
- emergency pause available

Not approved:

- permissionless public marketplace
- unattended signing
- backend key custody
- public netting
- physical goods
- high-risk categories
- Polymarket live movement
- broad multi-chain settlement
- scale beyond the configured caps

If usage pressure exceeds the Public Beta caps, onboarding expands into high-risk/regulated verticals, or failures appear in monitoring, pause expansion and complete the remaining public-production gates before continuing.

## Proposed First Launch Scope

Gate name: `Public Low-Risk Builder/API Pilot`

Allowed only after approval:

- paid APIs
- paid data feeds
- paid tools
- builder-monetized APIs in `display_only` or non-custodial accrual mode
- allowlisted or reviewed builders
- Solana USDC only
- DNA 10 bps direct split required for live paid Solana USDC flows
- quote, commit, finalize, receipt, paid retry
- visible fee waterfall
- receipt verification
- Telegram alerts
- emergency pause

Still blocked:

- live paid fee collection that does not require both provider and DNA treasury proofs
- auto-sweep
- backend custody
- hidden fees
- unattended signing
- public netting
- physical goods
- high-risk categories
- Polymarket live movement
- broad multi-chain production settlement

## Minimum Production Environment

Secrets must be provided through server secret storage only. Do not commit secrets.

```bash
NODE_ENV=production

X402_DB_DRIVER=postgres
X402_REPOSITORY_MODE=postgres
X402_DATABASE_URL=<production-postgres-url>

HELIUS_RPC=<production-helius-rpc>

X402_ENABLE_PROD_MONEY=0
X402_ENABLE_PUBLIC_MARKETPLACE=0
X402_ENABLE_DIRECT_SPLIT_FEES=1
X402_DIRECT_SPLIT_GATE_REF=PUBLIC_BETA_DIRECT_SPLIT_2026
X402_ENABLE_UNATTENDED_SIGNING=0
X402_ENABLE_BACKEND_KEY_CUSTODY=0
X402_ENABLE_PUBLIC_NETTING=0
X402_ENABLE_PHYSICAL_GOODS=0
X402_ENABLE_HIGH_RISK_CATEGORIES=0
X402_ENABLE_POLYMARKET_LIVE=0

X402_PLATFORM_FEE_MODE=direct_split
X402_PLATFORM_FEE_BPS=10
X402_PLATFORM_FEE_TREASURY=<dna-treasury-usdc-wallet>
X402_ENABLE_BUILDER_FEES=1
X402_BUILDER_FEE_DEFAULT_MODE=display_only

FEE_BPS=0
BASE_FEE_ATOMIC=0
MIN_FEE_ATOMIC=0

X402_ALERT_TELEGRAM_ENABLED=1
X402_ALERT_TELEGRAM_BOT_TOKEN=<secret>
X402_ALERT_TELEGRAM_CHAT_ID=<secret>
```

Production boot must reject backend private key custody, unattended signing, auto-sweep, hidden fee collection, live paid flows without direct split, direct split collection without a gate reference, and legacy fee stacking when canonical direct split platform fees are enabled.

## Production Database Proof

Required against production or staging-production Postgres:

```bash
npm --prefix x402 run db:migrate
npm --prefix x402 run db:health
npm --prefix x402 test -- tests/db/postgres-migration.test.ts tests/db/postgres-concurrency.test.ts tests/db/postgres-sybil-relist.test.ts
npm --prefix x402 run db:backup:test:postgres
```

Pass condition:

- migration passed
- health passed
- concurrency passed
- backup/restore passed
- webhook replay survives restart
- Sybil relist persistence passes
- builder fee accrual survives restart
- builder fee accrual survives backup/restore
- no live DB tests skipped

Evidence status: `PASSED_STAGING_PRODUCTION_CONTABO_SEQUENTIAL_RUN_PUBLIC_PROD_STILL_BLOCKED`

## Production Monitoring Proof

Required against deployed server:

- Prometheus or managed scrape sees production `/metrics`
- dashboard loads
- alert rules load
- Telegram route receives real messages
- named operator acknowledges the alert

Required fired alerts:

- `X402MonitoringRouteTest`
- `X402EmergencyPauseActive`
- `X402PiiBlock`
- `X402BackupFailure`
- `X402DbErrorSpike` or synthetic equivalent
- `X402VerifierErrorSpike` or synthetic equivalent

Evidence status: `PASSED_TELEGRAM_ROUTE_FROM_CONTABO_PARTIAL_COLLECTOR_URL_PENDING`

## Public-Production Operators

Public production requires no required production role marked `TBD`.

Required backup humans:

- backup emergency pause operator
- backup monitoring/on-call operator
- backup DB/backup operator
- backup release approver

Evidence source: `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md`

Status: `BLOCKED_BACKUP_OPERATORS_PENDING`

## Counsel Review

Counsel bundle:

- `docs/DNA_X402_COUNSEL_REVIEW_BUNDLE.md`
- `docs/DNA_X402_LEGAL_COMPLIANCE_REVIEW_PACKET.md`
- `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md`
- `docs/DNA_X402_BOSS_FIGHT_AUDIT_EVIDENCE.md`
- `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md`
- `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md`
- `docs/DNA_X402_BUILDER_MONETIZATION.md`
- `docs/DNA_X402_SOLANA_USDC_DRILL_REPORT.md`

Questions counsel must answer:

1. Can low-risk paid API/data-feed/tool commerce using USDC go live without MSB or money-transmitter registration?
2. What launch scope is safe before KYC/KYB?
3. What seller tax reporting thresholds apply?
4. What data must be retained despite erasure requests?
5. What sanctions screening is required?
6. What regions must be blocked or reviewed?
7. Are display/accrual-only DNA and builder fees acceptable for private/public pilot?
8. What is required before direct split public fee collection?
9. What terms/disclosures are required for agent-paid services?
10. What additional controls are required before Polymarket or copy-agent monetization?

Status: `BLOCKED_COUNSEL_RESPONSE_PENDING`

## Live-Gate Approval

Only this narrow gate may be approved from this packet:

`Public Low-Risk API/Data Feed/Tool Pilot`

Still blocked unless separately approved:

- Polymarket live
- public netting
- physical goods
- high-risk categories
- unattended signing
- backend custody
- broad multi-chain settlement
- direct split fee collection

Approval status: `BLOCKED`

Required fields before changing approval:

- owner
- date
- release commit
- evidence links
- monitoring reference
- operator reference
- counsel reference
- rollback plan
- explicit approval: `APPROVED` or `BLOCKED`

## Direct Split Fee Gate

Public Beta live paid Solana USDC flows require DNA 10 bps direct split collection. Public builder fee direct collection remains blocked until separately approved; builder fees stay display/accrual unless the builder direct split gate is explicitly approved.

DNA 10 bps direct split is implemented behind `X402_ENABLE_DIRECT_SPLIT_FEES=1`, `X402_PLATFORM_FEE_MODE=direct_split`, and `X402_DIRECT_SPLIT_GATE_REF`. A Public Beta Solana USDC direct split dust proof passed on 2026-05-16 with separate provider and DNA treasury SPL transfers, receipt-bound split proofs, and replay/underpay/wrong-treasury rejection. Live paid beta finalize must require both provider and DNA treasury proofs. Broader production approval still requires counsel constraints, public-production backup operators, production monitoring, and final production dust drill evidence.

If direct split is not configured, live paid Public Beta flows must not start:

```bash
X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK=0
X402_PLATFORM_FEE_MODE=display_only
X402_BUILDER_FEE_DEFAULT_MODE=display_only
X402_ENABLE_DIRECT_SPLIT_FEES=0
```

Public Beta evidence status: `PUBLIC_BETA_DIRECT_SPLIT_DUST_PROOF_PASSED`

Public-production status: `BLOCKED`

## Final Production Dust Drill

Required after production deployment and before public launch:

```bash
npm --prefix x402 run drill:solana-usdc -- --yes-real-mainnet-drill
```

Required proof:

- Helius RPC
- allowlisted wallet
- 0.01 to 0.10 USDC only
- low-risk API listing
- quote
- commit
- payment proof
- finalize
- receipt verify
- paid retry
- replay rejected
- wrong mint rejected
- wrong recipient rejected
- emergency pause tested after
- old receipt remains readable

Evidence status: `PUBLIC_BETA_DIRECT_SPLIT_DUST_PROOF_PASSED_LOCALLY; CONTABO_FINAL_DUST_DRILL_PENDING`

## Final Validation

Required:

```bash
npm --prefix x402 test
npm --prefix x402 run typecheck:x402
npm run mayhem:x402
npm run mayhem:x402:server
npm --prefix x402 run db:health
npm --prefix x402 run db:backup:test:postgres
npm --prefix x402 run security:scan
npm --prefix x402 audit --audit-level=high
npm --prefix x402 run build
npm --prefix site-agent test
npm --prefix site-agent run build
npm --prefix site-agent run analyze
npm --prefix site-agent audit --audit-level=high
npm run acceptance:builder
git diff --check
```

Evidence status: `PENDING_RELEASE_RUN`

## Approval Decision

Decision: `BLOCKED`

Reason:

- production server URL pending
- production docs/frontend x402 subpage pending
- managed PITR or equivalent production backup policy pending
- release tag/commit pending
- counsel response pending
- public-production backup operators pending
- final production dust drill pending
- live gate approval pending
- direct split fee gate remains blocked

If any item fails, status remains:

`DNA x402 remains Public Beta only; unlimited permissionless production is not approved.`
