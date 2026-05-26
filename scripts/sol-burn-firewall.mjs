#!/usr/bin/env node
// sol-burn-firewall.mjs — blocks mainnet actions that exceed SOL budget

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ALLOW   = process.env.ALLOW_MAINNET_DEPLOY === 'YES';
const MAX_DEP = parseFloat(process.env.MAX_DEPLOY_SOL      ?? '2.0');
const MAX_ACC = parseFloat(process.env.MAX_ACCOUNT_RENT_SOL ?? '0.05');
const MAX_TOT = parseFloat(process.env.MAX_TOTAL_RENT_SOL   ?? '0.5');

const SOL_PER_KB       = 0.00288;
const LAMPORTS_PER_SOL = 1_000_000_000;
const BYTE_YEAR        = 3480;
const RENT_YEARS       = 2;

function rentSol(bytes) {
  return (128 + bytes) * BYTE_YEAR * RENT_YEARS / LAMPORTS_PER_SOL;
}

// Estimate deploy cost
let totalDeploySol = 0;
const DEPLOY_DIR = 'target/deploy';
if (existsSync(DEPLOY_DIR)) {
  for (const f of readdirSync(DEPLOY_DIR).filter(f => f.endsWith('.so'))) {
    const kb = statSync(join(DEPLOY_DIR, f)).size / 1024;
    totalDeploySol += kb * SOL_PER_KB;
  }
}

// Estimate account rent for common account sizes
const COMMON_ACCOUNTS = [
  { name: 'NullifierShardHeader (×256)',  bytes: 78,  count: 256 },
  { name: 'ReceiptCheckpoint (×1)',        bytes: 78,  count: 1   },
  { name: 'ScratchAccount typical (×10)', bytes: 58,  count: 10  },
];
let totalRentSol = 0;
console.log('\n💰 Rent estimates:');
for (const a of COMMON_ACCOUNTS) {
  const sol = rentSol(a.bytes) * a.count;
  totalRentSol += sol;
  console.log(`  ${a.name}: ${sol.toFixed(4)} SOL`);
}

const totalSol = totalDeploySol + totalRentSol;

console.log(`\n📊 SOL Burn Summary:`);
console.log(`  Programs to deploy: ~${totalDeploySol.toFixed(4)} SOL`);
console.log(`  Account rent (est): ~${totalRentSol.toFixed(4)} SOL`);
console.log(`  Total:              ~${totalSol.toFixed(4)} SOL`);
console.log(`\n  Limits: deploy≤${MAX_DEP} | per-account≤${MAX_ACC} | rent-total≤${MAX_TOT}`);

let blocked = false;
if (!ALLOW)                          { console.error('\n🔥 BLOCKED: Set ALLOW_MAINNET_DEPLOY=YES to proceed.'); blocked = true; }
if (totalDeploySol > MAX_DEP)        { console.error(`🔥 BLOCKED: deploy cost ${totalDeploySol.toFixed(4)} > MAX_DEPLOY_SOL ${MAX_DEP}`); blocked = true; }
if (totalRentSol   > MAX_TOT)        { console.error(`🔥 BLOCKED: rent total ${totalRentSol.toFixed(4)} > MAX_TOTAL_RENT_SOL ${MAX_TOT}`); blocked = true; }

if (blocked) process.exit(1);
console.log('\n✅ SOL burn within budget. Approved.');
