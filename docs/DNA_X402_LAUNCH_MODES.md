# DNA x402 Launch Modes

This document prevents unsafe drift by defining launch modes. Each mode lists enabled scope, disabled scope, required gates, volume limits, seller types, monitoring, rollback, and operator requirements.

## Mode 0: Lab

- Enabled: local development, fake verifier, sandbox agents, local/file/Postgres dev state, sandbox checkout, mayhem tests.
- Disabled: production money movement, unattended signing, backend key custody, public netting, public physical goods, high-risk categories, Polymarket live movement, broad multi-chain settlement.
- Required gates: none beyond local test hygiene.
- Max volume: zero live value.
- Allowed sellers: test fixtures only.
- Monitoring: local `/metrics` optional.
- Rollback: stop local process and reset sandbox state.
- Operators: developer/operator running the lab.

## Mode 1: Private Testnet

- Enabled: testnet/devnet settlement only, invited sellers, limited buyer wallets, sandbox webhooks, receipt proof demos.
- Disabled: public marketplace, live production funds, unattended signing, public netting, physical goods, high-risk categories, Polymarket live movement.
- Required gates: testnet settlement proof, server mayhem, PII guard, emergency pause, monitoring smoke test.
- Max volume: zero mainnet value.
- Allowed sellers: invited internal or friendly test sellers.
- Monitoring: collector scrape and emergency pause alert in test environment.
- Rollback: disable quotes/finalize, stop testnet verifier, clear invited seller list.
- Operators: named testnet operator and backup.

## Mode 2: Private Mainnet Pilot

- Enabled: low-risk paid APIs/data feeds only, hand-approved sellers, strict caps, manual payout review, Solana USDC only if live-money gate is approved.
- Disabled: unattended agents, physical goods, high-risk categories, public netting, Polymarket live movement, non-Solana production settlement.
- Required gates: live Postgres migration/concurrency/backup, monitoring alert routing, counsel-approved scope, operator assignment, live-money checklist approval.
- Max volume: explicit cap in launch approval.
- Allowed sellers: manually approved low-risk API/data-feed providers.
- Monitoring: production collector, dashboard, alert routing, backup/restore alerts.
- Rollback: emergency pause, disable finalize, disable quotes, disable seller updates, revoke pilot sellers.
- Operators: primary incident operator, backup operator, policy reviewer.

## Mode 3: Public Low-Risk Marketplace

- Enabled: public browsing for low-risk APIs/tools/data feeds, seller verification rules, tax thresholds, support/appeals, public receipts.
- Disabled: public netting, physical goods, high-risk categories, Polymarket live movement, unattended live agent spending, broad multi-chain settlement.
- Required gates: counsel-reviewed launch scope, tax hooks active, sanctions/KYC/KYB adapters as required, monitoring live, operators staffed, appeal process staffed.
- Max volume: public cap defined by gate approval.
- Allowed sellers: low-risk categories passing policy and seller verification.
- Monitoring: full production collector, dashboards, alert routing, incident drills.
- Rollback: public marketplace pause, seller disable, listing disable, finalize pause, webhook pause.
- Operators: incident operator, policy approver, appeal reviewer, support owner.

## Mode 4: Expanded Vertical Pilots

- Enabled: compute, auctions, subscriptions, agent bundles, private enterprise networks only after vertical-specific gates.
- Disabled: any vertical without its own gate evidence.
- Required gates: vertical checklist, server mayhem extension, counsel where needed, operator runbook, monitoring panels.
- Max volume: per-vertical cap.
- Allowed sellers: vertical-approved providers.
- Monitoring: vertical-specific dashboards and alerts.
- Rollback: vertical kill switch plus global emergency pause.
- Operators: vertical owner plus global incident operator.

## Mode 5: High-Risk / Regulated

- Enabled: nothing by default.
- Disabled: physical goods, public netting, high-risk categories, trading/copy-agent monetization, broad multi-chain production settlement unless counsel and operators explicitly approve.
- Required gates: category-specific legal review, KYB/KYC/sanctions controls, tax reporting, staffed disputes, manual review, monitoring, rollback, executive approval.
- Max volume: defined only after approval.
- Allowed sellers: verified and approved only.
- Monitoring: full production monitoring plus category-specific risk alerts.
- Rollback: immediate pause, payout freeze if legally permitted, listing/seller disable, incident response.
- Operators: legal/compliance owner, incident operator, policy approver, appeal reviewer.

## Runtime Rule

The launch mode does not override kill switches. `X402_ENABLE_*` gates remain centralized in config and default to the safest value. Emergency pause overrides enable flags.
