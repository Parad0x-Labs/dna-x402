import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import BN from "bn.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  fetchWith402,
  AgentWallet,
  InMemoryReceiptStore,
  InMemorySpendTracker,
} from "../../src/client.js";
import { loadConfig, X402Config } from "../../src/config.js";
import { parseAtomic } from "../../src/feePolicy.js";
import { createSignedManifest } from "../../src/market/manifest.js";
import { ReceiptSigner, verifySignedReceipt } from "../../src/receipts.js";
import { createX402App } from "../../src/server.js";
import { PaymentProof } from "../../src/types.js";
import { verifySplTransferProof } from "../../src/verifier/splTransfer.js";
import { verifyStreamflowProof } from "../../src/verifier/streamflow.js";
import { installProgrammabilityFixtures } from "./programmability/fixtures/install.js";
import { PROGRAMMABILITY_FIXTURES } from "./programmability/fixtures/primitives.js";
import { PrimitiveId } from "./programmability/fixtures/types.js";

interface EnvFingerprint {
  gitCommit: string;
  gitDirty: boolean;
  nodeVersion: string;
  npmVersion: string;
  solanaVersion: string;
  cluster: string;
}

interface PrimitiveChecks {
  flow402: boolean;
  paymentVerification: boolean;
  receiptVerification: boolean;
  anchoringConfirm: boolean;
  feeCorrectness: boolean;
  txSizeBudget: boolean;
  pauseFlagsBehavior: boolean;
}

interface PrimitiveResult {
  primitiveId: PrimitiveId;
  title: string;
  resourcePath: string;
  settlementMode: "transfer" | "stream" | "netting";
  checks: PrimitiveChecks;
  pass: boolean;
  paymentTxSignature?: string;
  anchorTxSignature?: string;
  anchorBucket?: string;
  anchorBucketId?: string;
  receiptId?: string;
  notes: string[];
}

interface ReadinessReport {
  generatedAt: string;
  baseUrl: string;
  cluster: string;
  mode: "local" | "remote";
  fixturesBase: string;
  anchoringExpected: boolean;
  fingerprint: EnvFingerprint;
  txMetrics: {
    singleBytes: number;
    singleIxDataBytes: number;
    singleAccounts: number;
    singleSignatures: number;
    singleUsesAlt: boolean;
    batch32Bytes: number;
    batch32Anchors: number;
    singleComputeUnits: number;
    batch32ComputeUnits: number;
  };
  invariants: {
    paymentVerificationReasons: string[];
    rateLimitGuard: boolean;
    pauseFlags: boolean;
    fastCount: number;
    verifiedCount: number;
    verifiedLteFast: boolean;
    verifiedDefinition: string;
  };
  primitives: PrimitiveResult[];
  overallPass: boolean;
}

interface BenchTxSizeReport {
  smallest_settlement_tx_bytes: number;
  flows: Array<{
    flowId: string;
    serialized_tx_bytes: number;
    signatures_count: number;
    accounts_count: number;
    ix_data_bytes: number;
    uses_alt: boolean;
  }>;
  batch_anchor_max_within_1232: number;
  batch_anchor_metrics_32?: {
    serialized_tx_bytes: number;
  };
}

interface BenchComputeReport {
  flows: Array<{
    flowId: string;
    unitsConsumed: number;
    ok?: boolean;
  }>;
}

interface WalletCapture {
  wallet: AgentWallet;
  lastProof?: PaymentProof;
}

