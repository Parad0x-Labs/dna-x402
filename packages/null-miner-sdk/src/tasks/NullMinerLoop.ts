/**
 * null-miner-sdk — NULL Miner Task Loop
 *
 * Full end-to-end task loop (pure in-memory, no RPC):
 *   1. Platform posts encrypted task (ECDH dark pool)
 *   2. Agent scans with DKSAP scan key → decrypts task
 *   3. Agent executes task → builds proof hash
 *   4. Agent builds Semaphore signal witness (ZK identity)
 *   5. Builds dark_semaphore Signal instruction payload
 *   6. Builds x402 receipt anchor payload
 *   7. Returns completed loop result with all step data
 *
 * No Solana RPC, no wallets, no real transactions.
 * Use TaskLoopSimulator.run() for full integration tests.
 */

import { createHash, randomBytes } from "crypto";
import { x25519 } from "@noble/curves/ed25519";
import { encryptTask, decryptTask } from "../privacy/darkPool.js";
import {
  deriveIdentityFromKey,
  IncrementalMerkleTree,
  buildSignalWitness,
  buildExternalNullifier,
  computeNullifierHash,
} from "../zk/semaphore.js";
import { buildReceiptWitness, computeReceiptPublicInputs } from "../zk/receipt.js";
import { anchorReceiptPayload } from "../x402/index.js";
import type { VerifiedPayment } from "../x402/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Config for a task loop run. */
export interface TaskLoopConfig {
  /** Agent's X25519 scan private key (32 bytes). Used to decrypt tasks. */
  agentScanPriv: Uint8Array;
  /** Agent's Ed25519 spend key (32 bytes). Used to derive Semaphore identity. */
  agentSpendKey: Uint8Array;
  /** Platform identifier (e.g. "null-miner-devnet"). */
  platformId: string;
  /** Task group used as externalNullifier context — typically a round/epoch ID. */
  taskGroupId: string;
  /** USDC reward value for tasks in this group. */
  rewardUsdc: number;
}

/** One pipeline step's outcome. */
export interface TaskLoopStep {
  step: number;
  name: string;
  success: boolean;
  data: Record<string, unknown>;
}

/** Full result of a completed task loop. */
export interface TaskLoopResult {
  success: boolean;
  steps: TaskLoopStep[];
  taskId: string;
  /** Semaphore nullifier hash (hex). */
  nullifierHash: string;
  /** SHA-256 receipt hash (hex). */
  receiptHash: string;
  /** 98-byte dark_semaphore Signal instruction data (base64). */
  semaphoreInstructionData: string;
  /** DNA x402 receipt anchor instruction data (base64, 34 bytes). */
  receiptAnchorData: string;
  usdcEarned: number;
  /** NULL yield = rewardUsdc * 0.05 flywheel. */
  nullYield: number;
  elapsedMs: number;
}

/** An encrypted task as published by the platform. */
export interface EncryptedTaskPayload {
  /** Ephemeral sender public key (hex, 32 bytes). */
  ephemeralPub: string;
  /** AES-256-GCM nonce (hex, 12 bytes). */
  nonce: string;
  /** Authentication tag (hex, 16 bytes). */
  tag: string;
  /** Ciphertext (hex). */
  ciphertext: string;
  /** Task identifier (hex, 32 bytes). */
  taskId: string;
  /** USDC reward for this task. */
  rewardUsdc: number;
}

// ── Mock Task Builder ─────────────────────────────────────────────────────────

/**
 * Create a mock encrypted task for testing.
 * Encrypts a residential_relay task JSON to the given agent scan public key.
 */
export function createMockEncryptedTask(
  agentScanPub: Uint8Array,
  taskId: string,
  rewardUsdc: number,
): EncryptedTaskPayload {
  const taskJson = {
    taskId,
    kind: "residential_relay",
    rewardUsdc,
    expiresAt: Date.now() + 60_000,
  };

  const { encrypted } = encryptTask(taskJson, agentScanPub);

  return {
    ephemeralPub: encrypted.ephemeralPub,
    nonce:        encrypted.nonce,
    tag:          encrypted.tag,
    ciphertext:   encrypted.ciphertext,
    taskId,
    rewardUsdc,
  };
}

// ── Core Loop ─────────────────────────────────────────────────────────────────

