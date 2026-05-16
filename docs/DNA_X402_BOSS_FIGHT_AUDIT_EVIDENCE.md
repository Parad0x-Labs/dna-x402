# DNA x402 Boss Fight Audit Evidence

Date: 2026-05-15

Status: `TECHNICAL_PRE_PRODUCTION_EVIDENCE_PACK`

This document consolidates the main hardening "boss fight" evidence into one audit-readable index. It separates real on-chain transaction evidence from local/server/infrastructure evidence.

Blunt status:

DNA x402 has passed private mainnet dust-size Solana USDC proof, Public Beta Solana USDC direct split 10 bps dust proof, G-local live Postgres migration/concurrency/backup, Postgres-backed webhook replay-after-restart, persistent Sybil relist under live Postgres, local Prometheus/Alertmanager/Grafana alert routing evidence, external Telegram human-route delivery, and a hardened Contabo Public Beta HTTPS deployment route with scheduled backups.

Public production remains blocked by:

- external legal/compliance review
- backup operators for public production
- explicit live-gate approvals
- scheduled backup/PITR policy and release tag before public production
- direct split fee gate before public 10 bps collection

No public production money movement, public fee collection, unattended signing, backend key custody, public netting, physical goods, high-risk categories, broad multi-chain settlement, or Polymarket live movement is approved by this evidence.

## Evidence Map

