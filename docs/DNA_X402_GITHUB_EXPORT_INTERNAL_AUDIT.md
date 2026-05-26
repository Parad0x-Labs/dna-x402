# DNA x402 GitHub Export Internal Audit

Date: 2026-05-16
Maintainer: sls_0x
Canonical repository: https://github.com/Parad0x-Labs/dna-x402

Legacy mirror: https://github.com/Parad0x-Labs/x402-dna
Visibility: Private
Default branch: main

## Purpose

This packet records what was exported before repository canonicalization, what evidence exists in the repo, what validation was run, and what remains outside the Public Beta scope.

The export is an internal audit snapshot for DNA x402 as a public beta agent and programmable commerce rail. It is not a claim of unlimited permissionless production.

## Export Commits

The GitHub export was pushed through these visible repo commits:

| Commit | Purpose |
|---|---|
| `48ea65b` | Prepared the DNA x402 public beta launch pack. |
| `6385712` | Fixed GitHub Actions Rust toolchain setup for the receipt-anchor job. |
| `7e6e92b` | Tracked the site Polymarket proof data required by the frontend build. |
| `628e47c` | Fixed README SVG card text overflow in the architecture and proof cards. |
| `ce957d6` | Added the GitHub export internal audit packet. |
| `44ec6f7` | Added the x402 backend Agent Builder compiler, endpoints, SDK/CLI helpers, docs, tests, and migration. |

Additional audit-cleanup commits may exist after this table; this document records the Public Beta export snapshot through `44ec6f7` plus the current consistency cleanup.

## Exported Top-Level Surfaces

| Path | Audit Meaning |
|---|---|
| `README.md` | Public repo front door, product boundary, quick parse, Public Beta scope, examples, and start points. |
| `x402/` | Canonical API/server package, SDK exports, verifier, settlement, gates, tests, drills, monitoring, and scripts. |
| `site-agent/` | Agent-facing application and builder/user onboarding surface. |
| `site/` | Public docs/proof front door. |
| `examples/` | Runnable TypeScript examples for buyers, sellers, builders, webhooks, receipt verification, agent wallets, paper agents, copy settings, alpha monetization, and copied lots. |
| `docs/` | Product, safety, legal, monitoring, persistence, launch, and beta evidence packets. |
| `config/` | Public beta and staging/private-pilot config examples. |
| `infra/monitoring/` | Prometheus, Alertmanager, Telegram relay, alert rules, and Grafana dashboard config. |
| `programs/receipt_anchor/` | Solana receipt anchoring program. |
| `.github/workflows/` | GitHub Actions validation workflow. |

## Exported Documentation Index

These tracked docs are included in the private GitHub export:

