/**
 * null-miner-sdk — Off-chain ticket management for NULL lottery
 *
 * Tickets are signed messages (zero SOL cost), batched via Liquefy for
 * 1 on-chain tx per round. Nullifiers are Poseidon-derived so the ZK layer
 * can later verify spend-once properties.
 */

import { createHash, randomBytes } from "crypto";
import { poseidonHash2, hexToField, fieldToHex } from "../zk/poseidon.js";
import { createNullArchive } from "../liquefy/bridge.js";
import type { NullArchive, NullArchiveEntry } from "../liquefy/bridge.js";

import { checkWin } from "./DrawMachine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LotteryTicket {
  ticketId:   string;   // hex: SHA-256("ticket-v1:" + agentId + ":" + roundId + ":" + numbers.join(",") + ":" + timestamp)
  agentId:    string;   // passport ID
  roundId:    number;
  numbers:    number[]; // chosen 5 numbers from 1..=30
  nullifier:  string;   // hex: poseidon(hexToField(ticketId), BigInt(roundId))
  pricePaid:  number;   // NULL atomic (10_000_000 = 10 NULL with 6 decimals)
  timestamp:  number;   // unix ms
  signature:  string;   // hex: SHA-256("ticket-sig-v1:" + ticketId + ":" + agentId) — devnet only
}

export interface TicketBatch {
  roundId:    number;
  tickets:    LotteryTicket[];
  batchRoot:  string;   // Poseidon Merkle root of ticket nullifiers
  entryCount: number;
}

export interface FallbackPool {
  rounds:     number[];           // round IDs included (e.g., [1, 2, 3])
  allTickets: LotteryTicket[];
  poolSize:   number;
  poolRoot:   string;             // Poseidon Merkle root of all ticket nullifiers across 3 rounds
}

// ── Ticket Creation ───────────────────────────────────────────────────────────

/**
 * Create a single lottery ticket (off-chain, no SOL).
 * Validates: numbers.length === 5, all in 1..=30, distinct.
 */
export function createTicket(
  agentId:  string,
  roundId:  number,
  numbers:  number[],
  pricePaid = 10_000_000,
): LotteryTicket {
  if (numbers.length !== 5) {
    throw new Error(
      `TicketStore: numbers must have exactly 5 elements, got ${numbers.length}`
    );
  }
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      throw new Error(
        `TicketStore: number ${n} out of range 1..30`
      );
    }
  }
  const unique = new Set(numbers);
  if (unique.size !== 5) {
    throw new Error("TicketStore: numbers must be distinct");
  }

  const timestamp = Date.now();
  const numbersStr = [...numbers].sort((a, b) => a - b).join(",");

  // ticketId = SHA-256("ticket-v1:" + agentId + ":" + roundId + ":" + numbers.join(",") + ":" + timestamp)
  // Use sorted numbers for canonical form
  const ticketId = createHash("sha256")
    .update(`ticket-v1:${agentId}:${roundId}:${numbersStr}:${timestamp}`)
    .digest("hex");

  // nullifier = poseidon(hexToField(ticketId), BigInt(roundId))
  const nullifier = fieldToHex(
    poseidonHash2(hexToField(ticketId), BigInt(roundId))
  );

  // devnet signature
  const signature = createHash("sha256")
    .update(`ticket-sig-v1:${ticketId}:${agentId}`)
    .digest("hex");

  return {
    ticketId,
    agentId,
    roundId,
    numbers: [...numbers].sort((a, b) => a - b),
    nullifier,
    pricePaid,
    timestamp,
    signature,
  };
}

// ── Batch to Archive ──────────────────────────────────────────────────────────

/**
 * Batch tickets into a Liquefy-compatible archive for 1 on-chain tx.
 *   ticketNullifier → NullArchiveEntry.nullifierHash
 *   ticketId        → NullArchiveEntry.taskId
 *   priceAtomic     → NullArchiveEntry.amountAtomic
 */
export function batchTicketsToArchive(
  tickets:     LotteryTicket[],
  platformId = "null-lottery",
): NullArchive {
  const entries: NullArchiveEntry[] = tickets.map((t) => ({
    taskId:            t.ticketId,
    nullifierHash:     t.nullifier,
    receiptCommitment: createHash("sha256")
      .update(`lottery-receipt-v1:${t.ticketId}:${t.roundId}`)
      .digest("hex"),
    agentPassportId:   t.agentId,
    platformId,
    amountAtomic:      t.pricePaid,
    timestamp:         t.timestamp,
    isDecoy:           false,
  }));

  return createNullArchive(entries);
}

// ── Poseidon Merkle Root ──────────────────────────────────────────────────────

function iterativePoseidonRoot(leaves: bigint[]): bigint {
  if (leaves.length === 0) return 0n;
  let current = leaves;
  while (current.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left  = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i]; // pad with self
      next.push(poseidonHash2(left, right));
    }
    current = next;
  }
  return current[0];
}

/**
 * Build a batch root from an array of tickets.
 * Poseidon Merkle root: iterative poseidon reduction of ticket nullifiers.
 */
export function buildBatchRoot(tickets: LotteryTicket[]): string {
  if (tickets.length === 0) return "0".repeat(64);
  const leaves = tickets.map((t) => hexToField(t.nullifier));
  return fieldToHex(iterativePoseidonRoot(leaves));
}

// ── Fallback Pool ─────────────────────────────────────────────────────────────

/**
 * Build fallback pool from 3 rounds of tickets (for fallback draw).
 * Concatenates all tickets from all 3 rounds, computes combined Poseidon root.
 */
export function buildFallbackPool(rounds: TicketBatch[]): FallbackPool {
  const allTickets: LotteryTicket[] = [];
  const roundIds: number[] = [];

  for (const batch of rounds) {
    roundIds.push(batch.roundId);
    allTickets.push(...batch.tickets);
  }

  const poolSize = allTickets.length;
  const leaves   = allTickets.map((t) => hexToField(t.nullifier));
  const poolRoot = poolSize === 0
    ? "0".repeat(64)
    : fieldToHex(iterativePoseidonRoot(leaves));

  return {
    rounds:     roundIds,
    allTickets,
    poolSize,
    poolRoot,
  };
}

/**
 * Given a FallbackPool and winner index, find the winning ticket.
 */
export function findFallbackWinner(
  pool:        FallbackPool,
  winnerIndex: number,
): LotteryTicket | null {
  if (winnerIndex < 0 || winnerIndex >= pool.poolSize) return null;
  return pool.allTickets[winnerIndex] ?? null;
}

// ── Batch Win Check ───────────────────────────────────────────────────────────

/**
 * Check if any ticket in a batch wins the draw.
 * Returns winning ticket or null.
 */
export function checkBatchForWin(
  batch:        TicketBatch,
  drawnNumbers: number[],
): LotteryTicket | null {
  for (const ticket of batch.tickets) {
    if (checkWin(ticket.numbers, drawnNumbers)) return ticket;
  }
  return null;
}
