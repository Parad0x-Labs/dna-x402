/**
 * DNA x402 — Sell Your Compute in 10 Lines
 *
 * Runnable seller demo for transfer, netting, or stream mode.
 * Default mode is `transfer`; override with DNA_DEMO_MODE=netting|stream.
 *
 * Run:
 *   npx tsx examples/sell-compute.ts
 *
 * Test:
 *   curl http://localhost:3000/                          # free — see prices
 *   curl http://localhost:3000/inference                 # 402 — payment required
 *   curl http://localhost:3000/health                    # server status
 */
import { loadDemoSdk } from "./_runtime.js";

const PORT = Number(process.env.PORT ?? 3000);
const DNA_DEMO_MODE = process.env.DNA_DEMO_MODE;
const RECIPIENT = process.env.RECIPIENT ?? "DEMO_RECIPIENT_WALLET";

async function main() {
  const { normalizeDemoMode, startDemoSeller } = await loadDemoSdk();
  await startDemoSeller({
    port: PORT,
    recipient: RECIPIENT,
    mode: normalizeDemoMode(DNA_DEMO_MODE),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
