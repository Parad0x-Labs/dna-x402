# DNA x402 Incident Response Runbook

## First Actions

1. Pause the affected flow.
2. Preserve logs and audit export.
3. Identify affected sellers, buyers, listings, receipts, and webhooks.
4. Disable listings or sellers only through audited admin actions.
5. Do not delete policy history.

## Emergency Pause

Use:

```http
POST /admin/x402/emergency
```

Body:

```json
{
  "flag": "quotePaused",
  "enabled": true,
  "reason": "incident description",
  "actorId": "operator-id"
}
```

Supported flags:

- `quotePaused`
- `finalizePaused`
- `marketplacePaused`
- `webhookPaused`
- `sellerListingUpdatesPaused`

Receipts and audit reading must remain available during pause.

## Evidence

Export audit records from:

```http
GET /admin/x402/audit
GET /admin/audit/export
```
