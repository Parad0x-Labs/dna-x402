/**
 * NULL Miner SDK — OpenClaw Plugin Adapter (Momo-style)
 *
 * Registers NULL Miner as an OpenClaw plugin. When Momo (or any OpenClaw-based
 * AI assistant) generates an app, it can embed the NullMiner plugin so the
 * generated app's users earn USDC passively from day one.
 *
 * Plugin contract:
 *   - name:        unique plugin identifier
 *   - version:     semver
 *   - description: shown in plugin marketplace
 *   - init():      called when plugin loads — starts the agent loop
 *   - tools:       array of tool definitions the AI can call
 *   - destroy():   cleanup on unload
 *
 * Usage in a Momo-generated app:
 *   import { nullMinerPlugin } from "null-miner-sdk/openclaw";
 *
 *   const plugin = nullMinerPlugin({
 *     rpcUrl:        "https://api.devnet.solana.com",
 *     hostWallet:    momoEmbeddedWallet,
 *     platformId:    "momo",
 *   });
 *
 *   // Register with OpenClaw runtime
 *   openclaw.registerPlugin(plugin);
 */

import { NullMiner } from "../core/NullMiner.js";
import type { NullMinerConfig, MinerStats, TaskResult } from "../core/types.js";

// ── OpenClaw Plugin Interface ─────────────────────────────────────────────────

interface OpenClawTool {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
  handler:     (params: Record<string, unknown>) => Promise<unknown>;
}

interface OpenClawPlugin {
  name:        string;
  version:     string;
  description: string;
  init:        (context: OpenClawContext) => Promise<void>;
  tools:       OpenClawTool[];
  destroy:     () => void;
}

interface OpenClawContext {
  log:      (msg: string) => void;
  storage:  {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };
}

// ── Plugin Factory ────────────────────────────────────────────────────────────

export function nullMinerPlugin(config: NullMinerConfig): OpenClawPlugin {
  let miner: NullMiner | null = null;

  return {
    name:    "null-miner",
    version: "0.1.0",
    description:
      "Autonomous USDC earning for app users. Your app hosts a Dark Agent that " +
      "claims tasks from the DNA x402 marketplace, earns USDC, and pays NULL token " +
      "yield to the host. Users earn passively. Platform collects fees.",

    async init(ctx: OpenClawContext): Promise<void> {
      ctx.log("[NullMiner] Initializing plugin...");

      miner = new NullMiner({
        ...config,
        onEarn: (result: TaskResult) => {
          ctx.log(
            `[NullMiner] ✓ Earned $${result.usdcEarned.toFixed(4)} USDC + ` +
            `${result.nullYield.toFixed(6)} NULL (task: ${result.taskId.slice(0, 8)}...)`
          );
          config.onEarn?.(result);
        },
        onError: (err: Error) => {
          ctx.log(`[NullMiner] Error: ${err.message}`);
          config.onError?.(err);
        },
      });

      await miner.start();
      ctx.log(`[NullMiner] Agent running. Passport: ${miner.getPassportId().slice(0, 16)}...`);
    },

    tools: [
      {
        name:        "null_miner_stats",
        description: "Get current earnings stats for this app's NULL Miner agent.",
        parameters:  {},
        async handler(): Promise<MinerStats | { error: string }> {
          if (!miner) return { error: "NullMiner not initialized" };
          return miner.getStats();
        },
      },
      {
        name:        "null_miner_pause",
        description: "Pause the NULL Miner agent (stop claiming new tasks).",
        parameters:  {},
        async handler(): Promise<{ status: string }> {
          if (!miner) return { status: "not_running" };
          miner.stop();
          return { status: "paused" };
        },
      },
      {
        name:        "null_miner_resume",
        description: "Resume the NULL Miner agent.",
        parameters:  {},
        async handler(): Promise<{ status: string }> {
          if (!miner) return { status: "not_initialized" };
          await miner.start();
          return { status: "running" };
        },
      },
      {
        name:        "null_miner_passport",
        description: "Get the agent's ZK passport attestation (anonymous reputation proof).",
        parameters:  {
          claimedScore: {
            type:        "number",
            description: "Score to attest (must be ≤ actual score)",
          },
        },
        async handler(params: Record<string, unknown>) {
          if (!miner) return { error: "NullMiner not initialized" };
          const score = (params.claimedScore as number) ?? 0;
          return miner.attest(score);
        },
      },
    ],

    destroy(): void {
      miner?.stop();
      miner = null;
    },
  };
}
