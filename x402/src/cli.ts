#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileAgentPrompt, GUIDED_BUILDER_TREE, listAgentBuilderTemplates } from "./agents/builder/compiler.js";
import { DemoMode, runDemoBuyer, startDemoSeller } from "./demo/index.js";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const DEFAULT_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

type ScaffoldKind = "buyer" | "seller" | "agent";
type AgentTemplate = "service" | "marketplace" | "auction" | "trading" | "restricted-market";

const AGENT_TEMPLATE_ALIASES: Record<string, AgentTemplate> = {
  service: "service",
  seller: "service",
  api: "service",
  marketplace: "marketplace",
  market: "marketplace",
  auction: "auction",
  trading: "trading",
  strategy: "trading",
  "restricted-market": "restricted-market",
  restricted: "restricted-market",
  betting: "restricted-market",
  wagering: "restricted-market",
  gambling: "restricted-market",
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
    "  dna-x402 init agent [dir] [--template service|marketplace|auction|trading|restricted-market] [--no-install] [--force]",
    "  dna-x402 agent-builder templates",
    "  dna-x402 agent-builder draft --prompt \"...\" [--owner-wallet WALLET]",
    "  dna-x402 agent-builder guided",
    "  dna-x402 agent-builder confirm <draftId> --base-url URL --owner-wallet WALLET",
    "  dna-x402 agent-builder recipes --base-url URL",
    "  dna-x402 agent-builder clone <recipeId> --base-url URL --owner-wallet WALLET",
  ].join("\n"));
}

function packageRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../");
}

function npmCommand(args: string[]): { command: string; args: string[] } {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
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

function positionalArgs(args: string[]): string[] {
  const flagsWithValue = new Set(["--template", "--prompt", "--owner-wallet", "--base-url"]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      if (flagsWithValue.has(arg)) {
        index += 1;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(parsed));
  }
  return parsed;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const parsed = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(parsed));
  }
  return parsed;
}

