import path from "node:path";
import { createPostgresClientFromEnv } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";

const db = createPostgresClientFromEnv();
try {
  const migrationsDir = path.resolve("src/db/migrations");
  const applied = await runMigrations(db, migrationsDir);
  console.log(JSON.stringify({ ok: true, migrationsDir, applied }, null, 2));
} finally {
  await db.close?.();
}
