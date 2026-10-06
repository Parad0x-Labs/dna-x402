/**
 * null-miner-sdk — Off-chain ticket management for NULL lottery
 *
 * Tickets are signed messages (zero SOL cost), batched via Liquefy for
 * 1 on-chain tx per round. Nullifiers are Poseidon-derived so the ZK layer
 * can later verify spend-once properties.
 *
 * A round's tickets_root (AnchorTickets) is the dark_null_lottery ticket.rs
 * SHA-256 tree over ticket leaves H(tag, round_id, owner, numbers, nullifier);
 * see ticketTree.ts. A ticket needs an `owner` Solana key to be anchored and
 * claimed: ClaimJackpot rebuilds the leaf with the claimant's key.
 */

import { createHash } from "crypto";
import { poseidonHash2, hexToField, fieldToHex } from "../zk/poseidon.js";
import { createNullArchive } from "../liquefy/bridge.js";
import type { NullArchive, NullArchiveEntry } from "../liquefy/bridge.js";

import { checkWin } from "./DrawMachine.js";
import { bytesToHex, ownerKeyBytes, ticketLeaf, ticketsProof, ticketsRoot } from "./ticketTree.js";

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
  owner?:     string;   // base58 Solana key that claims the ticket (required to anchor/claim)
}

export interface TicketBatch {
  roundId:    number;
  tickets:    LotteryTicket[];
  batchRoot:  string;   // hex: ticket.rs SHA-256 tickets root (buildBatchRoot)
  entryCount: number;
}

export interface FallbackPool {
  rounds:     number[];           // the three consecutive round IDs (e.g., [1, 2, 3])
  allTickets: LotteryTicket[];    // the third round's anchored tickets, in leaf order
  poolSize:   number;             // = the third round's ticket_count
  poolRoot:   string;             // = the third round's tickets_root (hex)
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
  owner?:   string,
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
  if (owner !== undefined) ownerKeyBytes(owner); // validates a 32-byte base58 key

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
    ...(owner !== undefined ? { owner } : {}),
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

// ── Tickets tree (ticket.rs) ──────────────────────────────────────────────────

/** ticket.rs leaf of a ticket: H(tag, roundId, owner, numbers, nullifier). */
export function ticketLeafOf(ticket: LotteryTicket): Uint8Array {
  if (!ticket.owner) {
    throw new Error(`TicketStore: ticket ${ticket.ticketId} has no owner key (the leaf commits to the claimant)`);
  }
  return ticketLeaf(ticket.roundId, ticket.owner, ticket.numbers, ticket.nullifier);
}

/**
 * tickets_root for AnchorTickets: the ticket.rs SHA-256 tree over the tickets'
 * leaves in the given order (64 zero hex chars for no tickets).
 */
export function buildBatchRoot(tickets: LotteryTicket[]): string {
  return bytesToHex(ticketsRoot(tickets.map(ticketLeafOf)));
}

/** Merkle proof (hex sibling hashes, leaf up) of tickets[index] for ClaimJackpot. */
export function buildTicketProof(tickets: LotteryTicket[], index: number): string[] {
  return ticketsProof(tickets.map(ticketLeafOf), index).map(bytesToHex);
}

// ── Fallback Pool ─────────────────────────────────────────────────────────────

/**
 * Fallback pool for FallbackDraw over three consecutive no-winner rounds. The
 * program draws from the third round's anchored tickets tree, so the pool is
 * that round's batch; tickets of the first two rounds take part only if the
 * operator anchored them in the third round's set (as third-round tickets).
 */
export function buildFallbackPool(rounds: TicketBatch[]): FallbackPool {
  if (rounds.length !== 3) {
    throw new Error("TicketStore: the fallback takes exactly 3 rounds");
  }
  for (let i = 1; i < 3; i++) {
    if (rounds[i].roundId !== rounds[i - 1].roundId + 1) {
      throw new Error("TicketStore: fallback rounds must be consecutive");
    }
  }
  const third = rounds[2];
  for (const t of third.tickets) {
    if (t.roundId !== third.roundId) {
      throw new Error(`TicketStore: ticket ${t.ticketId} is not a round ${third.roundId} ticket`);
    }
  }
  const allTickets = [...third.tickets];
  return {
    rounds:     rounds.map((b) => b.roundId),
    allTickets,
    poolSize:   allTickets.length,
    poolRoot:   buildBatchRoot(allTickets),
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
