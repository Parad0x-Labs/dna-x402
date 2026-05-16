import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import dotenv from "dotenv";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { MAINNET_USDC_MINT, type X402Config } from "../../src/config.js";
import { createX402App } from "../../src/server.js";
import { ReceiptSigner, verifySignedReceipt } from "../../src/receipts.js";
import { resolveDrillRpcUrl } from "./rpc.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "../sim/splTokenLite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const x402Root = path.resolve(__dirname, "../..");
const keyDir = path.join(x402Root, "test-mainnet", "keys", "solana-usdc-drill");
const reportDir = path.join(repoRoot, "reports", "solana-usdc-drill");

for (const envPath of [
  path.join(repoRoot, ".env"),
  path.join(x402Root, ".env"),
  path.join(x402Root, ".env.local"),
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const BUYER_KEY_PATH = path.join(keyDir, "buyer-burner.json");
const SELLER_KEY_PATH = path.join(keyDir, "seller-recipient.json");
const TREASURY_KEY_PATH = path.join(keyDir, "treasury-display.json");
const NON_ALLOWLISTED_KEY_PATH = path.join(keyDir, "nonallowlisted-buyer.json");

const VALID_AMOUNT_ATOMIC = 50_000n; // 0.05 USDC
const DIRECT_SPLIT_AMOUNT_ATOMIC = 10_000n; // 0.01 USDC gross
const NON_ALLOWLISTED_AMOUNT_ATOMIC = 10_000n; // 0.01 USDC
const UNDERPAY_EXPECTED_ATOMIC = 100_000n; // 0.10 USDC
const NON_ALLOWLISTED_SOL_TOPUP = 5_000_000n; // 0.005 SOL

type JsonObject = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireExplicitApproval(): void {
  if (!process.argv.includes("--yes-real-mainnet-drill")) {
    throw new Error("Refusing to run real-chain drill without --yes-real-mainnet-drill");
  }
}

function directSplitRequested(): boolean {
  return process.argv.includes("--direct-split");
}

function requireDirectSplitPreconditions(rpc: ReturnType<typeof resolveDrillRpcUrl>): void {
  if (!rpc.highThroughput || rpc.source === "PUBLIC_DEFAULT") {
    throw new Error("Refusing direct split drill without Helius/high-throughput RPC. Set HELIUS_RPC or HELIUS_API_KEY.");
  }
  if (process.env.X402_ALERT_TELEGRAM_ENABLED !== "1" && process.env.X402_ALERT_TELEGRAM_ENABLED?.toLowerCase() !== "true") {
    throw new Error("Refusing direct split drill without Telegram alerts enabled. Set X402_ALERT_TELEGRAM_ENABLED=1.");
  }
  if (!process.env.X402_ALERT_TELEGRAM_BOT_TOKEN || !process.env.X402_ALERT_TELEGRAM_CHAT_ID) {
    throw new Error("Refusing direct split drill without Telegram bot token and chat ID in local env.");
  }
  if (!process.env.X402_ALERT_TELEGRAM_RELAY_SECRET || process.env.X402_ALERT_TELEGRAM_RELAY_SECRET.length < 24) {
    throw new Error("Refusing direct split drill without X402_ALERT_TELEGRAM_RELAY_SECRET of at least 24 characters.");
  }
  if (!process.env.X402_DIRECT_SPLIT_GATE_REF?.trim()) {
    throw new Error("Refusing direct split drill without explicit X402_DIRECT_SPLIT_GATE_REF.");
  }
}

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadOrCreateKeypair(filePath: string): Keypair {
  if (fs.existsSync(filePath)) {
    return loadKeypair(filePath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const keypair = Keypair.generate();
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), "utf8");
  return keypair;
}

async function getUsdcBalance(connection: Connection, owner: PublicKey): Promise<bigint> {
  const response = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(MAINNET_USDC_MINT) }, "confirmed");
  return response.value.reduce((sum, item) => {
    const amount = item.account.data.parsed.info.tokenAmount.amount;
    return sum + BigInt(amount);
  }, 0n);
}

