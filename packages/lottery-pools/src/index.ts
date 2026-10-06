// Client math and encoders for the null_lottery_pools program
// (programs/null_lottery_pools). Every function mirrors the Rust code and is
// checked against programs/null_lottery_pools/tests/vectors/lottery_pools_v1.json.
//
// Amounts, slots, indexes and round ids are bigint (u64 on chain). Program ids
// are not hardcoded: derive PDAs with the seeds below and your configured
// program id (for example PublicKey.findProgramAddressSync from @solana/web3.js).

import { createHash } from "node:crypto";

// ── constants ───────────────────────────────────────────────────────────────

export const TICKET_LEAF_TAG = "null-lottery-pools:ticket:v1";
export const ENTROPY_TAG = "null-lottery-pools:draw:v1";
export const NUMBER_TAG = "null-lottery-pools:number:v1";
export const TREE_DEPTH = 20;
export const MAX_TICKETS = 1n << 20n;
export const DRAW_DELAY_SLOTS = 32n;
export const FALLBACK_STEP_SLOTS = 512n;
export const MAX_SLOT_HASH_ENTRIES = 512;
export const BPS = 10_000n;
export const U64_MAX = (1n << 64n) - 1n;
export const MAX_FEE_BPS = 3_000;
export const MAX_RESERVE_BPS = 2_000;
export const MIN_CAP_BPS = 1_000;
export const DEFAULT_CAP_BPS = 7_000;

export const ERROR_BASE = 0x4c50_0000;
export const POOL_ERRORS = {
  InvalidInstruction: 1,
  InvalidParams: 2,
  InvalidAccount: 3,
  AccountInUse: 4,
  WrongRound: 5,
  SalesClosed: 6,
  SalesOpen: 7,
  InvalidNumbers: 8,
  RoundFull: 9,
  PreviousRoundUnsettled: 10,
  InvalidSysvar: 11,
  DrawTooEarly: 12,
  WrongStatus: 13,
  ClaimWindowClosed: 14,
  ClaimWindowOpen: 15,
  TicketNotWinning: 16,
  InvalidProof: 17,
  AlreadyClaimed: 18,
  NotCreator: 19,
  InsufficientFees: 20,
  Insolvent: 21,
  RetireNotAllowed: 22,
  MathOverflow: 23,
  ClaimMismatch: 24,
  RoundNotFinished: 25,
  WrongRentPayer: 26,
  AlreadyRetired: 27,
} as const;
export type PoolErrorName = keyof typeof POOL_ERRORS;

/** Name of a custom program error code, or undefined if it is not ours. */
export function poolErrorName(code: number): PoolErrorName | undefined {
  for (const [name, n] of Object.entries(POOL_ERRORS)) {
    if (ERROR_BASE + n === code) return name as PoolErrorName;
  }
  return undefined;
}

// ── bytes ───────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

function readU64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

function readU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Ticket numbers zero padded to the 8 bytes the program commits to. */
export function padNumbers(numbers: ArrayLike<number>): Uint8Array {
  if (numbers.length > 8) throw new RangeError("at most 8 numbers");
  const out = new Uint8Array(8);
  out.set(Array.from(numbers));
  return out;
}

// ── tree ────────────────────────────────────────────────────────────────────

export function ticketLeaf(
  pool: Uint8Array,
  roundId: bigint,
  owner: Uint8Array,
  numbers: ArrayLike<number>,
  ticketIndex: bigint,
): Uint8Array {
  return sha256(enc.encode(TICKET_LEAF_TAG), pool, u64le(roundId), owner, padNumbers(numbers), u64le(ticketIndex));
}

export function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(Uint8Array.of(0x01), left, right);
}

/** ZEROS[0] is the empty leaf; ZEROS[TREE_DEPTH] is the root of an empty round. */
export const ZEROS: readonly Uint8Array[] = (() => {
  const z: Uint8Array[] = [new Uint8Array(32)];
  for (let i = 0; i < TREE_DEPTH; i++) z.push(node(z[i], z[i]));
  return z;
})();

function nextLevel(level: Uint8Array[], zero: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) out.push(node(level[i], level[i + 1] ?? zero));
  return out;
}

