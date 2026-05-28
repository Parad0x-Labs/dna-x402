/**
 * Task Marketplace — In-memory task store
 *
 * Production: replace with Postgres + Redis queue + Solana escrow anchoring.
 * Devnet: in-memory store, auto-generates realistic tasks every 5 minutes.
 */

import { createHash, randomBytes } from "crypto";

// ── Task Types (mirrored from SDK) ────────────────────────────────────────────

export type TaskKind =
  | "residential_relay"
  | "app_store_snapshot"
  | "location_attestation"
  | "sensor_sample"
  | "protocol_maintenance";

export type ReputationTier = "bronze" | "silver" | "gold" | "elite";

export interface MarketplaceTask {
  taskId:         string;
  kind:           TaskKind;
  rewardUsdc:     number;
  expiresAtSlot:  number;
  proofRequirements: {
    expectedProofHash: string;
    maxLatencyMs?:     number;
    minAccuracyMeters?: number;
  };
  encryptedPayload?: string;
  /** Minimum tier required to claim this task */
  minTier:        ReputationTier;
  /** Platform that posted this task (earns reward when task completes) */
  posterId:       string;
  /** Who claimed it (null = available) */
  claimedBy:      string | null;
  claimedAt:      number | null;
  /** Has this task been completed + proof verified? */
  completed:      boolean;
  completedAt:    number | null;
  createdAt:      number;
}

export interface ClaimRecord {
  taskId:      string;
  passportId:  string;
  platformId:  string;
  claimedAt:   number;
}

export interface CompletionRecord {
  taskId:      string;
  passportId:  string;
  platformId:  string;
  proofHash:   string;
  usdcEarned:  number;
  nullYield:   number;
  completedAt: number;
}

// ── Store ────────────────────────────────────────────────────────────────────

class TaskStore {
  private tasks       = new Map<string, MarketplaceTask>();
  private completions = new Map<string, CompletionRecord>();

  constructor() {
    this.generateTasks();
    // Refresh task pool every 5 minutes
    setInterval(() => this.generateTasks(), 5 * 60 * 1000);
    // Expire stale claims every 2 minutes
    setInterval(() => this.expireClaims(), 2 * 60 * 1000);
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  getAvailable(tier: ReputationTier, platformId: string): MarketplaceTask[] {
    const tierRank = { bronze: 0, silver: 1, gold: 2, elite: 3 };
    const now      = Date.now();

    return Array.from(this.tasks.values()).filter(t =>
      !t.claimedBy &&
      !t.completed &&
      now < t.expiresAtSlot * 400 &&
      tierRank[tier] >= tierRank[t.minTier]
    );
  }

  get(taskId: string): MarketplaceTask | undefined {
    return this.tasks.get(taskId);
  }

  // ── Claim ────────────────────────────────────────────────────────────────────

  claim(taskId: string, passportId: string, platformId: string): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task)             return { ok: false, error: "task not found" };
    if (task.claimedBy)    return { ok: false, error: "already claimed" };
    if (task.completed)    return { ok: false, error: "already completed" };
    if (Date.now() > task.expiresAtSlot * 400) return { ok: false, error: "expired" };

