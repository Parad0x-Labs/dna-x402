import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net, { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { loadConfig } from "../../src/config.js";
import { createSignedManifest } from "../../src/market/manifest.js";
import { SolanaPaymentVerifier } from "../../src/paymentVerifier.js";
import { createX402App } from "../../src/server.js";
import { installProgrammabilityFixtures } from "../audit/programmability/fixtures/install.js";
import {
  createGauntletMintAndFund,
  drainSolBalances,
  ensureSolFunding,
  loadKeypairFromPath,
  resolveFunderKeypairPath,
  snapshotSolBalances,
  snapshotTokenBalances,
} from "./funding.js";
import { waitForAnchor, transferToken } from "./scenarios.js";
import { generateEphemeralWallets, redactWallets } from "./walletFactory.js";

interface ParsedArgs {
  outDir: string;
  rpcUrl: string;
  seed: string;
}

interface FlowSummary {
  label: string;
  buyerLanguage: string;
  sellerLabel: string;
  settlement: "transfer" | "stream" | "netting";
  scenario: string;
  ok: boolean;
  resource?: string;
  receiptId?: string;
  receiptHash?: string;
  paymentTxSignature?: string;
  streamId?: string;
  anchorSignature?: string;
  explorer?: {
    paymentTx?: string;
    anchorTx?: string;
  };
  raw?: unknown;
  error?: string;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function parseArgs(argv: string[]): ParsedArgs {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return {
    outDir: parseFlagValue(argv, "--out") ?? path.join(repoRoot, "reports", `devnet-polyglot-proof-${Date.now()}`),
    rpcUrl: parseFlagValue(argv, "--rpc-url") ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    seed: parseFlagValue(argv, "--seed") ?? crypto.randomUUID(),
  };
}

function assertWorkspacePath(target: string): string {
  const resolved = path.resolve(target);
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (process.platform === "win32" && !resolved.toLowerCase().startsWith(workspace.toLowerCase())) {
    throw new Error(`output path must stay under ${workspace}: ${resolved}`);
  }
  return resolved;
}

function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function short(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runJsonProcess<T>(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`process timed out\nstdout=${stdout.trim()}\nstderr=${stderr.trim()}`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const out = stdout.trim();
      const err = stderr.trim();
      if (code !== 0) {
        reject(new Error(`process failed (${code})\nstdout=${out}\nstderr=${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch (error) {
        reject(new Error(`failed to parse process JSON: ${(error as Error).message}\nstdout=${out}\nstderr=${err}`));
      }
    });
  });
}

function findCargoExe(repoRoot: string): string {
  const configured = process.env.CARGO_EXE;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const gLocal = path.resolve(repoRoot, ".tools", "rustup", "cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  if (fs.existsSync(gLocal)) {
    return gLocal;
  }
  return process.platform === "win32" ? "cargo.exe" : "cargo";
}

function rustEnv(repoRoot: string, outDir: string): NodeJS.ProcessEnv {
  const cargoHome = path.resolve(repoRoot, ".tools", "rustup", "cargo");
  const rustupHome = path.resolve(repoRoot, ".tools", "rustup", "rustup-home");
  const rustBin = path.resolve(cargoHome, "bin");
  return {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    CARGO_TARGET_DIR: path.resolve(repoRoot, ".cargo-target", "polyglot-devnet"),
    TMP: path.join(outDir, "tmp"),
    TEMP: path.join(outDir, "tmp"),
    PATH: `${rustBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function scanArtifactsForSecrets(outDir: string): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, reason: "private key block" },
    { regex: /\bmnemonic\b/i, reason: "mnemonic keyword" },
    { regex: /\bsecret_key\b/i, reason: "secret key keyword" },
    { regex: /\b[A-Za-z]:\\Users\\/, reason: "absolute Windows user path" },
    { regex: /\[\s*(\d{1,3}\s*,\s*){40,}\d{1,3}\s*\]/, reason: "keypair byte array" },
  ];

  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const joined = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walk(joined));
      } else {
        files.push(joined);
      }
    }
    return files;
  }

  for (const filePath of walk(outDir)) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2_000_000) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(outDir, filePath);
    for (const pattern of patterns) {
      if (pattern.regex.test(raw)) {
        findings.push(`${rel}: ${pattern.reason}`);
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

async function registerShop(baseUrl: string, params: {
  shopId: string;
  name: string;
  owner: Keypair;
  description: string;
  category: string;
  capability: string;
  endpointId: string;
  path: string;
  priceAtomic: string;
  settlementModes: Array<"transfer" | "stream" | "netting">;
  maxLatencyMs: number;
}): Promise<void> {
  const manifest = {
    manifestVersion: "market-v1" as const,
    shopId: params.shopId,
    name: params.name,
    ownerPubkey: params.owner.publicKey.toBase58(),
    description: params.description,
    category: params.category,
    endpoints: [
      {
        endpointId: params.endpointId,
        method: "GET" as const,
        path: params.path,
        capabilityTags: [params.capability, "devnet_polyglot"],
        description: params.description,
        pricingModel: { kind: "flat" as const, amountAtomic: params.priceAtomic },
        settlementModes: params.settlementModes,
        sla: { maxLatencyMs: params.maxLatencyMs, availabilityTarget: 0.99 },
      },
    ],
  };
  const signed = createSignedManifest(manifest, bs58.encode(Buffer.from(params.owner.secretKey)));
  const response = await fetchJson(`${baseUrl}/market/shops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  if (response.status !== 201) {
    throw new Error(`shop register failed for ${params.shopId}: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

async function summarizeFlow(params: {
  baseUrl: string;
  connection: Connection;
  label: string;
  buyerLanguage: string;
  sellerLabel: string;
  settlement: "transfer" | "stream" | "netting";
  scenario: string;
  raw: any;
}): Promise<FlowSummary> {
  const paymentTxSignature = params.raw?.txSignature ?? params.raw?.topupSignature;
  const anchor = params.raw?.receiptId
    ? await waitForAnchor(params.baseUrl, params.raw.receiptId, 120_000)
    : { ok: false };
  const flow: FlowSummary = {
    label: params.label,
    buyerLanguage: params.buyerLanguage,
    sellerLabel: params.sellerLabel,
    settlement: params.settlement,
    scenario: params.scenario,
    ok: Boolean(params.raw?.ok && params.raw?.receiptId && (params.settlement === "netting" || paymentTxSignature) && anchor.signature),
    resource: params.raw?.resource,
    receiptId: params.raw?.receiptId,
    receiptHash: params.raw?.receiptHash,
    paymentTxSignature,
    streamId: params.raw?.streamId,
    anchorSignature: anchor.signature,
    explorer: {
      paymentTx: paymentTxSignature ? explorerTx(paymentTxSignature) : undefined,
      anchorTx: anchor.signature ? explorerTx(anchor.signature) : undefined,
    },
    raw: params.raw,
  };

  if (paymentTxSignature) {
    const status = await params.connection.getSignatureStatus(paymentTxSignature, { searchTransactionHistory: true });
    flow.ok = flow.ok && Boolean(status.value && !status.value.err);
  }
  if (anchor.signature) {
    const status = await params.connection.getSignatureStatus(anchor.signature, { searchTransactionHistory: true });
    flow.ok = flow.ok && Boolean(status.value && !status.value.err);
  }
  return flow;
}

function writeReport(outDir: string, input: {
  generatedAt: string;
  baseUrl: string;
  mint: string;
  recipientOwner: string;
  funder: string;
  flows: FlowSummary[];
  secretScan: { ok: boolean; findings: string[] };
}): void {
  const decision = input.flows.every((flow) => flow.ok) && input.secretScan.ok ? "PASS" : "FAIL";
  const lines: string[] = [];
  lines.push("# Devnet Polyglot Agent Payment Proof");
  lines.push("");
  lines.push(`Generated: ${input.generatedAt}`);
  lines.push(`Result: ${decision}`);
  lines.push(`Cluster: Solana devnet`);
  lines.push(`Test mint: \`${input.mint}\``);
  lines.push(`Recipient owner: \`${input.recipientOwner}\``);
  lines.push(`Devnet funder: \`${input.funder}\``);
  lines.push("");
  lines.push("## What This Proves");
  lines.push("");
  lines.push("- Different coded buyers can complete the same HTTP 402 quote -> commit -> finalize -> receipt -> paid retry flow.");
  lines.push("- Transfer and stream-style top-up cases produced confirmed devnet SPL token transactions.");
  lines.push("- Netting produced a signed receipt and devnet anchor proof; netting intentionally has no per-request token transfer.");
  lines.push("- Every flow produced a receipt and a devnet anchor transaction.");
  lines.push("");
  lines.push("## Flow Matrix");
  lines.push("");
  lines.push("| Flow | Buyer | Seller / App | Settlement | Scenario | Receipt | Payment Tx | Anchor Tx | Status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const flow of input.flows) {
    const payment = flow.paymentTxSignature
      ? `[${short(flow.paymentTxSignature)}](${flow.explorer?.paymentTx})`
      : "n/a";
    const anchor = flow.anchorSignature
      ? `[${short(flow.anchorSignature)}](${flow.explorer?.anchorTx})`
      : "missing";
    lines.push(`| ${flow.label} | ${flow.buyerLanguage} | ${flow.sellerLabel} | ${flow.settlement} | ${flow.scenario} | \`${short(flow.receiptId)}\` | ${payment} | ${anchor} | ${flow.ok ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push("## Evidence Limits");
  lines.push("");
  lines.push("- This is a devnet proof using a 6-decimal devnet SPL test mint, not mainnet USDC.");
  lines.push("- Stream is proven as a stream-style funded-state/top-up path using the injected Streamflow-compatible verifier; it is not a live Streamflow program integration.");
  lines.push("- Seller apps are served by the local DNA x402 server with signed shop manifests. This proves wire compatibility and programmable payment flow, not independent third-party production deployment.");
  lines.push("- Betting/wagering remains intentionally blocked for public onboarding.");
  lines.push("");
  lines.push("## Artifact Safety");
  lines.push("");
  lines.push(`- Secret scan: ${input.secretScan.ok ? "PASS" : "FAIL"}`);
  if (!input.secretScan.ok) {
    for (const finding of input.secretScan.findings) {
      lines.push(`- ${finding}`);
    }
  }
  fs.writeFileSync(path.join(outDir, "DEVNET_POLYGLOT_PROOF.md"), `${lines.join("\n")}\n`);

  const post: string[] = [];
  post.push("Devnet proof is in.");
  post.push("");
  post.push("DNA x402 ran Python, Rust, and browser-style JS agents through the same paid HTTP flow:");
  post.push("");
  for (const flow of input.flows) {
    const tx = flow.paymentTxSignature ? ` payment tx ${flow.explorer?.paymentTx}` : " no per-request token tx by design";
    post.push(`- ${flow.buyerLanguage} -> ${flow.sellerLabel}: ${flow.settlement}, receipt ${flow.receiptId}, anchor ${flow.explorer?.anchorTx}.${tx}`);
  }
  post.push("");
  post.push("Plain English: different agent stacks can hit a paid endpoint, read the quote, pay, get a signed receipt, and unlock the result. Transfer/top-up proofs are on devnet. Netting is receipt + anchor based.");
  post.push("");
  post.push("Brutal boundary: this is devnet and local seller infrastructure, not a claim that every outside x402 app already interoperates without adapters.");
  fs.writeFileSync(path.join(outDir, "BULLISH_POST_DRAFT.md"), `${post.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const x402Root = path.join(repoRoot, "x402");
  const polyglotRoot = path.join(x402Root, "labs", "polyglot");
  const outDir = assertWorkspacePath(args.outDir);
  fs.mkdirSync(path.join(outDir, "tmp"), { recursive: true });

  const connection = new Connection(args.rpcUrl, "confirmed");
  const funderKeyPath = resolveFunderKeypairPath();
  const funder = loadKeypairFromPath(funderKeyPath);
  const wallets = generateEphemeralWallets({ count: 12, outDir, seed: args.seed });
  writeJson(path.join(outDir, "agents_public.json"), { agents: redactWallets(wallets) });

  await ensureSolFunding({
    connection,
    funder,
    wallets,
    minLamportsPerWallet: BigInt(Math.floor(0.03 * LAMPORTS_PER_SOL)),
  });

  const recipientOwner = funder.publicKey;
  const mintAndFund = await createGauntletMintAndFund({
    connection,
    funder,
    recipientOwner,
    wallets,
    decimals: 6,
    amountPerWalletAtomic: 20_000_000n,
  });

  const streamStates = new Map<string, { amountAtomic: string }>();
  const envSnapshot = {
    generatedAt: new Date().toISOString(),
    cluster: "devnet",
    rpcUrl: args.rpcUrl.includes("api-key=") ? args.rpcUrl.replace(/api-key=[^&]+/, "api-key=<redacted>") : args.rpcUrl,
    host: os.hostname(),
    funderPubkey: funder.publicKey.toBase58(),
    mint: mintAndFund.mint.toBase58(),
    recipientOwner: recipientOwner.toBase58(),
  };
  writeJson(path.join(outDir, "env.json"), envSnapshot);

  const runtimeEnv = {
    ...process.env,
    CLUSTER: "devnet",
    AUDIT_FIXTURES: "0",
    GAUNTLET_MODE: "1",
    USDC_MINT: mintAndFund.mint.toBase58(),
    PAYMENT_RECIPIENT: recipientOwner.toBase58(),
    SOLANA_RPC_URL: args.rpcUrl,
    ANCHORING_ENABLED: "1",
    ANCHORING_IMMEDIATE: "1",
    ANCHORING_FLUSH_INTERVAL_MS: "1000",
    RECEIPT_ANCHOR_PROGRAM_ID: process.env.RECEIPT_ANCHOR_PROGRAM_ID ?? "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
    ANCHORING_KEYPAIR_PATH: process.env.ANCHORING_KEYPAIR_PATH ?? funderKeyPath,
    ANCHORING_BATCH_SIZE: "1",
    ANCHORING_SIGNATURE_LOG_PATH: path.join(outDir, "anchor-signatures.log"),
    ALLOW_INSECURE: "1",
    UNSAFE_UNVERIFIED_NETTING_ENABLED: "1",
  };
  const config = loadConfig(runtimeEnv);
  const { app, context } = createX402App(config, {
    paymentVerifier: new SolanaPaymentVerifier(connection, {
      allowUnverifiedNetting: true,
      streamflowClient: {
        async getOne({ id }) {
          const state = streamStates.get(id);
          if (!state) {
            throw new Error(`missing stream state ${id}`);
          }
          return {
            recipient: recipientOwner.toBase58(),
            mint: mintAndFund.mint.toBase58(),
            depositedAmount: new BN(state.amountAtomic),
            withdrawnAmount: new BN("0"),
            closed: false,
          };
        },
      },
    }),
  });
  installProgrammabilityFixtures(app, context);

  const walletsByAgent = new Map(wallets.map((wallet) => [wallet.agentId, wallet]));
  app.post("/polyglot-wallet/pay", async (req, res) => {
    try {
      const body = req.body as {
        agentId?: string;
        quoteId?: string;
        settlement?: "transfer" | "stream";
        amountAtomic?: string;
        recipient?: string;
        mint?: string;
      };
      if (!body.agentId || !body.quoteId || !body.settlement || !body.amountAtomic) {
        res.status(400).json({ ok: false, error: "missing helper fields" });
        return;
      }
      if (body.recipient !== recipientOwner.toBase58() || body.mint !== mintAndFund.mint.toBase58()) {
        res.status(422).json({ ok: false, error: "quote recipient or mint mismatch" });
        return;
      }
      const wallet = walletsByAgent.get(body.agentId);
      const ownerAta = mintAndFund.walletAtas.get(body.agentId);
      if (!wallet || !ownerAta) {
        res.status(404).json({ ok: false, error: "unknown agent wallet" });
        return;
      }
      const txSignature = await transferToken({
        connection,
        owner: wallet.keypair,
        ownerAta,
        recipientAta: mintAndFund.recipientAta,
        mint: mintAndFund.mint,
        mintDecimals: 6,
        amountAtomic: BigInt(body.amountAtomic),
      });
      if (body.settlement === "stream") {
        const streamId = `devnet-stream-${body.agentId}-${crypto.createHash("sha256").update(`${body.quoteId}:${txSignature}`).digest("hex").slice(0, 24)}`;
        streamStates.set(streamId, { amountAtomic: body.amountAtomic });
        res.json({
          ok: true,
          payer: wallet.pubkey.toBase58(),
          txSignature,
          explorer: explorerTx(txSignature),
          paymentProof: {
            settlement: "stream",
            streamId,
            amountAtomic: body.amountAtomic,
            topupSignature: txSignature,
          },
        });
        return;
      }
      res.json({
        ok: true,
        payer: wallet.pubkey.toBase58(),
        txSignature,
        explorer: explorerTx(txSignature),
        paymentProof: {
          settlement: "transfer",
          txSignature,
          amountAtomic: body.amountAtomic,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const sellers = wallets.filter((wallet) => wallet.role === "seller");
    await registerShop(baseUrl, {
      shopId: "browser-agent-alpha-devnet",
      name: "Browser Agent Alpha Devnet",
      owner: sellers[0].keypair,
      description: "Browser-style seller agent exposing a paid devnet x402 tool.",
      category: "workflow_tool",
      capability: "browser_agent_service",
      endpointId: "browser-agent-alpha-tool",
      path: "/programmability/fixed-price",
      priceAtomic: "1200",
      settlementModes: ["transfer"],
      maxLatencyMs: 700,
    });
    await registerShop(baseUrl, {
      shopId: "strategy-stream-js-devnet",
      name: "Strategy Stream JS Devnet",
      owner: sellers[1].keypair,
      description: "Stream-gated trading signal subscription sold through x402.",
      category: "workflow_tool",
      capability: "stream_signal",
      endpointId: "stream-signal",
      path: "/programmability/subscription-stream?seconds=30",
      priceAtomic: "270",
      settlementModes: ["stream"],
      maxLatencyMs: 900,
    });

    const buyers = wallets.filter((wallet) => wallet.role === "buyer");
    const paymentHelperUrl = `${baseUrl}/polyglot-wallet/pay`;
    const pythonScript = path.join(polyglotRoot, "python_agent.py");
    const browserScript = path.join(polyglotRoot, "browser_agent.mjs");
    const rustManifest = path.join(polyglotRoot, "rust-agent", "Cargo.toml");

    const flows: FlowSummary[] = [];

    const pythonTransfer = await runJsonProcess<any>("python", [
      pythonScript,
      "--base-url", baseUrl,
      "--resource", "/programmability/english-auction",
      "--agent-id", buyers[0].agentId,
      "--settlement", "transfer",
      "--payment-helper-url", paymentHelperUrl,
    ], { cwd: repoRoot, timeoutMs: 120_000 });
    flows.push(await summarizeFlow({
      baseUrl,
      connection,
      label: "Python auction transfer",
      buyerLanguage: "Python",
      sellerLabel: "JS English auction app",
      settlement: "transfer",
      scenario: "English auction execution",
      raw: pythonTransfer,
    }));

    const pythonNetting = await runJsonProcess<any>("python", [
      pythonScript,
      "--base-url", baseUrl,
      "--resource", "/programmability/prediction-binary?side=yes",
      "--agent-id", buyers[1].agentId,
      "--settlement", "netting",
    ], { cwd: repoRoot, timeoutMs: 120_000 });
    flows.push(await summarizeFlow({
      baseUrl,
      connection,
      label: "Python prediction netting",
      buyerLanguage: "Python",
      sellerLabel: "JS prediction-market app",
      settlement: "netting",
      scenario: "Binary prediction market simulation",
      raw: pythonNetting,
    }));

    const rustTransfer = await runJsonProcess<any>(findCargoExe(repoRoot), [
      "run",
      "--quiet",
      "--manifest-path", rustManifest,
      "--",
      "--base-url", baseUrl,
      "--market-capability", "browser_agent_service",
      "--agent-id", buyers[2].agentId,
      "--settlement", "transfer",
      "--payment-helper-url", paymentHelperUrl,
    ], { cwd: repoRoot, env: rustEnv(repoRoot, outDir), timeoutMs: 180_000 });
    flows.push(await summarizeFlow({
      baseUrl,
      connection,
      label: "Rust marketplace transfer",
      buyerLanguage: "Rust",
      sellerLabel: "browser-agent marketplace shop",
      settlement: "transfer",
      scenario: "Market discovery plus paid fixed-price tool",
      raw: rustTransfer,
    }));

    const browserStream = await runJsonProcess<any>(process.execPath, [
      browserScript,
      "--base-url", baseUrl,
      "--market-capability", "stream_signal",
      "--agent-id", buyers[3].agentId,
      "--settlement", "stream",
      "--payment-helper-url", paymentHelperUrl,
    ], { cwd: repoRoot, timeoutMs: 120_000 });
    flows.push(await summarizeFlow({
      baseUrl,
      connection,
      label: "Browser JS stream",
      buyerLanguage: "Browser-style JS",
      sellerLabel: "stream-gated strategy shop",
      settlement: "stream",
      scenario: "Stream-funded strategy access",
      raw: browserStream,
    }));

    const flush = await fetchJson(`${baseUrl}/settlements/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    writeJson(path.join(outDir, "settlements_flush.json"), flush);

    const beforeDrain = {
      timestamp: new Date().toISOString(),
      sol: await snapshotSolBalances({ connection, wallets }),
      token: {
        mint: mintAndFund.mint.toBase58(),
        recipientOwner: recipientOwner.toBase58(),
        recipientAta: mintAndFund.recipientAta.toBase58(),
        rows: await snapshotTokenBalances({ connection, wallets, mint: mintAndFund.mint }),
      },
    };
    writeJson(path.join(outDir, "balances_before_drain.json"), beforeDrain);

    const drainedSol = await drainSolBalances({
      connection,
      wallets,
      recipient: funder.publicKey,
    });
    writeJson(path.join(outDir, "sol_drain.json"), {
      recipient: funder.publicKey.toBase58(),
      ok: drainedSol.every((row) => !row.error),
      rows: drainedSol,
    });

    fs.rmSync(path.join(outDir, "keys"), { recursive: true, force: true });
    const secretScan = scanArtifactsForSecrets(outDir);
    writeJson(path.join(outDir, "artifact_secret_scan.json"), secretScan);

    writeJson(path.join(outDir, "summary.json"), {
      generatedAt: envSnapshot.generatedAt,
      cluster: "devnet",
      baseUrl,
      mint: mintAndFund.mint.toBase58(),
      recipientOwner: recipientOwner.toBase58(),
      funder: funder.publicKey.toBase58(),
      flows,
      secretScan,
    });

    writeReport(outDir, {
      generatedAt: envSnapshot.generatedAt,
      baseUrl,
      mint: mintAndFund.mint.toBase58(),
      recipientOwner: recipientOwner.toBase58(),
      funder: funder.publicKey.toBase58(),
      flows,
      secretScan,
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ok: flows.every((flow) => flow.ok) && secretScan.ok,
      outDir,
      report: path.join(outDir, "DEVNET_POLYGLOT_PROOF.md"),
      postDraft: path.join(outDir, "BULLISH_POST_DRAFT.md"),
      flows: flows.map((flow) => ({
        label: flow.label,
        ok: flow.ok,
        paymentTx: flow.explorer?.paymentTx,
        anchorTx: flow.explorer?.anchorTx,
      })),
    }, null, 2));

    if (!flows.every((flow) => flow.ok) || !secretScan.ok) {
      process.exitCode = 1;
    }
  } finally {
    await new Promise<void>((resolve) => (server as net.Server).close(() => resolve()));
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