- `docs/AGENT_QUICKSTART.md`
- `docs/ALT_SETUP.md`
- `docs/API_REFERENCE.md`
- `docs/BUILDER_FEES.md`
- `docs/BUILDER_QUICKSTART.md`
- `docs/DEPLOY_FLY.md`
- `docs/DEPLOY_RAILWAY.md`
- `docs/DEVNET_DEPLOY.md`
- `docs/DNA_X402_ADMIN_ACTION_RUNBOOK.md`
- `docs/DNA_X402_AGENT_BUILDER.md`
- `docs/DNA_X402_AGENT_PERMISSIONS.md`
- `docs/DNA_X402_AGENT_RECIPES.md`
- `docs/DNA_X402_AGENT_WALLET_MODEL.md`
- `docs/DNA_X402_ALPHA_MONETIZATION.md`
- `docs/DNA_X402_ARCHITECTURE_UPGRADE_PLAN.md`
- `docs/DNA_X402_BACKUP_RESTORE_RUNBOOK.md`
- `docs/DNA_X402_BOSS_FIGHT_AUDIT_EVIDENCE.md`
- `docs/DNA_X402_BUILDER_MONETIZATION.md`
- `docs/DNA_X402_COPIED_LOT_LEDGER.md`
- `docs/DNA_X402_COPY_CONTROLS.md`
- `docs/DNA_X402_COUNSEL_REVIEW_BUNDLE.md`
- `docs/DNA_X402_DATABASE_SCHEMA.md`
- `docs/DNA_X402_DEMO_SCRIPT.md`
- `docs/DNA_X402_DEPLOYMENT_RUNBOOK.md`
- `docs/DNA_X402_FEE_WATERFALL.md`
- `docs/DNA_X402_FINAL_TECHNICAL_CLOSEOUT.md`
- `docs/DNA_X402_FUTURE_PROOF_COMMERCE_MATRIX.md`
- `docs/DNA_X402_GITHUB_EXPORT_INTERNAL_AUDIT.md`
- `docs/DNA_X402_GOVERNANCE_AND_APPEALS.md`
- `docs/DNA_X402_INCIDENT_RESPONSE_RUNBOOK.md`
- `docs/DNA_X402_LAUNCH_MODES.md`
- `docs/DNA_X402_LEGAL_COMPLIANCE_REVIEW_PACKET.md`
- `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md`
- `docs/DNA_X402_MAYHEM_TESTS.md`
- `docs/DNA_X402_MIGRATION_RUNBOOK.md`
- `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md`
- `docs/DNA_X402_MONITORING_AND_ALERTS.md`
- `docs/DNA_X402_MONITORING_WIRING_EVIDENCE.md`
- `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md`
- `docs/DNA_X402_POLICY_AND_COMPLIANCE.md`
- `docs/DNA_X402_POLYMARKET_AGENT_VERTICAL.md`
- `docs/DNA_X402_PRIVACY_AND_DATA_RIGHTS.md`
- `docs/DNA_X402_PRODUCT_LOGIC_EXPORT.md`
- `docs/DNA_X402_PRODUCTION_DEPLOYMENT_RUNBOOK.md`
- `docs/DNA_X402_PRODUCTION_LAUNCH_APPROVAL.md`
- `docs/DNA_X402_PROGRAMMABLE_PAYMENTS_PITCH_AND_ATTACK_MATRIX.md`
- `docs/DNA_X402_PUBLIC_BETA_ACCEPTANCE.md`
- `docs/DNA_X402_PUBLIC_LAUNCH_MESSAGING.md`
- `docs/DNA_X402_REPUTATION_AND_SYBIL.md`
- `docs/DNA_X402_SDK_AND_SANDBOX.md`
- `docs/DNA_X402_SETTLEMENT_ABSTRACTION.md`
- `docs/DNA_X402_SITE_AGENT_BUNDLE_REPORT.md`
- `docs/DNA_X402_SOLANA_TRADING_AGENT_VERTICAL.md`
- `docs/DNA_X402_SOLANA_USDC_DRILL_REPORT.md`
- `docs/DNA_X402_TAX_AND_REPORTING.md`
- `docs/ERROR_CODES.md`
- `docs/EXTERNAL_AUDIT_PACKET.md`
- `docs/FOOTPRINT.md`
- `docs/GO_TO_MARKET_SAFE.md`
- `docs/HANDOVER_MARKET_INTELLIGENCE.md`
- `docs/ONE_CLICK_AGENT_FACTORY.md`
- `docs/OPEN_SOURCE_RELEASE.md`
- `docs/PARADOX_STACK.md`
- `docs/POLYMARKET_AGENT_V1_ENGINEERING_TICKETS.md`
- `docs/POLYMARKET_AGENT_V1_LOCKED_PLAN.md`
- `docs/POLYMARKET_PHASE0_PHANTOM_EVM_COMPATIBILITY.md`
- `docs/PRIVATE_PILOT_ACCEPTANCE.md`
- `docs/PROGRAMMABILITY_CONTRACT.md`
- `docs/PROOF.md`
- `docs/PUBLIC_AGENT_ONBOARDING.md`
- `docs/RECEIPT_VERIFICATION.md`
- `docs/RESTRICTED_MARKET_POLICY.md`
- `docs/SECURITY.md`
- `docs/SELLER_LISTING_GUIDE.md`
- `docs/WEBHOOKS.md`
- `docs/X402_COMPAT.md`
- `docs/ZK_X402_LIVE_PATH_REPORT.md`

## Exported Example Projects

