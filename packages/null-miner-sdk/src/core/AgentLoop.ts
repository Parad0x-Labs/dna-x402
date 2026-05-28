/**
 * NULL Miner SDK — Agent Loop
 *
 * The autonomous task scanning → claiming → completing → earning cycle.
 * This is the "sleep-earn-watcher" equivalent in TypeScript.
 *
 * The loop:
 *   1. Fetch available tasks from DNA x402 marketplace (filtered by tier + allowed kinds)
 *   2. Score tasks by profitability (reward - estimated cost)
 *   3. Claim the best task via dark-agent-escrow (pull-based)
 *   4. Execute the task (delegate to TaskExecutor)
 *   5. Submit proof → escrow auto-releases USDC
 *   6. Report NULL yield to flywheel
 *   7. Update passport reputation
 *   8. Sleep until next tick
 */

import { createHash } from "crypto";
import type {
  NullMinerConfig,
  TaskSpec,
  TaskProof,
  TaskResult,
  MinerStats,
} from "./types.js";
import { TaskKind, ReputationTier } from "./types.js";
import { AgentPassport } from "./Passport.js";
import { TaskRegistry } from "../tasks/TaskRegistry.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;   // 30s between scans
const DEFAULT_MIN_REWARD_USDC  = 0.001;
const DEFAULT_MAX_TASKS_PER_HR = 60;
const DEFAULT_NULL_EMISSION_PCT = 5;

export class AgentLoop {
  private readonly config: Required<NullMinerConfig>;
  private readonly passport: AgentPassport;
  private readonly registry: TaskRegistry;

  private running = false;
  private stats: MinerStats = {
    tasksCompleted: 0,
    usdcEarned: 0,
    nullEarned: 0,
    uptime: 0,
    currentTier: ReputationTier.Bronze,
    reputationScore: 0,
  };
  private startedAt = 0;
  private tasksThisHour = 0;
  private hourWindowStart = 0;

  constructor(config: NullMinerConfig, passport: AgentPassport) {
    this.config = {
      allowedTasks:       config.allowedTasks       ?? Object.values(TaskKind),
      minRewardUsdc:      config.minRewardUsdc       ?? DEFAULT_MIN_REWARD_USDC,
      maxTasksPerHour:    config.maxTasksPerHour     ?? DEFAULT_MAX_TASKS_PER_HR,
      dryRun:                   config.dryRun                   ?? false,
      allowProofMismatchInDev:  config.allowProofMismatchInDev  ?? false,
      nullEmissionRatePct: config.nullEmissionRatePct ?? DEFAULT_NULL_EMISSION_PCT,
      onEarn:             config.onEarn              ?? (() => {}),
      onError:            config.onError             ?? ((e) => console.error("[NullMiner]", e)),
      ...config,
    } as Required<NullMinerConfig>;

    this.passport = passport;
    this.registry = new TaskRegistry();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running      = true;
    this.startedAt    = Date.now();
    this.hourWindowStart = Date.now();
    console.log(`[NullMiner] Agent ${this.passport.passportId.slice(0, 16)}... started`);
    console.log(`[NullMiner] Tier: ${this.passport.tier} | Score: ${this.passport.reputationScore}`);
    this.loop();
  }

  stop(): void {
    this.running = false;
    console.log("[NullMiner] Agent stopped");
  }

  getStats(): MinerStats {
    return {
      ...this.stats,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      currentTier: this.passport.tier,
      reputationScore: this.passport.reputationScore,
    };
  }

  // ── Core Loop ──────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.config.onError(err instanceof Error ? err : new Error(String(err)));
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async tick(): Promise<void> {
    // Reset hourly rate limit window
    if (Date.now() - this.hourWindowStart > 3_600_000) {
      this.tasksThisHour = 0;
      this.hourWindowStart = Date.now();
    }

    if (this.tasksThisHour >= this.config.maxTasksPerHour) {
      return; // rate limited
    }

    // 1. Fetch available tasks
    const available = await this.fetchAvailableTasks();
    if (available.length === 0) return;

    // 2. Filter + score
    const candidates = this.filterTasks(available);
    if (candidates.length === 0) return;

    // 3. Pick best task
    const best = this.selectBestTask(candidates);

    // 4. Claim + execute + prove
    await this.executeTask(best);
  }

  // ── Task Fetch (connects to DNA x402 marketplace) ─────────────────────────

  private marketplaceBase(): string | null {
    if (this.config.marketplaceUrl) return this.config.marketplaceUrl.replace(/\/$/, "");
    return null;
  }

  private marketplaceHeaders(): Record<string, string> {
    return {
      "X-Passport-Id": this.passport.passportId,
      "X-Platform-Id": this.config.platformId,
      "X-Tier":        this.passport.tier,
    };
  }

  private async fetchAvailableTasks(): Promise<TaskSpec[]> {
    const base = this.marketplaceBase();
    if (!base) return this.mockDevnetTasks();
    try {
      const resp = await fetch(`${base}/tasks`, {
        headers: this.marketplaceHeaders(),
      });
      if (!resp.ok) return this.mockDevnetTasks();
      return (await resp.json()) as TaskSpec[];
    } catch {
      return this.mockDevnetTasks();
    }
  }

  private filterTasks(tasks: TaskSpec[]): TaskSpec[] {
    return tasks.filter(t =>
      this.config.allowedTasks.includes(t.kind) &&
      t.rewardUsdc > this.config.minRewardUsdc &&
      Date.now() < t.expiresAtSlot * 400, // ~400ms per slot
    );
  }

