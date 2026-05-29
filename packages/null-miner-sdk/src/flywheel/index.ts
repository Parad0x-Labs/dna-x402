/**
 * null-miner-sdk — NULL Flywheel
 *
 * Work-backed token economics: ZK receipt proof → NULL mint authorization.
 * Receipt commitments gate NULL issuance — no free minting, no inflation without work.
 *
 * Token flow:
 *   TaskComplete → x402 receipt → receipt_anchor on-chain →
 *   flywheel router computes NULL yield -> mint-gate claim commitment ->
 *   host wallet receives NULL after the active beta/mainnet mint path approves the claim
 */

import { createHash } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Flywheel configuration. */
export interface FlywheelConfig {
  /** Emission rate as a percentage of task USDC value (0–100; default 5 = 5%). */
  nullEmissionRatePct: number;
  /** Epoch duration in milliseconds (default 86400000 = 24h). */
  epochDurationMs: number;
  /** Maximum NULL that can be emitted per epoch (default 10000). */
  maxNullPerEpoch: number;
  /** Platform identifier (for authorization hash). */
  platformId: string;
}

/** NULL yield computed for a single task completion. */
export interface FlywheelYield {
  taskId: string;
  /** USDC earned from the task (in dollars). */
  usdcEarned: number;
  /** NULL tokens to mint. */
  nullYield: number;
  /** Claim authorization hash (hex). Used by the on-chain mint gate or a gated beta minter. */
  mintAuthorizationHash: string;
  /** Current epoch identifier. */
  epochId: number;
  /** True if the epoch's NULL cap was reached and yield was clipped. */
  isEpochCapped: boolean;
}

/** Aggregated statistics for one epoch. */
export interface EpochStats {
  epochId: number;
  startMs: number;
  endMs: number;
  totalNullEmitted: number;
  totalUsdcWorked: number;
  taskCount: number;
  isCapped: boolean;
}

// ── Standalone functions ──────────────────────────────────────────────────────

/**
 * Compute raw NULL yield from a USDC amount and emission rate.
 *
 * @param usdcEarned — USDC amount (dollars)
 * @param ratePct    — emission rate in percent (e.g. 5 = 5%)
 */
export function computeNullYield(usdcEarned: number, ratePct: number): number {
  return usdcEarned * (ratePct / 100);
}

/**
 * Build the mint authorization hash for a completed task.
 *
 * Hash = SHA-256(
 *   "null-flywheel-mint-v1" ||
 *   taskId_utf8 ||
 *   receiptCommitment_utf8 ||
 *   nullYield_f64_bytes (big-endian IEEE 754) ||
 *   epochId_u32_be
 * )
 */
export function buildMintAuthorizationHash(
  taskId: string,
  receiptCommitment: string,
  nullYield: number,
  epochId: number,
): string {
  // Encode nullYield as IEEE 754 64-bit (8 bytes, big-endian)
  const yieldBuf = Buffer.allocUnsafe(8);
  yieldBuf.writeDoubleBE(nullYield, 0);

  // Encode epochId as u32 big-endian (4 bytes)
  const epochBuf = Buffer.allocUnsafe(4);
  epochBuf.writeUInt32BE(epochId >>> 0, 0);

  return createHash("sha256")
    .update(Buffer.from("null-flywheel-mint-v1"))
    .update(Buffer.from(taskId, "utf8"))
    .update(Buffer.from(receiptCommitment, "utf8"))
    .update(yieldBuf)
    .update(epochBuf)
    .digest("hex");
}

// ── NullFlywheel class ────────────────────────────────────────────────────────

/** NULL Flywheel — tracks work-backed NULL emission per epoch. */
export class NullFlywheel {
  private readonly cfg: Required<FlywheelConfig>;
  /** epoch id → mutable stats */
  private readonly epochs: Map<number, EpochStats> = new Map();

  constructor(config: FlywheelConfig) {
    this.cfg = {
      nullEmissionRatePct: config.nullEmissionRatePct,
      epochDurationMs:     config.epochDurationMs,
      maxNullPerEpoch:     config.maxNullPerEpoch,
      platformId:          config.platformId,
    };
  }

  // ── Epoch helpers ──────────────────────────────────────────────────────────

  /** Epoch ID for a given timestamp (defaults to now). */
  private epochIdFor(ms: number = Date.now()): number {
    return Math.floor(ms / this.cfg.epochDurationMs);
  }

  /** Get or create mutable stats for an epoch. */
  private getOrCreateEpoch(epochId: number): EpochStats {
    if (!this.epochs.has(epochId)) {
      const startMs = epochId * this.cfg.epochDurationMs;
      this.epochs.set(epochId, {
        epochId,
        startMs,
        endMs:            startMs + this.cfg.epochDurationMs,
        totalNullEmitted: 0,
        totalUsdcWorked:  0,
        taskCount:        0,
        isCapped:         false,
      });
    }
    return this.epochs.get(epochId)!;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Compute NULL yield for a completed task.
   * Applies epoch cap: if the epoch is already at maxNullPerEpoch, yield is 0.
   */
  computeYield(
    taskId: string,
    usdcEarned: number,
    receiptCommitment: string,
  ): FlywheelYield {
    const epochId = this.epochIdFor();
    const epoch   = this.getOrCreateEpoch(epochId);

    let rawYield = computeNullYield(usdcEarned, this.cfg.nullEmissionRatePct);
    let isEpochCapped = false;

    const remaining = this.cfg.maxNullPerEpoch - epoch.totalNullEmitted;
    if (remaining <= 0) {
      rawYield = 0;
      isEpochCapped = true;
    } else if (rawYield > remaining) {
      rawYield = remaining;
      isEpochCapped = true;
    }

    const mintAuthorizationHash = buildMintAuthorizationHash(
      taskId,
      receiptCommitment,
      rawYield,
      epochId,
    );

    return {
      taskId,
      usdcEarned,
      nullYield: rawYield,
      mintAuthorizationHash,
      epochId,
      isEpochCapped,
    };
  }

  /**
   * Record an emitted yield into the epoch's running totals.
   * Call after computeYield if you want epoch stats to stay consistent.
   */
  recordEmission(yld: FlywheelYield): void {
    const epoch = this.getOrCreateEpoch(yld.epochId);
    epoch.totalNullEmitted += yld.nullYield;
    epoch.totalUsdcWorked  += yld.usdcEarned;
    epoch.taskCount        += 1;
    if (epoch.totalNullEmitted >= this.cfg.maxNullPerEpoch) {
      epoch.isCapped = true;
    }
  }

  /** Stats for the current epoch (creates an empty record if it doesn't exist yet). */
  currentEpoch(): EpochStats {
    return this.getOrCreateEpoch(this.epochIdFor());
  }

  /** All epoch stats recorded so far (chronological order). */
  epochHistory(): EpochStats[] {
    return Array.from(this.epochs.values()).sort((a, b) => a.epochId - b.epochId);
  }

  /** Sum of all NULL emitted across all epochs. */
  totalNullEmitted(): number {
    let total = 0;
    for (const e of this.epochs.values()) total += e.totalNullEmitted;
    return total;
  }
}
