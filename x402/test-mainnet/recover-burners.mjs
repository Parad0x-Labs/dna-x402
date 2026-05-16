#!/usr/bin/env node
/**
 * Recover mainnet mayhem burner funds after an interrupted run.
 *
 * This drains transfer-agent USDC and SOL back to the deployer wallet and
 * writes a confirmation report with real transaction links. It intentionally
 * ignores netting agents because they should never receive funds.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "./spl-token-lite.mjs";
import {
  DEFAULT_MAINNET_RPC,
  MAINNET_USDC_MINT,
  assertWorkspacePath,
  confirmSignatures,
  defaultKeysDir,
  loadKeypair,
  shortBase58,
  writeJsonFile,
} from "./proof-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = assertWorkspacePath(process.env.MAINNET_KEYS_DIR || defaultKeysDir("mainnet"));
const MAYHEM_KEYS_DIR = assertWorkspacePath(path.join(KEYS_DIR, "mayhem-agents"));
const DEPLOYER_KP_PATH = assertWorkspacePath(process.env.MAINNET_DEPLOYER_KEYPAIR || path.join(KEYS_DIR, "deployer.json"));
const REPORT_DIR = assertWorkspacePath(process.env.RECOVERY_REPORT_DIR || __dirname);
const DATA_PATH = assertWorkspacePath(path.join(REPORT_DIR, "BURNER_RECOVERY_DATA.json"));
const REPORT_PATH = assertWorkspacePath(path.join(REPORT_DIR, "BURNER_RECOVERY_REPORT.md"));
const RPC_URL = process.env.HELIUS_RPC || process.env.SOLANA_RPC_URL || DEFAULT_MAINNET_RPC;
const USDC_MINT = new PublicKey(MAINNET_USDC_MINT);
const SOL_DUST_LAMPORTS = 5_000n;

const conn = new Connection(RPC_URL, "confirmed");
const deployer = loadKeypair(DEPLOYER_KP_PATH);
const deployerPubkey = deployer.publicKey;
const drainTxs = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function solscan(sig) {
  return `https://solscan.io/tx/${sig}`;
}

function formatAtomic(value, decimals) {
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function isRetryableRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|timeout|econnreset|fetch failed/i.test(message);
}

async function withRpcRetry(label, fn) {
  let delayMs = 750;
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === 12) {
        throw error;
      }
      console.warn(`${label}: retry ${attempt} after RPC error: ${String(error).slice(0, 160)}`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 12_000);
    }
  }
  throw lastError;
}

async function sendTx(label, tx, signers) {
  return withRpcRetry(label, async () => {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    drainTxs.push(sig);
    return sig;
  });
}

async function tokenBalance(ata) {
  try {
    return await withRpcRetry(`token balance ${ata.toBase58()}`, async () => (await getAccount(conn, ata)).amount);
  } catch {
    return 0n;
  }
}

async function accountInfo(pubkey) {
  return withRpcRetry(`account info ${pubkey.toBase58()}`, () => conn.getAccountInfo(pubkey, "confirmed"));
}

async function solBalance(pubkey) {
  return BigInt(await withRpcRetry(`SOL balance ${pubkey.toBase58()}`, () => conn.getBalance(pubkey, "confirmed")));
}

function loadTransferAgents() {
  const agents = [];
  for (let i = 1; i <= 20; i += 1) {
    const name = `transfer-${String(i).padStart(2, "0")}`;
    const keyPath = assertWorkspacePath(path.join(MAYHEM_KEYS_DIR, `${name}.json`));
    if (!fs.existsSync(keyPath)) {
      continue;
    }
    const keypair = loadKeypair(keyPath);
    agents.push({ name, keyPath, keypair, pubkey: keypair.publicKey });
  }
  return agents;
}

async function snapshotAgent(agent) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, agent.pubkey);
  const ataInfo = await accountInfo(ata);
  const usdc = ataInfo ? await tokenBalance(ata) : 0n;
  const sol = await solBalance(agent.pubkey);
  return {
    name: agent.name,
    pubkey: agent.pubkey.toBase58(),
    ata: ata.toBase58(),
    ataOpen: Boolean(ataInfo),
    solLamports: sol.toString(),
    sol: formatAtomic(sol, 9),
    usdcAtomic: usdc.toString(),
    usdc: formatAtomic(usdc, 6),
  };
}

async function recoverAgent(agent) {
  const before = await snapshotAgent(agent);
  const txs = [];
  const ata = new PublicKey(before.ata);
  const deployerAta = await getAssociatedTokenAddress(USDC_MINT, deployerPubkey);

  if (before.ataOpen) {
    const amount = BigInt(before.usdcAtomic);
    const tx = new Transaction();
    if (amount > 0n) {
      tx.add(createTransferInstruction(ata, deployerAta, agent.pubkey, amount));
    }
    tx.add(createCloseAccountInstruction(ata, deployerPubkey, agent.pubkey));
    const sig = await sendTx(`${agent.name} close/drain USDC ATA`, tx, [agent.keypair]);
    txs.push({ type: "usdc-close", signature: sig });
  }

  const balanceAfterAtaClose = await solBalance(agent.pubkey);
  if (balanceAfterAtaClose > SOL_DUST_LAMPORTS) {
    const lamports = balanceAfterAtaClose - SOL_DUST_LAMPORTS;
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: agent.pubkey,
      toPubkey: deployerPubkey,
      lamports: Number(lamports),
    }));
    const sig = await sendTx(`${agent.name} drain SOL`, tx, [agent.keypair]);
    txs.push({ type: "sol-drain", signature: sig });
  }

  const after = await snapshotAgent(agent);
  return { before, after, txs };
}

async function deployerSnapshot(label) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, deployerPubkey);
  const sol = await solBalance(deployerPubkey);
  const usdc = await tokenBalance(ata);
  return {
    label,
    pubkey: deployerPubkey.toBase58(),
    solLamports: sol.toString(),
    sol: formatAtomic(sol, 9),
    usdcAtomic: usdc.toString(),
    usdc: formatAtomic(usdc, 6),
    usdcAta: ata.toBase58(),
  };
}

function buildReport(data) {
  const lines = [];
  lines.push("# DNA x402 - Mainnet Burner Recovery Report");
  lines.push("");
  lines.push(`Date: ${data.timestamp}`);
  lines.push(`RPC: \`${data.rpcHost}\``);
  lines.push(`Deployer: \`${data.deployer.pubkey}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Transfer agents scanned | ${data.agents.length} |`);
  lines.push(`| Drain transactions | ${data.drainTxs.length} |`);
  lines.push(`| Recovery failures | ${data.failures.length} |`);
  lines.push(`| Deployer SOL before | ${data.deployer.before.sol} |`);
  lines.push(`| Deployer SOL after | ${data.deployer.after.sol} |`);
  lines.push(`| Deployer USDC before | ${data.deployer.before.usdc} |`);
  lines.push(`| Deployer USDC after | ${data.deployer.after.usdc} |`);
  lines.push("");
  lines.push("## Drain Transactions");
  lines.push("");
  lines.push("| # | Signature | Solscan |");
  lines.push("| --- | --- | --- |");
  if (data.drainTxs.length === 0) {
    lines.push("| 0 | none | none |");
  } else {
    data.drainTxs.forEach((sig, index) => {
      lines.push(`| ${index + 1} | \`${shortBase58(sig)}\` | [View](${solscan(sig)}) |`);
    });
  }
  lines.push("");
  lines.push("## Agent Residuals");
  lines.push("");
  lines.push("| Agent | Pubkey | Before SOL | After SOL | Before USDC | After USDC | ATA Open After |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  data.agents.forEach((row) => {
    lines.push(`| ${row.before.name} | \`${row.before.pubkey}\` | ${row.before.sol} | ${row.after.sol} | ${row.before.usdc} | ${row.after.usdc} | ${row.after.ataOpen ? "yes" : "no"} |`);
  });
  lines.push("");
  lines.push("## Conclusion");
  lines.push("");
  if (data.failures.length === 0) {
    lines.push("PASS: interrupted mayhem burner funds were recovered to the deployer wallet.");
  } else {
    lines.push("FAIL: at least one burner still has recoverable funds or an open token account.");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const agents = loadTransferAgents();
  const before = await deployerSnapshot("before-recovery");
  const recovered = [];
  const failures = [];

  for (const agent of agents) {
    console.log(`recover ${agent.name} ${agent.pubkey.toBase58()}`);
    try {
      const result = await recoverAgent(agent);
      recovered.push(result);
      if (BigInt(result.after.solLamports) > SOL_DUST_LAMPORTS || result.after.ataOpen || BigInt(result.after.usdcAtomic) > 0n) {
        failures.push({
          agent: agent.name,
          reason: "residual funds or ATA remain",
          after: result.after,
        });
      }
    } catch (error) {
      failures.push({
        agent: agent.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await confirmSignatures(conn, drainTxs, "burner recovery drain signatures", { timeoutMs: 180_000 });
  const after = await deployerSnapshot("after-recovery");
  const data = {
    timestamp: new Date().toISOString(),
    rpcHost: new URL(RPC_URL).host,
    deployer: {
      pubkey: deployerPubkey.toBase58(),
      keypairPath: DEPLOYER_KP_PATH,
      before,
      after,
    },
    agents: recovered,
    failures,
    drainTxs,
  };

  writeJsonFile(DATA_PATH, data);
  fs.writeFileSync(REPORT_PATH, buildReport(data));
  console.log(`Recovery report: ${REPORT_PATH}`);
  console.log(`Recovery data: ${DATA_PATH}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
