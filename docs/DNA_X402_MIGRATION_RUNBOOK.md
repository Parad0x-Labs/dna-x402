# DNA x402 Migration Runbook

Status: migration files, Docker Compose support, DB commands, and opt-in live Postgres tests exist. Live database execution passed on a G-local PostgreSQL 18 drill instance on 2026-05-15. Docker Compose execution is still not claimed because Docker is not installed on this workstation.

## Local Commands

```bash
npm --prefix x402 run db:backup:test
```

## Local Postgres Drill

`docker-compose.postgres.yml` runs Postgres 16 with a G-local bind-mounted data directory:

```bash
docker compose -f docker-compose.postgres.yml up -d
$env:X402_DB_DRIVER="postgres"
$env:X402_REPOSITORY_MODE="postgres"
$env:X402_DATABASE_URL="postgres://x402:x402_local@localhost:5432/x402_local"
npm --prefix x402 run db:reset
npm --prefix x402 run db:migrate
npm --prefix x402 run db:seed:sandbox
npm --prefix x402 run db:health
npm --prefix x402 test -- tests/db/postgres-migration.test.ts tests/db/postgres-concurrency.test.ts tests/db/postgres-sybil-relist.test.ts
npm --prefix x402 run db:backup:test:postgres
docker compose -f docker-compose.postgres.yml down
```

The live test files skip unless `X402_DATABASE_URL` is configured. If `X402_DATABASE_URL` is configured, these tests must fail hard on database errors and must not fall back to file adapters.

## 2026-05-15 G-Local Postgres Drill

Docker was not available locally, so the drill used PostgreSQL 18 binaries installed on the workstation and a separate G-local data directory:

```powershell
$env:X402_DB_DRIVER="postgres"
$env:X402_REPOSITORY_MODE="postgres"
$env:X402_DATABASE_URL="postgres://x402:x402_local@127.0.0.1:55432/x402_local"
$env:X402_PSQL_BIN="C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:X402_PG_DUMP_BIN="C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
$env:X402_DB_BACKUP_DIR="<repo-root>\.runtime\postgres-backups"
```

Passed:

- `npm --prefix x402 run db:reset`
- `npm --prefix x402 run db:migrate`
- `npm --prefix x402 run db:seed:sandbox`
- `npm --prefix x402 run db:health`
- `npm --prefix x402 test -- tests/db/postgres-migration.test.ts tests/db/postgres-concurrency.test.ts`
- `npm --prefix x402 run db:backup:test:postgres`
- `npm --prefix x402 test -- tests/db/postgres-sybil-relist.test.ts`
- `npm run mayhem:x402:server` with `X402_REPOSITORY_MODE=postgres` and `X402_DATABASE_URL` set, including Postgres-backed webhook replay-after-restart

One harness issue was found and fixed: live Postgres test files reset the same DB while Vitest ran files in parallel. The test helper now uses a Postgres advisory lock to serialize live DB reset/migrate suites.

## Production Migration Flow

1. Confirm `X402_DATABASE_URL` points at the intended production database.
2. Take a database backup.
3. Run `npm --prefix x402 run db:migrate`.
4. Verify `/health/db`.
5. Run server-level mayhem in sandbox mode before enabling traffic.

## Rollback

The current schema is additive. Rollback is backup restore, not destructive down-migration.

Never run destructive schema changes without a tested restore packet and signed operator approval.
