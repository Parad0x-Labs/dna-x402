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
  checkBatchForWin,
  buildBatchRoot,
} from "./TicketStore.js";
import type { LotteryTicket, TicketBatch } from "./TicketStore.js";

import { bridgeArchiveToAnchor } from "../liquefy/bridge.js";
import type { ArchiveBridgeResult } from "../liquefy/bridge.js";

import { lotteryConfigFromProfile } from "../config/profiles.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LotteryConfig {
  ticketPriceNull: number;   // atomic units
  houseFeeBps:     number;   // 50 = 0.5%
  numbersCount:    number;   // 5
  numbersRange:    number;   // 30
  fallbackAfter:   number;   // 3
  programId:       string;
  isActive:        boolean;
}

export interface RoundInfo {
  roundId:            number;
  status:             "open" | "committed" | "anchored" | "drawn" | "won" | "no_winner";
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
  winnerIndex:  number;
  poolSize:     number;
  seed:         string;
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
): BuyTicketResult {
  const ticket = createTicket(agentId, roundId, numbers, config.ticketPriceNull);

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
  const batch: TicketBatch = {
    roundId:    round.roundId,
    tickets,
    batchRoot:  buildBatchRoot(tickets),
    entryCount: tickets.length,
  };
  const winningTicket = checkBatchForWin(batch, drawResult.drawnNumbers);

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
 * Operator: execute fallback draw after 3 no-winner rounds.
 */
export function executeFallbackDraw(
  rounds:       TicketBatch[],
  fallbackSeed: string,
): FallbackDrawResult {
  const pool        = buildFallbackPool(rounds);
  if (pool.poolSize === 0) {
    throw new Error("LotterySDK: fallback pool is empty — no tickets across provided rounds");
  }

  const winnerIndex = buildFallbackWinnerIndex(fallbackSeed, pool.poolSize);
  const winnerTicket = findFallbackWinner(pool, winnerIndex);

  if (!winnerTicket) {
    throw new Error(`LotterySDK: fallback winner not found at index ${winnerIndex}`);
  }

  return {
    rounds:       pool.rounds,
    winnerTicket,
    winnerIndex,
    poolSize:     pool.poolSize,
    seed:         fallbackSeed,
  };
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
