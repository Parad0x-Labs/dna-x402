# DNA x402 Production Deployment Runbook

DNA x402 now has a modular safety architecture and Gate 2 control spine. It is not yet production marketplace ready. The next hardening cycle makes controls durable, observable, and operable by adding Postgres persistence, hard PII write blocking, integrated server-level mayhem, admin policy/appeals operations, emergency pause, backup/restore, and deployment runbooks. Public production money movement, unattended signing, public netting, physical goods, high-risk categories, and Polymarket live movement remain gated.

## Required Gates

- Postgres migrations executed and verified.
- `npm --prefix x402 run db:backup:test` passes.
- `npm run mayhem:x402` passes.
- `npm run mayhem:x402:server` passes.
- Admin auth configured before admin routes are enabled.
- Live money movement flags remain disabled unless an explicit external go-live approval exists.

## Critical Env Categories

- DB connection.
- Receipt signing key or explicit local-dev replacement.
- Webhook signing secret.
- Policy version.
- Marketplace enabled flag.
- Live money movement flag.
- Polymarket live movement flag.
- Chain RPC only when settlement is enabled.
- Admin auth config when admin routes are enabled.

## Health Checks

- `/health`
- `/status`
- `/admin/x402/emergency`
- `/admin/x402/audit`

Admin health endpoints require admin auth.
