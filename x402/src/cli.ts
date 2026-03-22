#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoMode, runDemoBuyer, startDemoSeller } from "./demo/index.js";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const DEFAULT_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

function printHelp(io: CliIo): void {
  io.stdout([
    "dna-x402",
    "",
    "Usage:",
    "  dna-x402 demo seller [--mode transfer|netting|stream] [--port 3000]",
    "  dna-x402 demo buyer [--mode transfer|netting|stream] [--base-url http://127.0.0.1:3000]",
    "  dna-x402 init seller [dir] [--no-install] [--force]",
    "  dna-x402 init buyer [dir] [--no-install] [--force]",
  ].join("\n"));
}

function packageRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../");
}

function readFlag(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseDemoModeArg(args: string[]): DemoMode {
  const raw = readFlag(args, "--mode");
  if (!raw) {
    return "transfer";
  }
  if (raw === "transfer" || raw === "netting" || raw === "stream") {
    return raw;
  }
  throw new Error(`Invalid --mode: ${raw}. Expected transfer, netting, or stream.`);
}

function parsePortArg(args: string[], flagName: string, fallback: number): number {
  const raw = readFlag(args, flagName, String(fallback));
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${flagName}: ${raw}. Expected an integer between 1 and 65535.`);
  }
  return port;
}

function parseBaseUrlArg(args: string[]): string {
  const raw = readFlag(args, "--base-url", "http://127.0.0.1:3000") ?? "http://127.0.0.1:3000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid --base-url: ${raw}. Expected an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid --base-url: ${raw}. Expected an absolute http(s) URL.`);
  }
  return raw;
}

async function currentVersion(): Promise<string> {
  const packageJsonPath = path.join(packageRootDir(), "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

async function ensureScaffoldDir(targetDir: string, force: boolean): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(`Target directory is not empty: ${targetDir}. Use --force to overwrite.`);
  }
}

function sellerPackageJson(packageSpec: string, name: string): string {
  return JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch index.ts",
      start: "tsx index.ts",
    },
    dependencies: {
      "dna-x402": packageSpec,
      "express": "^4.21.2",
    },
    devDependencies: {
      "@types/express": "^5.0.0",
      "@types/node": "^22.10.10",
      "tsx": "^4.19.2",
    },
  }, null, 2) + "\n";
}

function sellerIndexSource(): string {
  return `import express from "express";
import { dnaPrice, dnaSeller } from "dna-x402/seller";

const app = express();
app.use(express.json());

const recipient = process.env.RECIPIENT ?? "YOUR_SOLANA_WALLET_ADDRESS";
const port = Number(process.env.PORT ?? 3000);
const trustedLocalNetting = process.env.DNA_TRUSTED_LOCAL_NETTING !== "0";

const pay = dnaSeller(app, {
  recipient,
  settlement: trustedLocalNetting ? ["transfer", "netting", "stream"] : ["transfer", "stream"],
  unsafeUnverifiedNettingEnabled: trustedLocalNetting,
});

app.get("/", (_req, res) => {
  res.json({
    service: "DNA x402 seller",
    endpoints: {
      "/resource": "$0.001",
      "/inference": "$0.005",
      "/stream-access": "$0.0001",
    },
  });
});

app.get("/resource", dnaPrice("1000", pay), (_req, res) => {
  res.json({ ok: true, result: "resource payload" });
});

app.get("/inference", dnaPrice("5000", pay), (_req, res) => {
  res.json({ ok: true, result: "inference output", tokens: 847 });
});

app.get("/stream-access", dnaPrice("100", pay), (_req, res) => {
  res.json({ ok: true, access: "granted" });
});

app.listen(port, () => {
  console.log(\`DNA x402 seller listening on http://127.0.0.1:\${port}\`);
});
`;
}

function sellerEnvExample(): string {
  return [
    "RECIPIENT=YOUR_SOLANA_WALLET_ADDRESS",
    "PORT=3000",
    "DNA_TRUSTED_LOCAL_NETTING=1",
    "",
  ].join("\n");
}

function buyerPackageJson(packageSpec: string, name: string): string {
  return JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch index.ts",
      start: "tsx index.ts",
    },
    dependencies: {
      "dna-x402": packageSpec,
    },
    devDependencies: {
      "@types/node": "^22.10.10",
      "tsx": "^4.19.2",
    },
  }, null, 2) + "\n";
}