interface PrimitiveRuntimeResult {
  flow402: boolean;
  receiptVerification: boolean;
  anchoringConfirm: boolean;
  feeCorrectness: boolean;
  settlementMode: "transfer" | "stream" | "netting";
  paymentTxSignature?: string;
  anchorTxSignature?: string;
  anchorBucket?: string;
  anchorBucketId?: string;
  receiptId?: string;
  notes: string[];
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const i = args.findIndex((arg) => arg === flag);
  if (i === -1 || i + 1 >= args.length) {
    return undefined;
  }
  return args[i + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function runCommand(command: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const out = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: out.status ?? 1,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

function commandOutput(command: string, args: string[], cwd: string): string {
  const out = runCommand(command, args, cwd);
  if (out.status !== 0) {
    return "";
  }
  return `${out.stdout}${out.stderr}`.trim();
}

function sanitizeSig(prefix: string): string {
  const body = crypto.randomBytes(20).toString("hex");
  return `${prefix}${body}`;
}

function createWalletCapture(): WalletCapture {
  const capture: WalletCapture = {
    wallet: {
      payTransfer: async (quote) => {
        const proof: PaymentProof = {
          settlement: "transfer",
          txSignature: sanitizeSig("tx-"),
          amountAtomic: quote.totalAtomic,
        };
        capture.lastProof = proof;
        return proof;
      },
      payStream: async (quote) => {
        const proof: PaymentProof = {
          settlement: "stream",
          streamId: sanitizeSig("stream-"),
          amountAtomic: quote.totalAtomic,
        };
        capture.lastProof = proof;
        return proof;
      },
      payNetted: async (quote) => {
        const proof: PaymentProof = {
          settlement: "netting",
          amountAtomic: quote.totalAtomic,
          note: "programmability-audit",
        };
        capture.lastProof = proof;
        return proof;
      },
    },
  };
  return capture;
}

function isBase58Like(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function sumMetricValues(rows: unknown): number {
  if (!Array.isArray(rows)) {
    return 0;
  }
  return rows.reduce((sum, row) => {
    if (!row || typeof row !== "object") {
      return sum;
    }
    return sum + toNumber((row as { value?: unknown }).value);
  }, 0);
}

function parsePaymentRequirements(payload: unknown): {
  quoteId: string;
  totalAtomic: string;
  recommendedMode: "transfer" | "stream" | "netting";
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("payment requirements payload missing");
  }
  const maybe = payload as {
    paymentRequirements?: {
      quote?: { quoteId?: string; totalAtomic?: string };
      recommendedMode?: "transfer" | "stream" | "netting";
    };
  };
  const quoteId = maybe.paymentRequirements?.quote?.quoteId;
  const totalAtomic = maybe.paymentRequirements?.quote?.totalAtomic;
  const recommendedMode = maybe.paymentRequirements?.recommendedMode;
  if (!quoteId || !totalAtomic || !recommendedMode) {
    throw new Error("invalid payment requirements shape");
  }
  return {
    quoteId,
    totalAtomic,
    recommendedMode,
  };
}

function normalizeFixturesBase(value: string | undefined): string {
  if (!value) {
    return "/programmability";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "/programmability";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/$/, "");
}

function resolveFixtureResourcePath(defaultPath: string, fixturesBase: string): string {
  if (fixturesBase === "/programmability") {
    return defaultPath;
  }
  const prefix = "/programmability/";
  if (!defaultPath.startsWith(prefix)) {
    return defaultPath;
  }
  return `${fixturesBase}/${defaultPath.slice(prefix.length)}`;
}

async function remoteFixturesSelfTest(baseUrl: string): Promise<{ ok: boolean; reason?: string; count?: number }> {
  try {
    const response = await fetch(`${baseUrl}/audit/fixtures/status`);
    if (response.status !== 200) {
      return { ok: false, reason: `fixtures status returned ${response.status}` };
    }
    const payload = await response.json() as {
      enabled?: boolean;
      count?: number;
      primitives?: unknown[];
    };
    const count = Number(payload.count ?? (Array.isArray(payload.primitives) ? payload.primitives.length : 0));
    if (!payload.enabled) {
      return { ok: false, reason: "fixtures not mounted (enabled=false)" };
    }
    if (!Number.isFinite(count) || count < 10) {
      return { ok: false, reason: `fixtures not mounted (expected 10 primitives, got ${count || 0})`, count };
    }
    return { ok: true, count };
  } catch (error) {
    return { ok: false, reason: `fixtures not mounted (${(error as Error).message})` };
  }
}

class ProgrammabilityVerifier {
  async verify(_quote: unknown, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      if (!paymentProof.txSignature || !paymentProof.txSignature.startsWith("tx-")) {
        return { ok: false, settledOnchain: false, error: "invalid transfer proof" };
      }
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      if (!paymentProof.streamId || !paymentProof.streamId.startsWith("stream-")) {
        return { ok: false, settledOnchain: false, error: "invalid stream proof" };
      }
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: true, settledOnchain: false };
  }
}

async function runProofNegativeChecks(): Promise<{ ok: boolean; reasons: string[] }> {
  const nowMs = Date.UTC(2026, 1, 17, 0, 0, 0);

  const wrongMintConn: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 11,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [{ owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "200" } }],
        },
        transaction: { message: { instructions: [] } },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };
  const wrongRecipientConn: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 12,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [{ owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "200" } }],
        },
        transaction: { message: { instructions: [] } },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };
  const underpayConn: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 13,
        blockTime: Math.floor(nowMs / 1000),
        meta: {
          err: null,
          preTokenBalances: [{ owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "20" } }],
        },
        transaction: { message: { instructions: [] } },
      };
    },
    async getBlockTime() {
      return Math.floor(nowMs / 1000);
    },
  };
  const staleConn: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 14,
        blockTime: Math.floor((nowMs - 2_000_000) / 1000),
        meta: {
          err: null,
          preTokenBalances: [{ owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "200" } }],
        },
        transaction: { message: { instructions: [] } },
      };
    },
    async getBlockTime() {
      return Math.floor((nowMs - 2_000_000) / 1000);
    },
  };

  const wrongMint = await verifySplTransferProof(wrongMintConn, {
    txSignature: "sig-wrong-mint",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });
  const wrongRecipient = await verifySplTransferProof(wrongRecipientConn, {
    txSignature: "sig-wrong-recipient",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });
  const underpay = await verifySplTransferProof(underpayConn, {
    txSignature: "sig-underpay",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 900,
    nowMs,
  });
  const stale = await verifySplTransferProof(staleConn, {
    txSignature: "sig-stale",
    expectedMint: "usdc-mint",
    expectedRecipient: "recipient-wallet",
    minAmountAtomic: "100",
    maxAgeSeconds: 60,
    nowMs,
  });

  const streamWrongRecipient = await verifyStreamflowProof({
    async getOne() {
      return {
        recipient: "wrong-recipient",
        mint: "usdc-mint",
        depositedAmount: new BN("1000"),
        withdrawnAmount: new BN("0"),
        closed: false,
      };
    },
  }, {
    streamId: "stream-test",
    expectedRecipient: "recipient-wallet",
    expectedMint: "usdc-mint",
    minFundedAtomic: "100",
  });

  const reasons = [
    wrongMint.error ?? "wrong-mint check failed",
    wrongRecipient.error ?? "wrong-recipient check failed",
    underpay.error ?? "underpay check failed",
    stale.error ?? "stale check failed",
    streamWrongRecipient.error ?? "stream wrong-recipient check failed",
  ];

  const ok = !wrongMint.ok
    && (wrongMint.error ?? "").includes("wrong mint")
    && !wrongRecipient.ok
    && (wrongRecipient.error ?? "").includes("wrong recipient")
    && !underpay.ok
    && (underpay.error ?? "").includes("underpaid")
    && !stale.ok
    && (stale.error ?? "").includes("old")
    && !streamWrongRecipient.ok
    && (streamWrongRecipient.error ?? "").includes("wrong recipient");

  return { ok, reasons };
}

