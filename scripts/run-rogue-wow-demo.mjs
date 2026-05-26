#!/usr/bin/env node
/**
 * run-rogue-wow-demo.mjs
 *
 * Builds and runs the Rogue Alpha WOW demo binary, then prints a summary
 * of the generated ROGUE_WOW_DEMO.json evidence.
 *
 * Usage:
 *   node scripts/run-rogue-wow-demo.mjs
 *
 * Output:
 *   dist/true-frontier/ROGUE_WOW_DEMO.json
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outPath = join(root, 'dist', 'true-frontier', 'ROGUE_WOW_DEMO.json');

console.log();
console.log('  DARK NULL — ROGUE ALPHA WOW DEMO');
console.log('  ==================================');
console.log('  Building and running rogue_wow_demo binary...');
console.log();

try {
  execSync('cargo run -p rogue-agent-demo-core --bin rogue_wow_demo', {
    stdio: 'inherit',
    cwd: root,
  });
} catch (err) {
  console.error('\n  ERROR: binary failed to run.');
  console.error('  Make sure the workspace builds: cargo build --workspace');
  console.error(`  ${err.message || err}`);
  process.exit(1);
}

if (!existsSync(outPath)) {
  console.error(`\n  ERROR: expected output not found at ${outPath}`);
  process.exit(1);
}

const demo = JSON.parse(readFileSync(outPath, 'utf8'));

console.log();
console.log('  ROGUE_WOW_DEMO.json — summary');
console.log('  ─────────────────────────────────────────────────');
console.log(`  agent              : ${demo.agent}`);
console.log(`  network            : ${demo.network}`);
console.log(`  mainnet_ready      : ${demo.mainnet_ready}`);
console.log(`  production_claim   : ${demo.production_claim}`);
console.log();
console.log(`  [PERMISSION]`);
console.log(`    max_spend        : ${demo.permission.max_spend_lamports.toLocaleString()} lamports`);
console.log(`    withdraw_allowed : ${demo.permission.withdraw_allowed}`);
console.log(`    permission_hash  : ${demo.permission.permission_hash.slice(0,16)}...`);
console.log();
console.log(`  [SPEND]`);
console.log(`    status           : ${demo.allowed_spend.status}`);
console.log(`    copy_sniper_prec : ${demo.allowed_spend.copy_sniper_precision.toFixed(2)}  (5 shadow leaves)`);
console.log(`    spend_hash       : ${demo.allowed_spend.spend_hash.slice(0,16)}...`);
console.log();
console.log(`  [FORBIDDEN WITHDRAW]`);
console.log(`    status           : ${demo.forbidden_withdraw.status}`);
console.log(`    reason           : ${demo.forbidden_withdraw.reason}`);
console.log();
console.log(`  [KILL SWITCH]`);
console.log(`    status           : ${demo.kill_switch.status}`);
console.log(`    revocation_hash  : ${demo.kill_switch.revocation_hash.slice(0,16)}...`);
console.log();
console.log(`  [RECEIPT SOUL]`);
console.log(`    policy           : ${demo.receipt_soul.policy}`);
console.log(`    nullifier        : ${demo.receipt_soul.nullifier.slice(0,16)}...`);
console.log();
console.log(`  [SESSION]`);
console.log(`    payments_collapsed : ${demo.session.payments_collapsed}`);
console.log(`    settlement_root    : ${demo.session.settlement_root.slice(0,16)}...`);
console.log();
console.log(`  [FLIGHT RECORDER]`);
console.log(`    record_hash      : ${demo.flight_recorder.record_hash.slice(0,16)}...`);
console.log(`    redacted_view    : ${demo.flight_recorder.redacted_public_view_hash.slice(0,16)}...`);
console.log();
console.log(`  [NO-CUSTODY]`);
console.log(`    risk_score       : ${demo.no_custody.risk_score}  (0 = agent holds zero keys)`);
console.log(`    attestation_hash : ${demo.no_custody.attestation_hash.slice(0,16)}...`);
console.log();
console.log(`  [ONCHAIN RITUAL — ${demo.devnet_ritual.message}]`);
console.log(`    shard_path       : [${demo.devnet_ritual.shard_path.join(', ')}]`);
const letters = demo.devnet_ritual.message.split('');
demo.devnet_ritual.solscan_links.forEach((link, i) => {
  console.log(`    ${letters[i] || '?'} — ${link}`);
});
console.log();
console.log(`  Evidence: ${outPath}`);
console.log(`  Open UI : packages/rogue-agent-demo/index.html`);
console.log();
console.log('  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.');
console.log();
