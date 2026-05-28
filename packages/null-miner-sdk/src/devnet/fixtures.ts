/**
 * null-miner-sdk/devnet
 *
 * Devnet fixtures and helpers for local development + testing.
 * Import these in your tests — never in production code.
 */

import { createHash } from "crypto";
import { TaskKind, ReputationTier } from "../core/types.js";
import type { TaskSpec, MinerStats } from "../core/types.js";

// ── Devnet constants ──────────────────────────────────────────────────────────

export const DEVNET_RPC       = "https://api.devnet.solana.com";
export const DEVNET_PLATFORM  = "null-miner-devnet-test";

/** Stub wallet for devnet testing — never use on mainnet */
export const DEVNET_STUB_WALLET = {
  publicKey: "11111111111111111111111111111112", // System program — placeholder
  signTransaction: async (tx: unknown) => tx,
};

// ── Mock task factory ─────────────────────────────────────────────────────────

export function makeMockTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  const seed    = overrides.taskId ?? ("mock-" + Math.random().toString(36).slice(2));
  const taskId  = sha256(seed);
  const slot    = Math.floor(Date.now() / 400) + 2000;

  return {
    taskId,
    kind:          TaskKind.ResidentialRelay,
    rewardUsdc:    0.005,
    expiresAtSlot: slot,
    proofRequirements: {
      expectedProofHash: sha256(seed + "-output"),
    },
    ...overrides,
  };
}

export function makeMockTaskSet(): TaskSpec[] {
  return [
    makeMockTask({ kind: TaskKind.ResidentialRelay,    rewardUsdc: 0.009 }),
    makeMockTask({ kind: TaskKind.AppStoreSnapshot,    rewardUsdc: 0.003 }),
    makeMockTask({ kind: TaskKind.LocationAttestation, rewardUsdc: 0.004 }),
    makeMockTask({ kind: TaskKind.SensorSample,        rewardUsdc: 0.001 }),
    makeMockTask({ kind: TaskKind.ProtocolMaintenance, rewardUsdc: 0.0005 }),
  ];
}

// ── Expected mock stats ───────────────────────────────────────────────────────

export function makeExpectedStats(overrides: Partial<MinerStats> = {}): MinerStats {
  return {
    tasksCompleted: 0,
    usdcEarned:     0,
    nullEarned:     0,
    uptime:         0,
    currentTier:    ReputationTier.Bronze,
    reputationScore: 0,
    ...overrides,
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

/** Assert a value is a valid hex string of given byte length */
export function isHex(s: string, bytes?: number): boolean {
  if (typeof s !== "string") return false;
  if (!/^[0-9a-f]+$/i.test(s)) return false;
  if (bytes !== undefined && s.length !== bytes * 2) return false;
  return true;
}

/** Assert a passport ID looks valid (64-char hex) */
export function isValidPassportId(id: string): boolean {
  return isHex(id, 32);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
