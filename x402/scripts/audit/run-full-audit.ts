import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import request from "supertest";
import { X402Config } from "../../src/config.js";
import { createX402App } from "../../src/server.js";
import { PaymentVerifier } from "../../src/paymentVerifier.js";
import { ReceiptSigner, verifySignedReceipt } from "../../src/receipts.js";
import { PaymentProof, Quote, SignedReceipt } from "../../src/types.js";
import { verifySplTransferProof } from "../../src/verifier/splTransfer.js";
import { runTenAgentSimulation } from "../sim/run-10agents.js";

type Json = Record<string, unknown>;

interface StepResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

interface AuditReport {
  generatedAt: string;
  cluster: string;
  baseUrl?: string;
  marketAllowDevIngest: string;
  overallOk: boolean;
  deployEstimate: StepResult;
  deployLedger: StepResult;
  bufferReclaim: StepResult;
  pauseFlags: StepResult;
  verificationNegatives: StepResult;
  simulation10Agents: StepResult;
  smokeLocal: StepResult;
  smokeRemote: StepResult;
  anchoringEvidence: StepResult;
  artifacts: {
    estimateReportPath?: string;
    ledgerReportPath?: string;
    closeBuffersReportPath?: string;
    simulationReportPath?: string;
    anchorSignaturesPath?: string;
    anchorConfirmPath?: string;
    bucketAccountDumpPath?: string;
    auditJsonPath: string;
    auditMarkdownPath: string;
  };
  notes: string[];
}

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: true, settledOnchain: false };
  }
}

function usage(): string {
  return [
    "Usage: npm run audit:full -- [options]",
    "",
    "Options:",
    "  --cluster <name>            Cluster label for deploy scripts (default: devnet)",
    "  --base-url <url>            Remote server URL for smoke test (default: X402_BASE_URL env)",
    "  --deployer-keypair <path>   Solana keypair for deploy scripts (default: DEPLOYER_KEYPAIR env)",
    "  --upgrade-authority <path>  Upgrade/buffer authority path (default: deployer keypair)",
    "  --deploy                    Run live deploy-ledger instead of reusing latest report",
    "  --help                      Show this help",
  ].join("\n");
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

function nowStamp(): string {
  return new Date().toISOString().replace(/[:]/g, "-");
}

function runNpmScript(cwd: string, script: string, extraArgs: string[]): { ok: boolean; stdout: string; stderr: string; command: string } {
  const args = ["run", script];
  if (extraArgs.length > 0) {
    args.push("--", ...extraArgs);
  }
  const command = `npm ${args.join(" ")}`;
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });

  return {
    ok: (result.status ?? 1) === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    command,
  };
}

function readJsonFile(filePath: string): Json {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as Json;
}

function latestReportByPrefix(reportsDir: string, prefix: string): string | undefined {
  if (!fs.existsSync(reportsDir)) {
    return undefined;
  }
  const matches = fs.readdirSync(reportsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => path.join(reportsDir, name));
  if (matches.length === 0) {
    return undefined;
  }
  return matches
    .map((entry) => ({
      entry,
      mtimeMs: fs.statSync(entry).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].entry;
}

function ensureFile(pathToFile: string, context: string): void {
  if (!fs.existsSync(pathToFile)) {
    throw new Error(`${context}: expected file not found: ${pathToFile}`);
  }
}

function validateDeployLedgerShape(ledger: Json): { ok: boolean; message: string } {
  const entries = ledger.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, message: "ledger.entries is not an array" };
  }
  if (typeof ledger.cluster !== "string" || typeof ledger.walletPubkey !== "string") {
    return { ok: false, message: "ledger cluster/walletPubkey missing" };
  }
  if (entries.some((entry) => typeof entry !== "object" || entry === null)) {
    return { ok: false, message: "ledger entries contain non-object values" };
  }
  return { ok: true, message: `validated ${entries.length} ledger entries` };
}

