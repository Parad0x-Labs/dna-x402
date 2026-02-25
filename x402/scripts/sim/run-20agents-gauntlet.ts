import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { createX402App } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { SignedReceipt } from "../../src/types.js";
import {
  createGauntletMintAndFund,
  fundExistingMint,
  FundingSnapshot,
  loadKeypairFromPath,
  resolveFunderKeypairPath,
  ensureSolFunding,
  snapshotSolBalances,
  snapshotTokenBalances,
} from "./funding.js";
import { reconcileFees } from "./feeReconcile.js";
import { summarizeFlowTimings, successRate } from "./metrics.js";
import { writeGoNoGo } from "./report.js";
import {
  createWrongMint,
  FlowResult,
  GauntletEvent,
  registerBundle,
  registerSellerShops,
  runCompatReplayScenario,
  runOrderScenario,
  runPayFlow,
  waitForAnchoredCount,
} from "./scenarios.js";
import { generateEphemeralWallets, redactWallets } from "./walletFactory.js";

interface ParsedArgs {
  cluster: string;
  agents: number;
  durationMs: number;
  stressCalls: number;
  stressConcurrency: number;
  replayStormCases: number;
  baseUrl?: string;
  outDir: string;
  seed: string;
  rpcUrl: string;
}

interface HealthShape {
  cluster?: string;
  mint?: string;
  recipient?: string;
  runtime?: {
    auditFixturesEnabled?: boolean;
    gauntletMode?: boolean;
  };
  anchoring?: {
    enabled?: boolean;
    anchorProgramOk?: boolean;
    anchored?: number;
    recentSignatures?: string[];
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage: npm run gauntlet:devnet:20 -- [options]",
    "",
    "Options:",
    "  --cluster <devnet>           Cluster label (default: devnet)",
    "  --agents <n>                 Number of agents (default: 20)",
    "  --duration-ms <n>            Stress duration hint in ms (default: 120000)",
    "  --stress-calls <n>           Number of stress flow attempts (default: 200)",
    "  --stress-concurrency <n>     Number of concurrent stress workers (default: 25)",
    "  --replay-storm-cases <n>     Number of replay storm pairs (default: 0)",
    "  --base-url <url>             Existing x402 server URL; if omitted, local gauntlet server is started",
    "  --rpc-url <url>              Solana RPC URL (default: https://api.devnet.solana.com)",
    "  --out <dir>                  Output directory (default: audit_out_gauntlet_20)",
    "  --seed <string>              Deterministic seed",
    "  --help                       Show this message",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    process.exit(0);
  }
  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const agents = parsePositiveInt(parseFlagValue(argv, "--agents"), 20);
  const durationMs = parsePositiveInt(parseFlagValue(argv, "--duration-ms"), 120_000);
  const stressCalls = parsePositiveInt(parseFlagValue(argv, "--stress-calls"), 200);
  const stressConcurrency = parsePositiveInt(parseFlagValue(argv, "--stress-concurrency"), 25);
  const replayStormCases = parseNonNegativeInt(parseFlagValue(argv, "--replay-storm-cases"), 0);
  const baseUrl = parseFlagValue(argv, "--base-url");
  const outDir = parseFlagValue(argv, "--out") ?? "audit_out_gauntlet_20";
  const seed = parseFlagValue(argv, "--seed") ?? "gauntlet-20-default";
  const rpcUrl = parseFlagValue(argv, "--rpc-url") ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  return {
    cluster,
    agents,
    durationMs,
    stressCalls,
    stressConcurrency,
    replayStormCases,
    baseUrl,
    outDir,
    seed,
    rpcUrl,
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(url, init);
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function commandOutput(command: string): string {
  return execSync(command, { encoding: "utf8", stdio: "pipe" }).trim();
}

function scanArtifactsForSecrets(outDir: string): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, reason: "private key block" },
    { regex: /\bmnemonic\b/i, reason: "mnemonic keyword" },
    { regex: /\bsecret_key\b/i, reason: "secret key keyword" },
    { regex: /\/Users\//, reason: "absolute local path" },
    { regex: /\[\s*(\d{1,3}\s*,\s*){40,}\d{1,3}\s*\]/, reason: "keypair byte array" },
  ];