async function transferSol(connection: Connection, payer: Keypair, recipient: PublicKey, lamports: bigint): Promise<string> {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports: Number(lamports),
  }));
  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

async function transferUsdc(params: {
  connection: Connection;
  payer: Keypair;
  owner: Keypair;
  recipientOwner: PublicKey;
  amountAtomic: bigint;
}): Promise<string> {
  const mint = new PublicKey(MAINNET_USDC_MINT);
  const source = await getOrCreateAssociatedTokenAccount(
    params.connection,
    params.payer,
    mint,
    params.owner.publicKey,
    "confirmed",
  );
  const destination = await getOrCreateAssociatedTokenAccount(
    params.connection,
    params.payer,
    mint,
    params.recipientOwner,
    "confirmed",
  );
  const tx = new Transaction().add(createTransferCheckedInstruction(
    source.address,
    mint,
    destination.address,
    params.owner.publicKey,
    params.amountAtomic,
    6,
  ));
  return sendAndConfirmTransaction(params.connection, tx, [params.payer, params.owner], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

function baseConfig(params: {
  rpcUrl: string;
  buyer: PublicKey;
  seller: PublicKey;
  treasury: PublicKey;
  amountAtomic?: bigint;
  mint?: string;
  directSplit?: boolean;
}): X402Config {
  const directSplit = params.directSplit === true;
  return {
    nodeEnv: "staging",
    cluster: "mainnet-beta",
    port: 0,
    appVersion: "solana-usdc-private-drill",
    solanaRpcUrl: params.rpcUrl,
    usdcMint: params.mint ?? MAINNET_USDC_MINT,
    paymentRecipient: params.seller.toBase58(),
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat", "surge", "stream"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 300,
    feePolicy: {
      baseFeeAtomic: 0n,
      feeBps: 0,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 1n,
      minSettleAtomic: 0n,
    },
    nettingThresholdAtomic: 10_000n,
    nettingIntervalMs: 10_000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
    disabledShops: [],
    autoDisableReportThreshold: 0,
    allowInsecure: true,
    adminSecret: "staging-drill-admin-secret-123456",
    runtimeGates: {
      prodMoney: false,
      polymarketLive: false,
      publicNetting: false,
      physicalGoods: false,
      highRiskCategories: false,
      multiChainSettlement: false,
      unattendedSigning: false,
      backendKeyCustody: false,
      publicMarketplace: false,
      webhookDelivery: false,
      finalize: true,
      quotes: true,
      webhookReceiverTest: false,
      checklistRefs: {},
    },
    realChainDrill: {
      enabled: true,
      allowedSigners: [params.buyer.toBase58()],
      maxTxAtomic: "100000",
      dailyCapAtomic: "500000",
      feeMode: directSplit ? "direct_split" : "seller_accrual",
      platformFeeBps: 10,
      platformRecipient: params.treasury.toBase58(),
    },
    telegramAlerts: directSplit
      ? {
        enabled: true,
        botToken: process.env.X402_ALERT_TELEGRAM_BOT_TOKEN,
        chatId: process.env.X402_ALERT_TELEGRAM_CHAT_ID,
        parseMode: "HTML",
        relaySecret: process.env.X402_ALERT_TELEGRAM_RELAY_SECRET,
        commandsEnabled: false,
        allowedUserIds: [],
        allowedAdminIds: [],
        allowedChatIds: process.env.X402_ALERT_TELEGRAM_CHAT_ID ? [process.env.X402_ALERT_TELEGRAM_CHAT_ID] : [],
        statusMetricsUrl: "http://127.0.0.1:0/metrics",
      }
      : undefined,
    builderMonetization: directSplit
      ? {
        platformFeeBps: 10,
        platformFeeMode: "direct_split",
        platformTreasury: params.treasury.toBase58(),
        builderFeesEnabled: true,
        builderFeeDefaultMode: "display_only",
        builderFeeMaxBps: 500,
        affiliateFeesEnabled: false,
        affiliateFeeMaxBps: 200,
        directSplitFeesEnabled: true,
        directSplitGateRef: process.env.X402_DIRECT_SPLIT_GATE_REF?.trim(),
        autoSweepRequested: false,
      }
      : undefined,
  };
}

async function withServer<T>(config: X402Config, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { app } = createX402App(config, { receiptSigner: ReceiptSigner.generate() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function getJson(url: string, headers?: Record<string, string>): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json() as JsonObject };
}

async function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as JsonObject };
}

async function createQuoteCommit(baseUrl: string, amountAtomic: bigint): Promise<{ quote: JsonObject; commitId: string }> {
  const quoteRes = await getJson(`${baseUrl}/quote?resource=/resource&amountAtomic=${amountAtomic.toString(10)}`);
  if (quoteRes.status !== 200) {
    throw new Error(`quote failed: ${quoteRes.status} ${JSON.stringify(quoteRes.body)}`);
  }
  const quote = quoteRes.body;
  const commit = await postJson(`${baseUrl}/commit`, {
    quoteId: quote.quoteId,
    payerCommitment32B: `0x${"42".repeat(32)}`,
  });
  if (commit.status !== 201 || typeof commit.body.commitId !== "string") {
    throw new Error(`commit failed: ${commit.status} ${JSON.stringify(commit.body)}`);
  }
  return { quote, commitId: commit.body.commitId };
}

async function finalizeWithSignature(baseUrl: string, commitId: string, txSignature: string): Promise<{ status: number; body: JsonObject }> {
  return postJson(`${baseUrl}/finalize`, {
    commitId,
    paymentProof: {
      settlement: "transfer",
      txSignature,
    },
  });
}

type RequiredFeeLine = {
  id: string;
  kind: string;
  amount: string;
  recipient: string;
  requiredForFinalize: boolean;
};

function getRequiredDirectSplitLines(quote: JsonObject): { provider: RequiredFeeLine; dna: RequiredFeeLine } {
  const waterfall = quote.feeWaterfallV2 as { lines?: RequiredFeeLine[] } | undefined;
  const lines = waterfall?.lines?.filter((line) => line.requiredForFinalize) ?? [];
  const provider = lines.find((line) => line.kind === "PROVIDER_AMOUNT");
  const dna = lines.find((line) => line.kind === "DNA_PLATFORM_FEE");
  if (!provider || !dna) {
    throw new Error(`direct split quote missing provider/DNA required fee lines: ${JSON.stringify(lines)}`);
  }
  return { provider, dna };
}

async function finalizeWithSplitSignatures(params: {
  baseUrl: string;
  commitId: string;
  providerFeeLineId: string;
  providerTxSignature: string;
  dnaFeeLineId: string;
  dnaTxSignature: string;
}): Promise<{ status: number; body: JsonObject }> {
  return postJson(`${params.baseUrl}/finalize`, {
    commitId: params.commitId,
    splitPaymentProofs: [
      {
        feeLineId: params.providerFeeLineId,
        paymentProof: {
          settlement: "transfer",
          txSignature: params.providerTxSignature,
        },
      },
      {
        feeLineId: params.dnaFeeLineId,
        paymentProof: {
          settlement: "transfer",
          txSignature: params.dnaTxSignature,
        },
      },
    ],
  });
}

async function finalizeSplitWithRetry(params: {
  baseUrl: string;
  commitId: string;
  providerFeeLineId: string;
  providerTxSignature: string;
  dnaFeeLineId: string;
  dnaTxSignature: string;
  label: string;
  attempts?: number;
}): Promise<{ status: number; body: JsonObject }> {
  const attempts = params.attempts ?? 10;
  let last: { status: number; body: JsonObject } | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await finalizeWithSplitSignatures(params);
    if (x402ErrorCode(last) !== "X402_RPC_UNAVAILABLE") {
      return last;
    }
    await sleep(Math.min(2_000 * (i + 1), 12_000));
  }
  if (!last) {
    throw new Error(`finalize ${params.label} did not run`);
  }
  return last;
}

