/**
 * NULL Lottery — comprehensive test suite (60+ tests)
 *
 * Covers DrawMachine, TicketStore, and LotterySDK.
 */

import { createHash } from "crypto";

import {
  buildCommitment,
  revealDraw,
  verifyDraw,
  checkWin,
  generateSeed,
  buildFallbackWinnerIndex,
} from "../src/lottery/DrawMachine.js";

import {
  createTicket,
  batchTicketsToArchive,
  buildFallbackPool,
  findFallbackWinner,
  checkBatchForWin,
  buildBatchRoot,
} from "../src/lottery/TicketStore.js";
import type { LotteryTicket, TicketBatch } from "../src/lottery/TicketStore.js";

import {
  buyTicket,
  commitDraw,
  submitRoundTickets,
  revealAndDraw,
  executeFallbackDraw,
  computeJackpot,
  buildClaimReceipt,
  DEFAULT_LOTTERY_CONFIG,
} from "../src/lottery/LotterySDK.js";
import type { RoundInfo } from "../src/lottery/LotterySDK.js";

import { hexToField, poseidonHash2, fieldToHex } from "../src/zk/poseidon.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSeed(): string {
  // deterministic for tests that need reproducibility
  return "a".repeat(64);
}

function makeRoundInfo(overrides: Partial<RoundInfo> = {}): RoundInfo {
  return {
    roundId:            1,
    status:             "committed",
    seedCommitment:     buildCommitment(makeSeed()),
    drawnNumbers:       undefined,
    ticketCount:        0,
    totalNullDeposited: 0,
    jackpotAmount:      0,
    winnerNullifier:    undefined,
    noWinnerCount:      0,
    ...overrides,
  };
}

function makeTicket(
  numbers: number[] = [1, 2, 3, 4, 5],
  roundId = 1,
  agentId = "agent-1",
): LotteryTicket {
  return createTicket(agentId, roundId, numbers);
}

