/**
 * null-miner-sdk — NULL Lottery SDK
 *
 * High-level interface for players and house operators.
 * Wraps DrawMachine + TicketStore into an ergonomic API.
 */

import { createHash } from "crypto";
import {
  buildCommitment,
  revealDraw,
  generateSeed,
  buildFallbackWinnerIndex,
  checkWin as dmCheckWin,
} from "./DrawMachine.js";
import type { DrawResult } from "./DrawMachine.js";

import {
  createTicket,
  batchTicketsToArchive,
  buildFallbackPool,
  findFallbackWinner,
  buildTicketProof,
} from "./TicketStore.js";
import type { LotteryTicket, TicketBatch } from "./TicketStore.js";
import { claimJackpotData } from "./ticketTree.js";

import { bridgeArchiveToAnchor } from "../liquefy/bridge.js";
import type { ArchiveBridgeResult } from "../liquefy/bridge.js";

import { lotteryConfigFromProfile } from "../config/profiles.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LotteryConfig {
  ticketPriceNull: number;   // atomic units
  houseFeeBps:     number;   // basis points; both Parad0x profiles use 0
  numbersCount:    number;   // 5
  numbersRange:    number;   // 30
  fallbackAfter:   number;   // 3
  programId:       string;
  isActive:        boolean;
}

export interface RoundInfo {
  roundId:            number;
  status:             "open" | "committed" | "anchored" | "drawn" | "won" | "no_winner" | "fallback_drawn";
  seedCommitment?:    string;
  drawnNumbers?:      number[];
  ticketCount:        number;
  totalNullDeposited: number;
  jackpotAmount:      number;  // totalNullDeposited * (1 - houseFeeBps/10000)
  winnerNullifier?:   string;
  noWinnerCount:      number;
}

export interface BuyTicketResult {
  ticket:  LotteryTicket;
  receipt: string;         // hex: SHA-256("lottery-receipt-v1:" + ticketId + ":" + roundId)
}

export interface RoundDrawResult {
  roundId:        number;
  drawResult:     DrawResult;
  winningTicket:  LotteryTicket | null;
  jackpotAmount:  number;
  houseCut:       number;
  archiveBridge?: ArchiveBridgeResult;
}

export interface FallbackDrawResult {
  rounds:       number[];
  winnerTicket: LotteryTicket;
  winnerIndex:  number;       // leaf index in the third round's tickets tree
  poolSize:     number;       // FallbackDraw fallback_pool_size
  poolRoot:     string;       // FallbackDraw fallback_tickets_root (hex)
  seed:         string;       // the third round's committed draw seed
  proof:        string[];     // winner's Merkle proof (hex) for ClaimJackpot
}

// ── Default Config ────────────────────────────────────────────────────────────

export const DEFAULT_LOTTERY_CONFIG: LotteryConfig = lotteryConfigFromProfile();

// ── Player API ────────────────────────────────────────────────────────────────

/**
 * Buy a ticket for a round (off-chain, free).
 */
export function buyTicket(
  agentId:  string,
  roundId:  number,
  numbers:  number[],
  config:   LotteryConfig = DEFAULT_LOTTERY_CONFIG,
  owner?:   string,
): BuyTicketResult {
  const ticket = createTicket(agentId, roundId, numbers, config.ticketPriceNull, owner);

  const receipt = createHash("sha256")
    .update(`lottery-receipt-v1:${ticket.ticketId}:${roundId}`)
    .digest("hex");

  return { ticket, receipt };
}

/**
 * Player: check if a specific ticket wins.
 */
export function checkWin(
  ticket:       LotteryTicket,
  drawnNumbers: number[],
): boolean {
  return dmCheckWin(ticket.numbers, drawnNumbers);
}

// ── Operator API ──────────────────────────────────────────────────────────────

/**
 * Operator: commit to a draw seed for a round.
 * Returns commitment (house must keep seed secret until RevealDraw).
 */
export function commitDraw(roundId: number): { seed: string; commitment: string } {
  // roundId used for domain separation — prevents reuse across rounds
  const seed = generateSeed();
  // salt with roundId so even if randomBytes repeats (never in practice),
  // the seed is unique per round
  const saltedSeed = createHash("sha256")
    .update(`lottery-draw-v1:${roundId}:`)
    .update(Buffer.from(seed, "hex"))
    .digest("hex");

  const commitment = buildCommitment(saltedSeed);
  return { seed: saltedSeed, commitment };
}

/**
 * Operator: anchor a batch of tickets on-chain via Liquefy.
 */
