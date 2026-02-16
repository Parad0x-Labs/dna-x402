import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
  cmd: string;
}

export interface SolanaContext {
  cluster: string;
  keypair?: string;
}

export function toSol(lamports: bigint): string {
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = abs % 1_000_000_000n;
  return `${sign}${whole.toString(10)}.${frac.toString(10).padStart(9, "0")}`;
}

export function runSolana(args: string[], cwd = process.cwd()): CliRunResult {
  const cmd = `solana ${args.join(" ")}`;
  const result = spawnSync("solana", args, {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    cmd,
  };
}

export function ensureSuccess(result: CliRunResult): void {
  if (result.status === 0) {
    return;
  }
  throw new Error(`${result.cmd} failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

export function parseLamports(raw: string): bigint {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^0-9-]/g, "");
  if (!digits || digits === "-" || !/^-?\d+$/.test(digits)) {
    throw new Error(`Unable to parse lamports from: ${JSON.stringify(raw)}`);
  }
  return BigInt(digits);
}

export function readJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function getAddress(context: SolanaContext): string {
  const args = ["address", "-u", context.cluster];
  if (context.keypair) {
    args.push("-k", context.keypair);
  }
  const result = runSolana(args);
  ensureSuccess(result);
  return result.stdout.trim();
}

export function getBalanceLamports(pubkey: string, context: SolanaContext): bigint {
  const args = ["balance", pubkey, "-u", context.cluster, "--lamports"];
  if (context.keypair) {
    args.push("-k", context.keypair);
  }
  const result = runSolana(args);
  ensureSuccess(result);
  return parseLamports(result.stdout);
}

export function getBufferAccounts(context: SolanaContext): string[] {
  const args = ["program", "show", "--buffers", "-u", context.cluster, "--output", "json-compact"];
  if (context.keypair) {
    args.push("-k", context.keypair);
  }
  const result = runSolana(args);
  ensureSuccess(result);
  const parsed = readJson<{ buffers?: string[] }>(result.stdout);
  return Array.isArray(parsed.buffers) ? parsed.buffers : [];
}

export function discoverProgramSoFiles(rootDir: string): string[] {
  const deployDir = path.resolve(rootDir, "target", "deploy");
  if (!fs.existsSync(deployDir)) {
    return [];
  }

  return fs.readdirSync(deployDir)
    .filter((entry) => entry.endsWith(".so"))
    .map((entry) => path.join(deployDir, entry))
    .sort();
}

export function programKeypairPathForSo(soPath: string): string {
  const parsed = path.parse(soPath);
  return path.join(parsed.dir, `${parsed.name}-keypair.json`);
}

export function maybeProgramIdKeypairForSo(soPath: string): string | undefined {
  const keypairPath = programKeypairPathForSo(soPath);
  return fs.existsSync(keypairPath) ? keypairPath : undefined;
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:]/g, "-");
}

export function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

export function parseRepeatedFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function stageFileToTemp(sourcePath: string, suffix = ""): string {
  const sourceName = path.basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const digest = crypto.createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
  const stageDir = path.join(os.tmpdir(), "dnp-deploy-stage");
  fs.mkdirSync(stageDir, { recursive: true });
  const targetPath = path.join(stageDir, `${sourceName}.${digest}${suffix}`);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

export function stageSignerPath(signerPath: string | undefined): string | undefined {
  if (!signerPath) {
    return undefined;
  }
  if (!fs.existsSync(signerPath)) {
    return signerPath;
  }
  return stageFileToTemp(signerPath, ".json");
}