async function waitForAnchor(
  baseUrl: string,
  receiptId: string,
  cluster: string,
): Promise<{ ok: boolean; signature?: string; bucket?: string; bucketId?: string; note: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const probe = await fetch(`${baseUrl}/anchoring/receipt/${receiptId}`);
    if (probe.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      continue;
    }
    const payload = await probe.json() as {
      anchored?: { signature?: string; bucketPda?: string; bucketId?: string };
    };
    const signature = payload.anchored?.signature;
    const bucket = payload.anchored?.bucketPda;
    const bucketId = payload.anchored?.bucketId;
    if (!signature) {
      return { ok: false, note: "anchoring record missing signature" };
    }
    if (isBase58Like(signature)) {
      const confirm = runCommand("solana", ["confirm", signature, "-u", cluster], process.cwd());
      if (confirm.status !== 0) {
        return {
          ok: false,
          signature,
          bucket,
          bucketId,
          note: `anchor signature confirmation failed: ${confirm.stderr.trim()}`,
        };
      }
    }
    return {
      ok: true,
      signature,
      bucket,
      bucketId,
      note: "anchor confirmation passed",
    };
  }
  return { ok: false, note: "anchor confirmation timeout" };
}

async function runPrimitiveFlow(
  baseUrl: string,
  resourcePath: string,
  cluster: string,
  requireAnchoring: boolean,
): Promise<PrimitiveRuntimeResult> {
  const notes: string[] = [];
  const fullUrl = `${baseUrl}${resourcePath}`;
  const unpaid = await fetch(fullUrl);
  const flow402 = unpaid.status === 402;
  if (!flow402) {
    return {
      flow402: false,
      receiptVerification: false,
      anchoringConfirm: false,
      feeCorrectness: false,
      settlementMode: "transfer",
      notes: [`expected 402, got ${unpaid.status}`],
    };
  }

  const requirements = parsePaymentRequirements(await unpaid.json());
  const walletCapture = createWalletCapture();
  const store = new InMemoryReceiptStore();
  const spendTracker = new InMemorySpendTracker();

  const maxSpend = (parseAtomic(requirements.totalAtomic) + 50_000n).toString(10);
  const result = await fetchWith402(fullUrl, {
    wallet: walletCapture.wallet,
    maxSpendAtomic: maxSpend,
    preferStream: requirements.recommendedMode === "stream",
    receiptStore: store,
    spendTracker,
  });

  const responseOk = result.response.status === 200;
  const receipt = result.receipt;
  const settlementMode = walletCapture.lastProof?.settlement ?? requirements.recommendedMode;
  const receiptVerification = Boolean(receipt && verifySignedReceipt(receipt));
  const paymentTxSignature = walletCapture.lastProof?.settlement === "transfer"
    ? walletCapture.lastProof.txSignature
    : walletCapture.lastProof?.settlement === "stream"
      ? walletCapture.lastProof.streamId
      : "netting-ledger";

  if (!responseOk) {
    notes.push(`retry response status ${result.response.status}`);
  }
  if (!receiptVerification) {
    notes.push("receipt signature verification failed");
  }

  let feeCorrectness = true;
  if (result.commitId && walletCapture.lastProof && settlementMode === "netting") {
    const replayFinalize = await fetch(`${baseUrl}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commitId: result.commitId,
        paymentProof: walletCapture.lastProof,
      }),
    });

    const flush = await fetch(`${baseUrl}/settlements/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs: Date.now() + 3600_000 }),
    });
    const flushJson = await flush.json() as {
      batches?: Array<{
        commitIds?: string[];
        settleAmountAtomic?: string;
        providerAmountAtomic?: string;
        platformFeeAtomic?: string;
      }>;
    };
    const batches = flushJson.batches ?? [];
    const commitMentions = batches.reduce((sum, batch) => {
      const ids = batch.commitIds ?? [];
      return sum + ids.filter((id) => id === result.commitId).length;
    }, 0);

    let splitConsistent = true;
    for (const batch of batches) {
      if (!batch.settleAmountAtomic || !batch.providerAmountAtomic || !batch.platformFeeAtomic) {
        continue;
      }
      const settle = parseAtomic(batch.settleAmountAtomic);
      const provider = parseAtomic(batch.providerAmountAtomic);
      const fee = parseAtomic(batch.platformFeeAtomic);
      if (provider + fee !== settle) {
        splitConsistent = false;
      }
    }

    feeCorrectness = replayFinalize.status === 200 && commitMentions <= 1 && splitConsistent;
    if (!feeCorrectness) {
      notes.push(`netting fee check failed (replay=${replayFinalize.status}, mentions=${commitMentions})`);
    }
  }

  let anchoringConfirm = false;
  let anchorTxSignature: string | undefined;
  let anchorBucket: string | undefined;
  let anchorBucketId: string | undefined;
  if (!requireAnchoring) {
    notes.push("anchoring disabled for this run");
  } else if (receipt) {
    const anchor = await waitForAnchor(baseUrl, receipt.payload.receiptId, cluster);
    anchoringConfirm = anchor.ok;
    anchorTxSignature = anchor.signature;
    anchorBucket = anchor.bucket;
    anchorBucketId = anchor.bucketId;
    if (!anchor.ok) {
      notes.push(anchor.note);
    }
  }

  return {
    flow402: flow402 && responseOk,
    receiptVerification,
    anchoringConfirm,
    feeCorrectness,
    settlementMode,
    paymentTxSignature,
    anchorTxSignature,
    anchorBucket,
    anchorBucketId,
    receiptId: receipt?.payload.receiptId,
    notes,
  };
}