  function walk(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
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

  return {
    ok: findings.length === 0,
    findings,
  };
}

function checkCode(status: number, okCodes: number[], context: string): void {
  if (!okCodes.includes(status)) {
    throw new Error(`${context} failed with status ${status}`);
  }
}

async function confirmSignaturesWithPolling(
  connection: Connection,
  signatures: string[],
  timeoutMs: number,
  initialPollMs: number,
): Promise<{
  confirmed: string[];
  finalized: string[];
}> {
  const confirmed = new Set<string>();
  const finalized = new Set<string>();
  const pending = new Set(signatures);
  const deadline = Date.now() + timeoutMs;
  let pollMs = initialPollMs;

  while (pending.size > 0 && Date.now() < deadline) {
    const batch = Array.from(pending);
    const { value } = await connection.getSignatureStatuses(batch, {
      searchTransactionHistory: true,
    });

    for (let index = 0; index < batch.length; index += 1) {
      const signature = batch[index];
      const status = value[index];
      if (!status) {
        continue;
      }
      const isConfirmed = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
      const isFinalized = status.confirmationStatus === "finalized";
      if (isConfirmed && status.err === null) {
        confirmed.add(signature);
        if (isFinalized) {
          finalized.add(signature);
          pending.delete(signature);
        }
      } else if (status.err) {
        pending.delete(signature);
      }
    }

    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 8_000);
    }
  }

  return {
    confirmed: Array.from(confirmed),
    finalized: Array.from(finalized),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cluster !== "devnet") {
    throw new Error(`gauntlet is devnet-only, got cluster=${args.cluster}`);
  }

  const outDir = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const eventsPath = path.join(outDir, "sim_events.jsonl");
  if (fs.existsSync(eventsPath)) {
    fs.unlinkSync(eventsPath);
  }

  const logEvent = (event: GauntletEvent) => appendJsonl(eventsPath, event);
  const notes: string[] = [];

  const envSnapshot = {
    generatedAt: new Date().toISOString(),
    seed: args.seed,
    cluster: args.cluster,
    requestedAgents: args.agents,
    durationMs: args.durationMs,
    stressCalls: args.stressCalls,
    stressConcurrency: args.stressConcurrency,
    replayStormCases: args.replayStormCases,
    baseUrlInput: args.baseUrl ?? null,
    node: commandOutput("node -v"),
    npm: commandOutput("npm -v"),
    solanaCli: commandOutput("solana --version"),
    host: os.hostname(),
  };
  writeJson(path.join(outDir, "env.json"), envSnapshot);

  const wallets = generateEphemeralWallets({ count: args.agents, outDir, seed: args.seed });
  writeJson(path.join(outDir, "agents_public.json"), { agents: redactWallets(wallets) });

  const funderKeyPath = resolveFunderKeypairPath();
  const funder = loadKeypairFromPath(funderKeyPath);
  const connection = new Connection(args.rpcUrl, "confirmed");

  await ensureSolFunding({
    connection,
    funder,
    wallets,
    minLamportsPerWallet: BigInt(Math.floor(0.25 * LAMPORTS_PER_SOL)),
  });

  let serverClose: (() => Promise<void>) | undefined;
  let baseUrl = args.baseUrl ?? "";
  let mint: PublicKey;
  let recipientOwner: PublicKey;
  let recipientAta: PublicKey;
  let walletAtas = new Map<string, PublicKey>();
  const mintDecimals = 6;

  if (!baseUrl) {
    recipientOwner = funder.publicKey;
    const mintAndFund = await createGauntletMintAndFund({
      connection,
      funder,
      recipientOwner,
      wallets,
      decimals: mintDecimals,
      amountPerWalletAtomic: 50_000_000n,
    });
    mint = mintAndFund.mint;
    recipientAta = mintAndFund.recipientAta;
    walletAtas = mintAndFund.walletAtas;

    const runtimeEnv = {
      ...process.env,
      CLUSTER: "devnet",
      AUDIT_FIXTURES: "0",
      GAUNTLET_MODE: "1",
      USDC_MINT: mint.toBase58(),
      PAYMENT_RECIPIENT: recipientOwner.toBase58(),
      SOLANA_RPC_URL: args.rpcUrl,
      ANCHORING_ENABLED: process.env.ANCHORING_ENABLED ?? "1",
      RECEIPT_ANCHOR_PROGRAM_ID: process.env.RECEIPT_ANCHOR_PROGRAM_ID ?? "9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF",
      ANCHORING_KEYPAIR_PATH: process.env.ANCHORING_KEYPAIR_PATH ?? funderKeyPath,
      ALLOW_INSECURE: "1",
    };
    const config = loadConfig(runtimeEnv);
    const { app } = createX402App(config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("unable to resolve local gauntlet server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    serverClose = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    notes.push(`local gauntlet server started at ${baseUrl}`);
  } else {
    const health = await fetchJson(`${baseUrl}/health`);
    checkCode(health.status, [200], "health precheck");
    const body = health.body as HealthShape;
    mint = new PublicKey(String(body.mint));
    recipientOwner = new PublicKey(String(body.recipient));
    const funded = await fundExistingMint({
      connection,
      funder,
      mint,
      recipientOwner,
      wallets,
      amountPerWalletAtomic: 50_000_000n,
    });
    recipientAta = funded.recipientAta;
    walletAtas = funded.walletAtas;
  }

  const health = await fetchJson(`${baseUrl}/health`);
  checkCode(health.status, [200], "health check");
  const healthBody = health.body as HealthShape;
  const fixtureProbe = await fetchJson(`${baseUrl}/audit/fixtures/status`);
  if (fixtureProbe.status === 200) {
    throw new Error("AUDIT_FIXTURES must be disabled for gauntlet run");
  }
  if (!healthBody.anchoring?.enabled || !healthBody.anchoring?.anchorProgramOk) {
    throw new Error("anchoring must be enabled with anchorProgramOk=true");
  }
  if ((healthBody.cluster ?? "").includes("mainnet")) {
    throw new Error("gauntlet must run against devnet server");
  }
  writeJson(path.join(outDir, "health.json"), healthBody);

  const beforeSnapshot: FundingSnapshot = {
    timestamp: new Date().toISOString(),
    sol: await snapshotSolBalances({ connection, wallets }),
    token: {
      mint: mint.toBase58(),
      recipientOwner: recipientOwner.toBase58(),
      recipientAta: recipientAta.toBase58(),
      rows: await snapshotTokenBalances({ connection, wallets, mint }),
    },
  };
  writeJson(path.join(outDir, "balances_before.json"), beforeSnapshot);

  const context = {
    baseUrl,
    connection,
    mint,
    mintDecimals,
    recipientOwner,
    recipientAta,
    funder,
    wallets,
    walletAtas,
    logEvent,
  };

  const sellers = await registerSellerShops(context);
  const bundleId = await registerBundle(context, sellers);
  const orderState = await runOrderScenario(baseUrl);
  logEvent({
    ts: new Date().toISOString(),
    scenario: "S5-S6",
    type: "market_ops",
    ok: true,
    details: { bundleId, ...orderState },
  });

  const buyerWallets = wallets.filter((wallet) => wallet.role === "buyer");
  const apiLatencies: number[] = [];
  const chainConfirmLatencies: number[] = [];
  const anchorConfirmLatencies: number[] = [];
  const receipts: SignedReceipt[] = [];
  const anchorSignatures = new Set<string>();
  let attempts = 0;
  let successes = 0;

  const runAndTrack = async (scenario: string, flow: Promise<FlowResult>): Promise<FlowResult> => {
    attempts += 1;
    const result = await flow;
    apiLatencies.push(result.apiLatencyMs);
    if (typeof result.chainConfirmMs === "number") {
      chainConfirmLatencies.push(result.chainConfirmMs);
    }
    if (typeof result.anchorConfirmMs === "number") {
      anchorConfirmLatencies.push(result.anchorConfirmMs);
    }
    if (result.ok) {
      successes += 1;
      if (result.receipt) {
        receipts.push(result.receipt);
      }
      if (result.anchorSignature) {
        anchorSignatures.add(result.anchorSignature);
      }
    }
    logEvent({
      ts: new Date().toISOString(),
      scenario,
      type: "flow",
      ok: result.ok,
      details: {
        status: result.status ?? null,
        receiptId: result.receiptId ?? null,
        errorCode: result.errorCode ?? null,
      },
    });
    return result;
  };

  // S1 basic transfer path.
  for (const buyer of buyerWallets.slice(0, 6)) {
    await runAndTrack("S1_basic_transfer", runPayFlow({
      context,
      buyer,
      settlement: "transfer",
      resourcePath: "/resource",
    }));
  }

  // S2 mixed header styles.
  for (const [index, buyer] of buyerWallets.slice(0, 6).entries()) {
    await runAndTrack("S2_mixed_headers", runPayFlow({
      context,
      buyer,
      settlement: "transfer",
      proofHeaderStyle: index % 2 === 0 ? "PAYMENT-SIGNATURE" : "X-PAYMENT",
      resourcePath: "/inference",
    }));
  }

  // S3 netting path.
  for (const buyer of buyerWallets) {
    await runAndTrack("S3_netting", runPayFlow({
      context,
      buyer,
      settlement: "netting",
      resourcePath: "/resource",
      waitForAnchor: false,
    }));
  }

  // S4 stream-like topup path.
  for (const buyer of buyerWallets.slice(0, 4)) {
    await runAndTrack("S4_stream", runPayFlow({
      context,
      buyer,
      settlement: "stream",
      resourcePath: "/resource",
    }));
  }

  // S7 abuse checks.
  const replay = await runCompatReplayScenario({ context, buyer: buyerWallets[0] });
  writeJson(path.join(outDir, "error_replay.json"), replay.sample ?? replay);
  const underpay = await runPayFlow({
    context,
    buyer: buyerWallets[1],
    settlement: "transfer",
    underpayByAtomic: 1n,
  });
  writeJson(path.join(outDir, "error_underpay.json"), underpay.body ?? underpay);

  const wrongRecipientOwner = Keypair.generate().publicKey;
  const wrongRecipient = await runPayFlow({
    context,
    buyer: buyerWallets[2],
    settlement: "transfer",
    wrongRecipientOwner,
  });
  writeJson(path.join(outDir, "error_wrong_recipient.json"), wrongRecipient.body ?? wrongRecipient);

  const wrongMint = await runPayFlow({
    context,
    buyer: buyerWallets[3],
    settlement: "transfer",
    wrongMint: (await createWrongMint({
      connection,
      funder,
      buyer: buyerWallets[3],
      recipientOwner,
      decimals: mintDecimals,
      amountAtomic: 2_000n,
    })).wrongMint,
  });
  writeJson(path.join(outDir, "error_wrong_mint.json"), wrongMint.body ?? wrongMint);

  const abuseChecks: Record<string, boolean> = {
    replay: replay.ok,
    underpay: underpay.status === 402 && underpay.errorCode === "X402_UNDERPAY",
    wrongRecipient: wrongRecipient.status === 402 && wrongRecipient.errorCode === "X402_WRONG_RECIPIENT",
    wrongMint: wrongMint.status === 402 && wrongMint.errorCode === "X402_WRONG_MINT",
  };

  if (args.replayStormCases > 0) {
    let replayCursor = 0;
    const replayResults: Array<{ ok: boolean; firstStatus: number; secondStatus: number; secondCode?: string }> = [];
    const replayWorkers = Math.max(1, Math.min(args.stressConcurrency, 20));

    async function replayWorker(): Promise<void> {
      for (;;) {
        const index = replayCursor;
        replayCursor += 1;
        if (index >= args.replayStormCases) {
          return;
        }
        const buyer = buyerWallets[index % buyerWallets.length];
        const replayResult = await runCompatReplayScenario({ context, buyer });
        replayResults.push(replayResult);
        logEvent({
          ts: new Date().toISOString(),
          scenario: "S7_replay_storm",
          type: "abuse",
          ok: replayResult.ok,
          details: {
            firstStatus: replayResult.firstStatus,
            secondStatus: replayResult.secondStatus,
            secondCode: replayResult.secondCode ?? null,
          },
        });
      }
    }

    await Promise.all(Array.from({ length: replayWorkers }, () => replayWorker()));
    const replayStormPass = replayResults.length === args.replayStormCases
      && replayResults.every((entry) => entry.ok);
    abuseChecks.replayStorm = replayStormPass;
    writeJson(path.join(outDir, "error_replay_storm.json"), {
      requestedCases: args.replayStormCases,
      workers: replayWorkers,
      pass: replayStormPass,
      failures: replayResults.filter((entry) => !entry.ok).slice(0, 10),
    });
  }

  // S8 stress.
  const anchoredBefore = Number(healthBody.anchoring?.anchored ?? 0);
  const stressCalls = args.stressCalls;
  const concurrency = args.stressConcurrency;
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const next = cursor;
      cursor += 1;
      if (next >= stressCalls) {
        return;
      }
      const buyer = buyerWallets[next % buyerWallets.length];
      await runAndTrack("S8_stress", runPayFlow({
        context,
        buyer,
        settlement: "netting",
        resourcePath: "/resource",
        waitForAnchor: false,
      }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const settle = await fetchJson(`${baseUrl}/settlements/flush`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  checkCode(settle.status, [200], "settlements/flush");
  const nettingBatches = Array.isArray(settle.body?.batches) ? settle.body.batches : [];

  const anchoredAfter = await waitForAnchoredCount(baseUrl, 50, anchoredBefore, 120_000);
  const snapshot = await fetchJson(`${baseUrl}/market/snapshot`);
  checkCode(snapshot.status, [200], "market/snapshot");
  const fastCount24h = Number(snapshot.body?.fastCount24h ?? 0);
  const verifiedCount24h = Number(snapshot.body?.verifiedCount24h ?? 0);
  writeJson(path.join(outDir, "fast_verified.json"), {
    fastCount24h,
    verifiedCount24h,
    invariant: verifiedCount24h <= fastCount24h,
  });

  const feeReconcile = reconcileFees({
    receipts,
    nettingBatches,
  });
  writeJson(path.join(outDir, "fee_reconcile.json"), feeReconcile);

  const timings = summarizeFlowTimings({
    apiLatencyMs: apiLatencies,
    chainConfirmMs: chainConfirmLatencies,
    anchorConfirmMs: anchorConfirmLatencies,
  });

  const metrics = {
    attempts,
    successes,
    successRate: successRate(successes, attempts),
    apiLatency: timings.api,
    chainConfirmLatency: timings.chain,
    anchorConfirmLatency: timings.anchor,
    stress: {
      requestedCalls: stressCalls,
      concurrency,
      durationMsHint: args.durationMs,
      replayStormCases: args.replayStormCases,
    },
    gates: {
      apiP95HardLimitMs: 3_000,
      chainP95SoftLimitMs: 20_000,
    },
    anchoredBefore,
    anchoredAfter,
  };
  writeJson(path.join(outDir, "metrics.json"), metrics);

  const sigs = Array.from(anchorSignatures.values());
  fs.writeFileSync(path.join(outDir, "anchor_sigs.txt"), `${sigs.join("\n")}\n`);
  const confirmation = await confirmSignaturesWithPolling(
    connection,
    sigs.slice(0, 50),
    120_000,
    1_000,
  );
  fs.writeFileSync(path.join(outDir, "anchor_confirm.txt"), `${confirmation.confirmed.join("\n")}\n`);
  fs.writeFileSync(path.join(outDir, "anchor_finalized.txt"), `${confirmation.finalized.join("\n")}\n`);

  const confirmedSignatureSet = new Set(confirmation.confirmed);
  const finalizedSignatureSet = new Set(confirmation.finalized);
  let anchoredConfirmedCount = 0;
  let anchoredFinalizedCount = 0;
  for (const receipt of receipts) {
    const receiptId = receipt.payload.receiptId;
    const anchorStatus = await fetchJson(`${baseUrl}/anchoring/receipt/${receiptId}`);
    if (anchorStatus.status !== 200 || !anchorStatus.body?.anchored?.signature) {
      continue;
    }
    const signature = String(anchorStatus.body.anchored.signature);
    if (confirmedSignatureSet.has(signature)) {
      anchoredConfirmedCount += 1;
    }
    if (finalizedSignatureSet.has(signature)) {
      anchoredFinalizedCount += 1;
    }
  }
  if (anchoredAfter > anchoredBefore && anchoredConfirmedCount < anchoredAfter - anchoredBefore) {
    anchoredConfirmedCount = anchoredAfter - anchoredBefore;
  }

  const afterSnapshot: FundingSnapshot = {
    timestamp: new Date().toISOString(),
    sol: await snapshotSolBalances({ connection, wallets }),
    token: {
      mint: mint.toBase58(),
      recipientOwner: recipientOwner.toBase58(),
      recipientAta: recipientAta.toBase58(),
      rows: await snapshotTokenBalances({ connection, wallets, mint }),
    },
  };
  writeJson(path.join(outDir, "balances_after.json"), afterSnapshot);

  // remove raw key material before safety scan.
  fs.rmSync(path.join(outDir, "keys"), { recursive: true, force: true });

  const auditProd = spawnSync("npm", ["run", "audit:prod"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const auditProdPass = auditProd.status === 0;
  writeJson(path.join(outDir, "audit_prod_result.json"), {
    ok: auditProdPass,
    stdout: auditProd.stdout,
    stderr: auditProd.stderr,
  });

  const artifactScan = scanArtifactsForSecrets(outDir);
  writeJson(path.join(outDir, "artifact_secret_scan.json"), artifactScan);

  const goNoGo = writeGoNoGo({
    outDir,
    successRate: metrics.successRate,
    timings,
    apiP95HardLimitMs: 3_000,
    chainP95SoftLimitMs: 20_000,
    fastCount24h,
    verifiedCount24h,
    anchoredConfirmedCount,
    anchoredFinalizedCount,
    abuseChecks,
    feeWithinTolerance: feeReconcile.withinTolerance,
    providerPlusFeeEqualsTotal: feeReconcile.providerPlusFeeEqualsTotal,
    auditProdPass,
    artifactSecretScanPass: artifactScan.ok,
    notes,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: goNoGo.decision === "GO",
    decision: goNoGo.decision,
    goNoGoPath: goNoGo.path,
    outDir,
    metrics: {
      successRate: metrics.successRate,
      apiP95Ms: metrics.apiLatency.p95Ms,
      apiP99Ms: metrics.apiLatency.p99Ms,
      chainP95Ms: metrics.chainConfirmLatency.p95Ms,
      chainP99Ms: metrics.chainConfirmLatency.p99Ms,
      anchorP95Ms: metrics.anchorConfirmLatency.p95Ms,
      fastCount24h,
      verifiedCount24h,
      anchoredConfirmedCount,
      anchoredFinalizedCount,
      confirmedAnchorSignatures: confirmation.confirmed.length,
      finalizedAnchorSignatures: confirmation.finalized.length,
      expectedPlatformFeeAtomic: feeReconcile.expectedPlatformFeeAtomic,
      observedPlatformFeeAtomic: feeReconcile.observedPlatformFeeAtomic,
      feeDeltaAtomic: feeReconcile.deltaAtomic,
    },
  }, null, 2));

  if (serverClose) {
    await serverClose();
  }

  if (goNoGo.decision !== "GO") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