    task.claimedBy = passportId;
    task.claimedAt = Date.now();
    return { ok: true };
  }

  // ── Complete + Verify Proof ──────────────────────────────────────────────────

  complete(
    taskId:     string,
    passportId: string,
    platformId: string,
    proofHash:  string,
    opts: { allowProofMismatch?: boolean } = {},
  ): { ok: boolean; usdcEarned?: number; nullYield?: number; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task)                          return { ok: false, error: "task not found" };
    if (task.claimedBy !== passportId)  return { ok: false, error: "not your task" };
    if (task.completed)                 return { ok: false, error: "already completed" };

    // Proof verification: reject wrong hashes by default.
    // Set NULL_MINER_DEV_ALLOW_PROOF_MISMATCH=true only in local devnet testing.
    // Production will replace this with real Groth16 / anchor receipt validation.
    const proofMatch = proofHash === task.proofRequirements.expectedProofHash;
    if (!proofMatch) {
      if (!opts.allowProofMismatch) {
        return { ok: false, error: "proof hash mismatch" };
      }
      console.warn(`[TaskStore][DEV] Proof mismatch for ${taskId.slice(0, 16)} — allowProofMismatch=true`);
    }

    const usdcEarned = task.rewardUsdc * 0.9;   // 90% to agent
    const nullYield  = (usdcEarned * 0.05);      // 5% flywheel

    task.completed   = true;
    task.completedAt = Date.now();

    const record: CompletionRecord = {
      taskId, passportId, platformId, proofHash,
      usdcEarned, nullYield, completedAt: Date.now(),
    };
    this.completions.set(taskId, record);

    console.log(`[TaskStore] ✓ ${task.kind} | $${usdcEarned.toFixed(4)} → ${passportId.slice(0, 12)}...`);
    return { ok: true, usdcEarned, nullYield };
  }

  getCompletions(platformId?: string): CompletionRecord[] {
    const all = Array.from(this.completions.values());
    return platformId ? all.filter(c => c.platformId === platformId) : all;
  }

  // ── Task Generation ──────────────────────────────────────────────────────────

  private generateTasks(): void {
    const now        = Date.now();
    const slot       = Math.floor(now / 400);
    const POSTER_IDS = ["parad0x-internal", "enterprise-001", "devnet-faucet"];

    const templates: Array<Omit<MarketplaceTask, "taskId" | "proofRequirements" | "posterId" | "claimedBy" | "claimedAt" | "completed" | "completedAt" | "createdAt">> = [
      // Residential relay — bronze accessible, high volume
      { kind: "residential_relay",    rewardUsdc: 0.005, expiresAtSlot: slot + 2000, minTier: "bronze" },
      { kind: "residential_relay",    rewardUsdc: 0.008, expiresAtSlot: slot + 1500, minTier: "silver" },
      { kind: "residential_relay",    rewardUsdc: 0.012, expiresAtSlot: slot + 1000, minTier: "gold",   encryptedPayload: "eyJhbGciOiJub25lIn0.eyJ0YXJnZXQiOiJodHRwczovL2FwaS5wcmVtaXVtLmV4YW1wbGUuY29tIn0." },
      // App store snapshots — medium difficulty
      { kind: "app_store_snapshot",   rewardUsdc: 0.002, expiresAtSlot: slot + 3000, minTier: "bronze" },
      { kind: "app_store_snapshot",   rewardUsdc: 0.004, expiresAtSlot: slot + 2500, minTier: "silver" },
      // Location attestation — privacy-sensitive, pays more
      { kind: "location_attestation", rewardUsdc: 0.003, expiresAtSlot: slot + 2000, minTier: "bronze" },
      { kind: "location_attestation", rewardUsdc: 0.007, expiresAtSlot: slot + 1000, minTier: "gold" },
      // Sensor samples — quick, low pay
      { kind: "sensor_sample",        rewardUsdc: 0.001, expiresAtSlot: slot + 5000, minTier: "bronze" },
      { kind: "sensor_sample",        rewardUsdc: 0.0015,expiresAtSlot: slot + 4000, minTier: "bronze" },
      // Protocol maintenance — tiny but guaranteed
      { kind: "protocol_maintenance", rewardUsdc: 0.0005,expiresAtSlot: slot + 8000, minTier: "bronze" },
      { kind: "protocol_maintenance", rewardUsdc: 0.001, expiresAtSlot: slot + 6000, minTier: "bronze" },
    ];

    templates.forEach((tmpl, i) => {
      const seed    = `${tmpl.kind}-${slot}-${i}`;
      const taskId  = sha256(seed);
      const proof   = sha256(`${seed}-output`);

      if (this.tasks.has(taskId)) return; // already exists

      this.tasks.set(taskId, {
        taskId,
        kind:             tmpl.kind,
        rewardUsdc:       tmpl.rewardUsdc,
        expiresAtSlot:    tmpl.expiresAtSlot,
        encryptedPayload: tmpl.encryptedPayload,
        minTier:          tmpl.minTier,
        posterId:         POSTER_IDS[i % POSTER_IDS.length],
        claimedBy:        null,
        claimedAt:        null,
        completed:        false,
        completedAt:      null,
        createdAt:        now,
        proofRequirements: {
          expectedProofHash: proof,
          maxLatencyMs:      tmpl.kind === "residential_relay" ? 3000 : undefined,
          minAccuracyMeters: tmpl.kind === "location_attestation" ? 100 : undefined,
        },
      });
    });

    console.log(`[TaskStore] Generated tasks. Pool size: ${this.tasks.size}`);
  }

  private expireClaims(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.claimedBy && !task.completed) {
        // Release stale claims after 5 minutes
        if (task.claimedAt && now - task.claimedAt > 5 * 60 * 1000) {
          console.log(`[TaskStore] Releasing stale claim on ${task.taskId.slice(0, 16)}...`);
          task.claimedBy = null;
          task.claimedAt = null;
        }
      }
    }
  }
}

export const taskStore = new TaskStore();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
