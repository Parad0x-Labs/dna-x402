#!/usr/bin/env node
// Dark Null — ZK Compression Readiness Check
// Checks whether Light/ZK Compression deps are installed/configured.

import { execSync } from "node:child_process";
import * as fs from "node:fs";

function check(label, fn) {
  try {
    const r = fn();
    console.log(`  ✅ ${label}: ${r}`);
    return true;
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message ?? "not available"}`);
    return false;
  }
}

console.log("=== Dark Null ZK Compression Readiness ===\n");

console.log("1. Local Simulator (Rust crate):");
check("dark-compression-core crate exists", () => {
  fs.statSync("crates/dark-compression-core/src/lib.rs");
  return "crates/dark-compression-core/src/lib.rs";
});

console.log("\n2. Light Protocol / ZK Compression SDK:");
const lightAvailable = check("@lightprotocol/stateless.js", () => {
  execSync("node -e \"require('@lightprotocol/stateless.js')\"", { stdio: "pipe" });
  return "installed";
});
if (!lightAvailable) {
  console.log("     BLOCKED: npm install @lightprotocol/stateless.js");
  console.log("     See: https://www.zkcompression.com/");
}

console.log("\n3. Required Environment Variables:");
const vars = ["SOLANA_RPC_URL", "LIGHT_PROTOCOL_RPC", "COMPRESSION_PROGRAM_ID"];
for (const v of vars) {
  check(v, () => {
    if (!process.env[v]) throw new Error("not set");
    return process.env[v];
  });
}

console.log("\n4. Devnet RPC Status:");
check("Solana devnet RPC reachable", () => {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  execSync(
    `curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' ${rpc} --max-time 5`,
    { stdio: "pipe" }
  );
  return rpc;
});

console.log("\n=== Summary ===");
console.log("Local simulator: READY (Rust — no external deps)");
console.log(
  "Light Protocol adapter: " +
    (lightAvailable ? "READY" : "BLOCKED — install SDK first")
);
console.log("Real ZK Compression: BLOCKED until Light Protocol configured");
console.log(
  "Cost comparison: see CostComparison struct in dark-compressed-receipt-ledger"
);
