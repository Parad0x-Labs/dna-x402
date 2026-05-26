# DNA x402 Operator Assignments

Date: 2026-05-15

Status: `PUBLIC_BETA_PRIMARY_OPERATOR_ASSIGNED_BACKUPS_PENDING`

This document records the named humans responsible for production operations. Public production is not approved until these roles are assigned, contactable, and referenced from the live-gate checklist.

## Current Production Approval

Production launch approval: `BLOCKED`

Reason: counsel review, backup operators, direct split fee gate review, and explicit live-gate approvals are still pending.

Passed technical evidence:

- private mainnet dust-size Solana USDC technical chain proof
- live Postgres migration/concurrency/backup
- Postgres-backed webhook replay-after-restart
- persistent Sybil relist under live Postgres
- local Prometheus/Grafana/Alertmanager monitoring route
- external Telegram human alert routing

## Alert Route

Primary alert channel: `DNA x402 Ops Alerts`

Route status: `PASSED_EXTERNAL_TELEGRAM_ROUTE`

Evidence:

- `<repo-root>\reports\monitoring\2026-05-15T16-40-33-398Z-telegram-route\telegram-route-summary.json`

Do not record bot tokens, private chat IDs, phone numbers, or private credentials in this file.

## Incident Commander

Name: sls_0x

Contact: Telegram `@PlugMeHabibi` / `DNA x402 Ops Alerts`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA`

Responsibilities:

- owns incident severity and final incident decisions
- coordinates emergency pause, customer communication, and recovery order
- confirms incident closure and postmortem owner

## Emergency Pause Operator

Name: sls_0x

Wallet/account: primary operator account, final wallet/account reference kept outside this public repo

Contact: `DNA x402 Ops Alerts`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA_BACKUP_REQUIRED_FOR_PUBLIC_PROD`

Responsibilities:

- can trigger quote/finalize/marketplace/webhook pause
- confirms old receipts remain readable during pause
- records reason, timestamp, and rollback plan for every pause action

## Monitoring / On-Call Operator

Name: sls_0x

Alert channel: `DNA x402 Ops Alerts`

Contact: Telegram `@PlugMeHabibi`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA_BACKUP_REQUIRED_FOR_PUBLIC_PROD`

Responsibilities:

- watches external Telegram alerts
- acknowledges `X402EmergencyPauseActive`, `X402PiiBlock`, backup failure, DB error, verifier error, settlement unavailable, and webhook replay spikes
- escalates unresolved critical alerts to the incident commander

## Database / Backup Operator

Name: sls_0x / technical helper if available

Contact: Telegram `@PlugMeHabibi` / `DNA x402 Ops Alerts`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA_BACKUP_REQUIRED_FOR_PUBLIC_PROD`

Responsibilities:

- owns Postgres backup/restore drills
- verifies restored receipts, pause state, webhook replay keys, policy strikes, appeals, tax aggregates, and listing state
- tracks backup failure and restore drill failure alerts

## Legal / Compliance Owner

Name: sls_0x

Contact: Telegram `@PlugMeHabibi`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA`

Responsibilities:

- sends and tracks the legal/compliance review packet
- owns counsel feedback updates to live-gate checklists
- approves launch scope only after counsel response is reflected in docs and controls

## Security / Custody Reviewer

Name: sls_0x / technical helper if available

Contact: Telegram `@PlugMeHabibi` / `DNA x402 Ops Alerts`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA`

Responsibilities:

- confirms backend private key custody remains impossible
- reviews no unattended signing, no auto-sweep, no hidden fee collection, and no backend fee-wallet custody
- owns secret-scan failures and custody-related launch blockers

## Release Approver

Name: sls_0x

Contact: Telegram `@PlugMeHabibi`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA_BACKUP_REQUIRED_FOR_PUBLIC_PROD`

Responsibilities:

- approves deploys only after validation commands pass
- verifies live gates remain blocked unless explicitly approved
- refuses public production if counsel/operator/gate evidence is incomplete

## Direct Split Fee Gate Owner

Name: sls_0x

Contact: Telegram `@PlugMeHabibi`

Backup: `TBD`

Approval status: `ASSIGNED_PUBLIC_BETA_GATE_STILL_REQUIRES_APPROVAL`

Responsibilities:

- owns the direct split proof/finalization gate before public 10 bps collection
- confirms no auto-sweep, no backend custody, and no SOL-equivalent threshold sweeping
- verifies fee waterfall disclosure and receipt binding before any public fee collection

## Required Before Public Production

- all roles above have named humans
- backup operators assigned for emergency pause, monitoring/on-call, DB/backup, and release approval
- each other primary role has a backup or explicit single-operator risk acceptance
- every operator confirms access to `DNA x402 Ops Alerts`
- emergency pause operator confirms they can pause quote/finalize/marketplace/webhooks
- DB/backup operator confirms latest restore drill evidence
- legal/compliance owner confirms counsel packet has been sent
- security/custody reviewer confirms no backend key custody/signing path
- release approver confirms all live gates remain blocked unless explicitly approved

## Current Open Items

- `BLOCKED`: external counsel review
- `BLOCKED`: backup operators for public production
- `BLOCKED`: explicit live-gate approvals
- `BLOCKED`: direct split fee gate before public 10 bps collection

## Single-Operator Public Beta Note

One person owning multiple roles is acceptable for capped Public Beta. Public production requires at least one backup operator for:

- emergency pause
- monitoring/on-call
- DB/backup
- release approval
