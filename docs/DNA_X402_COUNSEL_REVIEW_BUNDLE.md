# DNA x402 Counsel Review Bundle

Date: 2026-05-15

Status: `PREPARED_NOT_EXTERNALLY_SENT_FROM_REPO`

Public production approval: `BLOCKED`

Reason: counsel review feedback has not yet been received or folded back into the live gate checklists. Public-production backup operators, direct split fee gate review, and explicit live-gate approvals are also still pending.

## Purpose

This is the handoff index for external legal/compliance review. It points counsel to the product model, money-flow controls, custody model, technical evidence, live-gate blockers, and open legal questions.

This packet does not approve public production, public fee collection, public marketplace launch, Polymarket live movement, public netting, physical goods, high-risk categories, unattended signing, or backend private key custody.

## Review Bundle

Send these documents together:

| Document | Purpose |
| --- | --- |
| `docs/DNA_X402_LEGAL_COMPLIANCE_REVIEW_PACKET.md` | Primary legal/compliance overview, custody model, policy/tax/privacy hooks, Polymarket gate status, and counsel questions. |
| `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md` | Written approval gates for production money movement, Polymarket live movement, public netting, physical goods, high-risk categories, multi-chain settlement, and direct fee collection. |
| `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md` | Consolidated architecture and implementation audit packet. |
| `docs/DNA_X402_BOSS_FIGHT_AUDIT_EVIDENCE.md` | One-stop technical evidence index for Solana dust proof, Postgres, monitoring, webhook replay, Sybil relist, and related proof artifacts. |
| `docs/DNA_X402_SOLANA_USDC_DRILL_REPORT.md` | Private mainnet dust-size Solana USDC technical chain proof and explicit non-production classification. |
| `docs/DNA_X402_OPERATOR_ASSIGNMENTS.md` | Public Beta primary operator assignment and public-production backup operator blockers. |
| `docs/DNA_X402_PRODUCTION_LAUNCH_APPROVAL.md` | Release approval packet for the limited public low-risk API/data-feed/tool pilot. |
| `docs/DNA_X402_PUBLIC_LAUNCH_MESSAGING.md` | Draft public wording and forbidden claims for counsel review before advertising. |

## Current Passed Evidence

- Private mainnet dust-size Solana USDC technical chain proof passed.
- Live Postgres migration, health, concurrency, backup, and restore passed on the G-local PostgreSQL 18 drill instance.
- Postgres-backed webhook replay-after-restart passed.
- Persistent Sybil relist passed under live Postgres mode.
- Local Prometheus/Grafana/Alertmanager monitoring route passed.
- External Telegram human alert delivery passed for test, emergency pause, PII block, and backup failure alerts.
- Public Beta primary operator roles are assigned to Saulius.

## Still Blocked

- External counsel/legal review.
- Public-production backup operators for emergency pause, monitoring/on-call, DB/backup, and release approval.
- Explicit live-gate approvals.
- Direct split fee proof/review before public 10 bps collection.

## Priority Counsel Questions

1. Can low-risk paid API/data-feed commerce using USDC trigger MSB or money-transmitter classification?
2. What is the safe launch scope before KYC/KYB?
3. What seller tax reporting thresholds apply by jurisdiction?
4. What data must be retained despite GDPR erasure requests?
5. What sanctions screening is required before public launch?
6. What extra controls are required before Polymarket/copy-agent monetization?
7. What disclosures are required for autonomous agent-paid services?
8. Which countries, states, or regions should be excluded at launch?
9. What terms of service and seller agreement language is required before a private mainnet pilot?
10. What operational logs must be retained, for how long, and under what access controls?

## Required Counsel Feedback Targets

Counsel feedback must be folded into:

- `docs/DNA_X402_LIVE_GATE_CHECKLISTS.md`
- `docs/DNA_X402_LEGAL_COMPLIANCE_REVIEW_PACKET.md`
- `docs/DNA_X402_MODULAR_COMMERCE_AUDIT_PACKET.md`
- `docs/DNA_X402_FINAL_TECHNICAL_CLOSEOUT.md`
- `docs/DNA_X402_PRODUCTION_LAUNCH_APPROVAL.md`
- `docs/DNA_X402_PUBLIC_LAUNCH_MESSAGING.md`

## Submission Log

| Date | Recipient | Sender | Status | Notes |
| --- | --- | --- | --- | --- |
| `PENDING` | `PENDING` | `PENDING` | `NOT_SENT` | Update only after the packet is actually sent externally. |

## Current Status Language

DNA x402 has passed private mainnet dust-size Solana USDC technical chain proof, live Postgres migration/concurrency/backup, Postgres-backed webhook replay-after-restart, persistent Sybil relist under live Postgres, local monitoring collector/dashboard/alert-route proof, external Telegram human-route proof, and Public Beta primary operator assignment. It is still not public production ready until counsel review, public-production backup operators, direct split fee gate review, and explicit live-gate approvals are complete.
