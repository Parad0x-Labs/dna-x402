import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { databaseUrlFromEnv } from "../../src/db/connection.js";
import { resolveSnapshotPath } from "./backup.js";

export function restoreSnapshot(sourcePath: string, targetPath = resolveSnapshotPath()): string {
  if (!sourcePath) {
    throw new Error("backup source path is required");
  }
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`backup source not found: ${resolvedSource}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(resolvedSource, targetPath);
  return targetPath;
}

export function restorePostgres(sourcePath: string): string {
  const databaseUrl = databaseUrlFromEnv();
  if (!databaseUrl) {
    throw new Error("X402_DATABASE_URL or DATABASE_URL is required for Postgres restore");
  }
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`backup source not found: ${resolvedSource}`);
  }
  const psql = process.env.X402_PSQL_BIN ?? "psql";
  execFileSync(psql, [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", resolvedSource], { stdio: "pipe" });
  return resolvedSource;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] ?? process.env.X402_DB_RESTORE_SOURCE;
  if (!source) {
    throw new Error("Usage: npm run db:restore -- <backupPath>");
  }
  const mode = process.env.X402_REPOSITORY_MODE ?? process.env.X402_DB_DRIVER ?? "file";
  const restoredPath = mode === "postgres" ? restorePostgres(source) : restoreSnapshot(source);
  console.log(JSON.stringify({
    ok: true,
    mode,
    source: path.resolve(source),
    restoredPath,
  }, null, 2));
}
