/**
 * DNA x402 — Buyer Agent Example
 *
 * Runnable buyer demo that pairs with `examples/sell-compute.ts`.
 * Default mode is `transfer`; override with DNA_DEMO_MODE=netting|stream.
 *
 * Run:
 *   npx tsx examples/buyer-agent.ts
 */
import { loadDemoSdk } from "./_runtime.js";

const DNA_SERVER = process.env.DNA_SERVER ?? "http://127.0.0.1:3000";
const DNA_DEMO_MODE = process.env.DNA_DEMO_MODE;

async function main() {
  const { normalizeDemoMode, runDemoBuyer } = await loadDemoSdk();
  await runDemoBuyer({
    baseUrl: DNA_SERVER,
    mode: normalizeDemoMode(DNA_DEMO_MODE),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