/** Root of a round with the given leaves (ticket order). */
export function rootOf(leaves: Uint8Array[]): Uint8Array {
  let level = leaves.slice();
  for (let l = 0; l < TREE_DEPTH; l++) {
    if (level.length === 0) level = [ZEROS[l]];
    level = nextLevel(level, ZEROS[l]);
  }
  return level[0];
}

/** Sibling path (TREE_DEPTH hashes) of leaf `index`. */
export function proofOf(leaves: Uint8Array[], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let level = leaves.slice();
  let i = index;
  for (let l = 0; l < TREE_DEPTH; l++) {
    proof.push(level[i ^ 1] ?? ZEROS[l]);
    level = nextLevel(level, ZEROS[l]);
    i >>= 1;
  }
  return proof;
}

export function rootFromProof(leaf: Uint8Array, index: bigint, proof: Uint8Array[]): Uint8Array {
  let acc = leaf;
  proof.forEach((sib, level) => {
    acc = (index >> BigInt(level)) & 1n ? node(sib, acc) : node(acc, sib);
  });
  return acc;
}

/** The on-chain frontier append, for indexers that follow a round live. */
export class IncrementalTree {
  readonly filled: Uint8Array[] = Array.from({ length: TREE_DEPTH }, () => new Uint8Array(32));
  count = 0n;
  root: Uint8Array = ZEROS[TREE_DEPTH];

  append(leaf: Uint8Array): Uint8Array {
    let cur = leaf;
    let idx = this.count;
    for (let l = 0; l < TREE_DEPTH; l++) {
      if ((idx & 1n) === 0n) {
        this.filled[l] = cur;
        cur = node(cur, ZEROS[l]);
      } else {
        cur = node(this.filled[l], cur);
      }
      idx >>= 1n;
    }
    this.count += 1n;
    this.root = cur;
    return cur;
  }
}

// ── economics ───────────────────────────────────────────────────────────────

export interface PoolParams {
  seed: bigint;
  ticketPrice: bigint;
  feeMaxBps: number;
  feeMinBps: number;
  reserveBps: number;
  capBps: number;
  pickK: number;
  rangeN: number;
  roundSlots: bigint;
  claimWindowSlots: bigint;
}

export interface Split {
  creator: bigint;
  reserve: bigint;
  jackpot: bigint;
}

export function binom(n: number, k: number): bigint {
  if (k > n) return 0n;
  let r = 1n;
  for (let i = 0n; i < BigInt(k); i++) r = (r * (BigInt(n) - i)) / (i + 1n);
  return r;
}

/** ceil(seed * 10_000 / feeMaxBps); U64_MAX for a zero-fee pool. */
export function recoupVolume(seed: bigint, feeMaxBps: number): bigint {
  if (feeMaxBps === 0) return U64_MAX;
  const d = BigInt(feeMaxBps);
  return (seed * BPS + d - 1n) / d;
}

export function jackpotCap(capBps: number, price: bigint, combos: bigint): bigint {
  return (BigInt(capBps) * price * combos) / BPS;
}

export function feeRateAfter(vr: bigint, feeMaxBps: number, feeMinBps: number, v: bigint): number {
  if (v === 0n) return feeMaxBps;
  let r = (BigInt(feeMaxBps) * vr) / v;
  if (r > BigInt(feeMaxBps)) r = BigInt(feeMaxBps);
  return Math.max(Number(r), feeMinBps);
}

/** Marginal creator fee rate in bps at cumulative sales `v`. */
export function feeRate(vr: bigint, feeMaxBps: number, feeMinBps: number, v: bigint): number {
  return v < vr ? feeMaxBps : feeRateAfter(vr, feeMaxBps, feeMinBps, v);
}

