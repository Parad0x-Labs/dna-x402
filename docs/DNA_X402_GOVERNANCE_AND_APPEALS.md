# DNA x402 Governance And Appeals

Date: 2026-05-15

## Purpose

Denylist power is a central risk. It needs evidence, versioning, appeal, and audit trail.

## Implemented Model

`PolicyRuleChange`:

- create, update, disable
- proposed, approved, rejected, rolled back
- reason
- diff
- effective timestamp

`DenylistEntry`:

- subject type and value
- reason code
- evidence refs
- severity
- active, expired, revoked
- creator
- optional expiry

`PolicyAppeal`:

- subject
- policy decision ID
- reason
- evidence
- open, review, approved, rejected
- reviewer
- resolution reason

## Rules

- Denylist entry without reason or evidence is rejected.
- Policy rule changes are role gated.
- Appeal resolution is role gated.
- Governance actions create audit events.
- Policy history cannot be silently deleted.
