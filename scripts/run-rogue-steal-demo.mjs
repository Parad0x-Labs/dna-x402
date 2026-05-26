#!/usr/bin/env node
/**
 * run-rogue-steal-demo.mjs
 *
 * Builds and runs the Rogue Steal Attempt demo binary, then prints a summary
 * of the generated ROGUE_STEAL_ATTEMPT_DEMO.json evidence.
 *
 * Usage:
 *   node scripts/run-rogue-steal-demo.mjs
 *
 * Output:
 *   dist/true-frontier/ROGUE_STEAL_ATTEMPT_DEMO.json
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outPath = join(root, 'dist', 'true-frontier', 'ROGUE_STEAL_ATTEMPT_DEMO.json');

console.log();
console.log('  DARK NULL — ROGUE TRIED TO STEAL DEMO');
console.log('  ======================================');
console.log('  Building and running rogue_steal_attempt_demo binary...');
console.log();

try {
  execSync('cargo run -p rogue-agent-demo-core --bin rogue_steal_attempt_demo', {
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
console.log('  ROGUE_STEAL_ATTEMPT_DEMO.json — summary');
console.log('  ─────────────────────────────────────────────────');
console.log(`  headline           : ${demo.headline}`);
console.log(`  agent              : ${demo.agent}`);
console.log(`  agent_had_key      : ${demo.agent_had_private_key}`);
console.log(`  mainnet_ready      : ${demo.mainnet_ready}`);
console.log(`  production_claim   : ${demo.production_claim}`);
console.log();

console.log('  [PERMISSION]');
console.log(`    allowed_scopes   : ${JSON.stringify(demo.permission.allowed_scopes)}`);
console.log(`    denied_scopes    : ${JSON.stringify(demo.permission.denied_scopes)}`);
console.log(`    withdraw_allowed : ${demo.permission.withdraw_allowed}`);
console.log(`    permission_hash  : ${demo.permission.permission_hash.slice(0, 16)}...`);
console.log();

console.log('  [ALLOWED ACTION]');
console.log(`    name             : ${demo.allowed_action.name}`);
console.log(`    status           : ${demo.allowed_action.status}  ✅`);
console.log(`    reason           : ${demo.allowed_action.reason}`);
console.log(`    shadow_leaves    : ${demo.allowed_action.shadow_leaves}`);
console.log(`    copy_sniper_prec : ${demo.allowed_action.copy_sniper_precision.toFixed(2)}`);
console.log();

console.log('  [STEAL ATTEMPT]');
console.log(`    name             : ${demo.steal_attempt.name}`);
console.log(`    status           : ${demo.steal_attempt.status}  ❌`);
console.log(`    reason           : ${demo.steal_attempt.reason}`);
console.log(`    funds_moved      : ${demo.steal_attempt.funds_moved}`);
console.log(`    destination      : ${demo.steal_attempt.attempted_destination_hash.slice(0, 16)}...  (hashed)`);
console.log();

console.log('  [KILL SWITCH]  ⚡');
console.log(`    triggered        : ${demo.kill_switch.triggered_after_steal_attempt}`);
console.log(`    future_spend     : ${demo.kill_switch.future_spend_status}  (${demo.kill_switch.future_spend_reason})`);
console.log(`    revocation_hash  : ${demo.kill_switch.revocation_hash.slice(0, 16)}...`);
console.log();

console.log('  [FLIGHT RECORDER]');
demo.flight_recorder.events.forEach((ev, i) => {
  console.log(`    event[${i}]         : ${ev}`);
});
console.log(`    public_chain     : ${demo.flight_recorder.public_chain_hash.slice(0, 16)}...`);
console.log();

console.log('  ┌─────────────────────────────────────────────┐');
console.log('  │  ALLOWED SPEND    ✅  accepted               │');
console.log('  │  STEAL ATTEMPT    ❌  blocked                │');
console.log('  │  KILL SWITCH      ⚡  session terminated     │');
console.log('  │  AGENT KEY        🚫  never held             │');
console.log('  └─────────────────────────────────────────────┘');
console.log();
console.log(`  Evidence: ${outPath}`);
console.log(`  Open UI : packages/rogue-agent-demo/index.html`);
console.log();
console.log('  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.');
console.log();
