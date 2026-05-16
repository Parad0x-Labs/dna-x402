import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { databaseUrlFromEnv } from "../../src/db/connection.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function resolveSnapshotPath(): string {
  return path.resolve(process.env.X402_DB_SNAPSHOT ?? ".runtime/db/commerce-state.json");
}

export function resolveBackupDir(): string {
  return path.resolve(process.env.X402_DB_BACKUP_DIR ?? ".runtime/backups");
}

export function backupSnapshot(sourcePath = resolveSnapshotPath(), backupDir = resolveBackupDir()): string {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  if (!fs.existsSync(sourcePath)) {
    fs.writeFileSync(sourcePath, "{}\n");
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const targetPath = path.join(backupDir, `dna-x402-commerce-${timestamp()}.json`);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

export function backupPostgres(backupDir = resolveBackupDir()): string {
  const databaseUrl = databaseUrlFromEnv();
  if (!databaseUrl) {
    throw new Error("X402_DATABASE_URL or DATABASE_URL is required for Postgres backup");
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const targetPath = path.join(backupDir, `dna-x402-postgres-${timestamp()}.sql`);
  const pgDump = process.env.X402_PG_DUMP_BIN ?? "pg_dump";
  execFileSync(pgDump, [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--file",
    targetPath,
    databaseUrl,
  ], { stdio: "pipe" });
  return targetPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.env.X402_REPOSITORY_MODE ?? process.env.X402_DB_DRIVER ?? "file";
  const backupPath = mode === "postgres" ? backupPostgres() : backupSnapshot();
  console.log(JSON.stringify({
    ok: true,
    mode,
    source: mode === "postgres" ? "postgres" : resolveSnapshotPath(),
    backupPath,
  }, null, 2));
}
