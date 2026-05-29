/**
 * null-miner-sdk — Provably-fair draw machine for NULL lottery
 *
 * Commit-reveal: house commits SHA-256(seed) at round open, reveals seed at
 * draw time. Draw is deterministic Fisher-Yates using Poseidon mixing so it is
 * fully reproducible from public inputs (seed + roundId).
 */

import { createHash, randomBytes } from "crypto";
import { poseidonHash2, hexToField, fieldToHex } from "../zk/poseidon.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DrawResult {
  roundId:       number;
  seed:          string;        // hex
  commitment:    string;        // hex: SHA-256(seed)
  drawnNumbers:  number[];      // 5 numbers from 1..=30, distinct
  drawHash:      string;        // hex: poseidon mix of seed+roundId identifying this draw
}

export interface DrawVerification {
  valid:    boolean;
  reason?:  string;
}

// ── Commitment ────────────────────────────────────────────────────────────────

/**
 * Build a commitment for a seed (house publishes this at round open).
 * commitment = SHA-256(seed_bytes)
 */
export function buildCommitment(seed: string): string {
  return createHash("sha256")
    .update(Buffer.from(seed, "hex"))
    .digest("hex");
}

// ── Draw ──────────────────────────────────────────────────────────────────────

/**
 * Reveal a seed and draw 5 numbers from 1..=30.
 * Verifies SHA-256(seed) === commitment before drawing.
 *
 * Fisher-Yates with Poseidon mixing:
 *   pool = [1..30]
 *   for i = 0..5:
 *     hashVal = poseidonHash2(hexToField(seed), BigInt(roundId * 100 + i))
 *     idx     = Number(hashVal % BigInt(30 - i))
 *     drawnNumbers[i] = pool[idx]; pool.splice(idx, 1)
 */
export function revealDraw(
  seed:       string,
  commitment: string,
  roundId:    number,
): DrawResult {
  // Verify commitment
  const expected = buildCommitment(seed);
  if (expected !== commitment) {
    throw new Error(
      `DrawMachine: commitment mismatch — seed does not match commitment`
    );
  }

  const seedField = hexToField(seed);
  const pool: number[] = [];
  for (let n = 1; n <= 30; n++) pool.push(n);

  const drawnNumbers: number[] = [];
  for (let i = 0; i < 5; i++) {
    const hashVal = poseidonHash2(seedField, BigInt(roundId * 100 + i));
    const idx     = Number(hashVal % BigInt(30 - i));
    drawnNumbers.push(pool[idx]);
    pool.splice(idx, 1);
  }

  // drawHash uniquely identifies this draw (public fingerprint)
  const drawHash = fieldToHex(
    poseidonHash2(seedField, BigInt(roundId))
  );

  return {
    roundId,
    seed,
    commitment,
    drawnNumbers,
    drawHash,
  };
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Verify a DrawResult: re-derive the draw from seed+commitment and compare.
 */
export function verifyDraw(result: DrawResult): DrawVerification {
  const { seed, commitment, roundId, drawnNumbers } = result;

  // Check basic structural constraints before re-running the draw
  if (!Array.isArray(drawnNumbers) || drawnNumbers.length !== 5) {
    return { valid: false, reason: "drawnNumbers must be an array of 5" };
  }

  for (const n of drawnNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return { valid: false, reason: `number ${n} out of range 1..30` };
    }
  }

  const unique = new Set(drawnNumbers);
  if (unique.size !== 5) {
    return { valid: false, reason: "drawnNumbers contains duplicates" };
  }

  // Re-derive and compare
  let recomputed: DrawResult;
  try {
    recomputed = revealDraw(seed, commitment, roundId);
  } catch (err: unknown) {
    return { valid: false, reason: (err as Error).message };
  }

  const same =
    recomputed.drawnNumbers.length === drawnNumbers.length &&
    recomputed.drawnNumbers.every((n, i) => n === drawnNumbers[i]);

  if (!same) {
    return { valid: false, reason: "drawnNumbers do not match recomputed draw" };
  }

  return { valid: true };
}

// ── Win Check ─────────────────────────────────────────────────────────────────

/**
 * Check if a ticket's chosen numbers match drawn numbers (must match ALL 5).
 * Both arrays are sorted before comparison — order-independent.
 */
export function checkWin(
  ticketNumbers: number[],
  drawnNumbers:  number[],
): boolean {
  if (ticketNumbers.length !== drawnNumbers.length) return false;
  const a = [...ticketNumbers].sort((x, y) => x - y);
  const b = [...drawnNumbers].sort((x, y) => x - y);
  return a.every((n, i) => n === b[i]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a random seed (32 bytes hex) for testing/devnet.
 */
export function generateSeed(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Build fallback winner index from seed + pool size.
 * winner_index = Number(poseidonHash2(hexToField(seed), BigInt(poolSize)) % BigInt(poolSize))
 */
export function buildFallbackWinnerIndex(seed: string, poolSize: number): number {
  if (poolSize <= 0) throw new Error("DrawMachine: poolSize must be > 0");
  const h = poseidonHash2(hexToField(seed), BigInt(poolSize));
  return Number(h % BigInt(poolSize));
}