/** Creator fee of a sale of `amount` starting at cumulative sales `vBefore` (floored). */
export function creatorFee(vBefore: bigint, amount: bigint, vr: bigint, feeMaxBps: number, feeMinBps: number): bigint {
  const vAfter = vBefore + amount;
  if (vAfter > U64_MAX) throw new RangeError("volume overflow");
  const seg1 = vBefore < vr ? (vAfter < vr ? vAfter : vr) - vBefore : 0n;
  const start2 = vBefore > vr ? vBefore : vr;
  const seg2 = vAfter > start2 ? vAfter - start2 : 0n;
  const rate2 = seg2 > 0n ? feeRateAfter(vr, feeMaxBps, feeMinBps, start2) : 0;
  return (seg1 * BigInt(feeMaxBps) + seg2 * BigInt(rate2)) / BPS;
}

/** Split of one ticket sold at cumulative sales `vBefore`. */
export function splitTicket(p: PoolParams, vr: bigint, vBefore: bigint, retired: boolean): Split {
  const price = p.ticketPrice;
  const creator = retired ? 0n : creatorFee(vBefore, price, vr, p.feeMaxBps, p.feeMinBps);
  const reserve = (price * BigInt(p.reserveBps)) / BPS;
  return { creator, reserve, jackpot: price - creator - reserve };
}

/** [toJackpot, overflowToReserve] for adding `amount` under `cap`. */
export function applyCap(jackpot: bigint, amount: bigint, cap: bigint): [bigint, bigint] {
  const room = cap > jackpot ? cap - jackpot : 0n;
  const toJ = amount < room ? amount : room;
  return [toJ, amount - toJ];
}

export function validNumbers(numbers: ArrayLike<number>, k: number, n: number): boolean {
  const a = padNumbers(numbers);
  let prev = 0;
  for (let i = 0; i < 8; i++) {
    if (i < k) {
      if (a[i] <= prev || a[i] > n) return false;
      prev = a[i];
    } else if (a[i] !== 0) {
      return false;
    }
  }
  return true;
}

// ── draw ────────────────────────────────────────────────────────────────────

export interface Selection {
  attempt: bigint;
  targetSlot: bigint;
  usedSlot: bigint;
  hash: Uint8Array;
}

export type SelectError = "Malformed" | "TooEarly" | "Overflow";

export function firstTarget(closeSlot: bigint): bigint {
  return closeSlot + DRAW_DELAY_SLOTS;
}

/** Which SlotHashes entry a Draw uses (entries in any order). */
export function selectSlotHash(
  entries: { slot: bigint; hash: Uint8Array }[],
  t0: bigint,
): Selection | { error: SelectError } {
  if (entries.length === 0 || entries.length > MAX_SLOT_HASH_ENTRIES) return { error: "Malformed" };
  const e = entries.slice().sort((a, b) => (a.slot > b.slot ? -1 : a.slot < b.slot ? 1 : 0));
  const newest = e[0].slot;
  const oldest = e[e.length - 1].slot;
  const attempt = oldest <= t0 ? 0n : (oldest - t0 + FALLBACK_STEP_SLOTS - 1n) / FALLBACK_STEP_SLOTS;
  const target = t0 + attempt * FALLBACK_STEP_SLOTS;
  if (target > U64_MAX) return { error: "Overflow" };
  if (newest < target) return { error: "TooEarly" };
  let used = e[0];
  for (const x of e) if (x.slot >= target) used = x;
  return { attempt, targetSlot: target, usedSlot: used.slot, hash: used.hash };
}

export function drawEntropy(
  pool: Uint8Array,
  roundId: bigint,
  sel: Selection,
  ticketsRoot: Uint8Array,
  ticketCount: bigint,
): Uint8Array {
  return sha256(
    enc.encode(ENTROPY_TAG),
    pool,
    u64le(roundId),
    u64le(sel.targetSlot),
    u64le(sel.usedSlot),
    sel.hash,
    ticketsRoot,
    u64le(ticketCount),
  );
}

/** k distinct numbers in 1..=n, ascending, zero padded to 8. */
export function drawNumbers(entropy: Uint8Array, k: number, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i + 1);
  for (let j = 0; j < k; j++) {
    const h = sha256(enc.encode(NUMBER_TAG), entropy, Uint8Array.of(j));
    const r = readU64(h, 0);
    const pick = j + Number(r % BigInt(n - j));
    [a[j], a[pick]] = [a[pick], a[j]];
  }
  const out = a.slice(0, k).sort((x, y) => x - y);
  while (out.length < 8) out.push(0);
  return out;
}