| Boss / Proof | Evidence Type | Status | Primary Artifact | What It Proves | What It Does Not Prove |
| --- | --- | --- | --- | --- | --- |
| Private Solana USDC dust proof | Mainnet transaction + signed receipt | `PASSED` | `G:\DNA x402\reports\solana-usdc-drill\2026-05-15T10-56-38-257Z.json` | Allowlisted Solana USDC payment can finalize, issue a receipt, unlock paid retry, reject replay/different-quote/underpay/wrong-recipient/wrong-mint/non-allowlisted signer, and record 10 bps as non-custodial accrual. | Public launch, public marketplace, public fee collection, auto-sweep, backend custody, or production readiness. |
| Boss 1: Live Postgres migration/concurrency/backup | Live database drill | `PASSED_G_LOCAL_POSTGRES_18` | `docs/DNA_X402_DATABASE_SCHEMA.md`, `docs/DNA_X402_MIGRATION_RUNBOOK.md`, `docs/DNA_X402_BACKUP_RESTORE_RUNBOOK.md` | Real PostgreSQL migration, health, concurrency, native `pg_dump`/`psql` restore, critical state survival. | Docker Compose proof on this workstation, managed Postgres proof, or public production ops. |
| Boss 2: Webhook replay after restart | Server mayhem with Postgres adapter | `PASSED_G_LOCAL_POSTGRES_18` | `npm run mayhem:x402:server` with `X402_REPOSITORY_MODE=postgres` | Webhook idempotency key survives restart and replay is rejected from persisted state. | External webhook provider integration or public webhook delivery. |
| Boss 3: Persistent Sybil relist | Live Postgres test | `PASSED_G_LOCAL_POSTGRES_18` | `x402/tests/db/postgres-sybil-relist.test.ts` | Seller cannot regain clean trust by changing slug/linking a new wallet/relisting similar capability after persisted strikes and clustered risk. | Perfect Sybil resistance against all future adversaries. It proves current persisted controls, not identity impossibility. |
| Boss 4: Monitoring routing | Local collector/dashboard/alert route + external Telegram delivery | `PASSED_LOCAL_STACK_AND_EXTERNAL_TELEGRAM_ROUTE` | `G:\DNA x402\reports\monitoring\2026-05-15T15-43-16-634+03-00\boss4-monitoring-evidence-summary.json`, `G:\DNA x402\reports\monitoring\2026-05-15T16-40-33-398Z-telegram-route\telegram-route-summary.json` | Prometheus scrapes `/metrics`, Grafana dashboard imports, alert rules load, Alertmanager delivers alerts to a local operator webhook, emergency pause and PII block alerts fire from real app metrics, and required Telegram alerts reached the private ops group with human confirmation. | Named operator staffing, legal approval, or live-gate approval. |
| Builder monetization gate | Unit tests + server mayhem + live Postgres refresh | `PASSED_G_LOCAL_POSTGRES_18_DISPLAY_AND_ACCRUAL_ONLY` | `x402/src/fees/waterfall.ts`, `docs/DNA_X402_BUILDER_MONETIZATION.md`, `npm run mayhem:x402:server`, `npm --prefix x402 run db:backup:test:postgres` | Builder fee lines are visible in quote, DNA fee remains first-class, builder caps/statuses are enforced, accrual records are receipt-bound, `fee_accruals` exists, and builder accrual survives repository restart and native backup/restore. | Public direct collection, auto-sweep, backend custody, or public 10 bps collection. |
| DNA 10 bps direct split Public Beta gate | HTTP finalize tests + server mayhem + mainnet dust split | `PUBLIC_BETA_DIRECT_SPLIT_DUST_PROOF_PASSED` | `x402/tests/serverFlow.test.ts`, `x402/scripts/mayhem/x402-server-mayhem.ts`, `G:\DNA x402\reports\solana-usdc-drill\2026-05-16T07-11-01-352Z-direct-split.json` | Approved Public Beta direct split required seller/provider and DNA treasury payment proofs before receipt issuance; real mainnet provider and DNA treasury SPL transfers verified; missing DNA proof, wrong treasury recipient, underpaid treasury proof, and proof replay failed safely; receipt binds `feeWaterfallHash`, fee lines, collection status, and split payment proof summaries. | Public direct collection, public production launch, counsel approval, direct builder fee collection, or direct split without allowlists/caps/Helius/Telegram/gate reference. |
| Contabo small-scale real-money pilot deployment | VPS deployment + Cloudflare/Nginx route + firewall hardening + scheduled backup + sequential regression | `APPROVED_SMALL_SCALE_OWNER_OPERATED_REAL_MONEY_PILOT` | `https://parad0xlabs.com/x402/health`, `docs/DNA_X402_PRODUCTION_LAUNCH_APPROVAL.md` | x402 runs from `/opt/dna-x402-next` under systemd, old `/opt/dna-x402` was archived, public HTTPS `/x402/health` reaches the app, public `/x402/metrics` is blocked, raw public `8080` is blocked, local metrics remain available, scheduled daily `pg_dump` timer passed, DB migrate/health/server mayhem/backup drill passed sequentially on the VPS, and Telegram alert drill passed from the server. | Counsel approval, public-production backup operator staffing, managed PITR/failover, final tagged release approval, public permissionless marketplace, or public direct split gate approval beyond the tiny allowlisted pilot caps. |
| Polymarket Phase 0 browser-local proof | Browser-local signing fixture | `PASSED_SIGN_ONLY_AND_WALLET_CREATE` | `G:\DNA x402\reports\polymarket-phase0\2026-05-14T21-10-18-000Z-browser-local.json`, `G:\DNA x402\reports\polymarket-phase0\2026-05-14T21-10-43-546Z-browser-local.json` | Browser-local Phantom EVM owner signer can produce a `POLY_1271` no-submit order fixture with `signatureType = 3`, builder code attached, and no mismatches; deposit wallet deployment call reported success. | Polymarket production trading, hosted automation, backend signing, pUSD transfer, copy trading, withdrawals, or public launch. |
| Archival 50-agent mainnet mayhem | Mainnet transaction report | `ARCHIVAL_PRIOR_PROOF` | `x402/test-mainnet/MAYHEM_50_REPORT.md` | Historical report shows 50 agents, 80 total trades, 20 real USDC transfer txs, 80/80 receipt anchors, 0 failed tests at the time of that run. | Current production readiness. Treat as archival context unless re-run under current gates and current infra. |

## Live Mainnet Solana USDC Dust Proof

Classification: private staging technical chain proof, not production readiness evidence.

Network: `mainnet-beta`

USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

Buyer allowlisted wallet: `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv`

Seller/recipient wallet: `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb`

Treasury public wallet: `8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u`

Quote ID: `3b543915-18d4-46fc-8751-07b6cd5c6c5d`

Commit ID: `e85358f4-df61-46de-bcd1-dd77b495e858`

Receipt ID: `d3c34b07-2b19-411f-8c6e-0d04aa77c1f9`

