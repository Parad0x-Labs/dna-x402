# DNA x402 Mayhem Tests

Date: 2026-05-15

## Command

```bash
npm run mayhem:x402
npm run mayhem:x402:sandbox
npm run mayhem:x402:server
```

The command is sandbox-safe and does not perform live money movement.

## Current Attack Coverage

- commit abandonment limit
- replay and concurrent replay
- sealed bid mismatch
- bundle circular dependency
- wash trade ignored
- restricted listing policy block
- agent overspend and revoked session
- webhook replay
- fee double charge
- depeg and unavailable chain quote removal
- tax threshold without profile blocks payout
- PII in receipt
- PII in audit event
- GDPR erasure preserves immutable reference
- denylist without evidence

## Server-Level Attack Coverage

The integrated server mode boots the app with a fake verifier and attacks HTTP routes:

- underpay
- wrong mint
- wrong recipient
- expired quote
- unsupported settlement
- stream reuse
- commit reuse
- response swap
- payment proof without commit
- payment proof for different quote
- concurrent replay
- finalize while paused
- receipt read while paused
- restricted publish
- restricted quote after unsafe registry insert
- high-risk category block
- public physical goods block/review
- disabled listing quote block
- admin disable/restore audit
- metrics endpoint
- public graph query
- competitor seller graph query
- admin raw graph read audit
- public aggregate below threshold
- emergency pause
- PII in receipt before write
- PII in governance audit before write
- sealed bid mismatch
- auction late reveal guard
- bundle circular dependency
- bundle max depth
- wash/self volume confidence
- sandbox-only webhook receiver unavailable without gate
- webhook valid-once HTTP receiver path
- webhook bad signature rejection
- webhook old timestamp rejection
- webhook duplicate idempotency rejection
- webhook PII block before immutable receiver log

Remaining future expansions:

- Sybil seller relist against persistent seller clustering
- auction late reveal through a real auction HTTP route
- stale emergency block expiration review
- webhook replay after restart through live Postgres adapter

## Next Required Server Mayhem Work

Do not add new product surfaces before this coverage is added.

The dedicated webhook HTTP receiver now covers the sandbox-safe in-process receiver checks. The remaining required webhook mayhem proof is replay after process restart with the Postgres adapter enabled.

Persistent Sybil relist coverage must wait until live Postgres is available. That test must prove a seller cannot clear policy strikes or regain clean trust by changing slug, linking a new wallet, or relisting after restart.