function buildBaseConfig(overrides: Partial<X402Config> = {}): X402Config {
  const base: X402Config = {
    port: 0,
    solanaRpcUrl: "https://api.devnet.solana.com",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat", "surge", "stream"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 120,
    feePolicy: {
      baseFeeAtomic: 0n,
      feeBps: 30,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    },
    nettingThresholdAtomic: 10_000n,
    nettingIntervalMs: 10_000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
  };

  return {
    ...base,
    ...overrides,
  };
}

async function runPauseFlagChecks(): Promise<StepResult> {
  const signer = ReceiptSigner.generate();

  const marketPaused = createX402App(
    buildBaseConfig({ pauseMarket: true }),
    { paymentVerifier: new FakeVerifier(), receiptSigner: signer },
  );
  const marketWrite = await request(marketPaused.app)
    .post("/market/shops")
    .send({})
    .expect(503);

  const finalizePaused = createX402App(
    buildBaseConfig({ pauseFinalize: true }),
    { paymentVerifier: new FakeVerifier(), receiptSigner: signer },
  );
  const first = await request(finalizePaused.app).get("/resource").expect(402);
  const quoteId = first.body.paymentRequirements.quote.quoteId as string;
  const commit = await request(finalizePaused.app)
    .post("/commit")
    .send({
      quoteId,
      payerCommitment32B: `0x${"66".repeat(32)}`,
    })
    .expect(201);
  const finalizeResp = await request(finalizePaused.app)
    .post("/finalize")
    .send({
      commitId: commit.body.commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-ok-123456789012345678901234567890",
      },
    })
    .expect(503);

  const ordersPaused = createX402App(
    buildBaseConfig({ pauseOrders: true }),
    { paymentVerifier: new FakeVerifier(), receiptSigner: signer },
  );
  const orderCreate = await request(ordersPaused.app)
    .post("/market/orders")
    .send({
      capability: "inference",
      maxPrice: "1000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    .expect(503);

  const ok = marketWrite.body.error === "market_paused"
    && finalizeResp.body.error === "finalize_paused"
    && orderCreate.body.error === "orders_paused";

  return {
    ok,
    message: ok ? "Pause flags enforced for market, finalize, and orders." : "Pause flag mismatch",
    details: {
      marketWriteError: marketWrite.body.error,
      finalizeError: finalizeResp.body.error,
      orderError: orderCreate.body.error,
    },
  };
}

async function runVerificationNegativeChecks(): Promise<StepResult> {
  const nowMs = Date.UTC(2026, 1, 16, 12, 0, 0);

  const wrongMintConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 100,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "200" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };

  const wrongRecipientConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 101,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "200" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };

  const underpayConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 102,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "20" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };

  const staleConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 103,
        blockTime: Math.floor((nowMs - 2_000_000) / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "200" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor((nowMs - 2_000_000) / 1000);
    },
  };

  const wrongMint = await verifySplTransferProof(wrongMintConnection, {
    txSignature: "wrong-mint-audit",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });

  const wrongRecipient = await verifySplTransferProof(wrongRecipientConnection, {
    txSignature: "wrong-recipient-audit",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });

  const underpay = await verifySplTransferProof(underpayConnection, {
    txSignature: "underpay-audit",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });

  const stale = await verifySplTransferProof(staleConnection, {
    txSignature: "stale-audit",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 60,
    nowMs,
  });

  let tickMs = nowMs;
  const staleQuoteApp = createX402App(
    buildBaseConfig({ quoteTtlSeconds: 1 }),
    {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
      now: () => new Date(tickMs),
    },
  );

  const quoteResp = await request(staleQuoteApp.app).get("/resource").expect(402);
  const quoteId = quoteResp.body.paymentRequirements.quote.quoteId as string;
  const commit = await request(staleQuoteApp.app)
    .post("/commit")
    .send({ quoteId, payerCommitment32B: `0x${"77".repeat(32)}` })
    .expect(201);
  tickMs += 2_500;
  const staleQuoteFinalize = await request(staleQuoteApp.app)
    .post("/finalize")
    .send({
      commitId: commit.body.commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-ok-123456789012345678901234567890",
      },
    })
    .expect(410);

  const signer = ReceiptSigner.generate();
  const signed = signer.sign({
    receiptId: "audit-receipt-1",
    quoteId: "audit-quote-1",
    commitId: "audit-commit-1",
    resource: "/resource",
    payerCommitment32B: "11".repeat(32),
    recipient: "recipient-wallet",
    mint: "USDC",
    amountAtomic: "100",
    feeAtomic: "1",
    totalAtomic: "101",
    settlement: "transfer",
    settledOnchain: true,
    txSignature: "sig-1",
    createdAt: new Date(nowMs).toISOString(),
  });

  const forged: SignedReceipt = {
    ...signed,
    signature: signed.signature.slice(0, -1) + (signed.signature.endsWith("1") ? "2" : "1"),
  };

  const ok = !wrongMint.ok
    && (wrongMint.error ?? "").includes("wrong mint")
    && !wrongRecipient.ok
    && (wrongRecipient.error ?? "").includes("wrong recipient")
    && !underpay.ok
    && (underpay.error ?? "").includes("underpaid")
    && !stale.ok
    && (stale.error ?? "").includes("old")
    && staleQuoteFinalize.body.error === "quote expired"
    && verifySignedReceipt(signed)
    && !verifySignedReceipt(forged);

  return {
    ok,
    message: ok ? "Negative verification checks reject invalid proofs and forged receipts." : "Negative verification checks failed",
    details: {
      wrongMintError: wrongMint.error,
      wrongRecipientError: wrongRecipient.error,
      underpayError: underpay.error,
      staleError: stale.error,
      staleQuoteError: staleQuoteFinalize.body.error,
      forgedReceiptRejected: !verifySignedReceipt(forged),
    },
  };
}

