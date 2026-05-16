# DNA x402 Admin Action Runbook

Admin routes are under `/admin` and require `ADMIN_SECRET` unless explicitly running local insecure mode.

## Policy

- `GET /admin/x402/policy`

Shows policy audit events and reason codes.

## Denylist

- `GET /admin/x402/denylist`
- `POST /admin/x402/denylist`
- `POST /admin/x402/denylist/:entryId/revoke`

Denylist creation requires reason and evidence. Entries without evidence are rejected.

## Appeals

- `GET /admin/x402/appeals`
- `POST /admin/x402/appeals`
- `POST /admin/x402/appeals/:appealId/resolve`

Appeal approval is an audited governance action.

## Emergency

- `GET /admin/x402/emergency`
- `POST /admin/x402/emergency`

Emergency pause changes require actor and reason.

## Audit

- `GET /admin/x402/audit`
- `GET /admin/audit/export`
