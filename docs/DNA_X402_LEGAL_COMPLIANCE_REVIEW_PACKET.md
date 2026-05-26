# DNA x402 Legal And Compliance Review Packet

Status: review packet prepared for external counsel. Public seller scale and public production remain `BLOCKED` until external counsel feedback is received and folded back into the live gate checklists.

## Product Overview

DNA x402 is a programmable commerce rail:

- sellers publish signed capabilities
- buyers and agents discover listings
- quotes are machine-readable
- payment proofs are verified
- receipts bind request, response, settlement, fee, and policy metadata
- reputation and audit trails update from proof events

## Custody Model

- Backend must not store private keys, seed phrases, session keys, or wallet dumps.
- Backend must not sign user orders or transfers.
- Production money movement remains gated.
- Live gates remain blocked for production money movement, unattended signing, public netting, physical goods, high-risk categories, and Polymarket live movement.

## Persistence Model

- Repository ports support memory, file snapshot, and Postgres-compatible adapters.
- The production schema is `x402/src/db/migrations/001_modular_commerce.sql`.
- G-local live PostgreSQL 18 migration, health, concurrency, native `pg_dump` backup, and `psql` restore drills passed on 2026-05-15.
- File snapshot durability is a local test bridge, not production durability.
- Managed production database deployment and public-production operator approvals remain separate launch gates.

## Current Technical Evidence

- Private mainnet dust-size Solana USDC technical chain proof passed for allowlisted wallets and low-risk sandbox listing only.
- Live Postgres migration/concurrency/backup/restore passed on the G-local drill instance.
- Postgres-backed webhook replay-after-restart passed.
- Persistent Sybil relist test passed under live Postgres mode.
- Local Prometheus/Grafana/Alertmanager monitoring route passed.
- External Telegram human alert delivery passed for test, emergency pause, PII block, and backup failure alerts.
- Private-pilot primary operator assignment is complete with sls_0x assigned to all primary roles; public-production backup operators remain pending.

## Compliance Hooks

- Policy engine with `PolicyInputV1`.
- Sanctions/KYC/KYB adapter interfaces.
- Tax profile and seller aggregate hooks.
- Governance denylist and appeals.
- PII-free immutable receipt and audit model.
- Admin audit model for denylist, appeals, emergency pause, listing disable/restore, and raw event access.

## Privacy Model

- PII is stored only in mutable records.
- Receipts, anchors, proof records, and immutable audit events reject raw PII before hash/sign/write.
- Data-subject request records exist for access, erasure, rectification, export, and restriction.
- Immutable PII guard runs before receipt hash/sign/write and before governance audit persistence.
- Tax aggregate hooks track gross proceeds, refunds, fees, thresholds, and missing seller tax profiles.

## Polymarket Gate Status

- Polymarket remains a vertical on top of DNA x402.
- Backend private key custody remains forbidden.
- Browser-local signer remains required.
- Live Polymarket production movement remains blocked until its dedicated live gate checklist passes.

## Open Counsel Questions

- Under what conditions could DNA x402 be treated as an MSB or money transmitter?
- Which marketplace categories require KYC/KYB before seller activation?
- What seller tax reporting thresholds apply by jurisdiction?
- What data must be retained despite erasure requests?
- What sanctions screening level is required before public launch?
- What disclosures are required for agent-paid services?
- What is the safe launch scope for low-risk paid APIs/data feeds?
- What extra controls are required before physical goods?
- What extra controls are required before Polymarket/copy-agent monetization?
- What are the jurisdictional blockers for EU users?

Priority counsel sequence:

1. Can low-risk paid API/data-feed commerce using USDC trigger MSB or money-transmitter classification?
2. What is the safe launch scope before KYC/KYB?
3. What seller tax reporting thresholds apply by jurisdiction?
4. What data must be retained despite GDPR erasure requests?
5. What sanctions screening is required before public launch?
6. What extra controls are required before Polymarket/copy-agent monetization?

## Live Movement Gates

- No public production money movement.
- No unattended signing.
- No public netting.
- No physical goods marketplace.
- No high-risk category publishing.
- No Polymarket production movement.
- No public 10 bps fee collection or direct split collection until the direct split fee gate passes.

See `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md` for the concrete checklist requirements and approval fields.

## Counsel Review Bundle

The external counsel packet should include:

- `docs/DNA_X402_LEGAL_COMPLIANCE_REVIEW_PACKET.md`
- `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md`
- `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md`
- `docs/DNA_X402_BOSS_FIGHT_AUDIT_EVIDENCE.md`
- `docs/DNA_X402_SOLANA_USDC_DRILL_REPORT.md`
- `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md`
- `docs/DNA_X402_COUNSEL_REVIEW_BUNDLE.md`

Counsel submission status: `PREPARED_NOT_EXTERNALLY_SENT_FROM_REPO`

Production status remains `BLOCKED` until counsel feedback is received, recorded, and reflected in the live gate checklist.