async function runLocalSmoke(): Promise<StepResult> {
  const anchoringEnabled = Boolean(process.env.RECEIPT_ANCHOR_PROGRAM_ID && process.env.ANCHORING_KEYPAIR_PATH);
  const signatureLogPath = process.env.ANCHORING_SIGNATURE_LOG_PATH
    ?? path.resolve(process.cwd(), "..", "reports", "anchor_tx_sigs.txt");

  const { app } = createX402App(buildBaseConfig({
    anchoringEnabled,
    receiptAnchorProgramId: process.env.RECEIPT_ANCHOR_PROGRAM_ID,
    anchoringKeypairPath: process.env.ANCHORING_KEYPAIR_PATH,
    anchoringAltAddress: process.env.ANCHORING_ALT_ADDRESS,
    anchoringImmediate: anchoringEnabled,
    anchoringBatchSize: 32,
    anchoringFlushIntervalMs: 1_000,
    anchoringSignatureLogPath: signatureLogPath,
  }), {
    paymentVerifier: new FakeVerifier(),
    receiptSigner: ReceiptSigner.generate(),
  });

  const health = await request(app).get("/health").expect(200);
  const snapshot = await request(app).get("/market/snapshot").expect(200);

  const first = await request(app).get("/resource").expect(402);
  const quoteId = first.body.paymentRequirements.quote.quoteId as string;
  const commit = await request(app)
    .post("/commit")
    .send({
      quoteId,
      payerCommitment32B: `0x${"77".repeat(32)}`,
    })
    .expect(201);
  const finalized = await request(app)
    .post("/finalize")
    .send({
      commitId: commit.body.commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-ok-123456789012345678901234567890",
      },
    })
    .expect(200);
  const retry = await request(app)
    .get("/resource")
    .set("x-dnp-commit-id", commit.body.commitId)
    .expect(200);

  let anchoringReceiptStatus = 0;
  if (anchoringEnabled) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const probe = await request(app).get(`/anchoring/receipt/${finalized.body.receiptId}`);
      anchoringReceiptStatus = probe.status;
      if (probe.status === 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return {
    ok: Boolean(health.body.ok)
      && snapshot.body !== undefined
      && retry.body?.ok === true
      && (!anchoringEnabled || anchoringReceiptStatus === 200),
    message: anchoringEnabled
      ? "Local smoke passed (/health, /market/snapshot, 402->finalize->200, anchoring confirmed)"
      : "Local smoke passed (/health, /market/snapshot, 402->finalize->200)",
    details: {
      healthOk: health.body.ok,
      snapshotKeys: Object.keys(snapshot.body ?? {}).length,
      receiptId: finalized.body.receiptId,
      retryOk: retry.body?.ok === true,
      anchoringEnabled,
      anchoringReceiptStatus: anchoringEnabled ? anchoringReceiptStatus : "disabled",
      anchoringSignatureLogPath: signatureLogPath,
    },
  };
}

