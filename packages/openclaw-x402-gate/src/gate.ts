/**
 * x402 gate — pure charging logic. Mint a 402 challenge and verify an incoming
 * payment header. No private keys, no custody: the recipient is a public address
 * you pass in, and funds settle directly to it on-chain.
 *
 * Structural verification here is synchronous and network-free. For revenue-
 * grade gating, follow it with the on-chain confirmation in ./onchain.ts.
 */

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  MEMO_PREFIX,
  USDC_MINT,
  X402_VERSION,
  atomicToUsdc,
  usdcToAtomic,
  type SolanaNetwork,
} from "./constants";
import type { ReplayStore } from "./replay";
import type {
  ChallengeOptions,
  VerifyResult,
  X402Challenge,
  X402PaymentProof,
  X402PaymentRequirement,
} from "./types";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Receipt hash — MUST stay byte-identical to the paying side so both ends of the
 * loop derive the same value.
 */
export function receiptHashFor(payer: string, req: X402PaymentRequirement): string {
  return sha256Hex(
    [
      req.memoPrefix,
      payer,
      req.payTo,
      req.maxAmountRequired,
      req.resource,
      req.network,
      req.extra?.nullifierSeed ?? "",
    ].join("|"),
  );
}

/** Build a single payment requirement (one entry in a 402's `accepts`). */
export function makeRequirement(opts: ChallengeOptions): X402PaymentRequirement {
  const network: SolanaNetwork = opts.network ?? "solana-devnet";
  if (!(opts.priceUsdc > 0)) {
    throw new Error("makeRequirement: priceUsdc must be > 0");
  }
  if (!opts.recipientAddress) {
    throw new Error("makeRequirement: recipientAddress (your wallet) is required");
  }
  return {
    scheme: "exact",
    network,
    maxAmountRequired: String(usdcToAtomic(opts.priceUsdc)),
    resource: opts.resource,
    description: opts.description ?? opts.resource,
    memoPrefix: MEMO_PREFIX,
    payTo: opts.recipientAddress,
    asset: USDC_MINT[network],
    extra: {
      platformWallet: opts.platformWallet,
      platformFeePct: opts.platformFeePct,
      anchorReceipt: opts.anchorReceipt,
      platformId: opts.platformId,
      passportId: opts.passportId,
      nullifierSeed: opts.nullifierSeed,
    },
  };
}

/** Wrap a requirement into a full 402 challenge body. */
export function makeChallenge(opts: ChallengeOptions): {
  status: 402;
  body: X402Challenge;
  requirement: X402PaymentRequirement;
} {
  const requirement = makeRequirement(opts);
  return {
    status: 402,
    body: { x402Version: X402_VERSION, accepts: [requirement] },
    requirement,
  };
}

/** Decode the base64 X-Payment header into a proof object. */
export function decodePaymentHeader(header: string): X402PaymentProof {
  let json: string;
  try {
    json = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new Error("x402: X-Payment header is not valid base64");
  }
  let proof: X402PaymentProof;
  try {
    proof = JSON.parse(json) as X402PaymentProof;
  } catch {
    throw new Error("x402: X-Payment header is not valid JSON");
  }
  return proof;
}

// ── Offline signature verification ────────────────────────────────────────────
// A proof's `signature` field carries EITHER a Solana transaction signature
// (base58; only verifiable on-chain via ./onchain.ts) OR an ed25519 signature
// by the payer's key over the canonical message below. Only the latter can be
// verified network-free, so header-only acceptance requires it.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromBase58(input: string): Uint8Array {
  let num = BigInt(0);
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58 character");
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Leading '1's encode leading zero bytes.
  for (const ch of input) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function decodeSignatureBytes(signature: string): Uint8Array | undefined {
  const candidates = [signature, signature.replace(/^0x/, "")];
  for (const candidate of candidates) {
    for (const decode of [
      () => fromBase58(candidate),
      () => Uint8Array.from(Buffer.from(candidate, "hex")),
      () => Uint8Array.from(Buffer.from(candidate, "base64")),
    ]) {
      try {
        const bytes = decode();
        if (bytes.length === 64) return bytes;
      } catch {
        // try the next encoding
      }
    }
  }
  return undefined;
}