async function runAgentBuilderCommand(subcommand: string | undefined, args: string[], io: CliIo): Promise<number> {
  if (subcommand === "templates") {
    io.stdout(JSON.stringify({ ok: true, templates: listAgentBuilderTemplates() }, null, 2));
    return 0;
  }
  if (subcommand === "guided") {
    io.stdout(JSON.stringify({ ok: true, tree: GUIDED_BUILDER_TREE }, null, 2));
    return 0;
  }
  if (subcommand === "draft") {
    const prompt = readFlag(args, "--prompt");
    if (!prompt) throw new Error("agent-builder draft requires --prompt");
    const ownerWallet = readFlag(args, "--owner-wallet", "LOCAL_PREVIEW_OWNER") ?? "LOCAL_PREVIEW_OWNER";
    io.stdout(JSON.stringify({ ok: true, ...compileAgentPrompt(prompt, ownerWallet) }, null, 2));
    return 0;
  }
  if (subcommand === "confirm") {
    const draftId = positionalArgs(args)[0];
    const baseUrl = readFlag(args, "--base-url");
    const ownerWallet = readFlag(args, "--owner-wallet");
    if (!draftId || !baseUrl || !ownerWallet) throw new Error("agent-builder confirm requires <draftId>, --base-url, and --owner-wallet");
    const draft = await getJson(`${baseUrl.replace(/\/$/, "")}/v1/agent-builder/drafts/${encodeURIComponent(draftId)}`) as {
      draft?: { result?: { riskSummary?: { requiredConfirmations?: string[] } } };
    };
    const confirmations = draft.draft?.result?.riskSummary?.requiredConfirmations ?? [];
    const result = await postJson(`${baseUrl.replace(/\/$/, "")}/v1/agent-builder/drafts/${encodeURIComponent(draftId)}/confirm`, {
      ownerWallet,
      acceptedRiskSummary: true,
      confirmations,
    });
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  if (subcommand === "recipes") {
    const baseUrl = readFlag(args, "--base-url");
    if (!baseUrl) throw new Error("agent-builder recipes requires --base-url");
    io.stdout(JSON.stringify(await getJson(`${baseUrl.replace(/\/$/, "")}/v1/agent-builder/recipes/public`), null, 2));
    return 0;
  }
  if (subcommand === "clone") {
    const recipeId = positionalArgs(args)[0];
    const baseUrl = readFlag(args, "--base-url");
    const ownerWallet = readFlag(args, "--owner-wallet");
    if (!recipeId || !baseUrl || !ownerWallet) throw new Error("agent-builder clone requires <recipeId>, --base-url, and --owner-wallet");
    io.stdout(JSON.stringify(await postJson(`${baseUrl.replace(/\/$/, "")}/v1/agent-builder/recipes/${encodeURIComponent(recipeId)}/clone`, { ownerWallet }), null, 2));
    return 0;
  }
  io.stderr(`Unknown agent-builder command: ${subcommand ?? ""}`);
  printHelp(io);
  return 1;
}

function parseAgentTemplate(args: string[]): AgentTemplate {
  const raw = readFlag(args, "--template", "service") ?? "service";
  const normalized = raw.trim().toLowerCase();
  const template = AGENT_TEMPLATE_ALIASES[normalized];
  if (!template) {
    throw new Error(`Invalid --template: ${raw}. Expected service, marketplace, auction, trading, or restricted-market.`);
  }
  return template;
}

function sanitizePackageName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "dna-x402-agent";
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
    const npm = npmCommand(["pack", "--json", "--silent", "--pack-destination", vendorDir]);
    const child = spawn(npm.command, npm.args, {
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

function agentPackageJson(packageSpec: string, name: string): string {
  return JSON.stringify({
    name: sanitizePackageName(name),
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch index.ts",
      start: "tsx index.ts",
      "sign-manifest": "tsx sign-manifest.ts",
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

function agentTemplateTitle(template: AgentTemplate): string {
  switch (template) {
    case "service":
      return "Paid Service Agent";
    case "marketplace":
      return "Marketplace Seller Agent";
    case "auction":
      return "Auction Tool Agent";
    case "trading":
      return "Trading Strategy Agent";
    case "restricted-market":
      return "Restricted Market Compliance Shell";
    default:
      return "DNA x402 Agent";
  }
}

function agentManifest(template: AgentTemplate): Record<string, unknown> {
  const ownerPubkey = "OWNER_SOLANA_WALLET_PUBLIC_KEY_BASE58";
  if (template === "marketplace") {
    return {
      manifestVersion: "market-v1",
      shopId: "marketplace-agent",
      name: "Marketplace Seller Agent",
      description: "Publishes paid marketplace search, quote, and order tools for safe service listings.",
      category: "workflow_tool",
      ownerPubkey,
      endpoints: [
        {
          endpointId: "marketplace-search",
          method: "POST",
          path: "/marketplace/search",
          capabilityTags: ["marketplace_search", "routing", "seller_discovery"],
          description: "Find service providers and return ranked marketplace options.",
          pricingModel: { kind: "flat", amountAtomic: "2500" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 1200, availabilityTarget: 0.995 },
        },
        {
          endpointId: "marketplace-order-plan",
          method: "POST",
          path: "/marketplace/order-plan",
          capabilityTags: ["order_planning", "routing", "workflow_tool"],
          description: "Build a safe order plan across listed providers without taking custody.",
          pricingModel: { kind: "flat", amountAtomic: "5000" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 1800, availabilityTarget: 0.99 },
        },
      ],
    };
  }

  if (template === "auction") {
    return {
      manifestVersion: "market-v1",
      shopId: "auction-tool-agent",
      name: "Auction Tool Agent",
      description: "Paid auction discovery and bid-planning tools for ordinary marketplace inventory.",
      category: "workflow_tool",
      ownerPubkey,
      endpoints: [
        {
          endpointId: "auction-discovery",
          method: "GET",
          path: "/auction/listings",
          capabilityTags: ["auction_discovery", "pricing", "workflow_tool"],
          description: "Return active safe-category auction inventory and clearing windows.",
          pricingModel: { kind: "flat", amountAtomic: "1500" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 1200, availabilityTarget: 0.995 },
        },
        {
          endpointId: "auction-bid-plan",
          method: "POST",
          path: "/auction/bid-plan",
          capabilityTags: ["auction_strategy", "price_discovery", "workflow_tool"],
          description: "Create a bid plan with budget limits and no custody or wager handling.",
          pricingModel: { kind: "flat", amountAtomic: "4500" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 1800, availabilityTarget: 0.99 },
        },
      ],
    };
  }

  if (template === "trading") {
    return {
      manifestVersion: "market-v1",
      shopId: "trading-strategy-agent",
      name: "Trading Strategy Agent",
      description: "Sells strategy research, backtests, and signal reports; execution and custody are disabled by default.",
      category: "data_enrichment",
      ownerPubkey,
      endpoints: [
        {
          endpointId: "strategy-report",
          method: "POST",
          path: "/strategy/report",
          capabilityTags: ["strategy_research", "backtest", "data_enrichment"],
          description: "Generate a paid strategy report from user-supplied market assumptions.",
          pricingModel: { kind: "flat", amountAtomic: "7500" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 2500, availabilityTarget: 0.99 },
        },
        {
          endpointId: "signal-subscription-preview",
          method: "GET",
          path: "/strategy/signals",
          capabilityTags: ["signal_feed", "research", "data_enrichment"],
          description: "Return a paid preview of strategy signal metadata without trade execution.",
          pricingModel: { kind: "flat", amountAtomic: "2500" },
          settlementModes: ["transfer", "stream"],
          sla: { maxLatencyMs: 1400, availabilityTarget: 0.995 },
        },
      ],
    };
  }

  if (template === "restricted-market") {
    return {
      manifestVersion: "market-v1",
      shopId: "restricted-market-shell",
      name: "Restricted Market Compliance Shell",
      description: "Compliance-gated betting and wagering shell. Public marketplace policy must block this manifest until licensing controls exist.",
      category: "workflow_tool",
      ownerPubkey,
      endpoints: [
        {
          endpointId: "restricted-status",
          method: "GET",
          path: "/restricted/status",
          capabilityTags: ["restricted_market", "compliance_review", "policy_blocked"],
          description: "Reports that betting, wagering, odds, and gambling flows are disabled by default.",
          pricingModel: { kind: "flat", amountAtomic: "0" },
          settlementModes: ["transfer"],
          sla: { maxLatencyMs: 500, availabilityTarget: 0.999 },
        },
      ],
    };
  }

  return {
    manifestVersion: "market-v1",
    shopId: "paid-service-agent",
    name: "Paid Service Agent",
    description: "One-command x402 seller for paid API, inference, data, and workflow services.",
    category: "workflow_tool",
    ownerPubkey,
    endpoints: [
      {
        endpointId: "resource",
        method: "GET",
        path: "/resource",
        capabilityTags: ["resource_access", "workflow_tool"],
        description: "Return a paid resource payload.",
        pricingModel: { kind: "flat", amountAtomic: "1000" },
        settlementModes: ["transfer", "stream"],
        sla: { maxLatencyMs: 800, availabilityTarget: 0.995 },
      },
      {
        endpointId: "inference",
        method: "POST",
        path: "/inference",
        capabilityTags: ["ai_inference", "workflow_tool"],
        description: "Run a paid inference-style service call.",
        pricingModel: { kind: "flat", amountAtomic: "5000" },
        settlementModes: ["transfer", "stream"],
        sla: { maxLatencyMs: 1600, availabilityTarget: 0.99 },
      },
    ],
  };
}

function agentEnvExample(template: AgentTemplate): string {
  const rows = [
    "RECIPIENT=YOUR_SOLANA_WALLET_ADDRESS",
    "OWNER_PUBKEY=YOUR_SOLANA_WALLET_ADDRESS",
    "OWNER_SECRET_BASE58=",
    "PORT=3000",
    "SOLANA_RPC_URL=https://api.mainnet-beta.solana.com",
    "DNA_TRUSTED_LOCAL_NETTING=0",
  ];
  if (template === "restricted-market") {
    rows.push("RESTRICTED_MARKET_COMPLIANCE_UNLOCKED=0");
  }
  rows.push("");
  return rows.join("\n");
}

function paidEndpointSource(template: AgentTemplate): string {
  if (template === "marketplace") {
    return `
app.post("/marketplace/search", dnaPrice("2500", pay), (req, res) => {
  const query = String(req.body?.query ?? "safe service");
  res.json({
    ok: true,
    query,
    results: [
      { shopId: "research-pack", capability: "data_enrichment", priceAtomic: "2500", p95LatencyMs: 780 },
      { shopId: "ops-automation", capability: "workflow_tool", priceAtomic: "3200", p95LatencyMs: 940 },
    ],
  });
});

app.post("/marketplace/order-plan", dnaPrice("5000", pay), (req, res) => {
  res.json({
    ok: true,
    planId: crypto.randomUUID(),
    objective: req.body?.objective ?? "route safe service order",
    constraints: req.body?.constraints ?? {},
    custody: "none",
    settlement: "x402 receipt required per paid step",
  });
});
`;
  }

  if (template === "auction") {
    return `
app.get("/auction/listings", dnaPrice("1500", pay), (_req, res) => {
  res.json({
    ok: true,
    listings: [
      { auctionId: "svc-001", asset: "data-enrichment slot", currentPriceAtomic: "12000", closesInSeconds: 900 },
      { auctionId: "svc-002", asset: "workflow automation slot", currentPriceAtomic: "18000", closesInSeconds: 1500 },
    ],
  });
});

app.post("/auction/bid-plan", dnaPrice("4500", pay), (req, res) => {
  res.json({
    ok: true,
    planId: crypto.randomUUID(),
    auctionId: req.body?.auctionId ?? "svc-001",
    maxBidAtomic: String(req.body?.maxBidAtomic ?? "0"),
    guardrails: ["no custody", "no wager handling", "budget capped"],
  });
});
`;
  }

  if (template === "trading") {
    return `
app.post("/strategy/report", dnaPrice("7500", pay), (req, res) => {
  res.json({
    ok: true,
    reportId: crypto.randomUUID(),
    market: req.body?.market ?? "user-supplied",
    summary: "Research-only strategy report generated. Execution and custody are disabled.",
    risk: ["not financial advice", "no custody", "no automated execution"],
  });
});

app.get("/strategy/signals", dnaPrice("2500", pay), (_req, res) => {
  res.json({
    ok: true,
    feed: "research-preview",
    signals: [
      { symbol: "EXAMPLE", horizon: "1h", confidence: 0.61, execution: "disabled" },
    ],
  });
});
`;
  }

  return `
app.get("/resource", dnaPrice("1000", pay), (_req, res) => {
  res.json({ ok: true, result: "paid resource payload" });
});

app.post("/inference", dnaPrice("5000", pay), (req, res) => {
  res.json({
    ok: true,
    result: "paid inference output",
    inputHash: crypto.createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex"),
  });
});
`;
}

function paidAgentIndexSource(template: AgentTemplate): string {
  return `import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import { createSignedManifest } from "dna-x402/market/manifest";
import { dnaPrice, dnaSeller } from "dna-x402/seller";

const app = express();
app.use(express.json());

const recipient = process.env.RECIPIENT ?? "YOUR_SOLANA_WALLET_ADDRESS";
const ownerPubkey = process.env.OWNER_PUBKEY ?? recipient;
const port = Number(process.env.PORT ?? 3000);
const trustedLocalNetting = process.env.DNA_TRUSTED_LOCAL_NETTING === "1";
const settlement = trustedLocalNetting
  ? ["transfer", "stream", "netting"] as Array<"transfer" | "stream" | "netting">
  : ["transfer", "stream"] as Array<"transfer" | "stream" | "netting">;

const pay = dnaSeller(app, {
  recipient,
  settlement,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  unsafeUnverifiedNettingEnabled: trustedLocalNetting,
});

async function runtimeManifest() {
  const raw = await readFile(new URL("./manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw);
  manifest.ownerPubkey = ownerPubkey;
  return manifest;
}

app.get("/", async (_req, res) => {
  const manifest = await runtimeManifest();
  res.json({
    service: manifest.name,
    shopId: manifest.shopId,
    manifest: "/.well-known/dna-x402/manifest.json",
    signedManifest: "/market/signed-manifest",
  });
});

app.get("/.well-known/dna-x402/manifest.json", async (_req, res) => {
  res.json(await runtimeManifest());
});

app.get("/market/signed-manifest", async (_req, res) => {
  if (!process.env.OWNER_SECRET_BASE58) {
    res.status(412).json({
      ok: false,
      error: "OWNER_SECRET_BASE58_REQUIRED",
      message: "Set OWNER_SECRET_BASE58 to publish a signed marketplace manifest.",
    });
    return;
  }
  res.json(createSignedManifest(await runtimeManifest(), process.env.OWNER_SECRET_BASE58));
});
${paidEndpointSource(template)}
app.listen(port, () => {
  console.log(\`${agentTemplateTitle(template)} listening on http://127.0.0.1:\${port}\`);
});
`;
}

function restrictedAgentIndexSource(): string {
  return `import { readFile } from "node:fs/promises";
import express from "express";

const app = express();
app.use(express.json());

const port = Number(process.env.PORT ?? 3000);
const complianceUnlocked = process.env.RESTRICTED_MARKET_COMPLIANCE_UNLOCKED === "1";

async function runtimeManifest() {
  const raw = await readFile(new URL("./manifest.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

app.get("/", (_req, res) => {
  res.json({
    service: "Restricted Market Compliance Shell",
    enabled: false,
    complianceUnlocked,
    manifest: "/.well-known/dna-x402/manifest.json",
  });
});

app.get("/.well-known/dna-x402/manifest.json", async (_req, res) => {
  res.json(await runtimeManifest());
});

app.get("/restricted/status", (_req, res) => {
  res.status(451).json({
    ok: false,
    error: "RESTRICTED_MARKET_DISABLED",
    message: "Betting, wagering, odds, and gambling flows are blocked in the public marketplace by default.",
    requiredBeforeActivation: [
      "jurisdiction-specific legal approval",
      "licensing review",
      "age and location controls",
      "AML/KYC and responsible-use controls",
      "separate compliance-gated product boundary",
    ],
  });
});

app.post("/restricted/quote", (_req, res) => {
  res.status(451).json({
    ok: false,
    error: "RESTRICTED_MARKET_DISABLED",
    message: "No live restricted-market quotes are issued by this starter.",
  });
});

app.listen(port, () => {
  console.log(\`Restricted market shell listening on http://127.0.0.1:\${port}\`);
});
`;
}

function agentIndexSource(template: AgentTemplate): string {
  return template === "restricted-market"
    ? restrictedAgentIndexSource()
    : paidAgentIndexSource(template);
}

function signManifestSource(): string {
  return `import { readFile, writeFile } from "node:fs/promises";
import { createSignedManifest } from "dna-x402/market/manifest";

const ownerSecret = process.env.OWNER_SECRET_BASE58;
if (!ownerSecret) {
  throw new Error("OWNER_SECRET_BASE58 is required");
}

const raw = await readFile(new URL("./manifest.json", import.meta.url), "utf8");
const manifest = JSON.parse(raw);
if (process.env.OWNER_PUBKEY) {
  manifest.ownerPubkey = process.env.OWNER_PUBKEY;
}

const signed = createSignedManifest(manifest, ownerSecret);
await writeFile(new URL("./signed-manifest.json", import.meta.url), \`\${JSON.stringify(signed, null, 2)}\\n\`);
console.log("Wrote signed-manifest.json");
`;
}

function agentReadmeSource(template: AgentTemplate): string {
  const title = agentTemplateTitle(template);
  const restricted = template === "restricted-market";
  return [
    `# ${title}`,
    "",
    "## Run",
    "1. Copy `.env.example` to `.env` and set `RECIPIENT` plus `OWNER_PUBKEY`.",
    "2. Run `npm install`.",
    "3. Run `npm run dev`.",
    "4. Open `http://127.0.0.1:3000/.well-known/dna-x402/manifest.json`.",
    "",
    "## Publish",
    "Set `OWNER_SECRET_BASE58` only in a local shell, then run:",
    "",
    "```sh",
    "npm run sign-manifest",
    "```",
    "",
    restricted
      ? "This template is intentionally not a live betting product. It returns HTTP 451 for restricted market routes and is expected to be blocked by public marketplace policy."
      : "This template is safe-category by default and exposes paid x402 endpoints with transfer and stream settlement. Enable local netting only in controlled development.",
    "",
    "## Production Notes",
    "- Use mainnet RPC with rate-limit headroom.",
    "- Keep owner signing secrets out of source control.",
    "- Verify signed receipts before granting durable access.",
    "- Do not enable restricted or regulated categories without separate legal and operational controls.",
    "",
  ].join("\n");
}

async function installDependencies(targetDir: string, io: CliIo): Promise<void> {
  io.stdout(`Installing dependencies in ${targetDir} ...`);
  await new Promise<void>((resolve, reject) => {
    const npm = npmCommand(["install"]);
    const child = spawn(npm.command, npm.args, {
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

async function scaffoldProject(kind: ScaffoldKind, args: string[], io: CliIo): Promise<number> {
  const force = hasFlag(args, "--force");
  const install = !hasFlag(args, "--no-install");
  const template = kind === "agent" ? parseAgentTemplate(args) : undefined;
  const targetArg = positionalArgs(args)[0];
  const defaultName = kind === "seller"
    ? "dna-x402-seller"
    : kind === "buyer"
      ? "dna-x402-buyer"
      : "dna-x402-agent";
  const targetDir = path.resolve(process.cwd(), targetArg ?? defaultName);
  await ensureScaffoldDir(targetDir, force);
  const packageSpec = await packCurrentPackage(targetDir);

  if (kind === "seller") {
    await writeFile(path.join(targetDir, "package.json"), sellerPackageJson(packageSpec, path.basename(targetDir)));
    await writeFile(path.join(targetDir, "index.ts"), sellerIndexSource());
    await writeFile(path.join(targetDir, ".env.example"), sellerEnvExample());
  } else if (kind === "buyer") {
    await writeFile(path.join(targetDir, "package.json"), buyerPackageJson(packageSpec, path.basename(targetDir)));
    await writeFile(path.join(targetDir, "index.ts"), buyerIndexSource());
    await writeFile(path.join(targetDir, ".env.example"), buyerEnvExample());
  } else {
    if (!template) {
      throw new Error("Agent template resolution failed.");
    }
    await writeFile(path.join(targetDir, "package.json"), agentPackageJson(packageSpec, path.basename(targetDir)));
    await writeFile(path.join(targetDir, "index.ts"), agentIndexSource(template));
    await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(agentManifest(template), null, 2)}\n`);
    await writeFile(path.join(targetDir, "sign-manifest.ts"), signManifestSource());
    await writeFile(path.join(targetDir, ".env.example"), agentEnvExample(template));
    await writeFile(path.join(targetDir, "README.md"), agentReadmeSource(template));
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

  if (command === "init" && (subcommand === "buyer" || subcommand === "seller" || subcommand === "agent")) {
    return scaffoldProject(subcommand, rest, io);
  }

  if (command === "agent-builder") {
    return runAgentBuilderCommand(subcommand, rest, io);
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