Receipt hash: `ef6564742cf0f4083bd7cc5181cd3023e1449fc947cfab9c632bfb50bf237311`

Valid payment amount: `50000` atomic USDC (`0.05 USDC`)

Fee accrual: `50` atomic USDC (`0.00005 USDC`) at 10 bps, status `ACCRUED_NOT_COLLECTED`

Fee collection status:

- no hidden fee
- no auto-sweep
- no backend fee wallet custody
- no SOL-equivalent threshold sweep
- direct split collection not enabled

### Mainnet TX Index

| Purpose | Signature | Link | What It Proves |
| --- | --- | --- | --- |
| SOL top-up for drill wallet | `2J2wtohhScPkQfeeY4XdULrLzXyAqav42mMBkTCap4PraNKqDF1hfNKKCjx3excVV6NBH9NuNodLttv4USZZ8muw` | [Solscan](https://solscan.io/tx/2J2wtohhScPkQfeeY4XdULrLzXyAqav42mMBkTCap4PraNKqDF1hfNKKCjx3excVV6NBH9NuNodLttv4USZZ8muw) | Wallet had real SOL to pay mainnet tx fees. |
| Valid allowlisted USDC payment | `5iDsqW4FnkocW9Tak2M1u47nMJZpy9Z1yYdv3YjQnVdcWZ2PY2cZGxqevmGzbUQ2TwWmab9pix6tMPcWZ9qZsQcA` | [Solscan](https://solscan.io/tx/5iDsqW4FnkocW9Tak2M1u47nMJZpy9Z1yYdv3YjQnVdcWZ2PY2cZGxqevmGzbUQ2TwWmab9pix6tMPcWZ9qZsQcA) | Real Solana USDC payment finalized, receipt verified, paid retry worked. |
| Non-allowlisted signer negative proof | `47LrLGdArv1KcRSd1iduQ9zEYXB6PD24ZDD1Tc3Y2Y5taJtpEmdvLNWHkCJ2LN4gqyqDp5DAD97jmtiwCfGeNf8f` | [Solscan](https://solscan.io/tx/47LrLGdArv1KcRSd1iduQ9zEYXB6PD24ZDD1Tc3Y2Y5taJtpEmdvLNWHkCJ2LN4gqyqDp5DAD97jmtiwCfGeNf8f) | Real tx from non-allowlisted signer was rejected by drill allowlist gate. |

### Valid Payment Flow Result

The valid tx finalized with:

- `validFinalizeOk: true`
- `receiptVerifies: true`
- `paidRetryOk: true`
- `feeAccrualRecorded: true`
- `noAutoSweep: true`
- `noBackendCustody: true`

The same proof rejected replay with:

- `X402_REPLAY_DETECTED`

Semantic negative checks passed:

- underpay rejected with `X402_UNDERPAY`
- wrong recipient rejected with `X402_WRONG_RECIPIENT`
- wrong mint rejected with `X402_WRONG_MINT`
- proof for different quote rejected
- non-allowlisted signer rejected with `X402_VERIFICATION_FAILED`

RPC note:

Public Solana RPC rate-limited the drill with `429 Too Many Requests`. Helius RPC support is accepted for longer private mainnet drills. RPC key material must be redacted in every report.

## Live Mainnet Direct Split Dust Proof

Classification: Public Beta direct split technical chain proof, not public production approval.

Report path: `G:\DNA x402\reports\solana-usdc-drill\2026-05-16T07-11-01-352Z-direct-split.json`

Network: `mainnet-beta`

RPC source: `HELIUS_API_KEY`

USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

Buyer allowlisted wallet: `CmGCjBZLqHZzeBk8nTxe4CgrJcXLJz3BBvAEMni3qezv`

Seller/provider wallet: `ETdR88B6ZVeBu3L5fNAmj9PbXEifSEQjASAx9w4YtCbb`

DNA treasury wallet: `8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u`

Gross amount: `10000` atomic USDC (`0.01 USDC`)

Provider amount: `9990` atomic USDC (`0.00999 USDC`)

DNA 10 bps direct split amount: `10` atomic USDC (`0.00001 USDC`)

### Direct Split TX Index

| Purpose | Signature | Link | What It Proves |
| --- | --- | --- | --- |
| Provider direct split transfer | `3BKjypmC1f1tr6nccToQhQpxcDh1Qr4eqaimBvL5z6DdmVbB9NaUZKDr25kPWrtukM9NnU8TZwmEXRE6zMVtYJxY` | [Solscan](https://solscan.io/tx/3BKjypmC1f1tr6nccToQhQpxcDh1Qr4eqaimBvL5z6DdmVbB9NaUZKDr25kPWrtukM9NnU8TZwmEXRE6zMVtYJxY) | Buyer sent provider amount directly to seller/provider recipient. |
| DNA treasury 10 bps direct split transfer | `qarpuSinFGrHBUx7Ap6Hfg9wzJBbhuNMU8xj6SGWMENzxZFU6jo18pkAfdRST9mP5sB6pMrR8m6u6fLEccvtmiX` | [Solscan](https://solscan.io/tx/qarpuSinFGrHBUx7Ap6Hfg9wzJBbhuNMU8xj6SGWMENzxZFU6jo18pkAfdRST9mP5sB6pMrR8m6u6fLEccvtmiX) | Buyer sent DNA 10 bps fee directly to DNA treasury recipient. |

### Direct Split Flow Result

The direct split run finalized with:

- `directSplitFinalizeOk: true`
- `receiptVerifies: true`
- `paidRetryOk: true`
- `dnaFeeCollectedDirectSplit: true`
- `splitProofsBound: true`
- `feeWaterfallHashBound: true`
- `noHiddenLegacyFee: true`
- `noAutoSweep: true`
- `noBackendCustody: true`

Semantic direct split negative checks passed:

- missing DNA proof rejected
- wrong DNA treasury recipient rejected
- underpaid DNA treasury proof rejected
- replay rejected

Public status remains blocked. This proof upgrades Public Beta direct split from app/server-tested to real mainnet dust-tested only.

## Boss 1: Live Postgres Evidence

Classification: infrastructure durability proof.

Environment:

- G-local PostgreSQL 18 drill instance
- connection: `postgres://x402:x402_local@127.0.0.1:55432/x402_local`
- G-local data directory used for drill state
- native PostgreSQL tools used for backup/restore

Passed commands:

```powershell
npm --prefix x402 run db:reset
npm --prefix x402 run db:migrate
npm --prefix x402 run db:seed:sandbox
npm --prefix x402 run db:health
npm --prefix x402 test -- tests/db/postgres-migration.test.ts tests/db/postgres-concurrency.test.ts
npm --prefix x402 run db:backup:test:postgres
```

What it proves:

- migrations run against live Postgres
- DB health passes with expected tables
- JSON payloads and timestamps round-trip
- critical repositories insert/read/update
- concurrent finalize cannot duplicate receipts
- concurrent webhook replay cannot pass twice
- concurrent agent spend cannot exceed caps
- emergency pause is persistent and deterministic
- policy strikes do not corrupt under race
- denylist uniqueness is enforced
- listing manifest versions do not collide
- native backup/restore works
- restored receipts verify
- restored emergency pause still blocks
- restored webhook replay keys still reject duplicates

What it does not prove:

- Docker Compose worked on this workstation
- managed Postgres is configured
- production PITR, retention, replication, or failover is ready

## Boss 2: Postgres-Backed Webhook Replay After Restart

Classification: replay persistence proof.

Evidence:

- `npm run mayhem:x402:server` executed with `X402_REPOSITORY_MODE=postgres` and `X402_DATABASE_URL` configured.

What it proves:

- valid webhook accepted once
- duplicate webhook rejected
- app/repository restart does not clear replay key
- same idempotency key is rejected after restart from persisted Postgres state

What it does not prove:

- external webhook provider delivery
- production webhook delivery monitoring
- public webhook ingress approval

## Boss 3: Persistent Sybil Relist

Classification: reputation and identity persistence proof.

Evidence:

- `npm --prefix x402 test -- tests/db/postgres-sybil-relist.test.ts`

What it proves:

- seller gets policy strike
- seller changes slug
- seller links or uses a new wallet path
- seller relists similar capability
- repository restarts
- strike and risk survive
- policy/reputation still sees clustered risk
- seller cannot regain clean trust just by relisting

What it does not prove:

- complete Sybil impossibility
- external KYC/KYB identity assurance
- legal sufficiency of clustering heuristics

## Boss 4: Monitoring Routing

Classification: local observability route proof.

Evidence:

- `G:\DNA x402\reports\monitoring\2026-05-15T15-43-16-634+03-00\boss4-monitoring-evidence-summary.json`
- `docs/DNA_X402_MONITORING_WIRING_EVIDENCE.md`
- protected Telegram relay: `POST /internal/alerts/telegram`
- Telegram drill script: `npm --prefix x402 run monitoring:test:telegram`
- Telegram 30-minute status script: `npm --prefix x402 run monitoring:telegram:status -- --period=30m`
- Telegram daily status script: `npm --prefix x402 run monitoring:telegram:status -- --period=24h`
- Telegram report pattern: `G:\DNA x402\reports\monitoring\<timestamp>-telegram-route`
- external Telegram proof: `G:\DNA x402\reports\monitoring\2026-05-15T16-40-33-398Z-telegram-route\telegram-route-summary.json`

Tools:

- Prometheus `v3.11.3`
- Alertmanager `v0.32.1`
- Grafana `v13.0.1+security-01`
- local operator webhook receiver

What it proves:

- x402 `/metrics` is reachable
- Prometheus scrape target is healthy
- Grafana dashboard imports
- alert rules load
- test alert routes
- emergency pause alert routes from real app metric
- immutable PII block alert routes from real app metric
- webhook replay metric increments
- DB error, verifier error, backup failure, restore failure, admin action burst, settlement unavailable route alerts deliver through synthetic drill rules
- Telegram relay path is implemented with redacted evidence output and shared-secret route protection
- Telegram command safety model exists: commands disabled by default, owner/admin user IDs and allowed chat IDs required before interaction controls can be enabled
- digest-ready metrics now expose verified volume, observed agents, and non-custodial fee accruals
- required external Telegram alerts delivered to `DNA x402 Ops Alerts` and were human-confirmed

What it does not prove:

- staffed production alert escalation
- staffed incident response

Monitoring route status:

External Telegram human/on-call delivery is passed for `X402MonitoringRouteTest`, `X402EmergencyPauseActive`, `X402PiiBlock`, and `X402BackupFailure`. Public Beta primary operator assignment is complete; public production still requires backup operators for emergency pause, monitoring/on-call, DB/backup, and release approval.

## Polymarket Phase 0 Evidence

Classification: vertical integration proof, no production money movement.

Evidence:

- `G:\DNA x402\reports\polymarket-phase0\2026-05-14T21-10-18-000Z-browser-local.json`
- `G:\DNA x402\reports\polymarket-phase0\2026-05-14T21-10-43-546Z-browser-local.json`

What it proves:

- browser-local owner signer path worked
- Phantom EVM/Polygon could sign required flow after switching to Polygon
- `POLY_1271` no-submit order fixture saved
- `signatureType = 3`
- builder code attached
- maker/signer/funder fields present in signed SDK fixture
- fixture mismatch list empty
- deposit wallet deployment result saved with `ok: true`

What it does not prove:

- production Polymarket trading
- pUSD transfer batch
- withdrawal bridge flow
- unattended copy trading
- backend signing
- fee collection

Polymarket live movement remains blocked.

## Archival 50-Agent Mainnet Mayhem Context

Classification: archival prior proof, not a current production gate.

Source:

- `x402/test-mainnet/MAYHEM_50_REPORT.md`

Reported summary:

- 50 agents
- 80 total trades
- 20 real USDC transfer trades
- 60 netting trades
- 84 tests passed
- 0 tests failed
- 80/80 receipts anchored on-chain
- 20 on-chain USDC transfer txs

This is useful historical evidence, but it should not be used as the current public-production approval by itself. If it is needed for launch claims, re-run under current gates, current monitoring, current Postgres, current counsel constraints, and current RPC configuration.

### Archival 20 USDC Transfer Links

| # | Solscan |
| --- | --- |
| 1 | [5YkC97Lz...](https://solscan.io/tx/5YkC97LzZx3eCFFoGSh4jGE62SeccqG3UK5aAnt86sLDfeu9T3pG5wFH1CnKvhY2xnRYumiWS5KmAh4EZPzdum2e) |
| 2 | [2FKAFWsE...](https://solscan.io/tx/2FKAFWsEFNJ7HvaEkh7BF45NXodK8FLeG4iMRqJuwyiePs8iin9ub8RVb7KXKerHyPGoiG64bGRwesUySjHNQpa9) |
| 3 | [3SqZTFUu...](https://solscan.io/tx/3SqZTFUuH8nUCVVGPCp1xbXMrqtMX2WuytbUYCYzJtB6dFKgh8rpAWZxDWvYY6vacEYHwN1gTSnWUPN8DAu1BYZW) |
| 4 | [3jd5pkgx...](https://solscan.io/tx/3jd5pkgxGZPLQE7KvZvx7atf4TnALnbZEinhs9ADJMaPDgJCkyZEs1KeoKxKV65QVpDqTmVZu1UCsc7j4jDckMDV) |
| 5 | [5bqnVd9t...](https://solscan.io/tx/5bqnVd9t3xkhAKY9D4UgPm4gneAx9vHPsUBDBdzdtr5o6MiFVHhgfTEdbrqxaDBzxsVtxSmQBG3dnxzmdSHQQP8K) |
| 6 | [3en3SY8S...](https://solscan.io/tx/3en3SY8SHo5SjWteY59QRiFd3vegrj3L66S6xMx4fqEEKNQ2hRhWEMprm2icrXhjwC7Yn89UMqWspEQiiB7rse1y) |
| 7 | [2cTUr1uW...](https://solscan.io/tx/2cTUr1uWg5tHLuPj4wcdKzt4s3gNkpaFVbvphYsmwqUpf3e5eqkNJxS8P7GwDqUKgZrmuXE4GYPRMeiynUogQrEf) |
| 8 | [3LvBHSpk...](https://solscan.io/tx/3LvBHSpkmTWfAgWRwZWRikfFCaqZMAT8ondvcnCGVYb6sx67GBzebitTun9W9z12Fzr67qb4WgVkZ2i7sZ8FFzxQ) |
| 9 | [em7MLHUd...](https://solscan.io/tx/em7MLHUd7McKwmkxWzjvrxSFfotEHCvhritXkgy8HaHp82vQqgHmeLva5gW3USRtHwMpKpuGCgdmsdVoJHff73t) |
| 10 | [3qoa8MkR...](https://solscan.io/tx/3qoa8MkRwxBfmVJmgcbHW1QsWtf7smoU8YY7i7DiHX4fDwARPKRXf9kRtPq4wRkRzNwvQP2Ke41ULc6kKmdTMykg) |
| 11 | [2pYkDZya...](https://solscan.io/tx/2pYkDZyayqSTrrz6FSyseZ5xc9tKmjXe3jJnPukb1hTdUwFzhKE4VgFtEdMekwtMZmDn45vY2nWKRHUbk7HEALU3) |
| 12 | [qyN4f4he...](https://solscan.io/tx/qyN4f4hefkMA6swKQMVj1HFn2z7QfbCmxAbvPYBPV3JNKdVvphqW1wMDDF3cQgGkhubCDZKKRUbt4UsPnCCm6Ro) |
| 13 | [63RHYwCo...](https://solscan.io/tx/63RHYwComNz1eyarbpMV3BhSKzW7RVmYAoSV8xmKEkxDTYVQ2ec1xy2iJ8nuEdwLTB7vsdKaB8MTce8wd2D2A9SA) |
| 14 | [4GzjTvFX...](https://solscan.io/tx/4GzjTvFXNxCJ5svzEpa4DtcEkMAi48fh2ig48qufQtegZJhb7Vrcr5WPBUBdq6SA8QqywcLyWcxb8g1aZ7qo1K1g) |
| 15 | [2HqJWh33...](https://solscan.io/tx/2HqJWh33ufdUgz3Mrk8sR39mBMuJUw9XjRYDJcxvLZqewDCp2V4AFP6wYqsNbjQ8ZRpZ1neJBEHS27c74h5eLfLV) |
| 16 | [ZiFRnjij...](https://solscan.io/tx/ZiFRnjij94KTJ1i6NT1XEiJZ6iFG94Hsq8iNgDTwpmUKb2r6ZZJEz7r1pYrUDymKxi85mvyB99mrBfgh6dawqcU) |
| 17 | [coJk1bgX...](https://solscan.io/tx/coJk1bgXoe6C123PENZTV6HWWo4BVYX91DbCfhc2jvtukLfZf83EGsUs793MapuCfe2YhpuGcSzdBAhCuuDvm95) |
| 18 | [3Nez6P6o...](https://solscan.io/tx/3Nez6P6ob1T4XELmvtJ15oXZDzttYfu6nUAk3CR5FJKRU1oz4b7wGsX68U9GDkFgfZGpDciPzYFPkUoLngZeSdVZ) |
| 19 | [L7hjJ6kk...](https://solscan.io/tx/L7hjJ6kkfXQ71xb8isnEpnh816fcDuV7jeW4dMKbCudZhV5bUzvdbSbpmSG9e6QCmzsWSjJrBmt8FV9kpytD4ZB) |
| 20 | [5h537QnL...](https://solscan.io/tx/5h537QnLEEWSje2XtfCoLUMG4R3jFSUKK5N6K2bn9VFELpy54JNXjNKdFh6kWKe586VGz5X46ETWgBtCCudeUrCY) |

## Current Production Gates

Still blocked:

- production money movement
- public fee collection
- unattended signing
- backend private key custody
- public netting
- physical goods
- high-risk categories
- Polymarket live movement
- broad multi-chain production settlement

Required before public production:

- counsel review
- backup operators for public production
- explicit live-gate approvals
- direct split fee gate before public 10 bps collection

## Final Audit Language

DNA x402 has passed private mainnet dust-size Solana USDC technical chain proof, Public Beta Solana USDC direct split 10 bps dust proof, live Postgres migration/concurrency/backup, Postgres-backed webhook replay-after-restart, persistent Sybil relist under live Postgres, local monitoring collector/dashboard/alert-route proof, external Telegram human-route proof, and Public Beta primary operator assignment. It is ready for capped Public Beta live paid flows that require DNA direct split. It is still not broad permissionless production ready until counsel review, backup operators, expanded fee gate approvals, and explicit expanded live-gate approvals are complete.
# Agent/Copy Postgres Durability Gate

Status: `PASSED_CONTABO_POSTGRES_16_PUBLIC_BETA_DB`

What this adds:

- `agent_wallets`
- `paper_agent_accounts`
- `agent_profiles`
- `alpha_monetization_configs`
- `copy_settings`
- `copy_decisions`
- `copied_lots`
- `alpha_fee_accruals`
- `agent_action_ledgers`

What the Contabo live Postgres rerun proved on 2026-05-16:

- agent wallet public metadata survives restart
- private-key payloads remain rejected before write
- paper balances and paper action ledger survive restart
- public/private profile stats survive restart
- alpha monetization config survives restart
- copy filters and risk caps survive restart
- copied lots survive restart
- finalized copied lots cannot re-finalize after restart
- positive finalized copied-lot PnL creates alpha accrual
- loss/unrealized PnL creates no alpha accrual
- backup/restore preserves agent/copy records
- `db:migrate` passed against the isolated `x402_agent_copy_gate` database with `001_modular_commerce.sql` and `002_agent_copy_durability.sql`
- `db:health` passed with all expected tables present
- `postgres-migration`, `postgres-concurrency`, `postgres-sybil-relist`, and `postgres-agent-copy-durability` tests passed with no skips
- native `pg_dump` / `psql` restore drill passed
- Postgres-mode server mayhem passed, including agent/copy abuse checks after restart

Evidence:

- Host: Contabo `207.180.199.56`
- Database: local PostgreSQL 16 database `x402_agent_copy_gate`
- Backup artifact: `/opt/dna-x402-next/.runtime/postgres-backups/dna-x402-postgres-2026-05-16T11-16-46-967Z.sql`
- Active staging database `x402_prod` was not reset for this drill.
- Active staging database `x402_prod` was backed up to `/opt/dna-x402-backups/x402_prod-before-agent-copy-002-20260516T111724Z.sql`, then migrated non-destructively with `002_agent_copy_durability.sql`; all 9 agent/copy tables were present after migration.