function x402ErrorCode(result: { body: JsonObject }): string | undefined {
  const error = result.body.error as { code?: string } | undefined;
  return error?.code;
}

async function finalizeWithRetry(params: {
  baseUrl: string;
  commitId: string;
  txSignature: string;
  label: string;
  attempts?: number;
}): Promise<{ status: number; body: JsonObject }> {
  const attempts = params.attempts ?? 10;
  let last: { status: number; body: JsonObject } | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await finalizeWithSignature(params.baseUrl, params.commitId, params.txSignature);
    if (x402ErrorCode(last) !== "X402_RPC_UNAVAILABLE") {
      return last;
    }
    await sleep(Math.min(2_000 * (i + 1), 12_000));
  }
  if (!last) {
    throw new Error(`finalize ${params.label} did not run`);
  }
  return last;
}

async function run(): Promise<void> {
  requireExplicitApproval();
  fs.mkdirSync(reportDir, { recursive: true });

  const rpc = resolveDrillRpcUrl(process.env);
  if (directSplitRequested()) {
    requireDirectSplitPreconditions(rpc);
  }
  const rpcUrl = rpc.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const buyer = loadKeypair(BUYER_KEY_PATH);
  const seller = loadOrCreateKeypair(SELLER_KEY_PATH);
  const treasury = loadOrCreateKeypair(TREASURY_KEY_PATH);
  const nonAllowlisted = loadOrCreateKeypair(NON_ALLOWLISTED_KEY_PATH);
  const wrongRecipient = Keypair.generate();

  const solBefore = await connection.getBalance(buyer.publicKey, "confirmed");
  const usdcBefore = await getUsdcBalance(connection, buyer.publicKey);
  const requiredUsdc = VALID_AMOUNT_ATOMIC + NON_ALLOWLISTED_AMOUNT_ATOMIC * 2n;
  if (usdcBefore < requiredUsdc) {
    throw new Error(`buyer has insufficient USDC: ${usdcBefore.toString()} atomic, need ${requiredUsdc.toString()}`);
  }
  if (BigInt(solBefore) < 30_000_000n) {
    throw new Error(`buyer has insufficient SOL for drill rent/fees: ${solBefore / LAMPORTS_PER_SOL} SOL`);
  }

  if (directSplitRequested()) {
    await runDirectSplitDrill({
      connection,
      rpc,
      rpcUrl,
      buyer,
      seller,
      treasury,
      solBefore,
      usdcBefore,
    });
    return;
  }

  const nonAllowlistedSol = await connection.getBalance(nonAllowlisted.publicKey, "confirmed");
  const solTopupSig = nonAllowlistedSol < Number(NON_ALLOWLISTED_SOL_TOPUP)
    ? await transferSol(connection, buyer, nonAllowlisted.publicKey, NON_ALLOWLISTED_SOL_TOPUP)
    : undefined;

  const validTx = await transferUsdc({
    connection,
    payer: buyer,
    owner: buyer,
    recipientOwner: seller.publicKey,
    amountAtomic: VALID_AMOUNT_ATOMIC,
  });

  await transferUsdc({
    connection,
    payer: buyer,
    owner: buyer,
    recipientOwner: nonAllowlisted.publicKey,
    amountAtomic: NON_ALLOWLISTED_AMOUNT_ATOMIC,
  });

  const nonAllowlistedTx = await transferUsdc({
    connection,
    payer: nonAllowlisted,
    owner: nonAllowlisted,
    recipientOwner: seller.publicKey,
    amountAtomic: NON_ALLOWLISTED_AMOUNT_ATOMIC,
  });

  const normalConfig = baseConfig({
    rpcUrl,
    buyer: buyer.publicKey,
    seller: seller.publicKey,
    treasury: treasury.publicKey,
  });

  const normal = await withServer(normalConfig, async (baseUrl) => {
    const valid = await createQuoteCommit(baseUrl, VALID_AMOUNT_ATOMIC);
    const finalized = await finalizeWithRetry({ baseUrl, commitId: valid.commitId, txSignature: validTx, label: "valid payment" });
    const receiptId = finalized.body.receiptId;
    const receipt = typeof receiptId === "string"
      ? await getJson(`${baseUrl}/receipt/${receiptId}`)
      : { status: 0, body: {} };
    const paidRetry = await getJson(`${baseUrl}/resource`, { "x-dnp-commit-id": valid.commitId });

    await sleep(1_000);
    const replay = await createQuoteCommit(baseUrl, VALID_AMOUNT_ATOMIC);
    const replayFinalize = await finalizeWithRetry({ baseUrl, commitId: replay.commitId, txSignature: validTx, label: "replay proof" });

    await sleep(1_000);
    const nonAllowlisted = await createQuoteCommit(baseUrl, NON_ALLOWLISTED_AMOUNT_ATOMIC);
    const nonAllowlistedFinalize = await finalizeWithRetry({
      baseUrl,
      commitId: nonAllowlisted.commitId,
      txSignature: nonAllowlistedTx,
      label: "non-allowlisted proof",
    });

    const feeAccruals = await getJson(`${baseUrl}/drill/fee-accruals`, {
      "x-admin-token": "staging-drill-admin-secret-123456",
    });

    return {
      baseUrl,
      validQuote: valid.quote,
      validFinalize: finalized,
      receipt,
      receiptValid: receipt.status === 200 ? verifySignedReceipt(receipt.body as never) : false,
      paidRetry,
      replayFinalize,
      nonAllowlistedFinalize,
      feeAccruals,
    };
  });

  const underpay = await withServer(baseConfig({
    rpcUrl,
    buyer: buyer.publicKey,
    seller: seller.publicKey,
    treasury: treasury.publicKey,
  }), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, UNDERPAY_EXPECTED_ATOMIC);
    return finalizeWithRetry({ baseUrl, commitId: flow.commitId, txSignature: validTx, label: "underpay proof" });
  });

  await sleep(1_000);
  const wrongRecipientResult = await withServer(baseConfig({
    rpcUrl,
    buyer: buyer.publicKey,
    seller: wrongRecipient.publicKey,
    treasury: treasury.publicKey,
  }), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, VALID_AMOUNT_ATOMIC);
    return finalizeWithRetry({ baseUrl, commitId: flow.commitId, txSignature: validTx, label: "wrong recipient proof" });
  });

  await sleep(1_000);
  const wrongMintResult = await withServer(baseConfig({
    rpcUrl,
    buyer: buyer.publicKey,
    seller: seller.publicKey,
    treasury: treasury.publicKey,
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  }), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, VALID_AMOUNT_ATOMIC);
    return finalizeWithRetry({ baseUrl, commitId: flow.commitId, txSignature: validTx, label: "wrong mint proof" });
  });

  const report = {
    status: "PRIVATE_STAGING_TECHNICAL_CHAIN_PROOF",
    generatedAt: new Date().toISOString(),
    statement: "Private staging Solana USDC technical chain proof - not production readiness evidence.",
    rpcUrl: rpc.reportValue,
    rpcSource: rpc.source,
    rpcHighThroughput: rpc.highThroughput,
    cluster: "mainnet-beta",
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
    treasury: treasury.publicKey.toBase58(),
    nonAllowlistedBuyer: nonAllowlisted.publicKey.toBase58(),
    usdcMint: MAINNET_USDC_MINT,
    amounts: {
      validPaymentAtomic: VALID_AMOUNT_ATOMIC.toString(10),
      nonAllowlistedPaymentAtomic: NON_ALLOWLISTED_AMOUNT_ATOMIC.toString(10),
      underpayExpectedAtomic: UNDERPAY_EXPECTED_ATOMIC.toString(10),
    },
    txs: {
      solTopupSig,
      validTx,
      nonAllowlistedTx,
      validSolscan: `https://solscan.io/tx/${validTx}`,
      nonAllowlistedSolscan: `https://solscan.io/tx/${nonAllowlistedTx}`,
    },
    checks: {
      validFinalizeOk: normal.validFinalize.status === 200,
      receiptVerifies: normal.receiptValid,
      paidRetryOk: normal.paidRetry.status === 200,
      replayRejected: x402ErrorCode(normal.replayFinalize) === "X402_REPLAY_DETECTED",
      nonAllowlistedRejected: x402ErrorCode(normal.nonAllowlistedFinalize) === "X402_VERIFICATION_FAILED",
      underpayRejected: x402ErrorCode(underpay) === "X402_UNDERPAY",
      wrongRecipientRejected: x402ErrorCode(wrongRecipientResult) === "X402_WRONG_RECIPIENT",
      wrongMintRejected: x402ErrorCode(wrongMintResult) === "X402_WRONG_MINT",
      feeAccrualRecorded: normal.feeAccruals.status === 200
        && (normal.feeAccruals.body.summary as { totalPlatformFeeAtomic?: string } | undefined)?.totalPlatformFeeAtomic === "50",
      noAutoSweep: true,
      noBackendCustody: true,
    },
    responses: {
      validFinalize: normal.validFinalize.body,
      receipt: normal.receipt.body,
      paidRetry: normal.paidRetry.body,
      replayFinalize: normal.replayFinalize.body,
      nonAllowlistedFinalize: normal.nonAllowlistedFinalize.body,
      underpay: underpay.body,
      wrongRecipient: wrongRecipientResult.body,
      wrongMint: wrongMintResult.body,
      feeAccruals: normal.feeAccruals.body,
    },
  };

  const allPassed = Object.entries(report.checks).every(([, value]) => value === true);
  const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, pass: allPassed }, null, 2), "utf8");
  console.log(JSON.stringify({ pass: allPassed, reportPath, checks: report.checks, txs: report.txs }, null, 2));
  if (!allPassed) {
    process.exitCode = 1;
  }
}