async function runPauseFlagCheckComprehensive(baseConfig: X402Config): Promise<boolean> {
  const signer = ReceiptSigner.generate();
  const pausedMarket = createX402App({ ...baseConfig, pauseMarket: true }, {
    paymentVerifier: new ProgrammabilityVerifier() as any,
    receiptSigner: signer,
  });
  installProgrammabilityFixtures(pausedMarket.app, pausedMarket.context);
  const marketPort = await listenTemp(pausedMarket.app);
  const marketStatus = await fetch(`http://127.0.0.1:${marketPort}/market/shops`).then((r) => r.status).catch(() => 0);

  const pausedFinalize = createX402App({ ...baseConfig, pauseFinalize: true }, {
    paymentVerifier: new ProgrammabilityVerifier() as any,
    receiptSigner: signer,
  });
  installProgrammabilityFixtures(pausedFinalize.app, pausedFinalize.context);
  const finalizePort = await listenTemp(pausedFinalize.app);
  const unpaid = await fetch(`http://127.0.0.1:${finalizePort}/programmability/fixed-price`);
  const req = parsePaymentRequirements(await unpaid.json());
  const commit = await fetch(`http://127.0.0.1:${finalizePort}/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteId: req.quoteId,
      payerCommitment32B: `0x${"aa".repeat(32)}`,
    }),
  }).then((r) => r.json() as Promise<{ commitId: string }>);
  const finalizeStatus = await fetch(`http://127.0.0.1:${finalizePort}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commitId: commit.commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-audit-pause-check",
      },
    }),
  }).then((r) => r.status).catch(() => 0);

  const pausedOrders = createX402App({ ...baseConfig, pauseOrders: true }, {
    paymentVerifier: new ProgrammabilityVerifier() as any,
    receiptSigner: signer,
  });
  installProgrammabilityFixtures(pausedOrders.app, pausedOrders.context);
  const ordersPort = await listenTemp(pausedOrders.app);
  const ordersStatus = await fetch(`http://127.0.0.1:${ordersPort}/market/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capability: "primitive_fixed_price",
      maxPrice: "2000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  }).then((r) => r.status).catch(() => 0);

  return marketStatus === 503 && finalizeStatus === 503 && ordersStatus === 503;
}

async function runRateLimitCheck(baseUrl: string): Promise<boolean> {
  const ownerKeypair = nacl.sign.keyPair();
  const ownerPubkey = bs58.encode(ownerKeypair.publicKey);
  const ownerSecret58 = bs58.encode(ownerKeypair.secretKey);
  const manifestTemplate = {
    manifestVersion: "market-v1" as const,
    shopId: "",
    name: "Rate Limit Shop",
    ownerPubkey,
    endpoints: [
      {
        endpointId: "one",
        method: "GET" as const,
        path: "/rate-limit",
        capabilityTags: ["rl"],
        description: "rate",
        pricingModel: { kind: "flat" as const, amountAtomic: "10" },
        settlementModes: ["transfer" as const],
        sla: { maxLatencyMs: 1200, availabilityTarget: 0.99 },
      },
    ],
  };

  let got429 = false;
  for (let i = 0; i < 14; i += 1) {
    const signed = createSignedManifest({
      ...manifestTemplate,
      shopId: `rate-limit-${i}`,
    }, ownerSecret58);
    const resp = await fetch(`${baseUrl}/market/shops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (resp.status === 429) {
      got429 = true;
      break;
    }
  }
  return got429;
}