// ── instruction data ────────────────────────────────────────────────────────

export function encodeCreatePool(nonce: bigint, p: PoolParams): Uint8Array {
  return concat([
    Uint8Array.of(0),
    u64le(nonce),
    u64le(p.seed),
    u64le(p.ticketPrice),
    u16le(p.feeMaxBps),
    u16le(p.feeMinBps),
    u16le(p.reserveBps),
    u16le(p.capBps),
    Uint8Array.of(p.pickK, p.rangeN),
    u64le(p.roundSlots),
    u64le(p.claimWindowSlots),
  ]);
}

export function encodeBuyTicket(roundId: bigint, owner: Uint8Array, numbers: ArrayLike<number>): Uint8Array {
  return concat([Uint8Array.of(1), u64le(roundId), owner, padNumbers(numbers)]);
}

export function encodeDraw(): Uint8Array {
  return Uint8Array.of(2);
}

export function encodeClaim(ticketIndex: bigint, numbers: ArrayLike<number>, proof: Uint8Array[]): Uint8Array {
  if (proof.length !== TREE_DEPTH) throw new RangeError(`proof must have ${TREE_DEPTH} hashes`);
  return concat([Uint8Array.of(3), u64le(ticketIndex), padNumbers(numbers), ...proof]);
}

export const encodeSettle = (): Uint8Array => Uint8Array.of(4);
export const encodePayout = (): Uint8Array => Uint8Array.of(5);
export const encodeRetire = (): Uint8Array => Uint8Array.of(7);
export const encodeCloseRound = (): Uint8Array => Uint8Array.of(8);

export function encodeWithdrawCreatorFees(amount: bigint): Uint8Array {
  return concat([Uint8Array.of(6), u64le(amount)]);
}

// ── PDA seeds ───────────────────────────────────────────────────────────────

export const poolSeeds = (creator: Uint8Array, nonce: bigint): Uint8Array[] => [enc.encode("pool"), creator, u64le(nonce)];
export const roundSeeds = (pool: Uint8Array, roundId: bigint): Uint8Array[] => [enc.encode("round"), pool, u64le(roundId)];
export const claimSeeds = (pool: Uint8Array, roundId: bigint, ticketIndex: bigint): Uint8Array[] => [
  enc.encode("claim"),
  pool,
  u64le(roundId),
  u64le(ticketIndex),
];

// ── accounts ────────────────────────────────────────────────────────────────

export const POOL_LEN = 280 + 32 * TREE_DEPTH;
export const ROUND_LEN = 248;
export const CLAIM_LEN = 89;

export interface PoolAccount {
  creator: Uint8Array;
  nonce: bigint;
  params: PoolParams;
  retired: boolean;
  lastSettleWon: boolean;
  hasPending: boolean;
  bump: number;
  combos: bigint;
  cap: bigint;
  recoupVolume: bigint;
  jackpot: bigint;
  reserve: bigint;
  creatorOwed: bigint;
  creatorWithdrawn: bigint;
  lockedPrize: bigint;
  owedPrizes: bigint;
  totalSales: bigint;
  pendingRoundId: bigint;
  roundId: bigint;
  roundOpenSlot: bigint;
  roundCloseSlot: bigint;
  ticketCount: bigint;
  root: Uint8Array;
}

