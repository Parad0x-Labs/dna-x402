import { createPostgresClientFromEnv } from "../../src/db/connection.js";
import { MODULAR_COMMERCE_TABLES } from "../../src/db/schema/tables.js";

const db = createPostgresClientFromEnv();
try {
  const ping = await db.query<{ ok: number }>("select 1 as ok");
  const tables = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const missing = MODULAR_COMMERCE_TABLES.filter((table) => !present.has(table));
  const ok = ping.rows[0]?.ok === 1 && missing.length === 0;
  console.log(JSON.stringify({ ok, missingTables: missing, tableCount: tables.rows.length }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await db.close?.();
}