| Example | Purpose |
|---|---|
| `examples/buyer-agent-ts` | Buyer agent quote/commit/proof/receipt flow. |
| `examples/seller-paid-api-ts` | Paid API seller integration. |
| `examples/builder-monetized-agent-ts` | Builder fee and monetized agent example. |
| `examples/webhook-receiver-ts` | Signed webhook receiver and verification example. |
| `examples/receipt-verifier-ts` | Receipt verification example. |
| `examples/agent-wallet-client-ts` | Client-side user-owned agent wallet example. |
| `examples/paper-polymarket-agent-ts` | Paper Polymarket-style agent example. |
| `examples/copy-settings-ts` | Copy/follow controls example. |
| `examples/alpha-monetization-ts` | Alpha fee display/accrual example. |
| `examples/copied-lot-ledger-ts` | Copied-lot ledger and finalization example. |

Each example includes a README, `.env.example`, TypeScript source, package metadata, and an acceptance test.

## Exported SDK And Package Surfaces

| Path | Purpose |
|---|---|
| `x402/src/` | Main TypeScript implementation for x402 commerce, policy, receipts, fees, agents, copy controls, monitoring, and gates. |
| `x402/scripts/` | Drill, backup, migration, monitoring, evidence, security, and operational scripts. |
| `x402/tests/` | Unit, integration, mayhem, Postgres, agent/copy, and regression tests. |
| `x402/sdk/python/dna_x402/` | Python receipt verification package. |
| `x402/sdk/python/tests/` | Python SDK receipt tests. |
| `x402/sdk/rust/dna-x402-client/` | Rust receipt/client SDK package. |

## Exported Config And Monitoring Surfaces

| Path | Purpose |
|---|---|
| `config/x402.public-beta.example.json` | Public Beta config template. |
| `config/x402.staging.private-pilot.example.json` | Historical staging/private-pilot config template. |
| `infra/monitoring/prometheus.yml` | Prometheus scrape config. |
| `infra/monitoring/alerts.yml` | Alert rules for emergency pause, PII, DB, verifier, backup, restore, webhook replay, admin burst, and settlement failures. |
| `infra/monitoring/grafana-dashboard-x402.json` | Grafana dashboard JSON. |
| `infra/monitoring/alertmanager-telegram-relay.example.yml` | Alertmanager to Telegram relay example. |

## Evidence Summary In Repo

The export includes documentation and reports covering:

- Public Beta scope and acceptance.
- Prompt-to-Agent and Guided Agent Builder backend support, including drafts, templates, cloneable recipes, risk summaries, and policy rejection for unsafe prompts.
- Builder Developer Launch Pack.
- Builder fee waterfall and non-custodial accrual model.
- Public Beta direct split 10 bps dust proof path.
- Private mainnet Solana USDC dust proof and direct-split drill evidence.
- Live Postgres migration, health, concurrency, backup, restore, webhook replay-after-restart, and Sybil relist proof.
- Agent/copy Postgres durability for wallets, paper accounts, profiles, alpha configs, copy settings, copied lots, alpha accruals, and action ledgers.
- Monitoring with Prometheus/Grafana/Alertmanager plus Telegram human alert route.
- Production launch approval framework, still fail-closed until production facts and approvals are complete.
- Counsel review bundle and live-gate checklists.

## Contabo Public Beta Route Evidence

The tracked audit packets record the Contabo Public Beta route evidence:

- `https://parad0xlabs.com/x402/health` is live.
- Public `/x402/metrics` is blocked.
- Raw public `8080` access is blocked.
- Local metrics remain available for collectors.
- `dna-x402.service` runs from `/opt/dna-x402-next`.
- The scheduled `pg_dump` timer is enabled.
- The Contabo route is Public Beta only. It is not unlimited permissionless production approval.

## Agent/Copy Durability Evidence

The tracked audit packets record the agent/copy durability gate as passed on Contabo PostgreSQL 16:

- `002_agent_copy_durability.sql` was applied non-destructively.
- Agent wallets survive restart/restore.
- Paper accounts survive restart/restore.
- Agent profiles survive restart/restore.
- Alpha monetization configs survive restart/restore.
- Copy settings survive restart/restore.
- Copied lots survive restart/restore.
- Alpha fee accruals survive restart/restore.
- Agent action ledgers survive restart/restore.

