#!/usr/bin/env node
// check-sbf-size.mjs — fails if any SBF binary exceeds its KB budget

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

// Budget in KB per program
const BUDGETS = {
  'dark_nullifier_banks.so':     200,
  'dark_compressed_receipts.so': 200,
  'dark_chaff.so':               150,
  'dark_scratch.so':             150,
  'receipt_anchor.so':           300,
};

const DEPLOY_DIRS = [
  'target/deploy',
  'target/sbf-solana-solana/release/deps',
];

// Approx: ~0.00288 SOL per KB of deployed program (mainnet estimate)
const SOL_PER_KB = 0.00288;

let failed = false;

for (const dir of DEPLOY_DIRS) {
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter(f => f.endsWith('.so'));
  if (files.length === 0) continue;

  console.log(`\n📦 SBF binaries in ${dir}:`);
  for (const file of files) {
    const path = join(dir, file);
    const sizeBytes = statSync(path).size;
    const sizeKb    = (sizeBytes / 1024).toFixed(1);
    const deploySOL = (sizeBytes / 1024 * SOL_PER_KB).toFixed(4);
    const budget    = BUDGETS[file];
    const status    = budget == null ? '⚪ (no budget set)' :
                      sizeBytes / 1024 <= budget ? '✅' : `❌ over ${budget} KB budget`;

    console.log(`  ${file}: ${sizeKb} KB | ~${deploySOL} SOL to deploy | ${status}`);
    if (budget != null && sizeBytes / 1024 > budget) failed = true;
  }
}

if (failed) {
  console.error('\n❌ Size budget exceeded. Trim deps or split the program.');
  process.exit(1);
} else {
  console.log('\n✅ All programs within size budget.');
}