export function submitRoundTickets(
  tickets: LotteryTicket[],
  roundId: number,
): ArchiveBridgeResult {
  const archive = batchTicketsToArchive(tickets, `null-lottery-round-${roundId}`);
  return bridgeArchiveToAnchor(archive);
}

/**
 * Operator: reveal seed and execute draw.
 */
export function revealAndDraw(
  seed:       string,
  commitment: string,
  round:      RoundInfo,
  tickets:    LotteryTicket[],
): RoundDrawResult {
  const drawResult = revealDraw(seed, commitment, round.roundId);

  // Find winning ticket
  const winningTicket =
    tickets.find((t) => dmCheckWin(t.numbers, drawResult.drawnNumbers)) ?? null;

  const { jackpot, houseCut } = computeJackpot(
    round.totalNullDeposited,
    DEFAULT_LOTTERY_CONFIG.houseFeeBps,
  );

  // Build archive bridge for on-chain anchoring
  let archiveBridge: ArchiveBridgeResult | undefined;
  if (tickets.length > 0) {
    try {
      archiveBridge = submitRoundTickets(tickets, round.roundId);
    } catch {
      // non-fatal — anchoring is best-effort in devnet
    }
  }

  return {
    roundId:       round.roundId,
    drawResult,
    winningTicket,
    jackpotAmount: jackpot,
    houseCut,
    archiveBridge,
  };
}

/**
 * Operator: the FallbackDraw the program will run after 3 no-winner rounds.
 *
 * `rounds` are the three consecutive rounds' anchored batches; the pool is the
 * third one. `fallbackSeed` is the third round's committed draw seed; pass its
 * commitment to check it here (the program checks SHA-256(seed) against it).
 */
export function executeFallbackDraw(
  rounds:               TicketBatch[],
  fallbackSeed:         string,
  thirdRoundCommitment?: string,
): FallbackDrawResult {
  const pool        = buildFallbackPool(rounds);
  if (pool.poolSize === 0) {
    throw new Error("LotterySDK: fallback pool is empty — the third round anchored no tickets");
  }
  if (thirdRoundCommitment !== undefined && buildCommitment(fallbackSeed) !== thirdRoundCommitment) {
    throw new Error("LotterySDK: fallback seed does not match the third round's commitment");
  }

  const thirdRound  = pool.rounds[2];
  const winnerIndex = buildFallbackWinnerIndex(fallbackSeed, thirdRound, pool.poolSize);
  const winnerTicket = findFallbackWinner(pool, winnerIndex);

  if (!winnerTicket) {
    throw new Error(`LotterySDK: fallback winner not found at index ${winnerIndex}`);
  }

  return {
    rounds:       pool.rounds,
    winnerTicket,
    winnerIndex,
    poolSize:     pool.poolSize,
    poolRoot:     pool.poolRoot,
    seed:         fallbackSeed,
    proof:        buildTicketProof(pool.allTickets, winnerIndex),
  };
}

/**
 * Player: ClaimJackpot instruction data for an anchored ticket at `leafIndex`
 * of its round's tickets tree (`tickets` = that round's anchored batch, in
 * order). The transaction must be signed by `ticket.owner`.
 */
export function buildClaimJackpotData(
  tickets:   LotteryTicket[],
  leafIndex: number,
): Uint8Array {
  const ticket = tickets[leafIndex];
  if (!ticket) throw new Error("LotterySDK: leaf index out of range");
  const proof = buildTicketProof(tickets, leafIndex).map((h) => Uint8Array.from(Buffer.from(h, "hex")));
  return claimJackpotData(ticket.nullifier, ticket.numbers, leafIndex, proof);
}

// ── Finance ───────────────────────────────────────────────────────────────────

/**
 * Compute jackpot amount after house cut.
 * jackpot = total - floor(total * houseFeeBps / 10000)
 */
export function computeJackpot(
  totalNullDeposited: number,
  houseFeeBps:        number,
): { jackpot: number; houseCut: number } {
  const houseCut = Math.floor(totalNullDeposited * houseFeeBps / 10_000);
  const jackpot  = totalNullDeposited - houseCut;
  return { jackpot, houseCut };
}

/**
 * Build claim receipt for a winning ticket.
 * receipt = SHA-256("lottery-claim-v1:" + ticket.nullifier + ":" + roundId + ":" + winnerAddress)
 */
export function buildClaimReceipt(
  ticket:        LotteryTicket,
  roundId:       number,
  winnerAddress: string,
): string {
  return createHash("sha256")
    .update(`lottery-claim-v1:${ticket.nullifier}:${roundId}:${winnerAddress}`)
    .digest("hex");
}
