import { createPostgresClientFromEnv, databaseUrlFromEnv } from "../../src/db/connection.js";
import { MODULAR_COMMERCE_TABLES } from "../../src/db/schema/tables.js";

function assertLocalResetAllowed(): void {
  const url = databaseUrlFromEnv();
  const explicitlyAllowed = process.env.X402_DB_RESET_ALLOW === "1";
  const local = Boolean(url && (url.includes("localhost") || url.includes("127.0.0.1")));
  if (!local && !explicitlyAllowed) {
    throw new Error("Refusing DB reset unless X402_DATABASE_URL is local or X402_DB_RESET_ALLOW=1 is set.");
  }
}

assertLocalResetAllowed();
const db = createPostgresClientFromEnv();
try {
  await db.query("begin");
  try {
    for (const table of [...MODULAR_COMMERCE_TABLES].reverse()) {
      await db.query(`drop table if exists ${table} cascade`);
    }
    await db.query("drop table if exists schema_migrations cascade");
    await db.query("drop function if exists dna_x402_touch_updated_at() cascade");
    await db.query("commit");
    console.log(JSON.stringify({ ok: true, resetTables: MODULAR_COMMERCE_TABLES.length }, null, 2));
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
} finally {
  await db.close?.();
}