export function decodePool(d: Uint8Array): PoolAccount {
  if (d.length !== POOL_LEN || new TextDecoder().decode(d.subarray(0, 8)) !== "NLPPOOL1") {
    throw new Error("not a pool account");
  }
  let o = 8;
  const bytes = (n: number) => d.slice(o, (o += n));
  const u64 = () => ((o += 8), readU64(d, o - 8));
  const u16 = () => ((o += 2), readU16(d, o - 2));
  const u8 = () => d[o++];
  const creator = bytes(32);
  const nonce = u64();
  const seed = u64();
  const ticketPrice = u64();
  const feeMaxBps = u16();
  const feeMinBps = u16();
  const reserveBps = u16();
  const capBps = u16();
  const pickK = u8();
  const rangeN = u8();
  const retired = u8() !== 0;
  const lastSettleWon = u8() !== 0;
  const hasPending = u8() !== 0;
  const bump = u8();
  const roundSlots = u64();
  const claimWindowSlots = u64();
  return {
    creator,
    nonce,
    params: { seed, ticketPrice, feeMaxBps, feeMinBps, reserveBps, capBps, pickK, rangeN, roundSlots, claimWindowSlots },
    retired,
    lastSettleWon,
    hasPending,
    bump,
    combos: u64(),
    cap: u64(),
    recoupVolume: u64(),
    jackpot: u64(),
    reserve: u64(),
    creatorOwed: u64(),
    creatorWithdrawn: u64(),
    lockedPrize: u64(),
    owedPrizes: u64(),
    totalSales: u64(),
    pendingRoundId: u64(),
    roundId: u64(),
    roundOpenSlot: u64(),
    roundCloseSlot: u64(),
    ticketCount: u64(),
    root: bytes(32),
  };
}

export interface RoundAccount {
  pool: Uint8Array;
  roundId: bigint;
  status: "drawn" | "settled";
  bump: number;
  attempt: bigint;
  targetSlot: bigint;
  usedSlot: bigint;
  slotHash: Uint8Array;
  root: Uint8Array;
  ticketCount: bigint;
  numbers: number[];
  prize: bigint;
  windowEnd: bigint;
  winners: bigint;
  share: bigint;
  paid: bigint;
  rentPayer: Uint8Array;
  drawSlot: bigint;
}

export function decodeRound(d: Uint8Array): RoundAccount {
  if (d.length !== ROUND_LEN || new TextDecoder().decode(d.subarray(0, 8)) !== "NLPROND1") {
    throw new Error("not a round account");
  }
  let o = 8;
  const bytes = (n: number) => d.slice(o, (o += n));
  const u64 = () => ((o += 8), readU64(d, o - 8));
  const pool = bytes(32);
  const roundId = u64();
  const status = d[o++] === 2 ? "settled" : "drawn";
  return {
    pool,
    roundId,
    status,
    bump: d[o++],
    attempt: u64(),
    targetSlot: u64(),
    usedSlot: u64(),
    slotHash: bytes(32),
    root: bytes(32),
    ticketCount: u64(),
    numbers: Array.from(bytes(8)),
    prize: u64(),
    windowEnd: u64(),
    winners: u64(),
    share: u64(),
    paid: u64(),
    rentPayer: bytes(32),
    drawSlot: u64(),
  };
}

/** Solvency invariant as the program checks it. */
export function poolLiabilities(p: PoolAccount): bigint {
  return p.jackpot + p.reserve + p.creatorOwed + p.lockedPrize + p.owedPrizes;
}

// ── logs ────────────────────────────────────────────────────────────────────

export interface TicketLog {
  roundId: bigint;
  ticketIndex: bigint;
  owner: Uint8Array;
  numbers: number[];
  leaf: Uint8Array;
}

/**
 * Parse a "Program data: ..." log line written by BuyTicket
 * (fields: "ticket", round_id, ticket_index, owner, numbers, leaf).
 * Returns undefined for any other line. The leaf is recomputed and checked
 * when `pool` is given.
 */
export function parseTicketLog(line: string, pool?: Uint8Array): TicketLog | undefined {
  const prefix = "Program data: ";
  if (!line.startsWith(prefix)) return undefined;
  const f = line.slice(prefix.length).trim().split(" ").map((s) => new Uint8Array(Buffer.from(s, "base64")));
  if (f.length !== 6 || new TextDecoder().decode(f[0]) !== "ticket") return undefined;
  const t: TicketLog = {
    roundId: readU64(f[1], 0),
    ticketIndex: readU64(f[2], 0),
    owner: f[3],
    numbers: Array.from(f[4]),
    leaf: f[5],
  };
  if (pool && !eq(ticketLeaf(pool, t.roundId, t.owner, t.numbers, t.ticketIndex), t.leaf)) {
    throw new Error("ticket log leaf mismatch");
  }
  return t;
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}
