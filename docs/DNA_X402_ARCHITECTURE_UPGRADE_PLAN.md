# DNA x402 Modular Commerce Network Upgrade

Date: 2026-05-15

## Summary

DNA x402 is being upgraded from a working programmable payment rail into a modular programmable commerce network. The existing core loop stays intact:

signed listing -> quote -> commit -> payment proof -> verification -> signed receipt -> paid retry -> fulfillment -> proof/reputation update.

The key architecture rule is that `market` remains orchestration only. Business rules live in services:

- `policy`
- `identity`
- `tax`
- `privacy`
- `eventPrivacy`
- `governance`
- `permissions`
- `fees`
- `settlement`
- `economics`
- `compute`
- `webhooks`
- `mayhem`

## Implemented Foundation

- `PolicyInputV1` and stable policy decision hashing.
- PII-free policy audit events.
- Tax profile and aggregate hooks.
- Data subject request and erasure model.
- Transaction graph access policy.
- Denylist governance and appeal service.
- Agent spend policy evaluator.
- Fee waterfall engine.
- Settlement option registry.
- Compute job state machine.
- Business attack helpers for commit abandonment, wash volume, sealed bid reveal, and bundle loops.
- Sandbox-safe `npm run mayhem:x402`.
- `/agent/marketplace` buyer and seller control surface.

## Locked Gates

- No production money movement without explicit test evidence.
- No backend private key custody or signing.
- No public netting without trusted bilateral credit controls.
- No public physical goods without verification, dispute, refund, and blocked-goods operations.
- No high-risk public categories by default.
- Polymarket remains a vertical, not the whole product.

## Storage Strategy

Use repository ports first:

- in-memory adapters for unit tests
- file snapshot adapters for local labs
- Postgres-compatible schemas documented before production migration

This avoids hardwiring product logic to one database while still keeping the production migration path clear.

## Regression Rule

Every gate must run cumulative tests:

- `npm --prefix x402 test`
- `npm --prefix x402 run typecheck:x402`
- `npm --prefix x402 run security:scan`
- `npm --prefix x402 audit --audit-level=high`
- `npm --prefix x402 run build`
- `npm --prefix site-agent test`
- `npm --prefix site-agent run build`
- `npm --prefix site-agent audit --audit-level=high`