/**
 * Run the full NULL Miner task loop (pure in-memory, no RPC).
 *
 * @param config         — agent keys + platform context
 * @param encryptedTask  — task posted by the platform (from createMockEncryptedTask or real marketplace)
 */
export async function runNullMinerTaskLoop(
  config: TaskLoopConfig,
  encryptedTask: EncryptedTaskPayload,
): Promise<TaskLoopResult> {
  const startMs = Date.now();
  const steps: TaskLoopStep[] = [];

  let nullifierHash = "";
  let receiptHash   = "";
  let semaphoreInstructionData = "";
  let receiptAnchorData = "";
  const taskId = encryptedTask.taskId;

  // ── Step 1: Scan and decrypt task ─────────────────────────────────────────

  let decryptedTask: Record<string, unknown> | null = null;
  try {
    const agentScanPub = x25519.getPublicKey(config.agentScanPriv);
    decryptedTask = decryptTask<Record<string, unknown>>(
      {
        ephemeralPub: encryptedTask.ephemeralPub,
        nonce:        encryptedTask.nonce,
        tag:          encryptedTask.tag,
        ciphertext:   encryptedTask.ciphertext,
      },
      config.agentScanPriv,
    );
    steps.push({
      step: 1,
      name: "scan-task",
      success: true,
      data: {
        taskId,
        kind:       decryptedTask["kind"],
        rewardUsdc: decryptedTask["rewardUsdc"],
        agentScanPub: Buffer.from(agentScanPub).toString("hex"),
      },
    });
  } catch (err) {
    steps.push({
      step: 1,
      name: "scan-task",
      success: false,
      data: { error: String(err) },
    });
    return _failResult(steps, taskId, startMs);
  }

  // ── Step 2: Build Semaphore identity from spend key ───────────────────────

  const identity = deriveIdentityFromKey(Buffer.from(config.agentSpendKey));
  steps.push({
    step: 2,
    name: "build-identity",
    success: true,
    data: {
      identityCommitment: identity.identityCommitment.toString("hex"),
    },
  });

  // ── Step 3: Insert identity into Merkle tree ──────────────────────────────

  const tree = new IncrementalMerkleTree(20);
  const leafIndex = tree.insert(identity.identityCommitment);
  steps.push({
    step: 3,
    name: "insert-tree",
    success: true,
    data: {
      leafIndex,
      merkleRoot: tree.root.toString("hex"),
      treeSize:   tree.size,
    },
  });

  // ── Step 4: Build signal witness ──────────────────────────────────────────

  const externalNullifier = buildExternalNullifier(
    "null-miner-task-v1",
    config.taskGroupId + ":" + taskId,
  );

  const signal = Buffer.from(taskId.startsWith("0x") ? taskId.slice(2) : taskId, "hex").length === 32
    ? Buffer.from(taskId.startsWith("0x") ? taskId.slice(2) : taskId, "hex")
    : createHash("sha256").update(taskId, "utf8").digest();

  const witness = buildSignalWitness({
    identity,
    tree,
    leafIndex,
    externalNullifier,
    signal,
  });

  nullifierHash = witness.nullifierHash.toString("hex");

  steps.push({
    step: 4,
    name: "build-witness",
    success: true,
    data: {
      nullifierHash,
      externalNullifier: externalNullifier.toString("hex"),
      signalHash: witness.signalHash.toString("hex"),
    },
  });

  // ── Step 5: Build receipt anchor inputs ───────────────────────────────────

  // Compute receipt hash: SHA-256("agent-receipt-v1:" || nullifierHash || ":" || taskId || ":" || platformId)
  receiptHash = createHash("sha256")
    .update(`agent-receipt-v1:${nullifierHash}:${taskId}:${config.platformId}`)
    .digest("hex");

  // Nullifier seed for receipt circuit: derive from identity nullifier + taskId
  const nullifierSeed = createHash("sha256")
    .update(identity.nullifier)
    .update(Buffer.from(taskId, "utf8"))
    .digest("hex");

  // Normalise taskId to 64-char hex for buildReceiptWitness
  const taskIdHex = taskId.replace(/^0x/, "").padStart(64, "0").slice(0, 64);

  const receiptWitness = buildReceiptWitness({
    payerAddress:  config.platformId,
    amountAtomic:  Math.floor(encryptedTask.rewardUsdc * 1_000_000),
    resource:      "/null-miner/task/" + taskId,
    platformId:    config.platformId,
    nullifierSeed,
    taskId:        taskIdHex,
  });
  const receiptPublic = computeReceiptPublicInputs(receiptWitness);

  steps.push({
    step: 5,
    name: "build-receipt-anchor",
    success: true,
    data: {
      receiptHash,
      receiptCommitment: receiptPublic.receiptCommitment,
      receiptNullifier:  receiptPublic.nullifierHash,
    },
  });

  // ── Step 6: Encode 98-byte dark_semaphore Signal instruction ──────────────

  // Format: [0x03, nullifier_hash[32], ext_nullifier[32], signal_hash[32]]
  const ixBuf = Buffer.alloc(98);
  ixBuf[0] = 0x03; // discriminant = Signal
  witness.nullifierHash.copy(ixBuf,  1);
  externalNullifier.copy(ixBuf, 33);
  witness.signalHash.copy(ixBuf, 65);
  semaphoreInstructionData = ixBuf.toString("base64");

  steps.push({
    step: 6,
    name: "semaphore-payload",
    success: true,
    data: {
      byteLength:  98,
      discriminant: "0x03",
      base64Length: semaphoreInstructionData.length,
    },
  });

  // ── Step 7: Build x402 receipt anchor payload ─────────────────────────────

  const mockPayment: VerifiedPayment = {
    valid:        true,
    payerAddress: config.platformId,
    amountUsdc:   encryptedTask.rewardUsdc,
    amountAtomic: Math.floor(encryptedTask.rewardUsdc * 1_000_000),
    receiptHash,
    resource:     "/null-miner/task/" + taskId,
    network:      "solana-devnet",
  };

  const anchorPayload = anchorReceiptPayload(mockPayment, {
    platformId:     config.platformId,
    routeToFlywheel: true,
  });
  receiptAnchorData = anchorPayload.instructionDataBase64;

  steps.push({
    step: 7,
    name: "x402-anchor",
    success: true,
    data: {
      anchorProgramId: anchorPayload.anchorProgramId,
      memo:            anchorPayload.memo,
      slot:            anchorPayload.slot,
      instructionBytes: Buffer.from(receiptAnchorData, "base64").length,
    },
  });

  // ── Done ──────────────────────────────────────────────────────────────────

  const nullYield = encryptedTask.rewardUsdc * 0.05;

  return {
    success:                  true,
    steps,
    taskId,
    nullifierHash,
    receiptHash,
    semaphoreInstructionData,
    receiptAnchorData,
    usdcEarned:               encryptedTask.rewardUsdc,
    nullYield,
    elapsedMs:                Date.now() - startMs,
  };
}