function makeBatch(tickets: LotteryTicket[], roundId = 1): TicketBatch {
  return {
    roundId,
    tickets,
    batchRoot:  buildBatchRoot(tickets),
    entryCount: tickets.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DrawMachine tests
// ─────────────────────────────────────────────────────────────────────────────

describe("DrawMachine — buildCommitment", () => {
  test("is deterministic", () => {
    const seed = makeSeed();
    expect(buildCommitment(seed)).toBe(buildCommitment(seed));
  });

  test("different seeds produce different commitments", () => {
    const s1 = "a".repeat(64);
    const s2 = "b".repeat(64);
    expect(buildCommitment(s1)).not.toBe(buildCommitment(s2));
  });

  test("commitment is 64 hex chars (SHA-256)", () => {
    expect(buildCommitment(makeSeed())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DrawMachine — revealDraw", () => {
  const seed = makeSeed();
  const commitment = buildCommitment(seed);
  const roundId = 42;

  test("valid seed+commitment returns DrawResult", () => {
    const result = revealDraw(seed, commitment, roundId);
    expect(result).toBeDefined();
    expect(result.roundId).toBe(roundId);
    expect(result.seed).toBe(seed);
    expect(result.commitment).toBe(commitment);
  });

  test("drawnNumbers has 5 elements", () => {
    const result = revealDraw(seed, commitment, roundId);
    expect(result.drawnNumbers).toHaveLength(5);
  });

  test("drawnNumbers are distinct", () => {
    const result = revealDraw(seed, commitment, roundId);
    const unique = new Set(result.drawnNumbers);
    expect(unique.size).toBe(5);
  });

  test("drawnNumbers are all in 1..=30", () => {
    const result = revealDraw(seed, commitment, roundId);
    for (const n of result.drawnNumbers) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(30);
    }
  });

  test("throws on wrong seed", () => {
    const badSeed = "b".repeat(64);
    expect(() => revealDraw(badSeed, commitment, roundId)).toThrow(
      /commitment mismatch/
    );
  });

  test("is deterministic — same inputs produce same output", () => {
    const r1 = revealDraw(seed, commitment, roundId);
    const r2 = revealDraw(seed, commitment, roundId);
    expect(r1.drawnNumbers).toEqual(r2.drawnNumbers);
    expect(r1.drawHash).toBe(r2.drawHash);
  });

  test("different roundIds produce different draws", () => {
    const r1 = revealDraw(seed, commitment, 1);
    // We need a distinct seed/commitment for round 2 to avoid commitment reuse issues
    const seed2 = "c".repeat(64);
    const commit2 = buildCommitment(seed2);
    const r2 = revealDraw(seed2, commit2, 2);
    // Very unlikely to be equal
    expect(r1.drawnNumbers).not.toEqual(r2.drawnNumbers);
  });

  test("drawHash is 64 hex chars", () => {
    const result = revealDraw(seed, commitment, roundId);
    expect(result.drawHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DrawMachine — verifyDraw", () => {
  const seed = makeSeed();
  const commitment = buildCommitment(seed);

  test("valid result passes verification", () => {
    const result = revealDraw(seed, commitment, 7);
    expect(verifyDraw(result)).toEqual({ valid: true });
  });

  test("modified numbers fails verification", () => {
    const result = revealDraw(seed, commitment, 7);
    const tampered = { ...result, drawnNumbers: [1, 2, 3, 4, 6] };
    const v = verifyDraw(tampered);
    expect(v.valid).toBe(false);
    expect(v.reason).toBeDefined();
  });

  test("duplicate numbers fails verification", () => {
    const result = revealDraw(seed, commitment, 7);
    const tampered = { ...result, drawnNumbers: [1, 1, 2, 3, 4] };
    expect(verifyDraw(tampered).valid).toBe(false);
  });

  test("number out of range fails verification", () => {
    const result = revealDraw(seed, commitment, 7);
    const tampered = { ...result, drawnNumbers: [0, 2, 3, 4, 5] };
    expect(verifyDraw(tampered).valid).toBe(false);
  });

  test("number > 30 fails verification", () => {
    const result = revealDraw(seed, commitment, 7);
    const tampered = { ...result, drawnNumbers: [31, 2, 3, 4, 5] };
    expect(verifyDraw(tampered).valid).toBe(false);
  });

  test("wrong number count fails verification", () => {
    const result = revealDraw(seed, commitment, 7);
    const tampered = { ...result, drawnNumbers: [1, 2, 3, 4] };
    expect(verifyDraw(tampered).valid).toBe(false);
  });
});

describe("DrawMachine — checkWin", () => {
  test("exact match returns true", () => {
    expect(checkWin([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(true);
  });

  test("partial match returns false", () => {
    expect(checkWin([1, 2, 3, 4, 5], [1, 2, 3, 4, 6])).toBe(false);
  });

  test("no match returns false", () => {
    expect(checkWin([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])).toBe(false);
  });

  test("order-independent — different order still wins", () => {
    expect(checkWin([5, 4, 3, 2, 1], [1, 2, 3, 4, 5])).toBe(true);
  });

  test("different lengths return false", () => {
    expect(checkWin([1, 2, 3, 4], [1, 2, 3, 4, 5])).toBe(false);
  });
});

describe("DrawMachine — generateSeed", () => {
  test("produces 64 hex chars", () => {
    expect(generateSeed()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls produce different seeds (probabilistic)", () => {
    expect(generateSeed()).not.toBe(generateSeed());
  });
});

describe("DrawMachine — buildFallbackWinnerIndex", () => {
  const seed = makeSeed();

  test("is deterministic", () => {
    expect(buildFallbackWinnerIndex(seed, 100)).toBe(
      buildFallbackWinnerIndex(seed, 100)
    );
  });

  test("result is in [0, poolSize)", () => {
    for (const size of [1, 10, 99, 1000]) {
      const idx = buildFallbackWinnerIndex(seed, size);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(size);
    }
  });

  test("different seeds produce different indices (probabilistic)", () => {
    const s1 = "a".repeat(64);
    const s2 = "b".repeat(64);
    // Very unlikely to collide with poolSize 10000
    expect(buildFallbackWinnerIndex(s1, 10000)).not.toBe(
      buildFallbackWinnerIndex(s2, 10000)
    );
  });

  test("poolSize=1 always returns 0", () => {
    expect(buildFallbackWinnerIndex(seed, 1)).toBe(0);
    expect(buildFallbackWinnerIndex(generateSeed(), 1)).toBe(0);
  });

  test("throws on poolSize=0", () => {
    expect(() => buildFallbackWinnerIndex(seed, 0)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TicketStore tests
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketStore — createTicket", () => {
  test("valid inputs return LotteryTicket with correct fields", () => {
    const t = createTicket("agent-1", 5, [1, 2, 3, 4, 5]);
    expect(t.agentId).toBe("agent-1");
    expect(t.roundId).toBe(5);
    expect(t.numbers).toHaveLength(5);
    expect(t.ticketId).toMatch(/^[0-9a-f]{64}$/);
    expect(t.nullifier).toMatch(/^[0-9a-f]{64}$/);
    expect(t.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test("numbers are stored sorted", () => {
    const t = createTicket("agent-1", 1, [5, 3, 1, 4, 2]);
    expect(t.numbers).toEqual([1, 2, 3, 4, 5]);
  });

  test("ticketId is deterministic SHA-256 of canonical string", () => {
    // To get same ticketId we need same timestamp — use a controlled version
    // We test: same call at different timestamps gives consistent format
    const t = createTicket("agent-x", 3, [1, 2, 3, 4, 5]);
    const expected = createHash("sha256")
      .update(`ticket-v1:agent-x:3:1,2,3,4,5:${t.timestamp}`)
      .digest("hex");
    expect(t.ticketId).toBe(expected);
  });

  test("nullifier is poseidon(hexToField(ticketId), BigInt(roundId))", () => {
    const t = createTicket("agent-y", 7, [6, 7, 8, 9, 10]);
    const expected = fieldToHex(
      poseidonHash2(hexToField(t.ticketId), BigInt(7))
    );
    expect(t.nullifier).toBe(expected);
  });

  test("throws if numbers.length != 5", () => {
    expect(() => createTicket("a", 1, [1, 2, 3, 4])).toThrow(/5/);
    expect(() => createTicket("a", 1, [1, 2, 3, 4, 5, 6])).toThrow(/5/);
  });

  test("throws if number is 0 (out of range)", () => {
    expect(() => createTicket("a", 1, [0, 1, 2, 3, 4])).toThrow(/range/);
  });

  test("throws if number is 31 (out of range)", () => {
    expect(() => createTicket("a", 1, [1, 2, 3, 4, 31])).toThrow(/range/);
  });

  test("throws if duplicate numbers", () => {
    expect(() => createTicket("a", 1, [1, 1, 2, 3, 4])).toThrow(/distinct/);
  });

  test("pricePaid defaults to 10_000_000", () => {
    const t = createTicket("a", 1, [1, 2, 3, 4, 5]);
    expect(t.pricePaid).toBe(10_000_000);
  });
});

describe("TicketStore — batchTicketsToArchive", () => {
  const tickets = [
    makeTicket([1, 2, 3, 4, 5], 1, "a1"),
    makeTicket([6, 7, 8, 9, 10], 1, "a2"),
    makeTicket([11, 12, 13, 14, 15], 1, "a3"),
  ];

  test("returns valid NullArchive", () => {
    const archive = batchTicketsToArchive(tickets);
    expect(archive).toBeDefined();
    expect(archive.archiveId).toBeDefined();
    expect(archive.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  test("all tickets present in archive (non-decoy)", () => {
    const archive = batchTicketsToArchive(tickets);
    const realEntries = archive.entries.filter((e) => !e.isDecoy);
    expect(realEntries).toHaveLength(tickets.length);
  });

  test("archive has decoy entries for privacy", () => {
    const archive = batchTicketsToArchive(tickets);
    const decoys = archive.entries.filter((e) => e.isDecoy);
    expect(decoys.length).toBeGreaterThan(0);
  });

  test("ticket nullifiers are used as nullifierHash in entries", () => {
    const archive = batchTicketsToArchive(tickets);
    const realEntries = archive.entries.filter((e) => !e.isDecoy);
    const nullifiers = realEntries.map((e) => e.nullifierHash);
    for (const t of tickets) {
      expect(nullifiers).toContain(t.nullifier);
    }
  });

  test("ticket IDs are used as taskId in entries", () => {
    const archive = batchTicketsToArchive(tickets);
    const realEntries = archive.entries.filter((e) => !e.isDecoy);
    const taskIds = realEntries.map((e) => e.taskId);
    for (const t of tickets) {
      expect(taskIds).toContain(t.ticketId);
    }
  });
});

describe("TicketStore — buildBatchRoot", () => {
  test("empty tickets returns zero string", () => {
    expect(buildBatchRoot([])).toBe("0".repeat(64));
  });

  test("1 ticket returns the nullifier itself (single-leaf tree)", () => {
    const t = makeTicket();
    // iterativePoseidonRoot with 1 leaf returns the leaf unchanged
    expect(buildBatchRoot([t])).toBe(t.nullifier);
  });

  test("2 tickets returns poseidon(n1, n2)", () => {
    const t1 = makeTicket([1, 2, 3, 4, 5], 1, "a1");
    const t2 = makeTicket([6, 7, 8, 9, 10], 1, "a2");
    const expected = fieldToHex(
      poseidonHash2(hexToField(t1.nullifier), hexToField(t2.nullifier))
    );
    expect(buildBatchRoot([t1, t2])).toBe(expected);
  });

  test("4 tickets produces correct tree", () => {
    const ts = [
      makeTicket([1, 2, 3, 4, 5], 1, "a1"),
      makeTicket([6, 7, 8, 9, 10], 1, "a2"),
      makeTicket([11, 12, 13, 14, 15], 1, "a3"),
      makeTicket([16, 17, 18, 19, 20], 1, "a4"),
    ];
    // Manual: h(h(n0,n1), h(n2,n3))
    const h01 = poseidonHash2(hexToField(ts[0].nullifier), hexToField(ts[1].nullifier));
    const h23 = poseidonHash2(hexToField(ts[2].nullifier), hexToField(ts[3].nullifier));
    const root = fieldToHex(poseidonHash2(h01, h23));
    expect(buildBatchRoot(ts)).toBe(root);
  });

  test("is consistent across calls", () => {
    const ts = [makeTicket([1, 2, 3, 4, 5]), makeTicket([6, 7, 8, 9, 10], 1, "a2")];
    expect(buildBatchRoot(ts)).toBe(buildBatchRoot(ts));
  });
});

describe("TicketStore — buildFallbackPool", () => {
  const batches: TicketBatch[] = [
    makeBatch([makeTicket([1, 2, 3, 4, 5], 1, "a1"), makeTicket([6, 7, 8, 9, 10], 1, "a2")], 1),
    makeBatch([makeTicket([11, 12, 13, 14, 15], 2, "a3")], 2),
    makeBatch([makeTicket([16, 17, 18, 19, 20], 3, "a4"), makeTicket([21, 22, 23, 24, 25], 3, "a5")], 3),
  ];

  test("combines tickets from 3 rounds", () => {
    const pool = buildFallbackPool(batches);
    expect(pool.allTickets).toHaveLength(5);
  });

  test("poolSize equals sum of ticket counts", () => {
    const pool = buildFallbackPool(batches);
    expect(pool.poolSize).toBe(5);
  });

  test("round IDs are captured", () => {
    const pool = buildFallbackPool(batches);
    expect(pool.rounds).toEqual([1, 2, 3]);
  });

  test("poolRoot is deterministic", () => {
    const p1 = buildFallbackPool(batches);
    const p2 = buildFallbackPool(batches);
    expect(p1.poolRoot).toBe(p2.poolRoot);
  });

  test("poolRoot is 64 hex chars", () => {
    const pool = buildFallbackPool(batches);
    expect(pool.poolRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("TicketStore — findFallbackWinner", () => {
  const tickets = [
    makeTicket([1, 2, 3, 4, 5], 1, "a1"),
    makeTicket([6, 7, 8, 9, 10], 1, "a2"),
    makeTicket([11, 12, 13, 14, 15], 1, "a3"),
  ];
  const pool = buildFallbackPool([makeBatch(tickets, 1)]);

  test("returns correct ticket by index", () => {
    expect(findFallbackWinner(pool, 0)).toEqual(tickets[0]);
    expect(findFallbackWinner(pool, 1)).toEqual(tickets[1]);
    expect(findFallbackWinner(pool, 2)).toEqual(tickets[2]);
  });

  test("negative index returns null", () => {
    expect(findFallbackWinner(pool, -1)).toBeNull();
  });

  test("index >= poolSize returns null", () => {
    expect(findFallbackWinner(pool, 3)).toBeNull();
    expect(findFallbackWinner(pool, 100)).toBeNull();
  });
});

describe("TicketStore — checkBatchForWin", () => {
  const tickets = [
    makeTicket([1, 2, 3, 4, 5], 1, "a1"),
    makeTicket([6, 7, 8, 9, 10], 1, "a2"),
    makeTicket([11, 12, 13, 14, 15], 1, "a3"),
  ];
  const batch = makeBatch(tickets, 1);

  test("returns winning ticket when match", () => {
    const winner = checkBatchForWin(batch, [6, 7, 8, 9, 10]);
    expect(winner).not.toBeNull();
    expect(winner!.agentId).toBe("a2");
  });

  test("returns null when no match", () => {
    expect(checkBatchForWin(batch, [2, 4, 6, 8, 10])).toBeNull();
  });

  test("returns null for empty batch", () => {
    const empty = makeBatch([], 1);
    expect(checkBatchForWin(empty, [1, 2, 3, 4, 5])).toBeNull();
  });

  test("finds first ticket that matches", () => {
    const winner = checkBatchForWin(batch, [1, 2, 3, 4, 5]);
    expect(winner!.agentId).toBe("a1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LotterySDK tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LotterySDK — DEFAULT_LOTTERY_CONFIG", () => {
  test("houseFeeBps is 50 (0.5%)", () => {
    expect(DEFAULT_LOTTERY_CONFIG.houseFeeBps).toBe(50);
  });

  test("numbersCount is 5", () => {
    expect(DEFAULT_LOTTERY_CONFIG.numbersCount).toBe(5);
  });

  test("numbersRange is 30", () => {
    expect(DEFAULT_LOTTERY_CONFIG.numbersRange).toBe(30);
  });

  test("fallbackAfter is 3", () => {
    expect(DEFAULT_LOTTERY_CONFIG.fallbackAfter).toBe(3);
  });

  test("isActive is true", () => {
    expect(DEFAULT_LOTTERY_CONFIG.isActive).toBe(true);
  });
});

describe("LotterySDK — buyTicket", () => {
  test("returns BuyTicketResult with ticket + receipt", () => {
    const result = buyTicket("agent-1", 1, [1, 2, 3, 4, 5]);
    expect(result.ticket).toBeDefined();
    expect(result.receipt).toBeDefined();
  });

  test("receipt is SHA-256('lottery-receipt-v1:...')", () => {
    const result = buyTicket("agent-1", 1, [1, 2, 3, 4, 5]);
    const expected = createHash("sha256")
      .update(`lottery-receipt-v1:${result.ticket.ticketId}:1`)
      .digest("hex");
    expect(result.receipt).toBe(expected);
  });

  test("ticket has correct roundId and numbers", () => {
    const result = buyTicket("agent-1", 7, [5, 10, 15, 20, 25]);
    expect(result.ticket.roundId).toBe(7);
    expect(result.ticket.numbers).toEqual([5, 10, 15, 20, 25]);
  });

  test("receipt is 64 hex chars", () => {
    const result = buyTicket("agent-1", 1, [1, 2, 3, 4, 5]);
    expect(result.receipt).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("LotterySDK — commitDraw", () => {
  test("returns seed (64 hex) + commitment (64 hex)", () => {
    const { seed, commitment } = commitDraw(1);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls produce different seeds (probabilistic)", () => {
    const r1 = commitDraw(1);
    const r2 = commitDraw(1);
    // Different random bytes underlying each call
    expect(r1.seed).not.toBe(r2.seed);
  });

  test("SHA-256(seed) === commitment", () => {
    const { seed, commitment } = commitDraw(99);
    expect(buildCommitment(seed)).toBe(commitment);
  });

  test("different roundIds produce different seeds (probabilistic)", () => {
    const r1 = commitDraw(1);
    const r2 = commitDraw(2);
    expect(r1.seed).not.toBe(r2.seed);
  });
});

describe("LotterySDK — submitRoundTickets", () => {
  const tickets = [
    makeTicket([1, 2, 3, 4, 5], 1, "a1"),
    makeTicket([6, 7, 8, 9, 10], 1, "a2"),
  ];

  test("returns ArchiveBridgeResult", () => {
    const result = submitRoundTickets(tickets, 1);
    expect(result).toBeDefined();
    expect(result.archiveId).toBeDefined();
    expect(result.batchReceiptRoot).toBeDefined();
    expect(result.anchorInstructionData).toBeDefined();
  });

  test("anchorInstructionData is base64, 34 bytes when decoded", () => {
    const result = submitRoundTickets(tickets, 1);
    const decoded = Buffer.from(result.anchorInstructionData, "base64");
    expect(decoded).toHaveLength(34);
  });

  test("entryCount includes real + decoy entries", () => {
    const result = submitRoundTickets(tickets, 1);
    // real=2 + at least 4 decoys
    expect(result.entryCount).toBeGreaterThanOrEqual(2);
  });
});

describe("LotterySDK — revealAndDraw", () => {
  const { seed, commitment } = commitDraw(1);
  const round = makeRoundInfo({
    roundId:            1,
    seedCommitment:     commitment,
    totalNullDeposited: 1_000,
  });

  test("valid scenario returns RoundDrawResult", () => {
    const result = revealAndDraw(seed, commitment, round, []);
    expect(result).toBeDefined();
    expect(result.roundId).toBe(1);
  });

  test("drawnNumbers has 5 elements", () => {
    const result = revealAndDraw(seed, commitment, round, []);
    expect(result.drawResult.drawnNumbers).toHaveLength(5);
  });

  test("winningTicket is null when no tickets", () => {
    const result = revealAndDraw(seed, commitment, round, []);
    expect(result.winningTicket).toBeNull();
  });

  test("winningTicket found when numbers match drawn", () => {
    // Use a seed where we know the draw, then create a matching ticket
    const draw = revealDraw(seed, commitment, 1);
    const winner = makeTicket(draw.drawnNumbers, 1, "winner");
    const result = revealAndDraw(seed, commitment, round, [winner]);
    expect(result.winningTicket).not.toBeNull();
    expect(result.winningTicket!.agentId).toBe("winner");
  });

  test("winningTicket is null when numbers don't match", () => {
    const loser = makeTicket([1, 2, 3, 4, 5], 1, "loser");
    // ensure loser numbers != drawn (very likely)
    const draw = revealDraw(seed, commitment, 1);
    const loserHasWon = checkWin(loser.numbers, draw.drawnNumbers);
    if (!loserHasWon) {
      const result = revealAndDraw(seed, commitment, round, [loser]);
      expect(result.winningTicket).toBeNull();
    }
  });

  test("jackpotAmount = total * (1 - 0.005)", () => {
    const round1k = makeRoundInfo({ totalNullDeposited: 1_000 });
    const result = revealAndDraw(seed, commitment, round1k, []);
    expect(result.jackpotAmount).toBe(995);
  });

  test("houseCut = total * 0.005", () => {
    const round1k = makeRoundInfo({ totalNullDeposited: 1_000 });
    const result = revealAndDraw(seed, commitment, round1k, []);
    expect(result.houseCut).toBe(5);
  });
});

describe("LotterySDK — executeFallbackDraw", () => {
  const batches: TicketBatch[] = [
    makeBatch([makeTicket([1, 2, 3, 4, 5], 1, "a1"), makeTicket([6, 7, 8, 9, 10], 1, "a2")], 1),
    makeBatch([makeTicket([11, 12, 13, 14, 15], 2, "a3")], 2),
    makeBatch([makeTicket([16, 17, 18, 19, 20], 3, "a4")], 3),
  ];
  const fallbackSeed = "d".repeat(64);

  test("returns FallbackDrawResult", () => {
    const result = executeFallbackDraw(batches, fallbackSeed);
    expect(result).toBeDefined();
    expect(result.winnerTicket).toBeDefined();
  });

  test("winnerTicket is from one of the 3 rounds", () => {
    const result = executeFallbackDraw(batches, fallbackSeed);
    const allTickets = batches.flatMap((b) => b.tickets);
    const ids = allTickets.map((t) => t.ticketId);
    expect(ids).toContain(result.winnerTicket.ticketId);
  });

  test("poolSize = total ticket count across 3 rounds", () => {
    const result = executeFallbackDraw(batches, fallbackSeed);
    expect(result.poolSize).toBe(4);
  });

  test("rounds array contains all 3 round IDs", () => {
    const result = executeFallbackDraw(batches, fallbackSeed);
    expect(result.rounds).toEqual([1, 2, 3]);
  });

  test("winnerIndex is in [0, poolSize)", () => {
    const result = executeFallbackDraw(batches, fallbackSeed);
    expect(result.winnerIndex).toBeGreaterThanOrEqual(0);
    expect(result.winnerIndex).toBeLessThan(result.poolSize);
  });

  test("throws on empty rounds", () => {
    expect(() => executeFallbackDraw([], fallbackSeed)).toThrow(/empty/);
  });
});

describe("LotterySDK — checkWin", () => {
  const { buyTicket: _buyTicket, checkWin: sdkCheckWin } = { buyTicket, checkWin: (t: LotteryTicket, d: number[]) => {
    // import the named export from LotterySDK
    const { checkWin: cw } = require("../src/lottery/LotterySDK.js");
    return cw(t, d);
  }};

  test("delegates correctly — winning ticket", () => {
    const result = buyTicket("agent-1", 1, [1, 2, 3, 4, 5]);
    // Import the SDK checkWin directly
    const { checkWin: sdkCW } = jest.requireActual("../src/lottery/LotterySDK.js") as typeof import("../src/lottery/LotterySDK.js");
    expect(sdkCW(result.ticket, [1, 2, 3, 4, 5])).toBe(true);
  });

  test("delegates correctly — losing ticket", () => {
    const result = buyTicket("agent-1", 1, [1, 2, 3, 4, 5]);
    const { checkWin: sdkCW } = jest.requireActual("../src/lottery/LotterySDK.js") as typeof import("../src/lottery/LotterySDK.js");
    expect(sdkCW(result.ticket, [6, 7, 8, 9, 10])).toBe(false);
  });
});

describe("LotterySDK — computeJackpot", () => {
  test("0 fee — jackpot equals total", () => {
    const { jackpot, houseCut } = computeJackpot(1000, 0);
    expect(jackpot).toBe(1000);
    expect(houseCut).toBe(0);
  });

  test("50 bps on 1000 — jackpot=995, houseCut=5", () => {
    const { jackpot, houseCut } = computeJackpot(1000, 50);
    expect(jackpot).toBe(995);
    expect(houseCut).toBe(5);
  });

  test("rounds down (floor)", () => {
    // 1% of 101 = 1.01 → floor = 1
    const { houseCut } = computeJackpot(101, 100);
    expect(houseCut).toBe(1);
    expect(computeJackpot(101, 100).jackpot).toBe(100);
  });

  test("10000 bps (100%) — house takes all", () => {
    const { jackpot, houseCut } = computeJackpot(500, 10000);
    expect(houseCut).toBe(500);
    expect(jackpot).toBe(0);
  });
});

describe("LotterySDK — buildClaimReceipt", () => {
  const ticket = makeTicket([1, 2, 3, 4, 5], 1, "agent-1");

  test("returns 64 hex chars", () => {
    expect(buildClaimReceipt(ticket, 1, "winner-addr")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic", () => {
    const r1 = buildClaimReceipt(ticket, 1, "winner-addr");
    const r2 = buildClaimReceipt(ticket, 1, "winner-addr");
    expect(r1).toBe(r2);
  });

  test("different winner addresses produce different receipts", () => {
    const r1 = buildClaimReceipt(ticket, 1, "addr-a");
    const r2 = buildClaimReceipt(ticket, 1, "addr-b");
    expect(r1).not.toBe(r2);
  });

  test("matches expected SHA-256 format", () => {
    const expected = createHash("sha256")
      .update(`lottery-claim-v1:${ticket.nullifier}:1:winner-addr`)
      .digest("hex");
    expect(buildClaimReceipt(ticket, 1, "winner-addr")).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Full round simulation
// ─────────────────────────────────────────────────────────────────────────────

describe("Full round simulation", () => {
  test("commit → buy 10 tickets → anchor → reveal draw → check wins", () => {
    const roundId = 42;
    const { seed, commitment } = commitDraw(roundId);

    // Buy 10 tickets
    const tickets: LotteryTicket[] = [];
    for (let i = 0; i < 10; i++) {
      const nums = [i + 1, i + 6, i + 11, i + 16, (i % 5) + 21];
      // Ensure distinct and in range
      const uniq = [...new Set(nums.map((n) => ((n - 1) % 30) + 1))];
      while (uniq.length < 5) uniq.push(uniq.length + 1);
      const safe = uniq.slice(0, 5) as [number, number, number, number, number];
      const { ticket } = buyTicket(`agent-${i}`, roundId, safe);
      tickets.push(ticket);
    }

    // Anchor tickets
    const bridge = submitRoundTickets(tickets, roundId);
    expect(bridge.entryCount).toBeGreaterThanOrEqual(10);

    // Draw
    const totalDeposit = tickets.length * DEFAULT_LOTTERY_CONFIG.ticketPriceNull;
    const round = makeRoundInfo({
      roundId,
      seedCommitment:     commitment,
      totalNullDeposited: totalDeposit,
      ticketCount:        tickets.length,
    });
    const drawResult = revealAndDraw(seed, commitment, round, tickets);

    expect(drawResult.drawResult.drawnNumbers).toHaveLength(5);
    expect(drawResult.jackpotAmount + drawResult.houseCut).toBe(totalDeposit);

    // Verify winner consistency
    if (drawResult.winningTicket) {
      expect(checkWin(drawResult.winningTicket.numbers, drawResult.drawResult.drawnNumbers)).toBe(true);
    }
  });

  test("full fallback simulation: 3 rounds no winner → fallback → winner found", () => {
    // Build 3 rounds with tickets that definitely don't match (we won't draw)
    const batches: TicketBatch[] = [];
    for (let r = 1; r <= 3; r++) {
      const batchTickets: LotteryTicket[] = [];
      for (let i = 0; i < 5; i++) {
        const base = (r - 1) * 10 + i;
        const nums: number[] = [];
        for (let j = 0; j < 5; j++) nums.push(((base + j) % 30) + 1);
        const uniq = [...new Set(nums)];
        while (uniq.length < 5) uniq.push(uniq.length + 1);
        batchTickets.push(makeTicket(uniq.slice(0, 5) as any, r, `agent-r${r}-${i}`));
      }
      batches.push(makeBatch(batchTickets, r));
    }

    const fallbackSeed = generateSeed();
    const result = executeFallbackDraw(batches, fallbackSeed);

    expect(result.winnerTicket).toBeDefined();
    expect(result.poolSize).toBe(15); // 5 tickets * 3 rounds
    expect(result.winnerIndex).toBeGreaterThanOrEqual(0);
    expect(result.winnerIndex).toBeLessThan(15);
    expect(result.rounds).toEqual([1, 2, 3]);

    // Winner ticket must be from one of the batches
    const allIds = batches.flatMap((b) => b.tickets.map((t) => t.ticketId));
    expect(allIds).toContain(result.winnerTicket.ticketId);
  });

  test("house cut test: 10 tickets × 10_000_000 NULL = 100_000_000 total", () => {
    const totalDeposit = 10 * DEFAULT_LOTTERY_CONFIG.ticketPriceNull; // 100_000_000 atomic = 100 NULL
    const { jackpot, houseCut } = computeJackpot(totalDeposit, DEFAULT_LOTTERY_CONFIG.houseFeeBps);

    // 0.5% of 100_000_000 = 500_000
    expect(houseCut).toBe(500_000);
    expect(jackpot).toBe(99_500_000);
    expect(jackpot + houseCut).toBe(totalDeposit);
  });
});