async function listenTemp(app: ReturnType<typeof createX402App>["app"]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to resolve temporary port"));
        return;
      }
      resolve(addr.port);
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
    }, 45_000).unref();
  });
}

function markdownForReport(report: ReadinessReport): string {
  const lines: string[] = [];
  lines.push("# PROGRAMMABILITY READINESS REPORT");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Base URL: ${report.baseUrl}`);
  lines.push(`Cluster: ${report.cluster}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Fixtures base: ${report.fixturesBase}`);
  lines.push(`Anchoring expected: ${report.anchoringExpected}`);
  lines.push(`Overall: ${report.overallPass ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("## Environment");
  lines.push(`- Git commit: ${report.fingerprint.gitCommit}`);
  lines.push(`- Git dirty: ${report.fingerprint.gitDirty}`);
  lines.push(`- Node: ${report.fingerprint.nodeVersion}`);
  lines.push(`- npm: ${report.fingerprint.npmVersion}`);
  lines.push(`- Solana CLI: ${report.fingerprint.solanaVersion}`);
  lines.push("");
  lines.push("## Primitive Matrix");
  lines.push("");
  lines.push("| Primitive | 402 Flow | Pay Verify | Receipt Verify | Anchor Confirm | Fee Correct | Tx-Size Budget | Pause Flags |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of report.primitives) {
    const c = row.checks;
    lines.push(`| ${row.primitiveId} | ${c.flow402 ? "PASS" : "FAIL"} | ${c.paymentVerification ? "PASS" : "FAIL"} | ${c.receiptVerification ? "PASS" : "FAIL"} | ${c.anchoringConfirm ? "PASS" : "FAIL"} | ${c.feeCorrectness ? "PASS" : "FAIL"} | ${c.txSizeBudget ? "PASS" : "FAIL"} | ${c.pauseFlagsBehavior ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push("## Tx/CU");
  lines.push(`- Single anchor bytes: ${report.txMetrics.singleBytes}`);
  lines.push(`- Single anchor ix data bytes: ${report.txMetrics.singleIxDataBytes}`);
  lines.push(`- Single anchor accounts/signatures: ${report.txMetrics.singleAccounts}/${report.txMetrics.singleSignatures}`);
  lines.push(`- Single anchor ALT: ${report.txMetrics.singleUsesAlt}`);
  lines.push(`- Batch(32) bytes: ${report.txMetrics.batch32Bytes}`);
  lines.push(`- Compute single/batch32: ${report.txMetrics.singleComputeUnits}/${report.txMetrics.batch32ComputeUnits}`);
  lines.push("");
  lines.push("## Analytics Semantics");
  lines.push(`- FAST count: ${report.invariants.fastCount}`);
  lines.push(`- VERIFIED count: ${report.invariants.verifiedCount}`);
  lines.push(`- VERIFIED <= FAST: ${report.invariants.verifiedLteFast ? "PASS" : "FAIL"}`);
  lines.push(`- Definition: ${report.invariants.verifiedDefinition}`);
  lines.push("");
  lines.push("## Invariant Notes");
  lines.push(`- Rate limit guard: ${report.invariants.rateLimitGuard ? "PASS" : "FAIL"}`);
  lines.push(`- Pause flags: ${report.invariants.pauseFlags ? "PASS" : "FAIL"}`);
  for (const reason of report.invariants.paymentVerificationReasons) {
    lines.push(`- Payment verifier reason: ${reason}`);
  }
  lines.push("");
  lines.push("## Primitive Signatures");
  for (const row of report.primitives) {
    lines.push(`- ${row.primitiveId}: payment=${row.paymentTxSignature ?? "n/a"}, anchor=${row.anchorTxSignature ?? "n/a"}, bucket=${row.anchorBucket ?? "n/a"}, bucketId=${row.anchorBucketId ?? "n/a"}`);
  }
  lines.push("");
  lines.push("## Boundary");
  lines.push("- Seller-defined logic: pricing, auction resolution, market strategy.");
  lines.push("- Protocol rails: payment verification, receipt integrity, anchoring confirmation, and market safety controls.");
  lines.push("- x402 flow: unpaid request returns 402 requirements, client pays, retries, then receives 200 + receipt.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cluster = parseFlagValue(args, "--cluster") ?? "devnet";
  const baseUrlArg = parseFlagValue(args, "--base-url");
  const fixturesBase = normalizeFixturesBase(parseFlagValue(args, "--fixtures-base"));
  const outDir = parseFlagValue(args, "--out-dir") ?? path.resolve(process.cwd(), "audit_out");
  const forceRemote = hasFlag(args, "--remote");

  fs.mkdirSync(outDir, { recursive: true });

  const repoRoot = path.resolve(process.cwd(), "..");
  const fingerprint: EnvFingerprint = {
    gitCommit: commandOutput("git", ["rev-parse", "HEAD"], repoRoot) || "unknown",
    gitDirty: Boolean(commandOutput("git", ["status", "--porcelain"], repoRoot)),
    nodeVersion: commandOutput("node", ["-v"], process.cwd()) || "unknown",
    npmVersion: commandOutput("npm", ["-v"], process.cwd()) || "unknown",
    solanaVersion: commandOutput("solana", ["--version"], repoRoot) || "unknown",
    cluster,
  };

  const txSizePath = path.resolve(process.cwd(), "reports", "bench_txsize.json");
  const computePath = path.resolve(process.cwd(), "reports", "bench_compute.json");
  if (!fs.existsSync(txSizePath) || !fs.existsSync(computePath)) {
    throw new Error("Missing bench reports. Run `npm run bench:txsize` and `npm run bench:compute` first.");
  }

  const tx = JSON.parse(fs.readFileSync(txSizePath, "utf8")) as BenchTxSizeReport;
  const cu = JSON.parse(fs.readFileSync(computePath, "utf8")) as BenchComputeReport;
  const singleTx = tx.flows.find((flow) => flow.flowId === "anchor_v0_with_alt")
    ?? tx.flows.find((flow) => flow.flowId === "anchor_v0_no_alt")
    ?? tx.flows[0];
  const singleCu = cu.flows.find((flow) => flow.flowId === "anchor_single_v0");
  const batchCu = cu.flows.find((flow) => flow.flowId === "anchor_batch32_v0");
  const txBudgetPass = Boolean(
    singleTx
      && singleTx.serialized_tx_bytes <= 450
      && singleTx.ix_data_bytes <= 40
      && singleTx.accounts_count <= 4
      && singleTx.signatures_count <= 1
      && tx.batch_anchor_max_within_1232 >= 32,
  );

  const base = loadConfig();
  const fallbackKeypairPath = path.join(process.env.HOME ?? "", ".config", "solana", "devnet-deployer.json");
  const autoKeypairPath = base.anchoringKeypairPath ?? (fs.existsSync(fallbackKeypairPath) ? fallbackKeypairPath : undefined);
  const autoProgramId = base.receiptAnchorProgramId ?? process.env.RECEIPT_ANCHOR_PROGRAM_ID ?? "9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF";
  const anchoringEnabled = Boolean(autoProgramId && autoKeypairPath);
  const baseConfig: X402Config = {
    ...base,
    port: 0,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
    anchoringEnabled,
    receiptAnchorProgramId: autoProgramId,
    anchoringKeypairPath: autoKeypairPath,
    anchoringImmediate: true,
    anchoringBatchSize: 1,
    anchoringFlushIntervalMs: 1_000,
    anchoringSignatureLogPath: path.resolve(repoRoot, "reports", "anchor_tx_sigs.txt"),
  };

  let baseUrl = baseUrlArg;
  let mode: "local" | "remote" = forceRemote ? "remote" : "local";
  let localServer: ReturnType<ReturnType<typeof createX402App>["app"]["listen"]> | undefined;

  if (!baseUrl && !forceRemote) {
    const { app, context } = createX402App(baseConfig, {
      paymentVerifier: new ProgrammabilityVerifier() as any,
      receiptSigner: ReceiptSigner.generate(),
    });
    installProgrammabilityFixtures(app, context);
    localServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      localServer?.once("listening", () => resolve());
      localServer?.once("error", reject);
    });
    const address = localServer.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind local programmability audit server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    mode = "local";
  } else if (baseUrlArg) {
    mode = "remote";
    baseUrl = baseUrlArg.replace(/\/$/, "");
  }

  if (!baseUrl) {
    throw new Error("Missing base URL. Use --base-url for remote mode or run local mode.");
  }

  if (mode === "remote") {
    const selfTest = await remoteFixturesSelfTest(baseUrl);
    if (!selfTest.ok) {
      throw new Error(selfTest.reason ?? "fixtures not mounted");
    }
  }

  const healthPayload = await fetch(`${baseUrl}/health`)
    .then((response) => response.json() as Promise<{ anchoring?: { enabled?: boolean } }>)
    .catch(() => undefined);
  const healthAnchoringEnabled = Boolean(healthPayload?.anchoring?.enabled);
  const requireAnchoring = mode === "remote"
    ? healthAnchoringEnabled
    : Boolean(baseConfig.anchoringEnabled);

  const paymentVerification = await runProofNegativeChecks();
  const pauseFlags = await runPauseFlagCheckComprehensive(baseConfig);
  const rateLimitGuard = mode === "local" ? await runRateLimitCheck(baseUrl) : true;

  const primitiveResults: PrimitiveResult[] = [];
  for (const fixture of PROGRAMMABILITY_FIXTURES) {
    const fixturePath = mode === "remote"
      ? resolveFixtureResourcePath(fixture.resourcePath, fixturesBase)
      : fixture.resourcePath;
    const runtime = await runPrimitiveFlow(baseUrl, fixturePath, cluster, requireAnchoring);
    const checks: PrimitiveChecks = {
      flow402: runtime.flow402,
      paymentVerification: paymentVerification.ok,
      receiptVerification: runtime.receiptVerification,
      anchoringConfirm: runtime.anchoringConfirm,
      feeCorrectness: runtime.feeCorrectness,
      txSizeBudget: txBudgetPass,
      pauseFlagsBehavior: pauseFlags,
    };
    primitiveResults.push({
      primitiveId: fixture.id,
      title: fixture.title,
      resourcePath: fixturePath,
      settlementMode: runtime.settlementMode,
      checks,
      pass: Object.values(checks).every(Boolean),
      paymentTxSignature: runtime.paymentTxSignature,
      anchorTxSignature: runtime.anchorTxSignature,
      anchorBucket: runtime.anchorBucket,
      anchorBucketId: runtime.anchorBucketId,
      receiptId: runtime.receiptId,
      notes: runtime.notes,
    });
  }

  const fastSelling = await fetch(`${baseUrl}/market/top-selling?window=24h&verificationTier=FAST`).then((r) => r.json()).catch(() => ({ results: [] }));
  const verifiedSelling = await fetch(`${baseUrl}/market/top-selling?window=24h&verificationTier=VERIFIED`).then((r) => r.json()).catch(() => ({ results: [] }));
  const fastCount = sumMetricValues((fastSelling as { results?: unknown }).results);
  const verifiedCount = sumMetricValues((verifiedSelling as { results?: unknown }).results);
  const verifiedLteFast = verifiedCount <= fastCount;

  const report: ReadinessReport = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    cluster,
    mode,
    fixturesBase,
    anchoringExpected: requireAnchoring,
    fingerprint,
    txMetrics: {
      singleBytes: singleTx?.serialized_tx_bytes ?? 0,
      singleIxDataBytes: singleTx?.ix_data_bytes ?? 0,
      singleAccounts: singleTx?.accounts_count ?? 0,
      singleSignatures: singleTx?.signatures_count ?? 0,
      singleUsesAlt: singleTx?.uses_alt ?? false,
      batch32Bytes: tx.batch_anchor_metrics_32?.serialized_tx_bytes ?? 0,
      batch32Anchors: tx.batch_anchor_max_within_1232,
      singleComputeUnits: singleCu?.unitsConsumed ?? 0,
      batch32ComputeUnits: batchCu?.unitsConsumed ?? 0,
    },
    invariants: {
      paymentVerificationReasons: paymentVerification.reasons,
      rateLimitGuard,
      pauseFlags,
      fastCount,
      verifiedCount,
      verifiedLteFast,
      verifiedDefinition: "VERIFIED means fulfilled receipt with anchored=true and verificationTier=VERIFIED (on-chain anchor confirmed).",
    },
    primitives: primitiveResults,
    overallPass: primitiveResults.every((row) => row.pass) && verifiedLteFast && rateLimitGuard && pauseFlags && paymentVerification.ok,
  };

  const readinessJsonPath = path.join(outDir, "programmable_readiness.json");
  const readinessDevnetPath = path.join(outDir, "programmable_devnet.json");
  const reportMdPath = path.join(outDir, "PROGRAMMABILITY_READINESS_REPORT.md");
  const receiptsPath = path.join(outDir, "programmable_receipts_sample.json");

  fs.writeFileSync(readinessJsonPath, JSON.stringify(report, null, 2));
  if (cluster === "devnet") {
    fs.writeFileSync(readinessDevnetPath, JSON.stringify(report, null, 2));
  }
  fs.writeFileSync(reportMdPath, markdownForReport(report));
  fs.writeFileSync(receiptsPath, JSON.stringify({
    generatedAt: report.generatedAt,
    samples: report.primitives.map((row) => ({
      primitiveId: row.primitiveId,
      receiptId: row.receiptId,
      anchorTxSignature: row.anchorTxSignature,
    })),
  }, null, 2));

  if (localServer) {
    await new Promise<void>((resolve) => localServer?.close(() => resolve()));
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: report.overallPass,
    baseUrl: report.baseUrl,
    cluster: report.cluster,
    mode: report.mode,
    fixturesBase: report.fixturesBase,
    readinessJsonPath,
    reportMdPath,
    receiptsPath,
    primitives: report.primitives.length,
    fastCount: report.invariants.fastCount,
    verifiedCount: report.invariants.verifiedCount,
  }, null, 2));

  if (!report.overallPass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