// ── TaskLoopSimulator ─────────────────────────────────────────────────────────

/** Convenience simulator for integration tests and devnet benchmarking. */
export class TaskLoopSimulator {
  private readonly config: TaskLoopConfig;
  private _tasksRun = 0;
  private _totalUsdcEarned = 0;
  private _totalNullYield  = 0;

  constructor(config: TaskLoopConfig) {
    this.config = config;
  }

  /**
   * Generate a mock encrypted task and run the full loop.
   * @param taskId — optional; random 32-byte hex if omitted
   */
  async run(taskId?: string): Promise<TaskLoopResult> {
    const id = taskId ?? randomBytes(32).toString("hex");
    const agentScanPub = x25519.getPublicKey(this.config.agentScanPriv);
    const encTask = createMockEncryptedTask(agentScanPub, id, this.config.rewardUsdc);
    const result  = await runNullMinerTaskLoop(this.config, encTask);

    if (result.success) {
      this._tasksRun++;
      this._totalUsdcEarned += result.usdcEarned;
      this._totalNullYield  += result.nullYield;
    }
    return result;
  }

  /** Accumulated simulator statistics. */
  stats(): { tasksRun: number; totalUsdcEarned: number; totalNullYield: number } {
    return {
      tasksRun:        this._tasksRun,
      totalUsdcEarned: this._totalUsdcEarned,
      totalNullYield:  this._totalNullYield,
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _failResult(steps: TaskLoopStep[], taskId: string, startMs: number): TaskLoopResult {
  return {
    success: false,
    steps,
    taskId,
    nullifierHash:            "",
    receiptHash:              "",
    semaphoreInstructionData: "",
    receiptAnchorData:        "",
    usdcEarned:               0,
    nullYield:                0,
    elapsedMs:                Date.now() - startMs,
  };
}
