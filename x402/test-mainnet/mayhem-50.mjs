#!/usr/bin/env node
/**
 * DNA x402 50-agent mainnet mayhem proof.
 *
 * This script is intentionally fail-closed. It refuses to pass if any tx
 * signature is fake, unconfirmed, missing from a report link, or if burner
 * funds remain after recovery.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "./spl-token-lite.mjs";
import {
  DEFAULT_MAINNET_RPC,
  MAINNET_USDC_MINT,
  assertNoBrokenSolscanLinks,
  assertPublicKey,
  assertWorkspacePath,
  boolEnv,
  confirmSignatures,
  defaultKeysDir,
  isBase58Signature,
  loadKeypair,
  shortBase58,
  writeJsonFile,
  writeKeypairIfMissing,
} from "./proof-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.X402_BASE_URL || "http://127.0.0.1:8080";
const KEYS_DIR = assertWorkspacePath(process.env.MAINNET_KEYS_DIR || defaultKeysDir("mainnet"));
const MAYHEM_KEYS_DIR = assertWorkspacePath(path.join(KEYS_DIR, "mayhem-agents"));
const DEPLOYER_KP_PATH = assertWorkspacePath(
  process.env.MAINNET_DEPLOYER_KEYPAIR || path.join(KEYS_DIR, "deployer.json"),
);
const REPORT_DIR = assertWorkspacePath(process.env.MAYHEM_REPORT_DIR || __dirname);
const REPORT_PATH = assertWorkspacePath(path.join(REPORT_DIR, "MAYHEM_50_REPORT.md"));
const DATA_PATH = assertWorkspacePath(path.join(REPORT_DIR, "MAYHEM_50_DATA.json"));
const CHECKPOINT_PATH = assertWorkspacePath(path.join(REPORT_DIR, "MAYHEM_50_CHECKPOINT.json"));
const FUNDING_REQUIRED_PATH = assertWorkspacePath(path.join(KEYS_DIR, "MAINNET_FUNDING_REQUIRED.json"));
const RPC_URL = process.env.HELIUS_RPC || process.env.SOLANA_RPC_URL || DEFAULT_MAINNET_RPC;
const REQUIRE_MAINNET = boolEnv("REQUIRE_MAINNET", true);
const REQUIRE_ANCHORING = boolEnv("REQUIRE_ANCHORING", true);
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const MIN_SOL_LAMPORTS = 250_000_000n;
const MIN_ANCHOR_SOL_LAMPORTS = 50_000_000n;
const MIN_USDC_ATOMIC = 6_000_000n;
const TRANSFER_AGENT_SOL_LAMPORTS = 3_000_000n;
const SOL_DUST_LAMPORTS = 5_000n;
const USDC_MINT = new PublicKey(MAINNET_USDC_MINT);
const RPC_RETRY_ATTEMPTS = Number(process.env.MAINNET_RPC_RETRY_ATTEMPTS ?? "12");
const RPC_THROTTLE_MS = Number(process.env.MAINNET_RPC_THROTTLE_MS ?? (RPC_URL.includes("api.mainnet-beta.solana.com") ? "1250" : "250"));
const EXPECT_NETTING_REJECTION = boolEnv("EXPECT_NETTING_REJECTION", REQUIRE_MAINNET);
const EXPECTED_NETTING_PROBES = 60;
const EXPECTED_TRANSFER_TRADES = 20;

const conn = new Connection(RPC_URL, "confirmed");
const deployerKp = writeKeypairIfMissing(DEPLOYER_KP_PATH);
const DEPLOYER = deployerKp.publicKey;
const ANCHORING_KP_PATH = process.env.ANCHORING_KEYPAIR_PATH
  ? assertWorkspacePath(process.env.ANCHORING_KEYPAIR_PATH)
  : null;
const anchoringKp = ANCHORING_KP_PATH ? loadKeypair(ANCHORING_KP_PATH) : null;
const ANCHOR_PAYER = anchoringKp?.publicKey ?? null;

const results = [];
let passCount = 0;
let failCount = 0;
const txSignatures = { funding: [], transfers: [], drains: [], anchors: [] };
const allAgents = [];

function checkpoint(stage, extra = {}) {
  writeJsonFile(CHECKPOINT_PATH, {
    timestamp: new Date().toISOString(),
    stage,
    deployer: DEPLOYER.toBase58(),
    passCount,
    failCount,
    txSignatures,
    results,
    ...extra,
  });
}

const TIERS = [
  { name: "nano", atomic: "10", usdcHuman: "$0.00001" },
  { name: "nano+", atomic: "50", usdcHuman: "$0.00005" },
  { name: "micro", atomic: "100", usdcHuman: "$0.0001" },
  { name: "micro+", atomic: "500", usdcHuman: "$0.0005" },
  { name: "milli", atomic: "1000", usdcHuman: "$0.001" },
  { name: "milli+", atomic: "5000", usdcHuman: "$0.005" },
  { name: "centi", atomic: "10000", usdcHuman: "$0.01" },
  { name: "deci", atomic: "100000", usdcHuman: "$0.10" },
  { name: "unit", atomic: "1000000", usdcHuman: "$1.00" },
  { name: "multi", atomic: "2000000", usdcHuman: "$2.00" },
];
const RESOURCES = ["/resource", "/inference", "/stream-access"];

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function record(test, status, details = {}) {
  const { status: httpStatus, ...safeDetails } = details;
  const entry = {
    test,
    status,
    ts: new Date().toISOString(),
    ...(httpStatus === undefined ? safeDetails : { ...safeDetails, httpStatus }),
  };
  results.push(entry);
  if (status === "PASS") {
    passCount += 1;
  } else {
    failCount += 1;
  }
  checkpoint(`record:${test}`);
  log(`${status === "PASS" ? "PASS" : "FAIL"} ${test}`);
}

function random32B() {
  return crypto.randomBytes(32).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|timeout|econnreset|fetch failed|socket|websocket/i.test(message);
}

async function withRpcRetry(label, fn, attempts = RPC_RETRY_ATTEMPTS) {
  let delayMs = 750;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await fn();
      if (RPC_THROTTLE_MS > 0) {
        await sleep(RPC_THROTTLE_MS);
      }
      return value;
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }
      log(`RPC retry ${attempt}/${attempts} for ${label}: ${String(error).slice(0, 160)}`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 12_000);
    }
  }
  throw new Error(`RPC retry exhausted for ${label}`);
}

async function accountInfo(pubkey, label) {
  return withRpcRetry(label, () => conn.getAccountInfo(pubkey, "confirmed"));
}

async function solBalance(pubkey, label) {
  return BigInt(await withRpcRetry(label, () => conn.getBalance(pubkey, "confirmed")));
}

async function sendTx(label, tx, signers) {
  let delayMs = 1_000;
  for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const latest = await withRpcRetry(`${label} latest blockhash`, () => conn.getLatestBlockhash("confirmed"));
      tx.feePayer = signers[0].publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(...signers);
      const signature = await withRpcRetry(`${label} send`, () => conn.sendRawTransaction(tx.serialize(), {
        maxRetries: 5,
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }));
      await confirmSignatures(conn, [signature], label, { timeoutMs: 180_000 });
      checkpoint(`tx:${label}`, { signature });
      return signature;
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt === RPC_RETRY_ATTEMPTS) {
        throw error;
      }
      log(`TX retry ${attempt}/${RPC_RETRY_ATTEMPTS} for ${label}: ${String(error).slice(0, 160)}`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 15_000);
    }
  }
  throw new Error(`transaction retry exhausted for ${label}`);
}

async function api(method, endpoint, body) {
  const headers = { "Content-Type": "application/json" };
  if (ADMIN_SECRET) {
    headers["x-admin-token"] = ADMIN_SECRET;
  }
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, ok: response.ok };
}

async function tokenBalance(ata) {
  try {
    return await withRpcRetry(`token balance ${ata.toBase58()}`, async () => (await getAccount(conn, ata)).amount);
  } catch {
    return 0n;
  }
}

async function ensureAta(owner, payer, signer) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  const account = await accountInfo(ata, `ATA lookup ${ata.toBase58()}`);
  if (!account) {
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(payer, ata, owner, USDC_MINT));
    const sig = await sendTx(`create ATA ${ata.toBase58()}`, tx, [signer]);
    txSignatures.funding.push(sig);
    checkpoint("funding:create-ata", { signature: sig, ata: ata.toBase58() });
  }
  return ata;
}

function loadOrCreateAgent(role, index) {
  const name = `${role}-${String(index).padStart(2, "0")}`;
  const keyPath = path.join(MAYHEM_KEYS_DIR, `${name}.json`);
  const keypair = writeKeypairIfMissing(keyPath);
  return {
    id: index,
    role,
    name,
    keypair,
    keyPath,
    pubkey: keypair.publicKey.toBase58(),
    ata: null,
    funded: false,
  };
}

function createAgents(role, count) {
  log(`Loading ${count} persisted ${role} agent keypairs under ${MAYHEM_KEYS_DIR}`);
  return Array.from({ length: count }, (_, i) => loadOrCreateAgent(role, i + 1));
}

async function writeFundingRequired(reason) {
  const deployerAta = await getAssociatedTokenAddress(USDC_MINT, DEPLOYER);
  writeJsonFile(FUNDING_REQUIRED_PATH, {
    generatedAt: new Date().toISOString(),
    reason,
    deployerPubkey: DEPLOYER.toBase58(),
    deployerKeypairPath: DEPLOYER_KP_PATH,
    anchorPayerPubkey: ANCHOR_PAYER?.toBase58() ?? null,
    anchoringKeypairPath: ANCHORING_KP_PATH,
    usdcMint: MAINNET_USDC_MINT,
    deployerUsdcAta: deployerAta.toBase58(),
    requiredMinimum: {
      solLamports: MIN_SOL_LAMPORTS.toString(),
      sol: "0.25",
      anchorSolLamports: MIN_ANCHOR_SOL_LAMPORTS.toString(),
      anchorSol: "0.05",
      usdcAtomic: MIN_USDC_ATOMIC.toString(),
      usdc: "6.0",
    },
  });
}

async function preflightMainnetFunds() {
  if (!ADMIN_SECRET) {
    throw new Error("ADMIN_SECRET is required for authenticated /settlements/flush and /admin proof checks");
  }
  if (!process.env.HELIUS_RPC && !process.env.SOLANA_RPC_URL) {
    throw new Error("Set SOLANA_RPC_URL or HELIUS_RPC before running mainnet proof; public RPC is not acceptable for a release gate.");
  }

  const health = await api("GET", "/health");
  if (!health.ok) {
    throw new Error(`server health check failed: ${health.status} ${JSON.stringify(health.json)}`);
  }
  if (REQUIRE_MAINNET) {
    const issues = [];
    if (health.json?.cluster !== "solana-mainnet") issues.push(`health.cluster=${health.json?.cluster}`);
    if (health.json?.mint !== MAINNET_USDC_MINT) issues.push(`health.mint=${health.json?.mint}`);
    if (health.json?.recipient !== DEPLOYER.toBase58() && !boolEnv("ALLOW_EXTERNAL_RECIPIENT", false)) {
      issues.push(`health.recipient must equal deployer ${DEPLOYER.toBase58()} for recoverable mayhem`);
    }
    if (health.json?.runtime?.auditFixturesEnabled) issues.push("AUDIT_FIXTURES enabled");
    if (health.json?.runtime?.gauntletMode) issues.push("GAUNTLET_MODE enabled");
    if (REQUIRE_ANCHORING && !health.json?.anchoring?.enabled) issues.push("anchoring disabled");
    if (issues.length > 0) {
      throw new Error(`server is not in mainnet proof mode: ${issues.join("; ")}`);
    }
  }

  const deployerSol = await solBalance(DEPLOYER, `deployer SOL balance ${DEPLOYER.toBase58()}`);
  const deployerAta = await getAssociatedTokenAddress(USDC_MINT, DEPLOYER);
  const deployerUsdc = await tokenBalance(deployerAta);
  const missing = [];
  if (deployerSol < MIN_SOL_LAMPORTS) {
    missing.push(`SOL ${Number(deployerSol) / LAMPORTS_PER_SOL} < 0.25`);
  }
  if (deployerUsdc < MIN_USDC_ATOMIC) {
    missing.push(`USDC ${Number(deployerUsdc) / 1_000_000} < 6.0`);
  }
  let anchorSol = 0n;
  if (REQUIRE_ANCHORING) {
    if (!ANCHOR_PAYER) {
      missing.push("ANCHORING_KEYPAIR_PATH is required when anchoring is required");
    } else {
      anchorSol = ANCHOR_PAYER.equals(DEPLOYER)
        ? deployerSol
        : await solBalance(ANCHOR_PAYER, `anchor payer SOL balance ${ANCHOR_PAYER.toBase58()}`);
      if (anchorSol < MIN_ANCHOR_SOL_LAMPORTS) {
        missing.push(`anchor payer SOL ${Number(anchorSol) / LAMPORTS_PER_SOL} < 0.05`);
      }
    }
  }
  if (missing.length > 0) {
    await writeFundingRequired(missing.join("; "));
    throw new Error(`mainnet deployer funding is insufficient: ${missing.join("; ")}. Funding instructions: ${FUNDING_REQUIRED_PATH}`);
  }

  record("PREFLIGHT", "PASS", {
    deployer: DEPLOYER.toBase58(),
    sol: (Number(deployerSol) / LAMPORTS_PER_SOL).toFixed(9),
    usdc: (Number(deployerUsdc) / 1_000_000).toFixed(6),
    anchorPayer: ANCHOR_PAYER?.toBase58(),
    anchorPayerSol: (Number(anchorSol) / LAMPORTS_PER_SOL).toFixed(9),
  });
  return health.json;
}

function formatAtomic(value, decimals) {
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatSignedDelta(before, after, decimals) {
  const delta = BigInt(after) - BigInt(before);
  const sign = delta < 0n ? "-" : "+";
  const absolute = delta < 0n ? -delta : delta;
  return `${sign}${formatAtomic(absolute, decimals)}`;
}

async function deployerBalanceSnapshot(label) {
  const solLamports = await solBalance(DEPLOYER, `deployer SOL balance ${DEPLOYER.toBase58()}`);
  const usdcAta = await getAssociatedTokenAddress(USDC_MINT, DEPLOYER);
  const usdcAtomic = await tokenBalance(usdcAta);
  return {
    label,
    capturedAt: new Date().toISOString(),
    pubkey: DEPLOYER.toBase58(),
    solLamports: solLamports.toString(),
    sol: formatAtomic(solLamports, 9),
    usdcAta: usdcAta.toBase58(),
    usdcAtomic: usdcAtomic.toString(),
    usdc: formatAtomic(usdcAtomic, 6),
  };
}

async function fundSol(agents, lamportsEach) {
  log(`Funding ${agents.length} transfer agents to ${Number(lamportsEach) / LAMPORTS_PER_SOL} SOL each`);
  for (const agent of agents) {
    const current = await solBalance(agent.keypair.publicKey, `${agent.name} SOL balance`);
    if (current >= lamportsEach) {
      continue;
    }
    const topup = lamportsEach - current;
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: DEPLOYER,
      toPubkey: agent.keypair.publicKey,
      lamports: Number(topup),
    }));
    const sig = await sendTx(`fund SOL ${agent.name}`, tx, [deployerKp]);
    txSignatures.funding.push(sig);
    checkpoint("funding:sol", { agent: agent.name, signature: sig });
    log(`  SOL funded ${agent.name}: ${shortBase58(sig)}`);
  }
}

async function fundUsdc(agents, amountsAtomic) {
  log(`Creating/using USDC ATAs and funding ${agents.length} transfer agents`);
  const deployerAta = await ensureAta(DEPLOYER, DEPLOYER, deployerKp);

  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    const targetAmount = BigInt(amountsAtomic[i % amountsAtomic.length]);
    const ata = await getAssociatedTokenAddress(USDC_MINT, agent.keypair.publicKey);
    agent.ata = ata.toBase58();

    const tx = new Transaction();
    const ataInfo = await accountInfo(ata, `${agent.name} ATA lookup`);
    if (!ataInfo) {
      tx.add(createAssociatedTokenAccountInstruction(DEPLOYER, ata, agent.keypair.publicKey, USDC_MINT));
    }
    const current = await tokenBalance(ata);
    if (current < targetAmount) {
      tx.add(createTransferInstruction(deployerAta, ata, DEPLOYER, targetAmount - current));
    }
    if (tx.instructions.length === 0) {
      agent.funded = true;
      continue;
    }
    const sig = await sendTx(`fund USDC ${agent.name}`, tx, [deployerKp]);
    txSignatures.funding.push(sig);
    agent.funded = true;
    checkpoint("funding:usdc", { agent: agent.name, signature: sig });
    log(`  USDC funded ${agent.name}: ${targetAmount} atomic, tx ${shortBase58(sig)}`);
  }
}

async function nettingPayment(agentName, resource, amountAtomic, tier) {
  const commitment = random32B();
  const prefix = `${agentName}/${tier}/${resource}`;

  const quote = await api("GET", `/quote?resource=${encodeURIComponent(resource)}&amountAtomic=${amountAtomic}`);
  if (!quote.ok) {
    record(`${prefix}/quote`, "FAIL", { response: quote.json });
    return null;
  }

  const commit = await api("POST", "/commit", {
    quoteId: quote.json.quoteId,
    payerCommitment32B: commitment,
  });
  if (commit.status !== 201) {
    record(`${prefix}/commit`, "FAIL", { response: commit.json });
    return null;
  }

  const finalize = await api("POST", "/finalize", {
    commitId: commit.json.commitId,
    paymentProof: { settlement: "netting", amountAtomic, note: `${agentName} ${tier}` },
  });
  if (!finalize.ok) {
    if (EXPECT_NETTING_REJECTION && /unsupported settlement mode: netting/i.test(String(finalize.json?.error ?? ""))) {
      record(`${prefix}/netting-rejected`, "PASS", { reason: finalize.json?.error });
      return {
        quoteId: quote.json.quoteId,
        commitId: commit.json.commitId,
        settlement: "netting-rejected",
        amount: amountAtomic,
        tier,
        resource,
        agent: agentName,
        rejected: true,
        reason: finalize.json?.error,
      };
    }
    record(`${prefix}/finalize`, "FAIL", { response: finalize.json });
    return null;
  }

  record(`${prefix}/netting`, "PASS", { receiptId: finalize.json.receiptId, amount: amountAtomic });
  return {
    quoteId: quote.json.quoteId,
    commitId: commit.json.commitId,
    receiptId: finalize.json.receiptId,
    settlement: "netting",
    amount: amountAtomic,
    tier,
    resource,
    agent: agentName,
  };
}

async function transferPayment(agent, resource, tier) {
  const prefix = `${agent.name}/${tier}/${resource}`;
  const quote = await api("GET", `/quote?resource=${encodeURIComponent(resource)}`);
  if (!quote.ok) {
    record(`${prefix}/quote`, "FAIL", { response: quote.json });
    return null;
  }

  const totalAtomic = quote.json.totalAtomic || quote.json.amount;
  const commit = await api("POST", "/commit", {
    quoteId: quote.json.quoteId,
    payerCommitment32B: random32B(),
  });
  if (commit.status !== 201) {
    record(`${prefix}/commit`, "FAIL", { response: commit.json });
    return null;
  }

  const recipientPubkey = assertPublicKey(quote.json.recipient, "quote.recipient");
  const recipientAta = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);
  const senderAta = await getAssociatedTokenAddress(USDC_MINT, agent.keypair.publicKey);
  const tx = new Transaction().add(
    createTransferInstruction(senderAta, recipientAta, agent.keypair.publicKey, BigInt(totalAtomic)),
  );

  let txSig;
  try {
    txSig = await sendTx(`USDC payment ${agent.name}`, tx, [agent.keypair]);
  } catch (error) {
    record(`${prefix}/transfer-tx`, "FAIL", { error: String(error).slice(0, 180) });
    return null;
  }
  txSignatures.transfers.push(txSig);
  checkpoint("transfer:payment", { agent: agent.name, signature: txSig });
  log(`  USDC transfer ${agent.name}: ${shortBase58(txSig)} total=${totalAtomic}`);

  await sleep(2_000);
  let finalize = await api("POST", "/finalize", {
    commitId: commit.json.commitId,
    paymentProof: { settlement: "transfer", txSignature: txSig, amountAtomic: totalAtomic },
  });

  if (!finalize.ok && finalize.json?.error?.code === "X402_NOT_CONFIRMED_YET") {
    await sleep(5_000);
    finalize = await api("POST", "/finalize", {
      commitId: commit.json.commitId,
      paymentProof: { settlement: "transfer", txSignature: txSig, amountAtomic: totalAtomic },
    });
  }

  if (!finalize.ok) {
    record(`${prefix}/finalize`, "FAIL", { response: finalize.json });
    return null;
  }

  record(`${prefix}/transfer`, "PASS", {
    receiptId: finalize.json.receiptId,
    txSig: shortBase58(txSig),
    amount: totalAtomic,
  });
  return {
    quoteId: quote.json.quoteId,
    commitId: commit.json.commitId,
    receiptId: finalize.json.receiptId,
    settlement: "transfer",
    txSignature: txSig,
    amount: totalAtomic,
    tier,
    resource,
    agent: agent.name,
  };
}

async function waitForAnchors(receiptIds) {
  if (!REQUIRE_ANCHORING) {
    record("ANCHORING", "PASS", { required: false, total: receiptIds.length });
    return [];
  }

  log(`Waiting for ${receiptIds.length} receipt anchors`);
  const deadline = Date.now() + 10 * 60_000;
  const anchoredByReceipt = new Map();
  while (Date.now() < deadline && anchoredByReceipt.size < receiptIds.length) {
    for (const receiptId of receiptIds) {
      if (anchoredByReceipt.has(receiptId)) {
        continue;
      }
      const response = await api("GET", `/anchoring/receipt/${receiptId}`);
      const recordPayload = response.json?.anchored;
      const signature = recordPayload?.signature ?? recordPayload?.txSignature;
      if (response.ok && response.json?.ok && isBase58Signature(signature)) {
        anchoredByReceipt.set(receiptId, { receiptId, ...recordPayload, signature });
      }
    }
    if (anchoredByReceipt.size < receiptIds.length) {
      await sleep(5_000);
    }
  }

  const anchored = Array.from(anchoredByReceipt.values());
  const uniqueAnchorSignatures = Array.from(new Set(anchored.map((row) => row.signature)));
  txSignatures.anchors.push(...uniqueAnchorSignatures);
  if (anchored.length !== receiptIds.length) {
    record("ANCHORING", "FAIL", { anchored: anchored.length, total: receiptIds.length });
    return anchored;
  }

  await confirmSignatures(conn, uniqueAnchorSignatures, "anchor signatures", { timeoutMs: 180_000 });
  record("ANCHORING", "PASS", {
    anchored: anchored.length,
    total: receiptIds.length,
    anchorTxs: uniqueAnchorSignatures.length,
  });
  return anchored;
}

async function flushNetting() {
  const flush = await api("POST", "/settlements/flush", {});
  record("FLUSH", flush.ok ? "PASS" : "FAIL", {
    batches: flush.json?.batches?.length ?? 0,
    response: flush.ok ? undefined : flush.json,
  });
  return flush;
}

async function drainUsdcAndClose(agents) {
  log("Draining USDC and closing transfer-agent ATAs back to deployer");
  const deployerAta = await getAssociatedTokenAddress(USDC_MINT, DEPLOYER);

  for (const agent of agents) {
    if (!agent.ata) {
      continue;
    }
    const senderAta = new PublicKey(agent.ata);
    const info = await accountInfo(senderAta, `${agent.name} ATA lookup for drain`);
    if (!info) {
      continue;
    }
    const amount = await tokenBalance(senderAta);
    const tx = new Transaction();
    if (amount > 0n) {
      tx.add(createTransferInstruction(senderAta, deployerAta, agent.keypair.publicKey, amount));
    }
    tx.add(createCloseAccountInstruction(senderAta, DEPLOYER, agent.keypair.publicKey));
    const sig = await sendTx(`drain USDC ${agent.name}`, tx, [agent.keypair]);
    txSignatures.drains.push(sig);
    checkpoint("drain:usdc", { agent: agent.name, signature: sig });
    log(`  Drained/closed ${agent.name}: usdc=${amount}, tx ${shortBase58(sig)}`);
  }
}

async function drainSol(agents) {
  log("Draining transfer-agent SOL back to deployer");
  for (const agent of agents) {
    const balance = await solBalance(agent.keypair.publicKey, `${agent.name} SOL balance for drain`);
    if (balance <= SOL_DUST_LAMPORTS + 5_000n) {
      continue;
    }
    const lamports = balance - SOL_DUST_LAMPORTS;
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: agent.keypair.publicKey,
      toPubkey: DEPLOYER,
      lamports: Number(lamports),
    }));
    const sig = await sendTx(`drain SOL ${agent.name}`, tx, [agent.keypair]);
    txSignatures.drains.push(sig);
    checkpoint("drain:sol", { agent: agent.name, signature: sig });
  }
}

async function verifyDrain(agents) {
  const failures = [];
  const residuals = [];
  for (const agent of agents) {
    const sol = await solBalance(agent.keypair.publicKey, `${agent.name} residual SOL balance`);
    const residual = {
      name: agent.name,
      pubkey: agent.pubkey,
      solLamports: sol.toString(),
      ataOpen: false,
      usdcAtomic: "0",
    };
    if (sol > SOL_DUST_LAMPORTS) {
      failures.push(`${agent.name} SOL ${sol.toString()}`);
    }
    if (agent.ata) {
      const ataInfo = await accountInfo(new PublicKey(agent.ata), `${agent.name} residual ATA lookup`);
      if (ataInfo) {
        const amount = await tokenBalance(new PublicKey(agent.ata));
        residual.ataOpen = true;
        residual.usdcAtomic = amount.toString();
        failures.push(`${agent.name} ATA still open amount=${amount.toString()}`);
      }
    }
    residuals.push(residual);
  }
  record("DRAIN_CHECK", failures.length === 0 ? "PASS" : "FAIL", {
    dustLamports: SOL_DUST_LAMPORTS.toString(),
    failures: failures.slice(0, 10),
  });
  return { ok: failures.length === 0, failures, residuals };
}

async function confirmAllTransactionGroups() {
  if (txSignatures.transfers.length !== 20) {
    record("TX_COUNT_TRANSFERS", "FAIL", { expected: 20, actual: txSignatures.transfers.length });
  } else {
    record("TX_COUNT_TRANSFERS", "PASS", { actual: txSignatures.transfers.length });
  }
  for (const [label, signatures] of Object.entries(txSignatures)) {
    if (label === "anchors" && !REQUIRE_ANCHORING) {
      continue;
    }
    await confirmSignatures(conn, signatures, `${label} signatures`, { timeoutMs: 180_000 });
    record(`TX_CONFIRM_${label.toUpperCase()}`, "PASS", { count: Array.from(new Set(signatures)).length });
  }
}

async function main() {
  const startTime = Date.now();
  log("DNA x402 50-agent mainnet mayhem starting");
  log(`Base URL: ${BASE}`);
  log(`RPC: ${RPC_URL}`);
  log(`Deployer: ${DEPLOYER.toBase58()}`);

  const health = await preflightMainnetFunds();
  const initialBalances = await deployerBalanceSnapshot("before-mayhem");
  const nettingAgents = createAgents("netting", 30);
  const transferAgents = createAgents("transfer", 20);
  allAgents.push(...nettingAgents, ...transferAgents);

  await fundSol(transferAgents, TRANSFER_AGENT_SOL_LAMPORTS);
  await fundUsdc(transferAgents, [
    "6000", "6000", "6000", "6000", "10000",
    "15000", "55000", "110000", "510000", "1100000",
    "6000", "6000", "6000", "6000", "10000",
    "15000", "55000", "110000", "510000", "1100000",
  ]);

  const nettingTrades = [];
  const nettingRejections = [];
  for (let i = 0; i < nettingAgents.length; i += 1) {
    const agent = nettingAgents[i];
    const tier = TIERS[i % TIERS.length];
    const resource = RESOURCES[i % RESOURCES.length];
    const trade = await nettingPayment(agent.name, resource, tier.atomic, tier.name);
    if (trade?.rejected) nettingRejections.push(trade);
    else if (trade) nettingTrades.push(trade);
  }

  for (const agent of nettingAgents.slice(0, 10)) {
    for (let j = 0; j < 3; j += 1) {
      const tier = TIERS[j % TIERS.length];
      const trade = await nettingPayment(agent.name, "/resource", tier.atomic, `burst-${tier.name}`);
      if (trade?.rejected) nettingRejections.push(trade);
      else if (trade) nettingTrades.push(trade);
    }
  }

  const transferTrades = [];
  const transferResources = [
    "/resource", "/inference", "/stream-access", "/resource", "/inference",
    "/stream-access", "/resource", "/inference", "/stream-access", "/resource",
    "/inference", "/stream-access", "/resource", "/inference", "/stream-access",
    "/resource", "/inference", "/stream-access", "/resource", "/inference",
  ];
  for (let i = 0; i < transferAgents.length; i += 1) {
    const trade = await transferPayment(transferAgents[i], transferResources[i], "default");
    if (trade) transferTrades.push(trade);
  }

  const allTrades = [...nettingTrades, ...transferTrades];
  const flush = await flushNetting();
  const receiptIds = allTrades.map((trade) => trade.receiptId).filter(Boolean);
  const anchoredReceipts = await waitForAnchors(receiptIds);
  const admin = await api("GET", "/admin/audit/summary");
  record("AUDIT", admin.ok ? "PASS" : "FAIL", { summary: admin.json });

  await drainUsdcAndClose(transferAgents);
  await drainSol(transferAgents);
  const drainCheck = await verifyDrain(transferAgents);
  await confirmAllTransactionGroups();
  const finalBalances = await deployerBalanceSnapshot("after-mayhem");

  const expectedTrades = EXPECT_NETTING_REJECTION ? EXPECTED_TRANSFER_TRADES : 80;
  if (allTrades.length !== expectedTrades) {
    record("TRADE_COUNT", "FAIL", { expected: expectedTrades, actual: allTrades.length });
  } else {
    record("TRADE_COUNT", "PASS", { actual: allTrades.length });
  }
  if (EXPECT_NETTING_REJECTION) {
    if (nettingRejections.length !== EXPECTED_NETTING_PROBES) {
      record("NETTING_REJECTION_COUNT", "FAIL", { expected: EXPECTED_NETTING_PROBES, actual: nettingRejections.length });
    } else {
      record("NETTING_REJECTION_COUNT", "PASS", { actual: nettingRejections.length });
    }
  }
  if (REQUIRE_ANCHORING && anchoredReceipts.length !== allTrades.length) {
    record("ANCHOR_COUNT_FINAL", "FAIL", { anchored: anchoredReceipts.length, total: allTrades.length });
  } else {
    record("ANCHOR_COUNT_FINAL", "PASS", { anchored: anchoredReceipts.length, total: allTrades.length });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const data = {
    timestamp: new Date().toISOString(),
    elapsed,
    passCount,
    failCount,
    deployer: DEPLOYER.toBase58(),
    anchorPayer: ANCHOR_PAYER?.toBase58() ?? null,
    totalTrades: allTrades.length,
    expectedTrades,
    nettingTrades: nettingTrades.length,
    nettingRejections: nettingRejections.length,
    expectedNettingRejections: EXPECT_NETTING_REJECTION ? EXPECTED_NETTING_PROBES : 0,
    transferTrades: transferTrades.length,
    initialBalances,
    finalBalances,
    txSignatures,
    anchoredReceipts,
    drainCheck,
    agents: allAgents.map((agent) => ({
      name: agent.name,
      role: agent.role,
      pubkey: agent.pubkey,
      ata: agent.ata,
      funded: agent.funded,
      keyPath: agent.keyPath,
    })),
    trades: allTrades,
    nettingRejectionProbes: nettingRejections,
    results,
    flushBatches: flush.json?.batches?.length || 0,
    auditSummary: admin.json,
  };
  writeJsonFile(DATA_PATH, data);

  const report = buildReport(data, health);
  assertNoBrokenSolscanLinks(report, "mayhem report");
  fs.writeFileSync(REPORT_PATH, report);
  log(`Report: ${REPORT_PATH}`);
  log(`Data: ${DATA_PATH}`);

  process.exit(failCount > 0 ? 1 : 0);
}

function solscan(sig) {
  return `https://solscan.io/tx/${sig}`;
}

function linkedSig(sig) {
  return `[${shortBase58(sig)}](${solscan(sig)})`;
}

function statusFor(data, testName) {
  return data.results.find((row) => row.test === testName)?.status ?? "MISSING";
}

function passFail(condition) {
  return condition ? "PASS" : "FAIL";
}

function appendExpectedRow(lines, label, expected, actual, status) {
  lines.push(`| ${label} | ${expected} | ${actual} | ${status} |`);
}

function appendTxTable(lines, title, signatures) {
  lines.push(`## ${title}`);
  lines.push("");
  lines.push("| # | Signature | Solscan |");
  lines.push("| --- | --- | --- |");
  if (signatures.length === 0) {
    lines.push("| 0 | none | none |");
  } else {
    signatures.forEach((sig, index) => {
      lines.push(`| ${index + 1} | \`${shortBase58(sig)}\` | [View](${solscan(sig)}) |`);
    });
  }
  lines.push("");
}

function buildReport(data, health) {
  const totalChecks = data.passCount + data.failCount;
  const passRate = totalChecks === 0 ? "0.0" : ((data.passCount / totalChecks) * 100).toFixed(1);
  const uniqueAnchors = Array.from(new Set(data.txSignatures.anchors ?? []));
  const transferRows = data.trades.filter((trade) => trade.settlement === "transfer");
  const nettingRows = data.trades.filter((trade) => trade.settlement === "netting");
  const nettingRejectionRows = data.nettingRejectionProbes ?? [];
  const lines = [];
  lines.push("# DNA x402 - 50-Agent Mainnet Mayhem Report");
  lines.push("");
  lines.push(`Date: ${data.timestamp}`);
  lines.push(`Duration: ${data.elapsed}s`);
  lines.push("Cluster: solana-mainnet");
  lines.push(`Deployer: \`${data.deployer}\``);
  lines.push(`Anchor payer: \`${data.anchorPayer ?? "unknown"}\``);
  lines.push(`RPC health cluster: \`${health?.cluster ?? "unknown"}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push("| Agents | 50 (30 netting + 20 transfer) |");
  lines.push(`| Total Trades | ${data.totalTrades}/${data.expectedTrades} |`);
  lines.push(`| Netting Trades | ${data.nettingTrades} |`);
  lines.push(`| Unsafe Netting Rejection Probes | ${data.nettingRejections ?? 0}/${data.expectedNettingRejections ?? 0} |`);
  lines.push(`| Transfer Trades (real USDC) | ${data.transferTrades} |`);
  lines.push(`| Checks Passed | ${data.passCount} |`);
  lines.push(`| Checks Failed | ${data.failCount} |`);
  lines.push(`| Pass Rate | ${passRate}% |`);
  lines.push(`| Receipts Anchored On-Chain | ${data.anchoredReceipts.length}/${data.totalTrades} |`);
  lines.push(`| Netting Batches Settled | ${data.flushBatches} |`);
  lines.push(`| On-Chain USDC Transfer TXs | ${data.txSignatures.transfers.length} |`);
  lines.push("");
  lines.push("## Expected vs Actual");
  lines.push("");
  lines.push("| Gate | Expected | Actual | Status |");
  lines.push("| --- | --- | --- | --- |");
  appendExpectedRow(lines, "Cluster", "`solana-mainnet`", `\`${health?.cluster ?? "unknown"}\``, passFail(health?.cluster === "solana-mainnet"));
  appendExpectedRow(lines, "Canonical USDC mint", `\`${MAINNET_USDC_MINT}\``, `\`${health?.mint ?? "unknown"}\``, passFail(health?.mint === MAINNET_USDC_MINT));
  appendExpectedRow(lines, "Payment recipient", "deployer wallet only", `\`${health?.recipient ?? "unknown"}\``, passFail(health?.recipient === data.deployer));
  appendExpectedRow(lines, "Anchor payer", "funded G-local keypair", `\`${data.anchorPayer ?? "unknown"}\``, data.anchorPayer ? "PASS" : "FAIL");
  appendExpectedRow(lines, "Agents", "50", String(data.agents.length), passFail(data.agents.length === 50));
  appendExpectedRow(lines, "Receipt-producing trades", `${data.expectedTrades} total`, String(data.totalTrades), passFail(data.totalTrades === data.expectedTrades));
  appendExpectedRow(lines, "Unsafe netting", "rejected on mainnet", `${data.nettingRejections ?? 0}/${data.expectedNettingRejections ?? 0}`, data.expectedNettingRejections ? statusFor(data, "NETTING_REJECTION_COUNT") : "n/a");
  appendExpectedRow(lines, "Real USDC transfers", "20 confirmed txs", String(data.txSignatures.transfers.length), statusFor(data, "TX_COUNT_TRANSFERS"));
  appendExpectedRow(lines, "Receipt anchors", "one anchor record per receipt", `${data.anchoredReceipts.length}/${data.totalTrades}`, statusFor(data, "ANCHOR_COUNT_FINAL"));
  appendExpectedRow(lines, "Burner recovery", `all transfer-agent ATAs closed and SOL <= ${SOL_DUST_LAMPORTS} lamports`, statusFor(data, "DRAIN_CHECK"), statusFor(data, "DRAIN_CHECK"));
  appendExpectedRow(lines, "Broken Solscan links", "0", "0", "PASS");
  lines.push("");
  lines.push("## Balance Summary");
  lines.push("");
  lines.push("| Wallet | Before SOL | After SOL | SOL Delta | Before USDC | After USDC | USDC Delta |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (data.initialBalances && data.finalBalances) {
    lines.push(`| Deployer | ${data.initialBalances.sol} | ${data.finalBalances.sol} | ${formatSignedDelta(data.initialBalances.solLamports, data.finalBalances.solLamports, 9)} | ${data.initialBalances.usdc} | ${data.finalBalances.usdc} | ${formatSignedDelta(data.initialBalances.usdcAtomic, data.finalBalances.usdcAtomic, 6)} |`);
  } else {
    lines.push("| Deployer | n/a | n/a | n/a | n/a | n/a | n/a |");
  }
  lines.push("");
  lines.push("Expected balance behavior: SOL decreases by mainnet transaction fees and any retained dust; USDC should return to the deployer because the payment recipient and drain destination are the deployer.");
  lines.push("");
  lines.push("## Real USDC Transfer Details");
  lines.push("");
  lines.push("| # | Agent | Resource | Amount USDC | Receipt ID | Signature | Solscan |");
  lines.push("| --- | --- | --- | ---: | --- | --- | --- |");
  transferRows.forEach((trade, index) => {
    lines.push(`| ${index + 1} | ${trade.agent} | \`${trade.resource}\` | ${formatAtomic(trade.amount, 6)} | \`${shortBase58(trade.receiptId)}\` | \`${shortBase58(trade.txSignature)}\` | [View](${solscan(trade.txSignature)}) |`);
  });
  lines.push("");
  lines.push("## Netting Receipt Details");
  lines.push("");
  lines.push("| # | Agent | Resource | Tier | Amount USDC | Receipt ID |");
  lines.push("| --- | --- | --- | --- | ---: | --- |");
  nettingRows.forEach((trade, index) => {
    lines.push(`| ${index + 1} | ${trade.agent} | \`${trade.resource}\` | ${trade.tier} | ${formatAtomic(trade.amount, 6)} | \`${shortBase58(trade.receiptId)}\` |`);
  });
  if (nettingRows.length === 0) {
    lines.push("| 0 | none | n/a | n/a | 0 | n/a |");
  }
  lines.push("");
  lines.push("## Unsafe Netting Rejection Details");
  lines.push("");
  lines.push("| # | Agent | Resource | Tier | Amount USDC | Reason |");
  lines.push("| --- | --- | --- | --- | ---: | --- |");
  nettingRejectionRows.forEach((probe, index) => {
    lines.push(`| ${index + 1} | ${probe.agent} | \`${probe.resource}\` | ${probe.tier} | ${formatAtomic(probe.amount, 6)} | ${String(probe.reason).replace(/\|/g, "/")} |`);
  });
  if (nettingRejectionRows.length === 0) {
    lines.push("| 0 | none | n/a | n/a | 0 | n/a |");
  }
  lines.push("");
  lines.push("## Anchored Receipts");
  lines.push("");
  lines.push("| Receipt ID | Anchor Signature | Solscan |");
  lines.push("| --- | --- | --- |");
  data.anchoredReceipts.forEach((anchor) => {
    lines.push(`| \`${shortBase58(anchor.receiptId)}\` | \`${shortBase58(anchor.signature)}\` | [View](${solscan(anchor.signature)}) |`);
  });
  lines.push("");
  appendTxTable(lines, "Funding Transactions", data.txSignatures.funding ?? []);
  appendTxTable(lines, "Drain Transactions", data.txSignatures.drains ?? []);
  appendTxTable(lines, "Unique Anchor Transactions", uniqueAnchors);
  lines.push("## Transaction Group Confirmation");
  lines.push("");
  lines.push("| Group | Expected | Actual | Status |");
  lines.push("| --- | ---: | ---: | --- |");
  lines.push(`| Funding | >= 1 when agents need top-up | ${(data.txSignatures.funding ?? []).length} | ${statusFor(data, "TX_CONFIRM_FUNDING")} |`);
  lines.push(`| Transfers | 20 | ${(data.txSignatures.transfers ?? []).length} | ${statusFor(data, "TX_CONFIRM_TRANSFERS")} |`);
  lines.push(`| Drains | >= 20 when transfer agents were active | ${(data.txSignatures.drains ?? []).length} | ${statusFor(data, "TX_CONFIRM_DRAINS")} |`);
  lines.push(`| Anchors | >= 1 unique tx | ${uniqueAnchors.length} | ${statusFor(data, "TX_CONFIRM_ANCHORS")} |`);
  lines.push("");
  lines.push("## Recovery Check");
  lines.push("");
  lines.push("| Agent | Pubkey | Remaining Lamports | ATA Open | Remaining USDC Atomic |");
  lines.push("| --- | --- | ---: | --- | ---: |");
  (data.drainCheck?.residuals ?? []).forEach((row) => {
    lines.push(`| ${row.name} | \`${row.pubkey}\` | ${row.solLamports} | ${row.ataOpen ? "yes" : "no"} | ${row.usdcAtomic} |`);
  });
  lines.push("");
  lines.push("## Audit Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(data.auditSummary, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| # | Test | Status | Details |");
  lines.push("| --- | --- | --- | --- |");
  data.results.forEach((row, index) => {
    const { test, status, ts, ...details } = row;
    lines.push(`| ${index + 1} | ${test} | ${status} | ${JSON.stringify(details).replace(/\|/g, "/").slice(0, 180)} |`);
  });
  lines.push("");
  lines.push("## Conclusion");
  lines.push("");
  const nettingGateOk = !data.expectedNettingRejections || data.nettingRejections === data.expectedNettingRejections;
  if (data.failCount === 0 && data.totalTrades === data.expectedTrades && data.anchoredReceipts.length === data.totalTrades && data.drainCheck?.ok && nettingGateOk) {
    lines.push("PASS: 50 agents exercised mainnet-safe behavior: unsafe netting rejected, real USDC transfers confirmed, receipts anchored, and burner funds recovered.");
  } else {
    lines.push("FAIL: the run is not a mainnet-ready proof. Review failed rows and raw JSON data.");
  }
  return `${lines.join("\n")}\n`;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("FATAL:", message);
  try {
    await writeFundingRequired(message);
  } catch {
    // Best effort only; the original failure is more important.
  }
  process.exit(1);
});
