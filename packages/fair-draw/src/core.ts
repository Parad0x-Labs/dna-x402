// Core math, encoders and decoders of the null_fair_draw program
// (programs/null_fair_draw). No imports: this file runs in Node.js and in the
// browser (verify.html inlines it with the TypeScript types stripped). Every
// function mirrors the Rust code and is checked against
// programs/null_fair_draw/tests/vectors/fair_draw_v1.json.
//
// Amounts, weights, slots and indexes are bigint (u64 on chain). Keys are
// 32-byte Uint8Arrays; base58 helpers convert them.

// ── constants ───────────────────────────────────────────────────────────────

export const LEAF_TAG = "null-fair-draw:leaf:v1";
export const SEED_TAG = "null-fair-draw:seed:v1";
export const STREAM_TAG = "null-fair-draw:stream:v1";
export const OPEN_DEPTH = 20;
export const MAX_LIST_DEPTH = 22;
export const PAIR_LEN = 40;
export const FRONTIER_LEN = OPEN_DEPTH * PAIR_LEN;
export const DRAW_DELAY_SLOTS = 32n;
export const FALLBACK_STEP_SLOTS = 512n;
export const MAX_TIERS = 8;
export const MAX_ROUNDS = 4;
export const MAX_SLOTS = 1024;
export const MAX_ALLOC_STEP = 10_240;
export const ROUND_INFO_LEN = 96;
export const HEADER_LEN = 408 + MAX_ROUNDS * ROUND_INFO_LEN;
export const SLOT_LEN = 60;
export const WON_LEN = 16;
export const MODE_OPEN = 0;
export const MODE_LIST = 1;
export const STATUS = { created: 0, funded: 1, awaitDraw: 2, resolving: 3, complete: 4 } as const;
export const SLOT_STATUS = { pending: 0, won: 1, claimed: 2, forfeited: 3, void: 4 } as const;
export const U64_MAX = (1n << 64n) - 1n;
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SLOT_HASHES_SYSVAR = "SysvarS1otHashes111111111111111111111111111";

export const ERROR_BASE = 0x4644_0000;
export const DRAW_ERRORS = {
  InvalidInstruction: 1,
  InvalidParams: 2,
  InvalidAccount: 3,
  AccountInUse: 4,
  WrongStatus: 5,
  EntriesClosed: 6,
  EntriesOpen: 7,
  WalletCapExceeded: 8,
  TreeFull: 9,
  InvalidSysvar: 10,
  DrawTooEarly: 11,
  InvalidProof: 12,
  PointNotInLeaf: 13,
  MissingProof: 14,
  NotWinner: 15,
  ClaimWindowClosed: 16,
  ClaimWindowOpen: 17,
  NotOrganizer: 18,
  Insolvent: 19,
  MathOverflow: 20,
  InvalidTokenAccount: 21,
  NothingToResolve: 22,
  ZeroWeight: 23,
  AlreadyClaimed: 24,
  EntrantInUse: 25,
  AccountNotExtended: 26,
} as const;
export type DrawErrorName = keyof typeof DRAW_ERRORS;

/** Name of a custom program error code, or undefined if it is not ours. */
export function drawErrorName(code: number): DrawErrorName | undefined {
  for (const [name, n] of Object.entries(DRAW_ERRORS)) {
    if (ERROR_BASE + n === code) return name as DrawErrorName;
  }
  return undefined;
}

// ── bytes ───────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

export function readU64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

function readU32(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
}

