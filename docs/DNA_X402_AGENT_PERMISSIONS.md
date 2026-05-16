# DNA x402 Agent Permissions

Date: 2026-05-15

## Purpose

Autonomous and semi-autonomous agents need spending limits before they can safely buy from other agents.

## Implemented Model

`AgentSpendPolicy` includes:

- owner wallet
- allowed and blocked capabilities
- max spend per call
- max spend per day
- max spend per seller
- max bundle depth
- allowed settlement modes
- allowed tokens
- expiry
- human approval threshold
- netting permission
- streaming permission
- sub-agent delegation permission
- revoke state

## Controls

- revoked session cannot spend
- expired session cannot spend
- blocked category cannot be bought
- amount cannot exceed per-call, daily, or per-seller limits
- token and settlement mode must be explicitly allowed
- netting and streaming require explicit permission
- bundle depth is capped

## Next UI

The marketplace control surface now exposes the concept. The next build should add a user-facing spend controls panel with dry-run simulation before execution.
