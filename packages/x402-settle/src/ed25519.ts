// ed25519 signing with node:crypto, and the curve-point test used for PDAs.

import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { concat, fromHex } from "./bytes.ts";

const PKCS8_PREFIX = fromHex("302e020100300506032b657004220420");
const SPKI_PREFIX = fromHex("302a300506032b6570032100");

/** A key that signs messages (a payer, a fee payer or a payee). */
export interface Signer {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

/** Signer from a 32-byte ed25519 seed (bytes 0..32 of a Solana secret key). */
export function keypairFromSeed(seed: Uint8Array): Signer {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const priv: KeyObject = createPrivateKey({ key: Buffer.from(concat(PKCS8_PREFIX, seed)), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  return {
    publicKey,
    sign: (message: Uint8Array) => Uint8Array.from(nodeSign(null, message, priv)),
  };
}

/** Signer from a 64-byte Solana secret key (seed || public key). */
export function keypairFromSecretKey(secret: Uint8Array): Signer {
  if (secret.length !== 64) throw new Error("secret key must be 64 bytes");
  return keypairFromSeed(secret.subarray(0, 32));
}

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const pub = createPublicKey({ key: Buffer.from(concat(SPKI_PREFIX, publicKey)), format: "der", type: "spki" });
  return nodeVerify(null, message, pub, signature);
}

// ---------------------------------------------------------------------------
// Curve point test (same acceptance as curve25519-dalek's decompress, which
// Solana uses to reject PDAs that are on the curve).
// ---------------------------------------------------------------------------

const P = (1n << 255n) - 19n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = mod(r * x);
    x = mod(x * x);
    k >>= 1n;
  }
  return r;
}

const D = mod(-121665n * pow(121666n, P - 2n));

export function isOnCurve(b: Uint8Array): boolean {
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i]! & 0x7f : b[i]!);
  y = mod(y);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  if (x2 === 0n) return true;
  return pow(x2, (P - 1n) / 2n) === 1n;
}
