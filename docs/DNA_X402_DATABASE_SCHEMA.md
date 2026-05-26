# DNA x402 Database Schema

Status: production schema scaffold and Postgres adapter support exist. Live Postgres validation passed on a G-local PostgreSQL 18 drill instance on 2026-05-15. Docker Compose itself is still not available on this workstation, so Docker Compose execution is not claimed.

The database layer keeps repository ports stable and supports in-memory, file-snapshot, and Postgres-compatible adapters. The first migration is `x402/src/db/migrations/001_modular_commerce.sql`.

## Tables

Every table has:

- `id`
- `version`
- `payload jsonb`
- `actor_id`
- `created_at`
- `updated_at`

Minimum production tables:

- `policy_decisions`
- `policy_audit_events`
- `seller_profiles`
- `seller_reputation_snapshots`
- `seller_policy_strikes`
- `seller_tax_profiles`
- `seller_tax_aggregates`
- `mutable_personal_records`
- `data_subject_requests`
- `market_event_access_logs`
- `policy_rule_changes`
- `denylist_entries`
- `policy_appeals`
- `agent_spend_policies`
- `agent_spend_usage`
- `fee_waterfalls`
- `settlement_options`
- `economic_attack_events`
- `compute_jobs`
- `compute_proofs`
- `receipts`
- `webhook_delivery_logs`
- `webhook_replay_keys`
- `emergency_pause_state`
- `marketplace_listings`
- `listing_manifest_versions`
- `listing_state_events`

Immutable records must be inserted append-only. Mutable records use versioned upserts.

## Current Adapters

- `FileSnapshotRepository`: durable local test adapter.
- `PostgresJsonRepository`: parameterized SQL adapter for production wiring.
- `PostgresDbClient`: `pg` pool-backed SQL client with transaction support.
- `RecordingDbClient`: test-only SQL recorder.

## Critical Indexes And Constraints

The first migration adds these production safety constraints:

- unique receipt hash index: `receipts_payload_receipt_hash_unique`
- active denylist subject uniqueness: `denylist_entries_active_subject_unique`
- webhook replay uniqueness: `webhook_replay_keys_payload_key_unique`
- manifest version uniqueness per listing: `listing_manifest_versions_listing_version_unique`
- fee no-double-charge uniqueness: `fee_waterfalls_no_double_charge_unique`

## Live Postgres Gate

Run these before any production deploy:

```bash
docker compose -f docker-compose.postgres.yml up -d
npm --prefix x402 run db:migrate
npm --prefix x402 run db:health
npm --prefix x402 run db:backup:test:postgres
docker compose -f docker-compose.postgres.yml down
```

## Live Postgres Evidence

Executed on 2026-05-15 against a temporary G-local PostgreSQL 18 instance:

- data directory: `<repo-root>\.runtime\postgres-drill-18-data`
- host: `127.0.0.1`
- port: `55432`
- database: `x402_local`
- user: `x402`

Commands passed:

```powershell
$env:X402_DB_DRIVER="postgres"
$env:X402_REPOSITORY_MODE="postgres"
$env:X402_DATABASE_URL="postgres://x402:x402_local@127.0.0.1:55432/x402_local"
$env:X402_PSQL_BIN="C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:X402_PG_DUMP_BIN="C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"

npm --prefix x402 run db:reset
npm --prefix x402 run db:migrate
npm --prefix x402 run db:seed:sandbox
npm --prefix x402 run db:health
npm --prefix x402 test -- tests/db/postgres-migration.test.ts tests/db/postgres-concurrency.test.ts
npm --prefix x402 run db:backup:test:postgres
npm --prefix x402 test -- tests/db/postgres-sybil-relist.test.ts
```

Result:

- migration passed
- DB health passed with `missingTables: []`
- live migration/concurrency tests passed
- `pg_dump` / restore drill passed
- persistent Sybil relist test passed
- Postgres-backed webhook replay-after-restart passed through server mayhem

Limitation: this is real live Postgres proof, not Docker Compose proof. Docker is not installed on this workstation.
