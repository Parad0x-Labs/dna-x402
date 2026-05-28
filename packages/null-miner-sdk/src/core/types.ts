/**
 * NULL Miner SDK — Core Types
 *
 * Universal type definitions for the NULL Miner agent economy.
 * Any platform integrating this SDK uses these types.
 */

// ── Task Types ────────────────────────────────────────────────────────────────

export enum TaskKind {
  /** Proxy an HTTP request via the host's residential IP. Pays per successful relay. */
  ResidentialRelay = "residential_relay",
  /** Query App Store / Google Play data. Pays per verified snapshot. */
  AppStoreSnapshot = "app_store_snapshot",
  /** Generate a ZK proof-of-location (no exact coords revealed). */
  LocationAttestation = "location_attestation",
  /** Collect sensor data sample (accelerometer, barometer, etc). */
  SensorSample = "sensor_sample",
  /** Protocol maintenance — closes expired accounts, compacts roots. */
  ProtocolMaintenance = "protocol_maintenance",
}

export interface TaskSpec {
  taskId: string;           // hex-encoded 32-byte job ID
  kind: TaskKind;
  rewardUsdc: number;       // USDC reward for completing this task
  expiresAtSlot: number;
  proofRequirements: ProofRequirements;
  /** Encrypted payload — only matched node can decrypt. Null if public task. */
  encryptedPayload?: string; // base64
}

export interface ProofRequirements {
  /** SHA-256 hash the proof output must match. */
  expectedProofHash: string; // hex
  /** Max allowed latency in ms for relay tasks. */
  maxLatencyMs?: number;
  /** Minimum GPS accuracy for location tasks. */
  minAccuracyMeters?: number;
}

export interface TaskProof {
  taskId: string;
  kind: TaskKind;
  outputHash: string;   // hex SHA-256 of the task output
  latencyMs?: number;
  agentPassportId: string;  // ZK passport ID — no wallet address
  timestamp: number;
}

export interface TaskResult {
  taskId: string;
  proof: TaskProof;
  usdcEarned: number;
  /** NULL tokens earned by the host (not the agent) via flywheel. */
  nullYield: number;
  slot: number;
}

// ── Agent / Passport ──────────────────────────────────────────────────────────

export interface PassportConfig {
  /** Secret spend key — never leaves the device. 32 bytes hex. */
  spendKey: string;
  /** Current epoch for reputation tracking. */
  epoch?: number;
}

export interface PassportAttestation {
  passportId: string;   // H(spend_key_commitment) — stable, anonymous
  reputationScore: number;  // 0–1000
  tier: ReputationTier;
  /** ZK proof blob (SHA-256 stub now, Groth16 Phase 2). */
  proofBlob: string;  // hex
}

export enum ReputationTier {
  Bronze = "bronze",   // 0–199 → Tier 1 tasks
  Silver = "silver",   // 200–499 → Tier 1-2 tasks
  Gold   = "gold",     // 500–799 → all tasks
  Elite  = "elite",    // 800–1000 → enterprise dark pool + priority
}

// ── Miner Config ──────────────────────────────────────────────────────────────

export interface NullMinerConfig {
  /** Solana RPC URL. Devnet for testing, mainnet for production. */
  rpcUrl: string;
  /** The host wallet — receives NULL token yield. Any Solana wallet. */
  hostWallet: HostWallet;
  /** Platform identifier — used for fee attribution. */
  platformId: string;
  /** Which task types this node will accept. Default: all. */
  allowedTasks?: TaskKind[];
  /** Minimum USDC reward to bother claiming a task. Default: 0.001. */
  minRewardUsdc?: number;
  /** Max tasks per hour. Default: 60. */
  maxTasksPerHour?: number;
  /**
   * Task marketplace URL. If set, the AgentLoop fetches real tasks and submits
   * proofs via this endpoint (e.g. "http://localhost:3742").
   * Falls back to devnet mock tasks when unset or unreachable.
   */
  marketplaceUrl?: string;
  /** Run without submitting real transactions. Default: false. */
  dryRun?: boolean;
  /**
   * Allow proof hash mismatches in developer/devnet mode. Default: false.
   * When false (the default), a wrong proof hash throws an error — escrow would reject it anyway.
   * Set true only for local devnet testing where mock tasks have derived proof hashes.
   */
  allowProofMismatchInDev?: boolean;
  /** NULL flywheel rate — % of task USDC value → NULL yield. Default: 5. */
  nullEmissionRatePct?: number;
  /** Called whenever the miner earns a reward. */
  onEarn?: (result: TaskResult) => void;
  /** Called on error. Default: console.error. */
  onError?: (err: Error, taskId?: string) => void;
}

export interface HostWallet {
  publicKey: string;            // base58 Solana address
  signTransaction: (tx: unknown) => Promise<unknown>;
}

// ── Platform Adapter Types ────────────────────────────────────────────────────

export interface ContentGateOptions {
  /** Price in USDC to unlock this content. */
  priceUsdc: number;
  /** Wallet address that receives the USDC payment. */
  recipientAddress: string;
  /** Human-readable description shown to payer. */
  description?: string;
  /** Whether to issue an on-chain receipt. Default: true. */
  anchorReceipt?: boolean;
}

export interface PlatformFeeConfig {
  /** Platform's cut of each payment (0–1). Default: 0.10 (10%). */
  platformFeePct?: number;
  /** Platform's wallet address for fee collection. */
  platformWallet: string;
}

// ── Earnings Tracking ─────────────────────────────────────────────────────────

export interface MinerStats {
  tasksCompleted: number;
  usdcEarned: number;
  nullEarned: number;
  uptime: number;         // seconds since start
  currentTier: ReputationTier;
  reputationScore: number;
}
