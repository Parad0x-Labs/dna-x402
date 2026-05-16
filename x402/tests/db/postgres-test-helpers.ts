import path from "node:path";
import { createPostgresClientFromEnv, databaseUrlFromEnv, DbClient, PostgresDbClient } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { MODULAR_COMMERCE_TABLES } from "../../src/db/schema/tables.js";

export const postgresAvailable = Boolean(databaseUrlFromEnv());
const LIVE_POSTGRES_TEST_LOCK_KEY = 402402402;

export function createLivePostgres(): PostgresDbClient {
  return createPostgresClientFromEnv();
}

export async function withLivePostgresTestLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDb = createLivePostgres();
  await lockDb.query("select pg_advisory_lock($1)", [LIVE_POSTGRES_TEST_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await lockDb.query("select pg_advisory_unlock($1)", [LIVE_POSTGRES_TEST_LOCK_KEY]);
    await lockDb.close();
  }
}

export async function resetLivePostgres(db: DbClient): Promise<void> {
  for (const table of [...MODULAR_COMMERCE_TABLES].reverse()) {
    await db.query(`drop table if exists ${table} cascade`);
  }
  await db.query("drop table if exists schema_migrations cascade");
  await db.query("drop function if exists dna_x402_touch_updated_at() cascade");
}

export async function migrateLivePostgres(db: DbClient): Promise<string[]> {
  return runMigrations(db, path.resolve("src/db/migrations"));
}

export async function resetAndMigrateLivePostgres(db: DbClient): Promise<void> {
  await resetLivePostgres(db);
  await migrateLivePostgres(db);
}
