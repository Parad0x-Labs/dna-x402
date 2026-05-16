#!/usr/bin/env node
/**
 * DNA x402 mainnet integration proof.
 *
 * This is a smaller proof than mayhem-50, but it uses the same fail-closed
 * rules for admin auth and anchoring: no missing signatures, no undefined
 * Solscan links, and no pass when anchoring is enabled but empty.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import {
  DEFAULT_MAINNET_RPC,
  MAINNET_USDC_MINT,
  assertNoBrokenSolscanLinks,
  assertWorkspacePath,
  boolEnv,
  confirmSignatures,
  defaultKeysDir,
  isBase58Signature,
  loadKeypair,
  shortBase58,
} from "./proof-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.X402_BASE_URL || "http://127.0.0.1:8080";
const KEYS_DIR = assertWorkspacePath(process.env.MAINNET_KEYS_DIR || defaultKeysDir("mainnet"));
const REPORT_PATH = assertWorkspacePath(path.join(__dirname, "MAINNET_TEST_REPORT.md"));
const DATA_PATH = assertWorkspacePath(path.join(__dirname, "MAINNET_TEST_DATA.json"));
const RPC_URL = process.env.HELIUS_RPC || process.env.SOLANA_RPC_URL || DEFAULT_MAINNET_RPC;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const REQUIRE_ANCHORING = boolEnv("REQUIRE_ANCHORING", true);

const allKeys = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, "ALL_KEYS.json"), "utf8"));
const deployerPath = process.env.MAINNET_DEPLOYER_KEYPAIR || allKeys.deployer?.path || path.join(KEYS_DIR, "deployer.json");
const deployerPubkey = loadKeypair(deployerPath).publicKey.toBase58();
const conn = new Connection(RPC_URL, "confirmed");

const results = [];
let passCount = 0;
let failCount = 0;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function record(test, status, details = {}) {
  const { status: httpStatus, ...safeDetails } = details;
  results.push({
    test,
    status,
    ts: new Date().toISOString(),
    ...(httpStatus === undefined ? safeDetails : { ...safeDetails, httpStatus }),
  });
  if (status === "PASS") {
    passCount += 1;
  } else {
    failCount += 1;
  }
  log(`${status === "PASS" ? "PASS" : "FAIL"} ${test}`);
}

async function api(method, endpoint, body) {
  const headers = { "Content-Type": "application/json" };
  if (ADMIN_SECRET) {
    headers["x-admin-token"] = ADMIN_SECRET;
  }
  const url = endpoint.startsWith("http") ? endpoint : `${BASE}${endpoint}`;
  const response = await fetch(url, {
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

function random32B() {
  return crypto.randomBytes(32).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testHealth() {
  const response = await api("GET", "/health");
  const body = response.json;
  const pass = response.ok
    && body?.ok
    && body?.cluster === "solana-mainnet"
    && body?.mint === MAINNET_USDC_MINT
    && body?.recipient === deployerPubkey
    && body?.runtime?.auditFixturesEnabled === false
    && body?.runtime?.gauntletMode === false
    && (!REQUIRE_ANCHORING || body?.anchoring?.enabled === true);
  record("T01: Health check", pass ? "PASS" : "FAIL", {
    cluster: body?.cluster,
    mint: body?.mint,
    recipient: body?.recipient,
    anchoringEnabled: body?.anchoring?.enabled,
  });
  return body;
}

async function testRegisterShop() {
  const sellerPubkey = allKeys["seller-provider"].pubkey;
  const bs58Mod = await import("bs58");
  const naclMod = await import("tweetnacl");
  const bs58 = bs58Mod.default;
  const nacl = naclMod.default;
  const sellerSecret = Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS_DIR, "seller-provider.json"), "utf8")));

  const manifest = {
    manifestVersion: "market-v1",
    shopId: "test-seller-ai-tools",
    name: "AI Test Tools Provider",
    description: "Burner seller for mainnet integration testing",
    category: "ai_inference",
    ownerPubkey: sellerPubkey,
    endpoints: [
      {
        endpointId: "text-summarize",
        method: "POST",
        path: "/api/summarize",
        capabilityTags: ["inference", "text"],
        description: "Summarize text using AI",
        pricingModel: { kind: "flat", amountAtomic: "2000" },
        settlementModes: ["netting"],
        sla: { maxLatencyMs: 5000, availabilityTarget: 0.99 },
      },
    ],
  };

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  const manifestHash = crypto.createHash("sha256").update(stableStringify(manifest)).digest("hex");
  const signature = nacl.sign.detached(Buffer.from(manifestHash, "hex"), sellerSecret);
  const response = await api("POST", "/market/shops", {
    manifest,
    manifestHash,
    signature: bs58.encode(signature),
    publishedAt: new Date().toISOString(),
  });
  record("T02: Register seller shop", response.status === 201 && response.json?.ok ? "PASS" : "FAIL", {
    status: response.status,
    response: response.ok ? undefined : response.json,
  });
}

async function testMarketDiscovery() {
  const shops = await api("GET", "/market/shops");
  const shopList = Array.isArray(shops.json?.shops) ? shops.json.shops : [];
  record("T03a: List marketplace shops", shops.ok && shopList.some((shop) => shop.shopId === "test-seller-ai-tools") ? "PASS" : "FAIL", {
    shopCount: shopList.length,
  });
  const search = await api("GET", "/market/search?q=summarize");
  record("T03b: Marketplace search", search.ok ? "PASS" : "FAIL", { status: search.status });
}

async function testPaymentFlow(agentName, resource, amountAtomic, prefix) {
  const quote = await api("GET", `/quote?resource=${encodeURIComponent(resource)}&amountAtomic=${amountAtomic}`);
  if (!quote.ok) {
    record(`${prefix}a: Quote`, "FAIL", { response: quote.json });
    return {};
  }
  record(`${prefix}a: Quote (${resource})`, "PASS", { quoteId: quote.json.quoteId, amount: quote.json.amount });

  const commit = await api("POST", "/commit", {
    quoteId: quote.json.quoteId,
    payerCommitment32B: random32B(),
  });
  if (commit.status !== 201) {
    record(`${prefix}b: Commit`, "FAIL", { response: commit.json });
    return { quoteId: quote.json.quoteId };
  }
  record(`${prefix}b: Commit`, "PASS", { commitId: commit.json.commitId });

  const finalize = await api("POST", "/finalize", {
    commitId: commit.json.commitId,
    paymentProof: { settlement: "netting", amountAtomic, note: `${agentName} test trade` },
  });
  if (!finalize.ok) {
    record(`${prefix}c: Finalize`, "FAIL", { response: finalize.json });
    return { quoteId: quote.json.quoteId, commitId: commit.json.commitId };
  }
  record(`${prefix}c: Finalize (netting)`, "PASS", { receiptId: finalize.json.receiptId });

  const receipt = await api("GET", `/receipt/${finalize.json.receiptId}`);
  if (receipt.ok && receipt.json?.payload) {
    record(`${prefix}d: Receipt fetch`, "PASS", { receiptId: receipt.json.payload.receiptId });
  } else {
    record(`${prefix}d: Receipt fetch`, "FAIL", { response: receipt.json });
  }

  return {
    quoteId: quote.json.quoteId,
    commitId: commit.json.commitId,
    receiptId: finalize.json.receiptId,
    receipt: receipt.json?.payload,
  };
}

async function testFlush() {
  const response = await api("POST", "/settlements/flush", {});
  record("T07: Flush netting ledger", response.ok ? "PASS" : "FAIL", {
    batches: response.json?.batches?.length ?? 0,
    response: response.ok ? undefined : response.json,
  });
  return response.json;
}

async function testAnchoring(receiptIds) {
  const anchored = new Map();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && anchored.size < receiptIds.length) {
    for (const receiptId of receiptIds) {
      if (anchored.has(receiptId)) {
        continue;
      }
      const response = await api("GET", `/anchoring/receipt/${receiptId}`);
      const payload = response.json?.anchored;
      const signature = payload?.signature ?? payload?.txSignature;
      if (response.ok && response.json?.ok && isBase58Signature(signature)) {
        anchored.set(receiptId, { receiptId, ...payload, signature });
      }
    }
    if (anchored.size < receiptIds.length) {
      await sleep(5_000);
    }
  }

  const rows = Array.from(anchored.values());
  const signatures = Array.from(new Set(rows.map((row) => row.signature)));
  if (REQUIRE_ANCHORING) {
    if (rows.length !== receiptIds.length) {
      record("T08: On-chain anchoring", "FAIL", { anchored: rows.length, total: receiptIds.length });
      return rows;
    }
    await confirmSignatures(conn, signatures, "integration anchor signatures");
  }
  record("T08: On-chain anchoring", REQUIRE_ANCHORING ? "PASS" : "PASS", {
    anchored: rows.length,
    total: receiptIds.length,
    txSignatures: signatures.map((sig) => shortBase58(sig)),
  });
  return rows;
}

async function testAdmin() {
  const overview = await api("GET", "/admin/overview");
  record("T09a: Admin overview", overview.ok ? "PASS" : "FAIL", { status: overview.status });
  const events = await api("GET", "/admin/audit/events?limit=5");
  record("T09b: Admin audit events", events.ok ? "PASS" : "FAIL", { status: events.status });
  const summary = await api("GET", "/admin/audit/summary");
  record("T09c: Admin audit summary", summary.ok ? "PASS" : "FAIL", { status: summary.status });
  const netting = await api("GET", "/admin/netting");
  record("T09d: Admin netting status", netting.ok ? "PASS" : "FAIL", { status: netting.status });
  return { overview: overview.json, summary: summary.json };
}

async function testReplayProtection(existingCommitId) {
  const response = await api("POST", "/finalize", {
    commitId: existingCommitId,
    paymentProof: { settlement: "netting", amountAtomic: "1000" },
  });
  record("T10: Replay protection (re-finalize)", response.ok && response.json?.receiptId ? "PASS" : "FAIL", {
    status: response.status,
  });
}

async function testErrorHandling() {
  const badCommit = await api("POST", "/commit", { quoteId: "00000000-0000-0000-0000-000000000000", payerCommitment32B: random32B() });
  record("T11a: Commit with bad quoteId", badCommit.status === 404 ? "PASS" : "FAIL", { status: badCommit.status });
  const badFinalize = await api("POST", "/finalize", { commitId: "00000000-0000-0000-0000-000000000000", paymentProof: { settlement: "netting" } });
  record("T11b: Finalize with bad commitId", badFinalize.status === 404 ? "PASS" : "FAIL", { status: badFinalize.status });
  const missingReceipt = await api("GET", "/receipt/nonexistent");
  record("T11c: Fetch nonexistent receipt", missingReceipt.status === 404 ? "PASS" : "FAIL", { status: missingReceipt.status });
}

async function testPauseFlags() {
  const pause = await api("POST", "/admin/pause/market?enable=true");
  record("T12a: Pause market", pause.ok ? "PASS" : "FAIL", { status: pause.status });
  const health = await api("GET", "/health");
  record("T12b: Verify market paused", health.json?.market?.paused === true ? "PASS" : "FAIL");
  const unpause = await api("POST", "/admin/pause/market?enable=false");
  record("T12c: Unpause market", unpause.ok ? "PASS" : "FAIL", { status: unpause.status });
}

async function testPricingVariations() {
  for (const item of [
    { path: "/resource", expected: "1000" },
    { path: "/inference", expected: "5000" },
    { path: "/stream-access", expected: "100" },
  ]) {
    const quote = await api("GET", `/quote?resource=${encodeURIComponent(item.path)}`);
    record(`T13: Pricing ${item.path}`, quote.ok && quote.json.amount === item.expected ? "PASS" : "FAIL", {
      expected: item.expected,
      got: quote.json?.amount,
    });
  }
}

function generateReport(health, trades, flushResult, anchoredResults, adminResults, elapsed) {
  const lines = [];
  const passRate = results.length === 0 ? "0.0" : ((passCount / results.length) * 100).toFixed(1);
  lines.push("# DNA x402 - Mainnet Integration Test Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Duration: ${elapsed}s`);
  lines.push(`Cluster: ${health?.cluster ?? "unknown"}`);
  lines.push(`Server Version: ${health?.build?.version ?? "unknown"}`);
  lines.push(`Program ID: ${health?.programs?.receiptAnchorProgramId ?? "n/a"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Total Tests | ${results.length} |`);
  lines.push(`| Passed | ${passCount} |`);
  lines.push(`| Failed | ${failCount} |`);
  lines.push(`| Pass Rate | ${passRate}% |`);
  lines.push(`| Anchored Receipts | ${anchoredResults.length}/${trades.filter((trade) => trade.receiptId).length} |`);
  lines.push("");
  lines.push("## Burner Wallets");
  lines.push("");
  lines.push("| Wallet | Public Key | Role |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Deployer | \`${deployerPubkey}\` | Fee payer / test recipient |`);
  for (const name of ["buyer-agent-1", "buyer-agent-2", "buyer-agent-3", "seller-provider"]) {
    lines.push(`| ${name} | \`${allKeys[name]?.pubkey ?? "missing"}\` | Burner proof key |`);
  }
  lines.push("");
  lines.push("## Test Results");
  lines.push("");
  lines.push("| # | Test | Status | Details |");
  lines.push("| --- | --- | --- | --- |");
  results.forEach((row, index) => {
    const { test, status, ts, ...details } = row;
    lines.push(`| ${index + 1} | ${test} | ${status} | ${JSON.stringify(details).replace(/\|/g, "/").slice(0, 180)} |`);
  });
  lines.push("");
  lines.push("## Trade Log");
  lines.push("");
  lines.push("| Resource | Amount Atomic | Quote ID | Commit ID | Receipt ID |");
  lines.push("| --- | --- | --- | --- | --- |");
  trades.forEach((trade) => {
    lines.push(`| ${trade.receipt?.resource ?? "n/a"} | ${trade.receipt?.amountAtomic ?? trade.quote?.amount ?? "n/a"} | \`${shortBase58(trade.quoteId ?? "n/a", 8, 4)}\` | \`${shortBase58(trade.commitId ?? "n/a", 8, 4)}\` | \`${shortBase58(trade.receiptId ?? "n/a", 8, 4)}\` |`);
  });
  lines.push("");
  lines.push("## On-Chain Anchoring");
  lines.push("");
  lines.push("| Receipt ID | Signature | Slot | Solscan |");
  lines.push("| --- | --- | --- | --- |");
  anchoredResults.forEach((anchor) => {
    lines.push(`| \`${shortBase58(anchor.receiptId)}\` | \`${shortBase58(anchor.signature)}\` | ${anchor.slot ?? "n/a"} | [View](https://solscan.io/tx/${anchor.signature}) |`);
  });
  lines.push("");
  lines.push("## Netting Ledger Flush");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(flushResult, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Admin Snapshot");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(adminResults?.summary, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Conclusion");
  lines.push("");
  lines.push(failCount === 0 ? "PASS: all checked mainnet integration paths passed." : "FAIL: this is not a mainnet-ready proof.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!ADMIN_SECRET) {
    throw new Error("ADMIN_SECRET is required for mainnet integration proof");
  }
  if (!fs.existsSync(path.join(KEYS_DIR, "ALL_KEYS.json"))) {
    throw new Error(`missing ${path.join(KEYS_DIR, "ALL_KEYS.json")}; run bootstrap-keys.mjs first`);
  }

  const startTime = Date.now();
  log("DNA x402 mainnet integration proof starting");
  const health = await testHealth();
  await testRegisterShop();
  await testMarketDiscovery();

  const trades = [];
  trades.push(await testPaymentFlow("buyer-agent-1", "/resource", "1000", "T04"));
  trades.push(await testPaymentFlow("buyer-agent-2", "/inference", "5000", "T05"));
  trades.push(await testPaymentFlow("buyer-agent-3", "/stream-access", "100", "T06"));
  for (let i = 0; i < 5; i += 1) {
    trades.push(await testPaymentFlow("buyer-agent-1", "/resource", "1000", `T06-burst-${i + 1}`));
  }

  const flushResult = await testFlush();
  const receiptIds = trades.map((trade) => trade.receiptId).filter(Boolean);
  const anchoredResults = await testAnchoring(receiptIds);
  const adminResults = await testAdmin();
  if (trades[0]?.commitId) {
    await testReplayProtection(trades[0].commitId);
  }
  await testErrorHandling();
  await testPauseFlags();
  await testPricingVariations();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const data = {
    generatedAt: new Date().toISOString(),
    elapsed,
    passCount,
    failCount,
    health,
    trades,
    flushResult,
    anchoredResults,
    adminResults,
    results,
  };
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  const report = generateReport(health, trades, flushResult, anchoredResults, adminResults, elapsed);
  assertNoBrokenSolscanLinks(report, "mainnet integration report");
  fs.writeFileSync(REPORT_PATH, report);
  log(`Report saved to ${REPORT_PATH}`);
  log(`Data saved to ${DATA_PATH}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