export const PAYMENT_SIGNATURE_DOMAIN = "x402-payment-v1";

/** Sorted-key canonical JSON — mirrors the work-receipt canonicalizer so both
 *  parties recompute identical bytes. NEVER plain JSON.stringify. */
function canonicalJSON(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map((x) => canonicalJSON(x)).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).filter((k) => (obj as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON((obj as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Canonical byte message an offline-verifiable proof signs with the payer's
 * ed25519 key. Exported so paying clients can produce matching signatures.
 */
export function paymentSignatureMessage(proof: {
  payerAddress: string;
  amount: string;
  resource: string;
}): Uint8Array {
  return new TextEncoder().encode(
    PAYMENT_SIGNATURE_DOMAIN +
      canonicalJSON({ amount: proof.amount, payerAddress: proof.payerAddress, resource: proof.resource }),
  );
}

/**
 * Verify a proof's ed25519 `signature` against its `payerAddress` (base58
 * Solana public key). Accepts base58 / hex / base64 signature encodings.
 * Returns false when the signature is not an offline-verifiable ed25519
 * signature (e.g. it is a raw Solana transaction signature).
 */
export function verifyPaymentSignature(proof: {
  signature: string;
  payerAddress: string;
  amount: string;
  resource: string;
}): boolean {
  try {
    const publicKey = fromBase58(proof.payerAddress);
    if (publicKey.length !== 32) return false;
    const sigBytes = decodeSignatureBytes(proof.signature);
    if (!sigBytes) return false;
    return ed25519.verify(sigBytes, paymentSignatureMessage(proof), publicKey);
  } catch {
    return false;
  }
}

/**
 * Structural verification — synchronous, network-free. Confirms the submitted
 * proof binds to THIS requirement (resource + amount), verifies the ed25519
 * signature against payerAddress where possible, and derives the receipt hash.
 *
 * When an optional `replayStore` is supplied, the proof key
 * `<receiptHash>:<signature>` is checked BEFORE a valid result is returned and
 * consumed for offline-verified proofs; proofs that still need on-chain
 * confirmation are marked by the caller after confirmOnChain() succeeds.
 *
 * Returns onChainVerified=false; pair with confirmOnChain() before serving
 * anything valuable. A proof whose signature could NOT be verified offline
 * (`signatureVerified: false`) MUST NOT be accepted without on-chain
 * confirmation.
 */
export function verifyPaymentStructure(
  header: string | null | undefined,
  requirement: X402PaymentRequirement,
  opts?: { replayStore?: ReplayStore },
): VerifyResult {
  if (!header) return { valid: false, error: "missing X-Payment header" };

  let proof: X402PaymentProof;
  try {
    proof = decodePaymentHeader(header);
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!proof.signature) return { valid: false, error: "proof missing signature" };
  if (!proof.payerAddress) return { valid: false, error: "proof missing payerAddress" };
  if (proof.resource !== requirement.resource) {
    return { valid: false, error: "proof resource does not match the gated resource" };
  }

  let paid: bigint;
  let required: bigint;
  try {
    paid = BigInt(proof.amount);
    required = BigInt(requirement.maxAmountRequired);
  } catch {
    return { valid: false, error: "proof amount is not an integer" };
  }
  if (paid < required) {
    return {
      valid: false,
      error: `underpaid: ${atomicToUsdc(Number(paid))} < ${atomicToUsdc(Number(required))} USDC`,
    };
  }

  const signatureVerified = verifyPaymentSignature(proof);
  const receiptHash = receiptHashFor(proof.payerAddress, requirement);

  // Replay protection runs BEFORE any valid result is returned.
  const replayKey = `${receiptHash}:${proof.signature}`;
  if (opts?.replayStore) {
    if (opts.replayStore.has(replayKey)) {
      return { valid: false, error: "replayed payment proof rejected" };
    }
    if (signatureVerified) {
      opts.replayStore.markUsed(replayKey);
    }
  }

  return {
    valid: true,
    payerAddress: proof.payerAddress,
    amountAtomic: Number(paid),
    amountUsdc: atomicToUsdc(Number(paid)),
    receiptHash,
    resource: requirement.resource,
    onChainVerified: false,
    signatureVerified,
    signature: proof.signature,
  };
}
