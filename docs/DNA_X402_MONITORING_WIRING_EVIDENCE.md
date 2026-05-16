# DNA x402 Monitoring Wiring Evidence

Status: `LOCAL_MONITORING_STACK_AND_EXTERNAL_TELEGRAM_ROUTE_PASSED`

Date: 2026-05-15

Boss 4 local monitoring wiring has been exercised with G-local tooling:

- Prometheus `v3.11.3`
- Alertmanager `v0.32.1`
- Grafana `v13.0.1+security-01`
- local operator webhook receiver on `127.0.0.1:19094`

Tooling, runtime data, and evidence were kept under `G:\DNA x402`:

- tools: `G:\DNA x402\.tools\monitoring`
- runtime: `G:\DNA x402\.runtime\monitoring`
- evidence: `G:\DNA x402\reports\monitoring\2026-05-15T15-43-16-634+03-00`

This proves collector, dashboard, rule loading, alert delivery to a local operator route, and external Telegram delivery to the private `DNA x402 Ops Alerts` group. The Telegram evidence proves a real human/operator route. Named production operators and live-gate approvals are still separate blockers.

## Evidence Checklist

| Evidence item | Status | Evidence |
| --- | --- | --- |
| DNA x402 `/metrics` reachable by collector | `PASSED_LOCAL` | `x402-metrics-after-webhook-replay.prom` includes x402 counters and gauges. |
| Prometheus scrape target tested | `PASSED_LOCAL` | `prometheus-targets-final.json` shows `dna-x402-local` target `health: up`. |
| Grafana dashboard imported | `PASSED_LOCAL` | `grafana-dashboard-search-final.json` shows `uid: dna-x402-safety`, URL `/d/dna-x402-safety/dna-x402-production-safety`. |
| Alert rules loaded | `PASSED_LOCAL` | `promtool-check.txt` validates `alerts.yml` and `drill-alerts.yml`; `prometheus-rules-final.json` captures loaded rules. |
| Test alert delivered | `PASSED_LOCAL_OPERATOR_WEBHOOK` | `operator-webhook.ndjson` contains `X402MonitoringRouteTest`. |
| Emergency pause alert tested | `PASSED_APP_DERIVED` | Admin emergency pause toggled; `x402_emergency_pause_active 1`; `X402EmergencyPauseActive` delivered to operator webhook. |
| Immutable PII block alert tested | `PASSED_APP_DERIVED` | Sandbox webhook PII payload rejected before immutable log; `x402_pii_blocks_total 1`; `X402PiiBlock` delivered. |
| DB error alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402DbErrorSpike` delivered through Alertmanager using drill rule. |
| Verifier error alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402VerifierErrorSpike` delivered through Alertmanager using drill rule. |
| Webhook replay spike alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | Valid webhook accepted once, duplicate rejected; `x402_webhook_replays_rejected_total 1`; spike route also delivered through drill rule. |
| Admin action burst alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402AdminActionBurst` delivered through Alertmanager using drill rule. |
| Backup failure alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402BackupFailure` delivered through Alertmanager using drill rule. |
| Restore drill failure alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402RestoreDrillFailure` delivered through Alertmanager using drill rule. |
| Settlement unavailable alert delivered or simulated | `PASSED_SYNTHETIC_ROUTE_DRILL` | `X402SettlementUnavailable` delivered through Alertmanager using drill rule. |
| External human/operator channel | `PASSED_EXTERNAL_TELEGRAM_ROUTE` | `G:\DNA x402\reports\monitoring\2026-05-15T16-40-33-398Z-telegram-route\telegram-route-summary.json` records `PASSED_EXTERNAL_HUMAN_ROUTE`; `X402MonitoringRouteTest`, `X402EmergencyPauseActive`, `X402PiiBlock`, and `X402BackupFailure` reached the private Telegram group and were human-confirmed. |

## What Was Actually Proved

Prometheus scraped the live local x402 server on `127.0.0.1:18080/metrics`.

Grafana started from the G-local package and imported the DNA x402 dashboard through file provisioning.

Alertmanager loaded the G-local config and delivered alerts to the local operator webhook.

Two alerts came from real x402 metrics, not synthetic-only routing:

- `X402EmergencyPauseActive`
- `X402PiiBlock`

The remaining route-only alerts were forced with drill rules so route delivery could be tested without causing real DB, backup, restore, verifier, or settlement incidents:

- `X402DbErrorSpike`
- `X402BackupFailure`
- `X402RestoreDrillFailure`
- `X402VerifierErrorSpike`
- `X402WebhookReplaySpike`
- `X402AdminActionBurst`
- `X402SettlementUnavailable`

That is a valid local routing drill. The external Telegram proof below confirms a real operator channel separately.

## External Telegram Route Evidence

Status: `PASSED_EXTERNAL_HUMAN_ROUTE`

Private group: `DNA x402 Ops Alerts`

Bot username: `DNAx402_Bot`

Token: `REDACTED`

Chat ID: redacted in reports

Report:

- `G:\DNA x402\reports\monitoring\2026-05-15T16-40-33-398Z-telegram-route\telegram-route-summary.json`

Delivered and human-confirmed:

- `X402MonitoringRouteTest` at `2026-05-15T16:40:33.701Z`
- `X402EmergencyPauseActive` at `2026-05-15T16:40:33.907Z`
- `X402PiiBlock` at `2026-05-15T16:40:34.011Z`
- `X402BackupFailure` at `2026-05-15T16:40:34.100Z`

The drill was executed with `--human-seen`, and the user confirmed the messages in the private Telegram group.

## Important Fix From This Drill

The PII metric was too narrow before this drill: `x402_pii_blocks_total` counted blocked receipts but not sandbox webhook immutable-log PII blocks.

This was fixed so webhook immutable-log PII guard failures increment the PII block metric and can fire `X402PiiBlock`.

Regression coverage was tightened in server mayhem so the webhook PII block path now asserts:

- webhook payload is rejected before immutable delivery log
- no `WEBHOOK_RECEIVED` audit event is written
- `x402_pii_blocks_total` increments

## Evidence Files

Primary summary:

- `G:\DNA x402\reports\monitoring\2026-05-15T15-43-16-634+03-00\boss4-monitoring-evidence-summary.json`

Key evidence:

- `tool-manifest.json`
- `promtool-check.txt`
- `amtool-check.txt`
- `prometheus-targets-final.json`
- `prometheus-rules-final.json`
- `prometheus-alerts-final.json`
- `alertmanager-alerts-final.json`
- `alertmanager-status.json`
- `grafana-health.json`
- `grafana-dashboard-search-final.json`
- `operator-webhook.ndjson`
- `emergency-pause-response.json`
- `pii-webhook-response.json`
- `webhook-valid-then-replay.json`
- `x402-metrics-after-webhook-replay.prom`

## Current Truth

Monitoring moved from config-only to local collector/dashboard/alert-route proof plus external Telegram human-route proof.

Public production still requires named operators, counsel review, and explicit live-gate approvals. The external Telegram route is now proven, but operator ownership and escalation duties still need assignment.

## Telegram Operations Path

The selected external route is Telegram:

- private group: `DNA x402 Ops Alerts`
- relay module: `x402/src/monitoring/telegramAlert.ts`
- protected internal relay route: `POST /internal/alerts/telegram`
- drill script: `npm --prefix x402 run monitoring:test:telegram`
- Alertmanager example: `infra/monitoring/alertmanager-telegram-relay.example.yml`
- report folder pattern: `G:\DNA x402\reports\monitoring\<timestamp>-telegram-route`

Required local/server secret env values:

```txt
X402_ALERT_TELEGRAM_ENABLED=true
X402_ALERT_TELEGRAM_BOT_TOKEN=<server secret only>
X402_ALERT_TELEGRAM_CHAT_ID=<server secret only>
X402_ALERT_TELEGRAM_PARSE_MODE=HTML
X402_ALERT_TELEGRAM_RELAY_SECRET=<server secret only>
```

The bot token must never be committed, logged, or copied into audit docs. Drill reports store only redacted token/chat identifiers.

Telegram command safety:

- outbound alerts only need the configured ops chat ID
- inbound bot commands are disabled by default with `X402_ALERT_TELEGRAM_COMMANDS_ENABLED=false`
- if commands are enabled later, only IDs in `X402_ALERT_TELEGRAM_ALLOWED_USER_IDS` or `X402_ALERT_TELEGRAM_ALLOWED_ADMIN_IDS` may interact
- commands are also restricted to `X402_ALERT_TELEGRAM_ALLOWED_CHAT_IDS`
- set the owner ID from Telegram locally, for example `X402_ALERT_TELEGRAM_ALLOWED_USER_IDS=<owner user id>`; do not commit personal Telegram IDs into source files

Ops digest scripts:

```txt
npm --prefix x402 run monitoring:telegram:status -- --period=30m
npm --prefix x402 run monitoring:telegram:status -- --period=24h
```

The digest reads `X402_ALERT_TELEGRAM_STATUS_METRICS_URL` (default `http://127.0.0.1:8080/metrics`) and reports:

- engine online / paused / down
- quote and commit counts
- finalized and rejected payments
- receipt count
- verified volume from `x402_volume_atomic_total`
- non-custodial fee accrual from `x402_real_chain_fee_accrued_atomic_total`
- observed agents from `x402_agents_observed_total` when requests include `x-dna-agent-id`
- PII blocks, webhook replay rejections, admin actions, DB/verifier/settlement errors

Recommended production schedule after Telegram delivery is proven:

- every 30 minutes: `monitoring:telegram:status -- --period=30m`
- once per 24 hours: `monitoring:telegram:status -- --period=24h`

These status pings are ops visibility only. They do not approve public production, fee collection, auto-sweep, or live-gate unlocks.

Telegram delivery has been proven for:

- `X402MonitoringRouteTest`
- `X402EmergencyPauseActive`
- `X402PiiBlock`
- `X402BackupFailure`

Other acceptable external routes remain optional future additions:

- Discord
- Slack
- email
- PagerDuty
- Opsgenie
- equivalent production on-call channel

Then repeat the alert delivery drill and append evidence showing:

- alert route target
- test alert received by the human/operator channel
- emergency pause alert received
- PII block alert received
- DB error alert received or simulated
- backup failure alert received or simulated
- restore failure alert received or simulated

No public production launch should treat monitoring as complete without that external route evidence.
