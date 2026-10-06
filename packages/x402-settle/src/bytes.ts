// Byte helpers: hex, base58, little-endian integers, hashing (node:crypto).

import { createHash } from "node:crypto";

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) {
    throw new Error("invalid hex");
  }
  return Uint8Array.from(Buffer.from(s, "hex"));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Byte-wise comparison (the order of `Pubkey` in Rust). */
export function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

const U64_MAX = (1n << 64n) - 1n;

export function u64le(v: bigint | number): Uint8Array {
  const x = BigInt(v);
  if (x < 0n || x > U64_MAX) throw new Error("u64 out of range");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, x, true);
  return out;
}

export function u32le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error("u32 out of range");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
}

export function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error("u16 out of range");
  return Uint8Array.of(v & 0xff, v >> 8);
}

export function readU64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

export function readU32(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
}

export function readU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
}

export function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
}

// ---------------------------------------------------------------------------
// base58 (Bitcoin alphabet, as used for Solana addresses and signatures)
// ---------------------------------------------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(b: Uint8Array): string {
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  return "1".repeat(zeros) + s;
}

export function b58decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** A 32-byte public key from base58 or raw bytes. */
export function key(k: string | Uint8Array): Uint8Array {
  const b = typeof k === "string" ? b58decode(k) : k;
  if (b.length !== 32) throw new Error("public key must be 32 bytes");
  return b;
}
