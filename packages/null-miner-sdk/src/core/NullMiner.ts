/**
 * NULL Miner SDK — Main Class
 *
 * The single entry point for any app integrating NULL Miner.
 *
 * Usage (3 lines):
 *   import { NullMiner } from "null-miner-sdk";
 *   const miner = new NullMiner({ rpcUrl, hostWallet, platformId });
 *   await miner.start();
 *
 * The miner handles everything:
 *   - Generates a Dark Agent Passport (ZK identity, stealth addresses)
 *   - Scans the DNA x402 marketplace for profitable tasks
 *   - Executes tasks autonomously (bandwidth relay, app store data, location proof)
 *   - Receives USDC directly via x402 escrow auto-release
 *   - Emits NULL token yield to the host wallet via the Flywheel
 *   - Builds reputation over time → unlocks higher-tier tasks
 */

import { randomBytes } from "crypto";
import { AgentPassport } from "./Passport.js";
import { AgentLoop } from "./AgentLoop.js";
import type { NullMinerConfig, MinerStats, PassportAttestation } from "./types.js";

export class NullMiner {
  private readonly passport: AgentPassport;
  private readonly loop: AgentLoop;
  private readonly config: NullMinerConfig;

  constructor(config: NullMinerConfig) {
    this.config = config;

    // Generate or restore spend key
    // In production: persist to secure storage (Keychain / Chrome extension storage)
    const spendKey = this.loadOrCreateSpendKey(config.platformId);

    this.passport = new AgentPassport({
      spendKey,
      epoch: Math.floor(Date.now() / 172_800_000),
    });

    this.loop = new AgentLoop(config, this.passport);

    console.log(`[NullMiner] Initialized`);
    console.log(`[NullMiner] Passport:  ${this.passport.passportId.slice(0, 32)}...`);
    console.log(`[NullMiner] Platform:  ${config.platformId}`);
    console.log(`[NullMiner] Host:      ${config.hostWallet.publicKey.slice(0, 16)}...`);
    console.log(`[NullMiner] Dry run:   ${config.dryRun ?? false}`);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  // ── Stats & Identity ───────────────────────────────────────────────────────

  getStats(): MinerStats {
    return this.loop.getStats();
  }

  getPassportId(): string {
    return this.passport.passportId;
  }

  /**
   * Generate a ZK attestation of this agent's reputation.
   * Share with task marketplaces or other protocols.
   */
  attest(claimedScore: number): PassportAttestation {
    return this.passport.attest(claimedScore);
  }

  // ── Key Management ─────────────────────────────────────────────────────────

  /**
   * Loads spend key from storage or generates a new one.
   * Key is namespaced by platformId so different apps get different agents.
   */
  private loadOrCreateSpendKey(platformId: string): string {
    const storageKey = `null-miner-spend-key:${platformId}`;

    // Browser / extension context
    if (typeof globalThis.localStorage !== "undefined") {
      const existing = globalThis.localStorage.getItem(storageKey);
      if (existing && existing.length === 64) return existing;
      const fresh = randomBytes(32).toString("hex");
      globalThis.localStorage.setItem(storageKey, fresh);
      return fresh;
    }

    // Node.js context (tests / devnet)
    return randomBytes(32).toString("hex");
  }
}