## Validation Snapshot

The export path was validated with cumulative local checks before the GitHub push:

| Check | Result |
|---|---|
| `npm --prefix x402 test` | Passed: 351 passed, 8 skipped after the Agent Builder backend pack. |
| `npm --prefix x402 run typecheck:x402` | Passed. |
| `npm run mayhem:x402` | Passed. |
| `npm run mayhem:x402:server` | Passed during server mayhem passes before export. |
| `npm --prefix x402 run security:scan` | Passed. |
| `npm --prefix x402 audit --audit-level=high` | Passed. |
| `npm --prefix x402 run build` | Passed. |
| `npm run acceptance:builder` | Passed. |
| `npm run acceptance:agents` | Passed. |
| `npm --prefix site-agent test` | Passed: 8 passed at export time. |
| `npm --prefix site-agent run build` | Passed. |
| `npm --prefix site-agent run analyze` | Passed. |
| `npm --prefix site-agent audit --audit-level=high` | Passed. |
| `git diff --check` | Passed at export time. |

GitHub Actions `mainnet-readiness` passed after the README overflow fixes on commit `628e47c` and again after the Agent Builder backend pack on commit `44ec6f7`.

## GitHub Actions Coverage

The private GitHub repo includes `.github/workflows/security-scan.yml`, which validates:

- Node package install.
- x402 tests.
- x402 typecheck.
- x402 build.
- x402 security scan.
- x402 high-level audit.
- site-agent tests.
- site-agent build.
- site-agent analyze.
- site-agent high-level audit.
- builder acceptance tests.
- Rust receipt-anchor test job.

The Rust toolchain setup was fixed in commit `6385712`, and the required site data asset was tracked in commit `7e6e92b`.

## README Visual Asset Cleanup

The README uses three SVG assets:

- `docs/assets/dna-header.svg`
- `docs/assets/dna-proof-card.svg`
- `docs/assets/dna-architecture.svg`

The proof and architecture cards were tightened in commit `628e47c`. The header card was then widened/reduced slightly so GitHub's README renderer keeps card text inside boundaries.

Local render checks were saved under:

- `reports/svg-card-check/dna-header.png`
- `reports/svg-card-check/dna-proof-card.png`
- `reports/svg-card-check/dna-architecture.png`

The `reports/` directory is runtime evidence and is not part of the GitHub source export unless explicitly promoted into docs.

## Explicit Non-Claims

This export does not claim:

- unlimited permissionless production;
- backend private key custody;
- backend signing;
- hidden fees;
- unrestricted autonomous live trading;
- public Polymarket live movement;
- public Solana autonomous trading;
- physical goods;
- public netting;
- high-risk categories;
- guaranteed compliance in all jurisdictions.

## Current Product Status

DNA x402 is entering Public Beta for agents, builder APIs, paper trading, copy controls, public profiles, and low-risk capped live payments.

Users can create agents, test strategies, publish profiles, configure copy rules, and use visible receipt-bound fees.

Backend custody, backend signing, hidden fees, unrestricted autonomous live trading, physical goods, public netting, and high-risk categories are not in beta scope.

## Remaining Gate Items

Before broader production expansion / permissionless production:

- production deployment evidence must be filled with real production API/docs URLs and provider facts;
- production Postgres proof must be run against the production/staging-production DB;
- production monitoring and Telegram alert proof must be run from the deployed environment;
- counsel response must be recorded and folded into live gates;
- public-production backup operators must be assigned;
- narrow live-gate approval must be recorded;
- dangerous categories must remain outside beta scope until separately approved.

## Secret Handling

Secrets were not committed as part of the GitHub export.

The source export keeps `.env`-style files out of git, uses `.env.example` placeholders, redacts Telegram and Helius secrets in reports, and keeps runtime artifacts outside tracked source by default.

Root-level runtime directories intentionally remain ignored:

- `/.deploy/`
- `/data/`
- `reports/`
- `.tools/`