async function runRemoteSmoke(baseUrl: string | undefined): Promise<StepResult> {
  if (!baseUrl) {
    return {
      ok: true,
      message: "Remote smoke skipped: no X402_BASE_URL/--base-url provided.",
      details: { skipped: true },
    };
  }

  try {
    const health = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    const snapshot = await fetch(`${baseUrl.replace(/\/$/, "")}/market/snapshot`);
    const healthJson = health.ok ? await health.json() : null;

    const ok = health.ok && snapshot.ok && Boolean(healthJson?.ok);
    return {
      ok,
      message: ok
        ? `Remote smoke passed against ${baseUrl}`
        : `Remote smoke failed against ${baseUrl}`,
      details: {
        baseUrl,
        healthStatus: health.status,
        snapshotStatus: snapshot.status,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: `Remote smoke failed against ${baseUrl}: ${(error as Error).message}`,
      details: {
        baseUrl,
      },
    };
  }
}

function runAnchoringEvidence(params: {
  cluster: string;
  signatureLogPath: string;
  outSignaturesPath: string;
  outConfirmPath: string;
  outBucketDumpPath: string;
}): StepResult {
  if (!fs.existsSync(params.signatureLogPath)) {
    return {
      ok: true,
      message: `Anchoring signature log not found: ${params.signatureLogPath}`,
      details: { skipped: true },
    };
  }

  const lines = fs.readFileSync(params.signatureLogPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      ok: true,
      message: "Anchoring signature log exists but has no entries.",
      details: { skipped: true, signatureLogPath: params.signatureLogPath },
    };
  }

  const signatures = lines.map((line) => {
    const sig = /sig=([1-9A-HJ-NP-Za-km-z]{32,88})/.exec(line)?.[1];
    const bucket = /bucket=([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(line)?.[1];
    const bucketId = /bucketId=([0-9]+)/.exec(line)?.[1];
    return { line, sig, bucket, bucketId };
  });

  fs.writeFileSync(params.outSignaturesPath, `${lines.join("\n")}\n`);

  const latest = signatures[signatures.length - 1];
  if (!latest.sig || !latest.bucket) {
    return {
      ok: false,
      message: "Could not parse latest anchoring signature/bucket from log.",
      details: {
        signatureLogPath: params.signatureLogPath,
        lastLine: latest.line,
      },
    };
  }

  const confirm = spawnSync("solana", ["confirm", latest.sig, "-u", params.cluster], {
    encoding: "utf8",
    env: process.env,
  });
  fs.writeFileSync(params.outConfirmPath, `${confirm.stdout ?? ""}${confirm.stderr ?? ""}`);

  const bucketDump = spawnSync("solana", ["account", latest.bucket, "-u", params.cluster], {
    encoding: "utf8",
    env: process.env,
  });
  fs.writeFileSync(params.outBucketDumpPath, `${bucketDump.stdout ?? ""}${bucketDump.stderr ?? ""}`);

  const ok = (confirm.status ?? 1) === 0 && (bucketDump.status ?? 1) === 0;
  return {
    ok,
    message: ok
      ? `Anchoring evidence confirmed for ${latest.sig}`
      : `Anchoring evidence failed (confirm=${confirm.status}, bucketDump=${bucketDump.status})`,
    details: {
      signature: latest.sig,
      bucket: latest.bucket,
      bucketId: latest.bucketId,
      signatureLogPath: params.signatureLogPath,
      outSignaturesPath: params.outSignaturesPath,
      outConfirmPath: params.outConfirmPath,
      outBucketDumpPath: params.outBucketDumpPath,
    },
  };
}

function markdownForReport(report: AuditReport): string {
  const lines = [
    "# Full Audit Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Cluster: ${report.cluster}`,
    `Overall: ${report.overallOk ? "PASS" : "FAIL"}`,
    "",
    "## Steps",
    `- Deploy estimate: ${report.deployEstimate.ok ? "PASS" : "FAIL"} - ${report.deployEstimate.message}`,
    `- Deploy ledger: ${report.deployLedger.ok ? "PASS" : "FAIL"} - ${report.deployLedger.message}`,
    `- Buffer reclaim: ${report.bufferReclaim.ok ? "PASS" : "FAIL"} - ${report.bufferReclaim.message}`,
    `- Pause flags: ${report.pauseFlags.ok ? "PASS" : "FAIL"} - ${report.pauseFlags.message}`,
    `- Verification negatives: ${report.verificationNegatives.ok ? "PASS" : "FAIL"} - ${report.verificationNegatives.message}`,
    `- 10-agent simulation: ${report.simulation10Agents.ok ? "PASS" : "FAIL"} - ${report.simulation10Agents.message}`,
    `- Local smoke: ${report.smokeLocal.ok ? "PASS" : "FAIL"} - ${report.smokeLocal.message}`,
    `- Remote smoke: ${report.smokeRemote.ok ? "PASS" : "FAIL"} - ${report.smokeRemote.message}`,
    `- Anchoring evidence: ${report.anchoringEvidence.ok ? "PASS" : "FAIL"} - ${report.anchoringEvidence.message}`,
    "",
    "## Artifacts",
    `- audit json: ${report.artifacts.auditJsonPath}`,
    `- deploy estimate: ${report.artifacts.estimateReportPath ?? "n/a"}`,
    `- deploy ledger: ${report.artifacts.ledgerReportPath ?? "n/a"}`,
    `- close buffers: ${report.artifacts.closeBuffersReportPath ?? "n/a"}`,
    `- sim 10 agents: ${report.artifacts.simulationReportPath ?? "n/a"}`,
    `- anchor tx sigs: ${report.artifacts.anchorSignaturesPath ?? "n/a"}`,
    `- anchor confirm: ${report.artifacts.anchorConfirmPath ?? "n/a"}`,
    `- bucket dump: ${report.artifacts.bucketAccountDumpPath ?? "n/a"}`,
    "",
    "## Notes",
  ];

  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const x402Dir = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const repoRoot = path.resolve(x402Dir, "..");
  const reportsDir = path.join(repoRoot, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const stamp = nowStamp();
  const cluster = parseFlagValue(argv, "--cluster") ?? process.env.CLUSTER ?? "devnet";
  const baseUrl = parseFlagValue(argv, "--base-url") ?? process.env.X402_BASE_URL;
  const deployerKeypair = parseFlagValue(argv, "--deployer-keypair") ?? process.env.DEPLOYER_KEYPAIR;
  const upgradeAuthority = parseFlagValue(argv, "--upgrade-authority") ?? process.env.UPGRADE_AUTHORITY ?? deployerKeypair;
  const runDeploy = hasFlag(argv, "--deploy");

  const estimateReportPath = path.join(reportsDir, `estimate-deploy-cost-${stamp}.json`);
  const generatedLedgerPath = path.join(reportsDir, `deploy-ledger-${stamp}.json`);
  const closeBuffersReportPath = path.join(reportsDir, `close-buffers-${stamp}.json`);
  const simulationReportPath = path.join(reportsDir, `sim-10agents-${stamp}.json`);
  const anchorSignaturesPath = path.join(reportsDir, `anchor_tx_sigs-${stamp}.txt`);
  const anchorConfirmPath = path.join(reportsDir, `anchor_confirm-${stamp}.txt`);
  const bucketAccountDumpPath = path.join(reportsDir, `bucket_account_dump-${stamp}.txt`);
  const auditJsonPath = path.join(reportsDir, `audit-${stamp}.json`);
  const auditMarkdownPath = path.join(repoRoot, "AUDIT_REPORT.md");

  const notes: string[] = [];
  const marketAllowDevIngest = process.env.MARKET_ALLOW_DEV_INGEST ?? "unset";
  if (marketAllowDevIngest === "1") {
    notes.push("MARKET_ALLOW_DEV_INGEST=1 detected; audit expected 0 for integrity mode.");
  }

  const estimateArgs = ["--cluster", cluster, "--out", estimateReportPath];
  if (deployerKeypair) {
    estimateArgs.push("--keypair", deployerKeypair);
  }
  const estimateRun = runNpmScript(x402Dir, "deploy:estimate", estimateArgs);
  if (!estimateRun.ok) {
    throw new Error(`deploy:estimate failed\n${estimateRun.stdout}\n${estimateRun.stderr}`);
  }
  ensureFile(estimateReportPath, "deploy estimate");

  let ledgerReportPath: string | undefined;
  if (runDeploy) {
    const ledgerArgs = ["--cluster", cluster, "--out", generatedLedgerPath];
    if (deployerKeypair) {
      ledgerArgs.push("--keypair", deployerKeypair);
    }
    if (upgradeAuthority) {
      ledgerArgs.push("--upgrade-authority", upgradeAuthority);
    }
    const ledgerRun = runNpmScript(x402Dir, "deploy:ledger", ledgerArgs);
    if (!ledgerRun.ok) {
      throw new Error(`deploy:ledger failed\n${ledgerRun.stdout}\n${ledgerRun.stderr}`);
    }
    ledgerReportPath = generatedLedgerPath;
  } else {
    ledgerReportPath = latestReportByPrefix(reportsDir, "deploy-ledger-");
    if (!ledgerReportPath) {
      const dryArgs = ["--cluster", cluster, "--dry-run", "--out", generatedLedgerPath];
      if (deployerKeypair) {
        dryArgs.push("--keypair", deployerKeypair);
      }
      if (upgradeAuthority) {
        dryArgs.push("--upgrade-authority", upgradeAuthority);
      }
      const dryRun = runNpmScript(x402Dir, "deploy:ledger", dryArgs);
      if (!dryRun.ok) {
        throw new Error(`deploy:ledger --dry-run failed\n${dryRun.stdout}\n${dryRun.stderr}`);
      }
      ledgerReportPath = generatedLedgerPath;
      notes.push("No previous deploy-ledger report found; generated dry-run ledger.");
    } else {
      notes.push(`Reused latest deploy-ledger report: ${ledgerReportPath}`);
    }
  }
  ensureFile(ledgerReportPath, "deploy ledger");

  const closeArgs = ["--cluster", cluster, "--out", closeBuffersReportPath];
  if (deployerKeypair) {
    closeArgs.push("--keypair", deployerKeypair);
  }
  if (upgradeAuthority) {
    closeArgs.push("--authority", upgradeAuthority);
  }
  const closeRun = runNpmScript(x402Dir, "deploy:buffers:close", closeArgs);
  if (!closeRun.ok) {
    throw new Error(`deploy:buffers:close failed\n${closeRun.stdout}\n${closeRun.stderr}`);
  }
  ensureFile(closeBuffersReportPath, "close buffers");

  const estimateJson = readJsonFile(estimateReportPath);
  const ledgerJson = readJsonFile(ledgerReportPath);
  const closeJson = readJsonFile(closeBuffersReportPath);

  const ledgerShape = validateDeployLedgerShape(ledgerJson);
  const reclaimedLamports = BigInt(String(closeJson.deltaLamports ?? "0"));
  const buffersBefore = Array.isArray(closeJson.buffersBefore) ? closeJson.buffersBefore.length : 0;

  const deployEstimateResult: StepResult = {
    ok: true,
    message: "Deploy estimate report generated",
    details: {
      totalEstimatedLowSol: estimateJson.totalEstimatedLowSol,
      totalEstimatedHighSol: estimateJson.totalEstimatedHighSol,
      reportPath: estimateReportPath,
    },
  };

  const deployLedgerResult: StepResult = {
    ok: ledgerShape.ok,
    message: ledgerShape.message,
    details: {
      reportPath: ledgerReportPath,
      totalDeltaSol: ledgerJson.totalDeltaSol,
      entries: Array.isArray(ledgerJson.entries) ? ledgerJson.entries.length : 0,
    },
  };

  const bufferReclaimResult: StepResult = {
    ok: reclaimedLamports > 0n || buffersBefore === 0,
    message: reclaimedLamports > 0n
      ? "Buffer reclaim returned lamports"
      : (buffersBefore === 0 ? "No buffers existed before reclaim" : "Buffers existed but no lamports reclaimed"),
    details: {
      deltaLamports: closeJson.deltaLamports,
      deltaSol: closeJson.deltaSol,
      buffersBefore,
      buffersAfter: Array.isArray(closeJson.buffersAfter) ? closeJson.buffersAfter.length : undefined,
      reportPath: closeBuffersReportPath,
    },
  };

  const pauseFlagsResult = await runPauseFlagChecks();
  const negativeResult = await runVerificationNegativeChecks();

  let simulationResult: StepResult;
  try {
    const sim = await runTenAgentSimulation({
      baseSeed: 260216,
      cluster,
      outPath: simulationReportPath,
    });
    simulationResult = {
      ok: true,
      message: "10-agent simulation passed",
      details: {
        outPath: sim.outPath,
        passedScenarios: sim.report.passedScenarios,
        failedScenarios: sim.report.failedScenarios,
      },
    };
  } catch (error) {
    simulationResult = {
      ok: false,
      message: `10-agent simulation failed: ${(error as Error).message}`,
      details: {
        outPath: simulationReportPath,
      },
    };
  }

  const smokeLocal = await runLocalSmoke();
  const smokeRemote = await runRemoteSmoke(baseUrl);
  const signatureLogPath = process.env.ANCHORING_SIGNATURE_LOG_PATH
    ?? path.join(repoRoot, "reports", "anchor_tx_sigs.txt");
  const anchoringEvidence = runAnchoringEvidence({
    cluster,
    signatureLogPath,
    outSignaturesPath: anchorSignaturesPath,
    outConfirmPath: anchorConfirmPath,
    outBucketDumpPath: bucketAccountDumpPath,
  });

  if (!smokeRemote.ok && baseUrl === undefined) {
    notes.push("Remote smoke was skipped because no base URL was provided.");
  }

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    baseUrl,
    marketAllowDevIngest,
    overallOk: deployEstimateResult.ok
      && deployLedgerResult.ok
      && bufferReclaimResult.ok
      && pauseFlagsResult.ok
      && negativeResult.ok
      && simulationResult.ok
      && smokeLocal.ok
      && anchoringEvidence.ok
      && (smokeRemote.ok || baseUrl === undefined),
    deployEstimate: deployEstimateResult,
    deployLedger: deployLedgerResult,
    bufferReclaim: bufferReclaimResult,
    pauseFlags: pauseFlagsResult,
    verificationNegatives: negativeResult,
    simulation10Agents: simulationResult,
    smokeLocal,
    smokeRemote,
    anchoringEvidence,
    artifacts: {
      estimateReportPath,
      ledgerReportPath,
      closeBuffersReportPath,
      simulationReportPath: fs.existsSync(simulationReportPath) ? simulationReportPath : undefined,
      anchorSignaturesPath: fs.existsSync(anchorSignaturesPath) ? anchorSignaturesPath : undefined,
      anchorConfirmPath: fs.existsSync(anchorConfirmPath) ? anchorConfirmPath : undefined,
      bucketAccountDumpPath: fs.existsSync(bucketAccountDumpPath) ? bucketAccountDumpPath : undefined,
      auditJsonPath,
      auditMarkdownPath,
    },
    notes,
  };

  fs.writeFileSync(auditJsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(auditMarkdownPath, markdownForReport(report));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: report.overallOk,
    auditJsonPath,
    auditMarkdownPath,
    steps: {
      deployEstimate: report.deployEstimate.ok,
      deployLedger: report.deployLedger.ok,
      bufferReclaim: report.bufferReclaim.ok,
      pauseFlags: report.pauseFlags.ok,
      verificationNegatives: report.verificationNegatives.ok,
      simulation10Agents: report.simulation10Agents.ok,
      smokeLocal: report.smokeLocal.ok,
      smokeRemote: report.smokeRemote.ok,
      anchoringEvidence: report.anchoringEvidence.ok,
    },
  }, null, 2));

  if (!report.overallOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