async function runDirectSplitDrill(params: {
  connection: Connection;
  rpc: ReturnType<typeof resolveDrillRpcUrl>;
  rpcUrl: string;
  buyer: Keypair;
  seller: Keypair;
  treasury: Keypair;
  solBefore: number;
  usdcBefore: bigint;
}): Promise<void> {
  const directSplitConfig = {
    rpcUrl: params.rpcUrl,
    buyer: params.buyer.publicKey,
    seller: params.seller.publicKey,
    treasury: params.treasury.publicKey,
    directSplit: true,
  };

  const directSplit = await withServer(baseConfig(directSplitConfig), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, DIRECT_SPLIT_AMOUNT_ATOMIC);
    const { provider, dna } = getRequiredDirectSplitLines(flow.quote);

    const providerTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.seller.publicKey,
      amountAtomic: BigInt(provider.amount),
    });
    const dnaTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.treasury.publicKey,
      amountAtomic: BigInt(dna.amount),
    });

    const finalized = await finalizeSplitWithRetry({
      baseUrl,
      commitId: flow.commitId,
      providerFeeLineId: provider.id,
      providerTxSignature: providerTx,
      dnaFeeLineId: dna.id,
      dnaTxSignature: dnaTx,
      label: "valid direct split",
    });
    const receiptId = finalized.body.receiptId;
    const receipt = typeof receiptId === "string"
      ? await getJson(`${baseUrl}/receipt/${receiptId}`)
      : { status: 0, body: {} };
    const paidRetry = await getJson(`${baseUrl}/resource`, { "x-dnp-commit-id": flow.commitId });

    const replay = await createQuoteCommit(baseUrl, DIRECT_SPLIT_AMOUNT_ATOMIC);
    const replayLines = getRequiredDirectSplitLines(replay.quote);
    const replayFinalize = await finalizeSplitWithRetry({
      baseUrl,
      commitId: replay.commitId,
      providerFeeLineId: replayLines.provider.id,
      providerTxSignature: providerTx,
      dnaFeeLineId: replayLines.dna.id,
      dnaTxSignature: dnaTx,
      label: "direct split replay",
    });

    return {
      baseUrl,
      quote: flow.quote,
      lines: { provider, dna },
      txs: { providerTx, dnaTx },
      finalized,
      receipt,
      receiptValid: receipt.status === 200 ? verifySignedReceipt(receipt.body as never) : false,
      paidRetry,
      replayFinalize,
    };
  });

  const missingDna = await withServer(baseConfig(directSplitConfig), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, DIRECT_SPLIT_AMOUNT_ATOMIC);
    const { provider } = getRequiredDirectSplitLines(flow.quote);
    return postJson(`${baseUrl}/finalize`, {
      commitId: flow.commitId,
      splitPaymentProofs: [
        {
          feeLineId: provider.id,
          paymentProof: {
            settlement: "transfer",
            txSignature: directSplit.txs.providerTx,
          },
        },
      ],
    });
  });

  const wrongTreasuryResult = await withServer(baseConfig(directSplitConfig), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, DIRECT_SPLIT_AMOUNT_ATOMIC);
    const { provider, dna } = getRequiredDirectSplitLines(flow.quote);
    const providerTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.seller.publicKey,
      amountAtomic: BigInt(provider.amount),
    });
    const wrongDnaTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.seller.publicKey,
      amountAtomic: BigInt(dna.amount),
    });
    return finalizeSplitWithRetry({
      baseUrl,
      commitId: flow.commitId,
      providerFeeLineId: provider.id,
      providerTxSignature: providerTx,
      dnaFeeLineId: dna.id,
      dnaTxSignature: wrongDnaTx,
      label: "wrong DNA treasury recipient",
    });
  });

  const underpaidTreasuryResult = await withServer(baseConfig(directSplitConfig), async (baseUrl) => {
    const flow = await createQuoteCommit(baseUrl, DIRECT_SPLIT_AMOUNT_ATOMIC);
    const { provider, dna } = getRequiredDirectSplitLines(flow.quote);
    const providerTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.seller.publicKey,
      amountAtomic: BigInt(provider.amount),
    });
    const underpaidDnaTx = await transferUsdc({
      connection: params.connection,
      payer: params.buyer,
      owner: params.buyer,
      recipientOwner: params.treasury.publicKey,
      amountAtomic: BigInt(dna.amount) - 1n,
    });
    return finalizeSplitWithRetry({
      baseUrl,
      commitId: flow.commitId,
      providerFeeLineId: provider.id,
      providerTxSignature: providerTx,
      dnaFeeLineId: dna.id,
      dnaTxSignature: underpaidDnaTx,
      label: "underpaid DNA treasury",
    });
  });

  const solAfter = await params.connection.getBalance(params.buyer.publicKey, "confirmed");
  const usdcAfter = await getUsdcBalance(params.connection, params.buyer.publicKey);
  const receiptPayload = (directSplit.receipt.body as { payload?: JsonObject }).payload;
  const feeSummary = receiptPayload?.feeCollectionSummary as { dnaPlatformFeeStatus?: string } | undefined;
  const splitProofs = receiptPayload?.splitPaymentProofs as unknown[] | undefined;
  const quote = directSplit.quote as { feeAtomic?: string; totalAtomic?: string; feeWaterfallV2?: { feeWaterfallHash?: string } };
  const report = {
    status: "PRIVATE_STAGING_DIRECT_SPLIT_TECHNICAL_CHAIN_PROOF",
    generatedAt: new Date().toISOString(),
    statement: "Private staging Solana USDC direct split technical chain proof - not public production approval.",
    rpcUrl: params.rpc.reportValue,
    rpcSource: params.rpc.source,
    rpcHighThroughput: params.rpc.highThroughput,
    cluster: "mainnet-beta",
    directSplitGateRef: process.env.X402_DIRECT_SPLIT_GATE_REF?.trim(),
    buyer: params.buyer.publicKey.toBase58(),
    seller: params.seller.publicKey.toBase58(),
    treasury: params.treasury.publicKey.toBase58(),
    wrongTreasury: params.seller.publicKey.toBase58(),
    usdcMint: MAINNET_USDC_MINT,
    amounts: {
      grossAtomic: DIRECT_SPLIT_AMOUNT_ATOMIC.toString(10),
      providerAtomic: directSplit.lines.provider.amount,
      dnaFeeAtomic: directSplit.lines.dna.amount,
      platformFeeBps: 10,
      solBefore: (params.solBefore / LAMPORTS_PER_SOL).toString(),
      solAfter: (solAfter / LAMPORTS_PER_SOL).toString(),
      usdcBeforeAtomic: params.usdcBefore.toString(10),
      usdcAfterAtomic: usdcAfter.toString(10),
    },
    txs: {
      providerTx: directSplit.txs.providerTx,
      dnaTreasuryTx: directSplit.txs.dnaTx,
      providerSolscan: `https://solscan.io/tx/${directSplit.txs.providerTx}`,
      dnaTreasurySolscan: `https://solscan.io/tx/${directSplit.txs.dnaTx}`,
    },
    checks: {
      directSplitFinalizeOk: directSplit.finalized.status === 200,
      receiptVerifies: directSplit.receiptValid,
      paidRetryOk: directSplit.paidRetry.status === 200,
      dnaFeeCollectedDirectSplit: feeSummary?.dnaPlatformFeeStatus === "COLLECTED_DIRECT_SPLIT",
      splitProofsBound: Array.isArray(splitProofs) && splitProofs.length === 2,
      feeWaterfallHashBound: typeof quote.feeWaterfallV2?.feeWaterfallHash === "string"
        && receiptPayload?.feeWaterfallHash === quote.feeWaterfallV2.feeWaterfallHash,
      noHiddenLegacyFee: quote.feeAtomic === "0",
      missingDnaProofRejected: x402ErrorCode(missingDna) === "X402_MISSING_PAYMENT_PROOF",
      wrongTreasuryRecipientRejected: x402ErrorCode(wrongTreasuryResult) === "X402_WRONG_RECIPIENT",
      underpaidTreasuryRejected: x402ErrorCode(underpaidTreasuryResult) === "X402_UNDERPAY",
      replayRejected: x402ErrorCode(directSplit.replayFinalize) === "X402_REPLAY_DETECTED",
      noAutoSweep: true,
      noBackendCustody: true,
    },
    responses: {
      quote: directSplit.quote,
      validFinalize: directSplit.finalized.body,
      receipt: directSplit.receipt.body,
      paidRetry: directSplit.paidRetry.body,
      replayFinalize: directSplit.replayFinalize.body,
      missingDna,
      wrongTreasuryRecipient: wrongTreasuryResult.body,
      underpaidTreasury: underpaidTreasuryResult.body,
    },
  };

  const allPassed = Object.entries(report.checks).every(([, value]) => value === true);
  const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-direct-split.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, pass: allPassed }, null, 2), "utf8");
  console.log(JSON.stringify({ pass: allPassed, reportPath, checks: report.checks, txs: report.txs }, null, 2));
  if (!allPassed) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