function readU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function fromBase58(s: string, len = 32): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character ${c}`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  if (out.length !== len) throw new Error(`base58 value is ${out.length} bytes, expected ${len}`);
  return Uint8Array.from(out);
}

/** A 32-byte key from base58 text or bytes. */
export function key(k: string | Uint8Array): Uint8Array {
  return typeof k === "string" ? fromBase58(k) : k;
}

// ── SHA-256 (synchronous, no dependencies) ──────────────────────────────────

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const msg = concat(parts);
  const bitLen = msg.length * 8;
  const padLen = ((msg.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 4, bitLen >>> 0);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]);
  return out;
}

// ── program-derived addresses ───────────────────────────────────────────────

const P = (1n << 255n) - 19n;
const D = (-121665n * modPow(121666n, P - 2n, P)) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = ((b % m) + m) % m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Whether 32 bytes decode to a point of ed25519 (PDAs must not). */
export function isOnCurve(b: Uint8Array): boolean {
  const bytes = b.slice();
  const sign = bytes[31] >> 7;
  bytes[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * modPow(mod(u * v7), (P - 5n) / 8n, P));
  const vx2 = mod(v * x * x);
  if (vx2 === u) {
    // root found
  } else if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
  } else {
    return false;
  }
  return !(x === 0n && sign === 1);
}

export function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array {
  const h = sha256(...seeds, programId, enc.encode("ProgramDerivedAddress"));
  if (isOnCurve(h)) throw new Error("address is on the curve");
  return h;
}

export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): [Uint8Array, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch {
      // next bump
    }
  }
  throw new Error("no viable bump");
}

export const drawAddress = (programId: Uint8Array, organizer: Uint8Array, drawId: bigint): [Uint8Array, number] =>
  findProgramAddress([enc.encode("draw"), organizer, u64le(drawId)], programId);
export const vaultAddress = (programId: Uint8Array, draw: Uint8Array): [Uint8Array, number] =>
  findProgramAddress([enc.encode("vault"), draw], programId);
export const entrantAddress = (programId: Uint8Array, draw: Uint8Array, owner: Uint8Array): [Uint8Array, number] =>
  findProgramAddress([enc.encode("entrant"), draw, owner], programId);

// ── sum tree ────────────────────────────────────────────────────────────────

/** A tree node: hash and the total weight below it. */
export type Pair = { hash: Uint8Array; weight: bigint };

export function leafHash(draw: Uint8Array, wallet: Uint8Array, weight: bigint): Uint8Array {
  return sha256(enc.encode(LEAF_TAG), draw, wallet, u64le(weight));
}

export function node(l: Pair, r: Pair): Pair {
  const w = l.weight + r.weight;
  if (w > U64_MAX) throw new RangeError("weight overflow");
  return { hash: sha256(Uint8Array.of(1), l.hash, u64le(l.weight), r.hash, u64le(r.weight)), weight: w };
}

/** ZEROS[i] is the empty subtree of height i (weight 0). */
export const ZEROS: readonly Uint8Array[] = (() => {
  const z: Uint8Array[] = [new Uint8Array(32)];
  for (let i = 0; i < MAX_LIST_DEPTH; i++) z.push(node({ hash: z[i], weight: 0n }, { hash: z[i], weight: 0n }).hash);
  return z;
})();

/** All levels of a depth-`depth` tree (levels[depth][0] is the root). */
export function buildTree(leaves: Pair[], depth: number): Pair[][] {
  const levels: Pair[][] = [];
  let cur = leaves.slice();
  for (let l = 0; l < depth; l++) {
    const z: Pair = { hash: ZEROS[l], weight: 0n };
    if (cur.length === 0) cur = [z, z];
    if (cur.length % 2 === 1) cur.push(z);
    levels.push(cur);
    const next: Pair[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(node(cur[i], cur[i + 1]));
    cur = next;
  }
  levels.push(cur);
  return levels;
}

export function rootOf(leaves: Pair[], depth: number): Pair {
  if (leaves.length === 0) return { hash: ZEROS[depth], weight: 0n };
  return buildTree(leaves, depth)[depth][0];
}

/** Sibling pairs from the leaf up, as `depth * 40` bytes. */
export function proofFromLevels(levels: Pair[][], depth: number, index: number): Uint8Array {
  const out = new Uint8Array(depth * PAIR_LEN);
  let i = index;
  for (let l = 0; l < depth; l++) {
    const sib = levels[l][i ^ 1] ?? { hash: ZEROS[l], weight: 0n };
    out.set(sib.hash, l * PAIR_LEN);
    out.set(u64le(sib.weight), l * PAIR_LEN + 32);
    i >>= 1;
  }
  return out;
}

export function proofOf(leaves: Pair[], depth: number, index: number): Uint8Array {
  return proofFromLevels(buildTree(leaves, depth), depth, index);
}

/** The leaf's interval start if the proof reaches (root, total); otherwise undefined. */
export function verifyProof(
  root: Uint8Array,
  total: bigint,
  depth: number,
  count: bigint,
  index: bigint,
  leaf: Uint8Array,
  weight: bigint,
  path: Uint8Array,
): bigint | undefined {
  if (weight === 0n || index >= count || path.length !== depth * PAIR_LEN || depth > MAX_LIST_DEPTH) return undefined;
  if (index >> BigInt(depth) !== 0n) return undefined;
  let acc: Pair = { hash: leaf, weight };
  let prefix = 0n;
  try {
    for (let l = 0; l < depth; l++) {
      const sib: Pair = { hash: path.subarray(l * PAIR_LEN, l * PAIR_LEN + 32), weight: readU64(path, l * PAIR_LEN + 32) };
      if ((index >> BigInt(l)) & 1n) {
        prefix += sib.weight;
        if (prefix > U64_MAX) return undefined;
        acc = node(sib, acc);
      } else {
        acc = node(acc, sib);
      }
    }
  } catch {
    return undefined;
  }
  return equalBytes(acc.hash, root) && acc.weight === total ? prefix : undefined;
}

/** Smallest depth (at least 1) holding `count` leaves. */
export function depthFor(count: number): number {
  let d = 1;
  while (2 ** d < count) d++;
  return d;
}

// ── entry lists ─────────────────────────────────────────────────────────────

export interface Entry {
  wallet: Uint8Array;
  weight: bigint;
}

/**
 * Parse an entry list: JSON (`[{ "wallet": "<base58>", "weight": 3 }, ...]`,
 * weight optional, default 1) or CSV (`wallet,weight` per line, optional header,
 * weight optional). Order is the leaf order.
 */
export function parseList(text: string): Entry[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    const rows = JSON.parse(t) as { wallet: string; weight?: number | string }[];
    return rows.map((r) => ({ wallet: fromBase58(r.wallet), weight: BigInt(r.weight ?? 1) }));
  }
  const out: Entry[] = [];
  for (const line of t.split(/\r?\n/)) {
    const cells = line.split(",").map((c) => c.trim());
    if (!cells[0] || /^wallet$/i.test(cells[0])) continue;
    out.push({ wallet: fromBase58(cells[0]), weight: BigInt(cells[1] || "1") });
  }
  return out;
}

/** The committed list of a draw: leaves, root, total, count and depth. */
export interface BuiltList {
  entries: Entry[];
  leaves: Pair[];
  levels: Pair[][];
  root: Uint8Array;
  total: bigint;
  count: bigint;
  depth: number;
}

export function buildList(draw: Uint8Array, entries: Entry[], depth?: number): BuiltList {
  if (entries.length === 0) throw new Error("empty list");
  for (const e of entries) if (e.weight <= 0n) throw new Error("zero-weight entries are rejected");
  const d = depth ?? depthFor(entries.length);
  const leaves = entries.map((e) => ({ hash: leafHash(draw, e.wallet, e.weight), weight: e.weight }));
  const levels = buildTree(leaves, d);
  const r = levels[d][0];
  return { entries, leaves, levels, root: r.hash, total: r.weight, count: BigInt(entries.length), depth: d };
}

export interface LeafProof {
  leafIndex: bigint;
  wallet: Uint8Array;
  weight: bigint;
  path: Uint8Array;
}

export function listProof(list: BuiltList, index: number): LeafProof {
  return {
    leafIndex: BigInt(index),
    wallet: list.entries[index].wallet,
    weight: list.entries[index].weight,
    path: proofFromLevels(list.levels, list.depth, index),
  };
}

/** Leaf index whose interval contains point p. */
export function leafAt(list: BuiltList, p: bigint): number {
  let acc = 0n;
  for (let i = 0; i < list.entries.length; i++) {
    const w = list.entries[i].weight;
    if (w > 0n && p < acc + w) return i;
    acc += w;
  }
  throw new RangeError("point beyond total");
}

// ── stream ──────────────────────────────────────────────────────────────────

export function drawSeed(
  draw: Uint8Array,
  round: number,
  targetSlot: bigint,
  usedSlot: bigint,
  slotHash: Uint8Array,
  root: Uint8Array,
  total: bigint,
  count: bigint,
): Uint8Array {
  return sha256(enc.encode(SEED_TAG), draw, Uint8Array.of(round), u64le(targetSlot), u64le(usedSlot), slotHash, root, u64le(total), u64le(count));
}

export function streamBlock(seed: Uint8Array, j: bigint): Uint8Array {
  const tag = enc.encode(STREAM_TAG);
  return concat([sha256(tag, seed, u64le(j), Uint8Array.of(0)), sha256(tag, seed, u64le(j), Uint8Array.of(1))]);
}

/** X mod m for the 512-bit big-endian integer X. */
export function wideMod(x: Uint8Array, m: bigint): bigint {
  let v = 0n;
  for (const b of x) v = (v << 8n) | BigInt(b);
  return v % m;
}

export function point(seed: Uint8Array, j: bigint, m: bigint): bigint {
  return wideMod(streamBlock(seed, j), m);
}

/** Map u past the won intervals [start, start + weight), sorted by start. */
export function remap(u: bigint, wonSorted: [bigint, bigint][]): bigint {
  let p = u;
  for (const [start, weight] of wonSorted) {
    if (start <= p) p += weight;
    else break;
  }
  return p;
}

/**
 * Reference draw: winner leaf indexes (null for a void slot) of `slots` slots
 * starting at global slot `firstSlot`, after the leaves in `alreadyWon`.
 */
export function referenceDraw(
  weights: bigint[],
  alreadyWon: number[],
  seed: Uint8Array,
  firstSlot: bigint,
  slots: number,
): (number | null)[] {
  const starts: bigint[] = [];
  let acc = 0n;
  for (const w of weights) {
    starts.push(acc);
    acc += w;
  }
  const total = acc;
  const won: [bigint, bigint][] = alreadyWon.map((i) => [starts[i], weights[i]]);
  won.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let wonWeight = won.reduce((s, x) => s + x[1], 0n);
  const out: (number | null)[] = [];
  for (let s = 0; s < slots; s++) {
    const m = total - wonWeight;
    if (m === 0n) {
      out.push(null);
      continue;
    }
    const p = remap(point(seed, firstSlot + BigInt(s), m), won);
    let i = 0;
    for (let k = 0; k < weights.length; k++) {
      if (weights[k] > 0n && starts[k] <= p && p < starts[k] + weights[k]) {
        i = k;
        break;
      }
    }
    let pos = 0;
    while (pos < won.length && won[pos][0] < starts[i]) pos++;
    won.splice(pos, 0, [starts[i], weights[i]]);
    wonWeight += weights[i];
    out.push(i);
  }
  return out;
}

// ── instruction data ────────────────────────────────────────────────────────

export interface Tier {
  count: number;
  amount: bigint;
}

export interface CreateParams {
  mode: number;
  weighted: boolean;
  redrawRounds: number;
  tiers: Tier[];
  entryPrice: bigint;
  walletCap: bigint;
  closeSlot: bigint;
  claimWindowSlots: bigint;
  /** 32 zero bytes (or undefined) for SOL. */
  prizeMint?: Uint8Array;
  entryMint?: Uint8Array;
  feeDest?: Uint8Array;
}

const ZERO32 = new Uint8Array(32);

export function encodeCreateDraw(drawId: bigint, p: CreateParams): Uint8Array {
  return concat([
    Uint8Array.of(0),
    u64le(drawId),
    Uint8Array.of(p.mode, p.weighted ? 1 : 0, p.redrawRounds, p.tiers.length),
    ...p.tiers.flatMap((t) => [u32le(t.count), u64le(t.amount)]),
    u64le(p.entryPrice),
    u64le(p.walletCap),
    u64le(p.closeSlot),
    u64le(p.claimWindowSlots),
    p.prizeMint ?? ZERO32,
    p.entryMint ?? ZERO32,
    p.feeDest ?? ZERO32,
  ]);
}

function encodeProof(p: LeafProof): Uint8Array {
  return concat([u64le(p.leafIndex), p.wallet, u64le(p.weight), Uint8Array.of(p.path.length / PAIR_LEN), p.path]);
}

export const encodeFundPrizes = (): Uint8Array => Uint8Array.of(1);
export const encodeEnter = (count: number, owner: Uint8Array): Uint8Array => concat([Uint8Array.of(2), u32le(count), owner]);
export const encodeCommitList = (root: Uint8Array, total: bigint, count: bigint, depth: number): Uint8Array =>
  concat([Uint8Array.of(3), root, u64le(total), u64le(count), Uint8Array.of(depth)]);
export const encodeDraw = (): Uint8Array => Uint8Array.of(4);
export const encodeResolve = (max: number, proofs: LeafProof[]): Uint8Array =>
  concat([Uint8Array.of(5, max, proofs.length), ...proofs.map(encodeProof)]);
export const encodeClaim = (slot: number, proof?: LeafProof): Uint8Array =>
  concat([Uint8Array.of(6), u16le(slot), proof ? concat([Uint8Array.of(1), encodeProof(proof)]) : Uint8Array.of(0)]);
export const encodeAdvance = (): Uint8Array => Uint8Array.of(7);
export const encodeReclaim = (): Uint8Array => Uint8Array.of(8);
export const encodeClose = (): Uint8Array => Uint8Array.of(9);
export const encodeCancel = (): Uint8Array => Uint8Array.of(10);
export const encodeProveEntry = (proof: LeafProof): Uint8Array => concat([Uint8Array.of(11), encodeProof(proof)]);
export const encodeCloseEntrant = (): Uint8Array => Uint8Array.of(12);
export const encodeExtend = (): Uint8Array => Uint8Array.of(13);

// ── draw account ────────────────────────────────────────────────────────────

export interface RoundInfo {
  firstTarget: bigint;
  targetSlot: bigint;
  usedSlot: bigint;
  attempt: bigint;
  slotHash: Uint8Array;
  seed: Uint8Array;
}

export interface Slot {
  start: bigint;
  weight: bigint;
  leafIndex: bigint;
  wallet: Uint8Array;
  tier: number;
  status: number;
  round: number;
}

export interface DrawAccount {
  organizer: Uint8Array;
  drawId: bigint;
  bump: number;
  vaultBump: number;
  mode: number;
  weighted: boolean;
  status: number;
  round: number;
  redrawRounds: number;
  tierCount: number;
  depth: number;
  wonCount: number;
  prizeMint: Uint8Array;
  entryMint: Uint8Array;
  feeDest: Uint8Array;
  entryPrice: bigint;
  walletCap: bigint;
  closeSlot: bigint;
  claimWindowSlots: bigint;
  tiers: Tier[];
  totalPrize: bigint;
  funded: bigint;
  paid: bigint;
  returned: bigint;
  refundable: bigint;
  root: Uint8Array;
  totalWeight: bigint;
  leafCount: bigint;
  commitSlot: bigint;
  wonWeight: bigint;
  capacity: number;
  slotCount: number;
  nextSlot: number;
  roundFirstSlot: number;
  windowEnd: bigint;
  rounds: RoundInfo[];
  slots: Slot[];
  won: [bigint, bigint][];
}

export function drawLen(mode: number, capacity: number): number {
  return HEADER_LEN + (mode === MODE_OPEN ? FRONTIER_LEN : 0) + capacity * (SLOT_LEN + WON_LEN);
}

export function decodeDraw(d: Uint8Array): DrawAccount {
  if (d.length < HEADER_LEN || new TextDecoder().decode(d.subarray(0, 8)) !== "NFDDRAW1") throw new Error("not a draw account");
  let o = 8;
  const bytes = (n: number) => d.slice(o, (o += n));
  const u8 = () => d[o++];
  const u16 = () => ((o += 2), readU16(d, o - 2));
  const u32 = () => ((o += 4), readU32(d, o - 4));
  const u64 = () => ((o += 8), readU64(d, o - 8));
  const organizer = bytes(32);
  const drawId = u64();
  const bump = u8();
  const vaultBump = u8();
  const mode = u8();
  const weighted = u8() !== 0;
  const status = u8();
  const round = u8();
  const redrawRounds = u8();
  const tierCount = u8();
  const depth = u8();
  const wonCount = u16();
  o += 5;
  const prizeMint = bytes(32);
  const entryMint = bytes(32);
  const feeDest = bytes(32);
  const entryPrice = u64();
  const walletCap = u64();
  const closeSlot = u64();
  const claimWindowSlots = u64();
  const allTiers: Tier[] = [];
  for (let i = 0; i < MAX_TIERS; i++) allTiers.push({ count: u32(), amount: u64() });
  const a: DrawAccount = {
    organizer, drawId, bump, vaultBump, mode, weighted, status, round, redrawRounds, tierCount, depth, wonCount,
    prizeMint, entryMint, feeDest, entryPrice, walletCap, closeSlot, claimWindowSlots,
    tiers: allTiers.slice(0, tierCount),
    totalPrize: u64(), funded: u64(), paid: u64(), returned: u64(), refundable: u64(),
    root: bytes(32), totalWeight: u64(), leafCount: u64(), commitSlot: u64(), wonWeight: u64(),
    capacity: u16(), slotCount: u16(), nextSlot: u16(), roundFirstSlot: u16(), windowEnd: u64(),
    rounds: [], slots: [], won: [],
  };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    a.rounds.push({ firstTarget: u64(), targetSlot: u64(), usedSlot: u64(), attempt: u64(), slotHash: bytes(32), seed: bytes(32) });
  }
  const full = drawLen(mode, a.capacity);
  if (d.length !== full) {
    if (status === STATUS.created && d.length < full) return a;
    throw new Error("draw account size mismatch");
  }
  const so = HEADER_LEN + (mode === MODE_OPEN ? FRONTIER_LEN : 0);
  for (let i = 0; i < a.slotCount; i++) {
    const b = so + i * SLOT_LEN;
    a.slots.push({
      start: readU64(d, b), weight: readU64(d, b + 8), leafIndex: readU64(d, b + 16), wallet: d.slice(b + 24, b + 56),
      tier: d[b + 56], status: d[b + 57], round: d[b + 58],
    });
  }
  const wo = so + a.capacity * SLOT_LEN;
  for (let k = 0; k < wonCount; k++) a.won.push([readU64(d, wo + k * WON_LEN), readU64(d, wo + k * WON_LEN + 8)]);
  return a;
}

/** Prizes not yet paid or returned. */
export const outstanding = (a: DrawAccount): bigint => a.funded - a.paid - a.returned;

// ── logs ────────────────────────────────────────────────────────────────────

function b64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Entry receipts from "Program data: ..." log lines of Enter
 * (fields: "entry", index, owner, weight, leaf). The leaf is recomputed and
 * checked against the draw key.
 */
export function parseEntryLog(line: string, draw: Uint8Array): { index: bigint; owner: Uint8Array; weight: bigint } | undefined {
  const prefix = "Program data: ";
  if (!line.startsWith(prefix)) return undefined;
  const f = line.slice(prefix.length).trim().split(" ").map(b64);
  if (f.length !== 5 || new TextDecoder().decode(f[0]) !== "entry") return undefined;
  const e = { index: readU64(f[1], 0), owner: f[2], weight: readU64(f[3], 0) };
  if (!equalBytes(leafHash(draw, e.owner, e.weight), f[4])) throw new Error("entry log leaf mismatch");
  return e;
}

/**
 * Entries of an open raffle, rebuilt from the Enter logs of `programId`
 * (one array of log lines per transaction, oldest to newest), in leaf order.
 * Only "Program data" lines inside the program's own invocation count.
 */
export function entriesFromLogs(txLogs: string[][], programId: string, draw: Uint8Array): Entry[] {
  const byIndex = new Map<bigint, Entry>();
  for (const lines of txLogs) {
    const stack: string[] = [];
    for (const line of lines) {
      const inv = /^Program (\w+) invoke/.exec(line);
      if (inv) {
        stack.push(inv[1]);
        continue;
      }
      if (/^Program \w+ (success|failed)/.test(line)) {
        stack.pop();
        continue;
      }
      if (stack[stack.length - 1] !== programId) continue;
      const e = parseEntryLog(line, draw);
      if (e) byIndex.set(e.index, { wallet: e.owner, weight: e.weight });
    }
  }
  const out: Entry[] = [];
  for (let i = 0n; i < BigInt(byIndex.size); i++) {
    const e = byIndex.get(i);
    if (!e) throw new Error(`entry ${i} missing from the logs`);
    out.push(e);
  }
  return out;
}

// ── verification ────────────────────────────────────────────────────────────

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  winners: { slot: number; round: number; tier: number; leafIndex: bigint; wallet: string; status: number; amount: bigint }[];
  proofsChecked: number;
}

/**
 * Recompute a draw from its account bytes and the full entry list (leaf
 * order): the root and total, every round's seed, the winner of every
 * resolved slot (in slot order, re-draw rounds included), the won-interval
 * table, and a proof for every winner.
 */
export function verifyDrawState(drawKey: Uint8Array, a: DrawAccount, entries: Entry[]): VerifyReport {
  const problems: string[] = [];
  const winners: VerifyReport["winners"] = [];
  let proofsChecked = 0;
  if (a.leafCount === 0n) {
    if (entries.length) problems.push("account has no entries but a list was given");
    return { ok: problems.length === 0, problems, winners, proofsChecked };
  }
  const list = buildList(drawKey, entries.map((e) => ({ ...e })), a.depth);
  if (!equalBytes(list.root, a.root)) problems.push("list root differs from the committed root");
  if (list.total !== a.totalWeight) problems.push(`total weight ${list.total} != committed ${a.totalWeight}`);
  if (list.count !== a.leafCount) problems.push(`entry count ${list.count} != committed ${a.leafCount}`);
  if (!a.weighted && entries.some((e) => e.weight !== 1n)) problems.push("unweighted draw with a weight other than 1");
  const weights = entries.map((e) => e.weight);
  const wonLeaves: number[] = [];
  for (let r = 0; r <= a.round && r < MAX_ROUNDS; r++) {
    const ri = a.rounds[r];
    const roundSlots = a.slots.map((s, j) => ({ s, j })).filter((x) => x.s.round === r && x.j < a.nextSlot);
    if (roundSlots.length === 0) continue;
    if (ri.targetSlot !== ri.firstTarget + ri.attempt * FALLBACK_STEP_SLOTS) problems.push(`round ${r}: target slot does not match the fixed fallback schedule`);
    if (ri.usedSlot < ri.targetSlot) problems.push(`round ${r}: used slot before target`);
    const seed = drawSeed(drawKey, r, ri.targetSlot, ri.usedSlot, ri.slotHash, a.root, a.totalWeight, a.leafCount);
    if (!equalBytes(seed, ri.seed)) problems.push(`round ${r}: seed mismatch`);
    const startSlot = roundSlots[0].j;
    const expect = referenceDraw(weights, wonLeaves, seed, BigInt(startSlot), roundSlots.length);
    roundSlots.forEach(({ s, j }, k) => {
      const e = expect[k];
      if (e === null) {
        if (s.status !== SLOT_STATUS.void) problems.push(`slot ${j}: expected void`);
        return;
      }
      wonLeaves.push(e);
      if (s.status === SLOT_STATUS.void || s.status === SLOT_STATUS.pending) {
        problems.push(`slot ${j}: expected a winner (leaf ${e})`);
        return;
      }
      if (s.leafIndex !== BigInt(e)) problems.push(`slot ${j}: on-chain leaf ${s.leafIndex}, recomputed ${e}`);
      const proof = listProof(list, e);
      const start = verifyProof(a.root, a.totalWeight, a.depth, a.leafCount, BigInt(e), list.leaves[e].hash, list.leaves[e].weight, proof.path);
      proofsChecked++;
      if (start === undefined) problems.push(`slot ${j}: winner proof does not verify`);
      else if (start !== s.start || list.entries[e].weight !== s.weight) problems.push(`slot ${j}: interval differs`);
      const known = !equalBytes(s.wallet, ZERO32);
      if (known && !equalBytes(s.wallet, list.entries[e].wallet)) problems.push(`slot ${j}: wallet differs from leaf ${e}`);
      winners.push({
        slot: j, round: r, tier: s.tier, leafIndex: s.leafIndex, wallet: toBase58(list.entries[e].wallet), status: s.status,
        amount: a.tiers[s.tier]?.amount ?? 0n,
      });
    });
  }
  // The won-interval table holds exactly the winners, in ascending order.
  const table = wonLeaves.map((i) => list.leaves.slice(0, i).reduce((s, l) => s + l.weight, 0n)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (table.length !== a.won.length || table.some((st, k) => st !== a.won[k][0])) problems.push("won-interval table differs");
  if (a.paid + a.returned > a.funded) problems.push("paid + returned exceeds funded");
  return { ok: problems.length === 0, problems, winners, proofsChecked };
}
