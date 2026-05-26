# DNA x402 Backup And Restore Runbook

## Local Snapshot Adapter

```bash
npm --prefix x402 run db:backup
npm --prefix x402 run db:restore -- <backupPath>
npm --prefix x402 run db:backup:test
```

The local backup test creates seller, listing, policy, receipt, appeal, and emergency pause state, backs it up, restores it, and verifies the records survive.

## Production Postgres

Production must use native Postgres backup tooling. The file-snapshot scripts are not a substitute for `pg_dump`, point-in-time recovery, managed database snapshots, or restore drills.

Postgres mode:

```bash
$env:X402_DB_DRIVER="postgres"
$env:X402_REPOSITORY_MODE="postgres"
$env:X402_DATABASE_URL="postgres://x402:x402_local@localhost:5432/x402_local"
npm --prefix x402 run db:backup -- --out <repo-root>\reports\db\x402.pgsql
npm --prefix x402 run db:restore -- <repo-root>\reports\db\x402.pgsql
npm --prefix x402 run db:backup:test:postgres
```

Tooling requirements:

- `pg_dump` available on PATH or `X402_PG_DUMP_BIN`
- `psql` available on PATH or `X402_PSQL_BIN`
- real Postgres connection in `X402_DATABASE_URL`

Required before production:

- automated backup schedule
- encrypted backup storage
- restore rehearsal
- receipt verification after restore
- emergency pause state verification after restore
- webhook replay key verification after restore
- policy strike and appeal verification after restore

## 2026-05-15 Backup / Restore Evidence

Postgres backup/restore passed against the G-local PostgreSQL 18 drill instance.

Config:

```powershell
$env:X402_DATABASE_URL="postgres://x402:x402_local@127.0.0.1:55432/x402_local"
$env:X402_PSQL_BIN="C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:X402_PG_DUMP_BIN="C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
$env:X402_DB_BACKUP_DIR="<repo-root>\.runtime\postgres-backups"
```

Command:

```powershell
npm --prefix x402 run db:backup:test:postgres
```

Result:

- backup file created under `<repo-root>\x402\.runtime\postgres-backups`
- restore succeeded
- critical seller, listing, policy, strike, denylist, appeal, tax, privacy, agent spend, fee, receipt, webhook replay, and emergency pause records survived restore

Latest observed backup path:

```txt
<repo-root>\x402\.runtime\postgres-backups\dna-x402-postgres-2026-05-15T12-12-47-862Z.sql
```

Limitation: this proves native `pg_dump`/`psql` restore on live Postgres. It does not prove Docker Compose because Docker is unavailable on this workstation.
