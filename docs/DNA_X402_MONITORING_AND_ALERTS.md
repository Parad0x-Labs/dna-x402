# DNA x402 Monitoring And Alerts

Status: `/metrics` exists for Prometheus-style scraping. Production dashboards and alert routing still need operator setup.

Prepared config:

- `infra/monitoring/prometheus.yml`
- `infra/monitoring/alerts.yml`
- `infra/monitoring/grafana-dashboard-x402.json`
- `docs/DNA_X402_MONITORING_WIRING_EVIDENCE.md`

## Metrics Endpoint

```txt
GET /metrics
```

Current counters/gauges:

- `x402_quotes_created_total`
- `x402_quotes_blocked_total`
- `x402_commits_created_total`
- `x402_finalize_success_total`
- `x402_finalize_rejected_total`
- `x402_receipts_issued_total`
- `x402_policy_blocks_total`
- `x402_policy_reviews_total`
- `x402_pii_blocks_total`
- `x402_webhook_deliveries_total`
- `x402_webhook_replays_rejected_total`
- `x402_emergency_pause_active`
- `x402_admin_actions_total`
- `x402_appeals_open_total`
- `x402_denylist_active_total`
- `x402_tax_profiles_missing_total`
- `x402_db_errors_total`
- `x402_verifier_errors_total`
- `x402_settlement_unavailable_total`
- `x402_mayhem_failures_total`

## Required Alerts

- finalize rejection spike: `x402_finalize_rejected_total` increases above baseline for 5 minutes
- verifier error spike: `x402_verifier_errors_total` increases above baseline for 5 minutes
- DB error spike: any increase in `x402_db_errors_total`
- webhook replay spike: any burst in `x402_webhook_replays_rejected_total`
- PII block occurrence: any increase in `x402_pii_blocks_total`
- emergency pause activated: `x402_emergency_pause_active == 1`
- admin action burst: abnormal increase in `x402_admin_actions_total`
- policy block spike: abnormal increase in `x402_policy_blocks_total`
- tax threshold blocked payout: payout block reason in policy/audit logs
- settlement chain unavailable: increase in `x402_settlement_unavailable_total`
- receipt signing failure: any receipt issue failure or immutable write failure
- backup failure: failed `db:backup` or scheduled backup job
- restore drill failure: failed `db:backup:test:postgres`

## Blunt Production Requirement

Metrics existing is not enough. Before public launch, wire this endpoint into a production collector, build dashboards, configure alert routing, and run an incident drill that includes emergency pause, backup failure, restore failure, PII block, and verifier outage.

`docs/DNA_X402_MONITORING_WIRING_EVIDENCE.md` must record real scrape/import/rule-load/alert-delivery evidence before monitoring is considered production-wired.
