import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DbClient } from "./connection.js";

export async function runMigrations(db: DbClient, migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")): Promise<string[]> {
  const applied: string[] = [];
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  for (const file of files) {
    const existing = await db.query<{ name: string }>("select name from schema_migrations where name = $1", [file]);
    if (existing.rows.length > 0) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await db.query("begin");
    try {
      await db.query(sql);
      await db.query("insert into schema_migrations (name) values ($1)", [file]);
      await db.query("commit");
      applied.push(file);
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }
  return applied;
}