async function packCurrentPackage(targetDir: string): Promise<string> {
  const vendorDir = path.join(targetDir, "vendor");
  await mkdir(vendorDir, { recursive: true });

  const tarballName = await new Promise<string>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn("npm", ["pack", "--json", "--silent", "--pack-destination", vendorDir], {
      cwd: packageRootDir(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderr || `npm pack failed with code ${code ?? "unknown"}`));
        return;
      }
      const output = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (!output) {
        reject(new Error("npm pack did not report a tarball filename"));
        return;
      }
      try {
        const parsed = JSON.parse(output) as Array<{ filename?: string }>;
        const filename = parsed.at(-1)?.filename;
        if (!filename) {
          reject(new Error("npm pack did not report a tarball filename"));
          return;
        }
        resolve(filename);
      } catch (error) {
        reject(new Error(`Failed to parse npm pack output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.on("error", reject);
  });

  return `file:./vendor/${tarballName}`;
}

function buyerIndexSource(): string {
  return `import {
  fetchWith402,
  InMemoryReceiptStore,
  InMemorySpendTracker,
} from "dna-x402";

const dnaServer = process.env.DNA_SERVER ?? "http://127.0.0.1:3000";
const mode = process.env.DNA_BUYER_MODE ?? "netting";

const wallet = mode === "netting"
  ? {
      payTransfer: async (quote) => ({ settlement: "netting" as const, amountAtomic: quote.totalAtomic, note: "buyer-starter-demo" }),
      payNetted: async (quote) => ({ settlement: "netting" as const, amountAtomic: quote.totalAtomic, note: "buyer-starter-demo" }),
    }
  : {
      payTransfer: async () => {
        throw new Error("Replace payTransfer with your real wallet integration before using transfer mode.");
      },
    };

const receipts = new InMemoryReceiptStore();
const spendTracker = new InMemorySpendTracker();

for (const resource of ["/resource", "/inference", "/stream-access"]) {
  const result = await fetchWith402(\`\${dnaServer}\${resource}\`, {
    wallet,
    maxSpendAtomic: "100000",
    maxSpendPerDayAtomic: "5000000",
    preferNetting: mode === "netting",
    receiptStore: receipts,
    spendTracker,
  });
  console.log(resource, "→", result.response.status, result.receipt?.payload.receiptId ?? "");
}

console.log("Receipts stored:", receipts.receipts.size);
`;
}

function buyerEnvExample(): string {
  return [
    "DNA_SERVER=http://127.0.0.1:3000",
    "DNA_BUYER_MODE=netting",
    "",
  ].join("\n");
}

async function installDependencies(targetDir: string, io: CliIo): Promise<void> {
  io.stdout(`Installing dependencies in ${targetDir} ...`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: targetDir,
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install failed with code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

async function scaffoldProject(kind: "buyer" | "seller", args: string[], io: CliIo): Promise<number> {
  const force = hasFlag(args, "--force");
  const install = !hasFlag(args, "--no-install");
  const targetArg = args.find((arg) => !arg.startsWith("-"));
  const defaultName = kind === "seller" ? "dna-x402-seller" : "dna-x402-buyer";
  const targetDir = path.resolve(process.cwd(), targetArg ?? defaultName);
  await ensureScaffoldDir(targetDir, force);
  const packageSpec = await packCurrentPackage(targetDir);

  if (kind === "seller") {
    await writeFile(path.join(targetDir, "package.json"), sellerPackageJson(packageSpec, path.basename(targetDir)));
    await writeFile(path.join(targetDir, "index.ts"), sellerIndexSource());
    await writeFile(path.join(targetDir, ".env.example"), sellerEnvExample());
  } else {
    await writeFile(path.join(targetDir, "package.json"), buyerPackageJson(packageSpec, path.basename(targetDir)));
    await writeFile(path.join(targetDir, "index.ts"), buyerIndexSource());
    await writeFile(path.join(targetDir, ".env.example"), buyerEnvExample());
  }

  io.stdout(`Scaffolded ${kind} starter in ${targetDir}`);
  if (install) {
    await installDependencies(targetDir, io);
  }
  return 0;
}

async function runDemoCommand(kind: "buyer" | "seller", args: string[], io: CliIo): Promise<number> {
  const mode = parseDemoModeArg(args);
  const quiet = hasFlag(args, "--quiet");

  if (kind === "seller") {
    const port = parsePortArg(args, "--port", 3000);
    const recipient = readFlag(args, "--recipient", "DEMO_RECIPIENT_WALLET");
    await startDemoSeller({
      mode,
      port,
      recipient,
      quiet,
    });
    return 0;
  }

  const baseUrl = parseBaseUrlArg(args);
  const result = await runDemoBuyer({
    baseUrl,
    mode,
    quiet,
  });
  const ok = result.results.every((entry) => entry.status === 200);
  if (!ok) {
    io.stderr("One or more demo buyer calls failed.");
    return 1;
  }
  return 0;
}

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }

  if (command === "demo" && (subcommand === "buyer" || subcommand === "seller")) {
    return runDemoCommand(subcommand, rest, io);
  }

  if (command === "init" && (subcommand === "buyer" || subcommand === "seller")) {
    return scaffoldProject(subcommand, rest, io);
  }

  io.stderr(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
  printHelp(io);
  return 1;
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isCliEntrypoint()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