  private selectBestTask(tasks: TaskSpec[]): TaskSpec {
    return tasks.reduce((best, t) => t.rewardUsdc > best.rewardUsdc ? t : best);
  }

  // ── Task Execution ─────────────────────────────────────────────────────────

  private async executeTask(task: TaskSpec): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[NullMiner][DRY RUN] Would execute task ${task.taskId} (${task.kind}) +$${task.rewardUsdc}`);
      return;
    }

    const executor = this.registry.get(task.kind);
    if (!executor) {
      throw new Error(`No executor registered for task kind: ${task.kind}`);
    }

    // Claim task (register intent with escrow)
    await this.claimTask(task);

    // Execute
    const outputHash = await executor.execute(task);

    // Build proof
    const proof = this.buildProof(task, outputHash);

    // Submit proof → escrow auto-releases
    const usdcEarned = await this.submitProof(task, proof);

    // Compute NULL yield
    const nullYield = (usdcEarned * this.config.nullEmissionRatePct) / 100;

    const result: TaskResult = {
      taskId:     task.taskId,
      proof,
      usdcEarned,
      nullYield,
      slot:       Math.floor(Date.now() / 400),
    };

    // Update state
    this.tasksThisHour++;
    this.stats.tasksCompleted++;
    this.stats.usdcEarned += usdcEarned;
    this.stats.nullEarned += nullYield;

    // Update passport reputation
    this.passport.recordReceipt({
      receiptHash:    proof.outputHash,
      programId:      sha256(task.kind),
      amountLamports: BigInt(Math.floor(usdcEarned * 1_000_000)),
      epoch:          Math.floor(Date.now() / 172_800_000), // ~2 day epochs
    });

    this.config.onEarn(result);

    console.log(
      `[NullMiner] ✓ ${task.kind} | +$${usdcEarned.toFixed(4)} USDC | +${nullYield.toFixed(6)} NULL | ` +
      `score=${this.passport.reputationScore} tier=${this.passport.tier}`
    );
  }

  // ── Escrow Interactions ────────────────────────────────────────────────────

  private async claimTask(task: TaskSpec): Promise<void> {
    const base = this.marketplaceBase();
    if (!base) {
      console.log(`[NullMiner] Claiming task ${task.taskId.slice(0, 16)}... (devnet mock)`);
      return;
    }
    const resp = await fetch(`${base}/tasks/${task.taskId}/claim`, {
      method:  "POST",
      headers: this.marketplaceHeaders(),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(`Claim failed: ${body.error ?? resp.status}`);
    }
    console.log(`[NullMiner] Claimed task ${task.taskId.slice(0, 16)}`);
  }

  private buildProof(task: TaskSpec, outputHash: string): TaskProof {
    return {
      taskId:        task.taskId,
      kind:          task.kind,
      outputHash,
      agentPassportId: this.passport.passportId,
      timestamp:     Date.now(),
    };
  }

  private async submitProof(task: TaskSpec, proof: TaskProof): Promise<number> {
    // Validate proof hash locally before hitting the wire.
    if (proof.outputHash !== task.proofRequirements.expectedProofHash) {
      if (!this.config.dryRun && !this.config.allowProofMismatchInDev) {
        throw new Error(
          `Proof hash mismatch for task ${task.taskId.slice(0, 16)}: ` +
          `expected ${task.proofRequirements.expectedProofHash.slice(0, 16)}, ` +
          `got ${proof.outputHash.slice(0, 16)}. ` +
          `Set dryRun or allowProofMismatchInDev=true to bypass in dev.`
        );
      }
      console.warn("[NullMiner][DEV] Proof hash mismatch accepted — allowProofMismatchInDev=true");
    }

    const base = this.marketplaceBase();
    if (!base) {
      // Devnet mock — no real API call, no on-chain anchor.
      return task.rewardUsdc * 0.9;
    }

    // Submit proof to marketplace API → API verifies, pays USDC, anchors receipt.
    const resp = await fetch(`${base}/tasks/${task.taskId}/proof`, {
      method:  "POST",
      headers: { ...this.marketplaceHeaders(), "Content-Type": "application/json" },
      body:    JSON.stringify({
        proofHash:       proof.outputHash,
        agentPassportId: proof.agentPassportId,
        nullifier:       this.passport.nullifierSeed(task.taskId),
      }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(`Proof submission failed: ${body.error ?? resp.status}`);
    }
    const result = await resp.json() as { usdcEarned?: number };
    return result.usdcEarned ?? task.rewardUsdc * 0.9;
  }

  // ── Devnet Mock Tasks ─────────────────────────────────────────────────────

  private mockDevnetTasks(): TaskSpec[] {
    const now = Date.now();
    return [
      {
        taskId:         sha256("devnet-relay-001"),
        kind:           TaskKind.ResidentialRelay,
        rewardUsdc:     0.005,
        expiresAtSlot:  Math.floor(now / 400) + 1000,
        proofRequirements: {
          expectedProofHash: sha256("devnet-relay-001-output"),
        },
      },
      {
        taskId:         sha256("devnet-maintenance-001"),
        kind:           TaskKind.ProtocolMaintenance,
        rewardUsdc:     0.001,
        expiresAtSlot:  Math.floor(now / 400) + 2000,
        proofRequirements: {
          expectedProofHash: sha256("devnet-maintenance-001-output"),
        },
      },
    ];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
