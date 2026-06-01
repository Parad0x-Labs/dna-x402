/**
 * @parad0x_labs/outcome-receipts
 *
 * Creator-signed, chain-anchored outcome receipts for x402 signal/task deliveries.
 *
 * Design:
 *   - OutcomeReceipt is signed by the creator (Ed25519 over the canonical struct)
 *   - anchorOutcomeReceipt stores the SHA-256 of the receipt JSON on-chain via
 *     receipt_anchor (6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN, mainnet-beta)
 *   - No fake PnL can be mechanically enforced here — but any false claim is
 *     on-chain provable because the signed struct is permanently anchored.
 *
 * Layout of anchor instruction data:
 *   [0x01][0x00][32 bytes SHA-256 of JSON-encoded OutcomeReceipt] = 34 bytes
 */

import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RECEIPT_ANCHOR_PROGRAM_ID =
  "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Performance metrics reported by the creator alongside the outcome. */
export interface OutcomeMetric {
  /** Profit-and-loss in USD (positive = profit). */
  pnl?: number;
  /** Accuracy as a fraction [0, 1]. */
  accuracy?: number;
  /** Latency in milliseconds from signal to fill. */
  latency?: number;
  /** Number of samples/trades the metric is computed over. */
  sampleSize?: number;
  /** Maximum drawdown as a fraction [0, 1] (e.g. 0.05 = 5 %). */
  drawdown?: number;
}

/**
 * OutcomeReceipt
 *
 * Represents the creator-attested result of a signal or task delivery.
 * Linked back to the original x402 delivery receipt via `receiptId`.
 *
 * The creator signs a canonical representation of this struct (see
 * `canonicalBytes`) and the entire receipt (including the signature) is
 * anchored on-chain so that any false claim is permanently provable.
 */
export interface OutcomeReceipt {
  /** Links to the original x402 delivery receipt (UUID or hash). */
  receiptId: string;
  /** Optional reference to the signal that triggered the delivery. */
  signalId?: string;
  /** Unix timestamp (seconds) when the content was delivered. */
  deliveredAt: number;
  /** Unix timestamp (seconds) when the outcome was resolved, if known. */
  resolvedAt?: number;
  /**
   * Creator-asserted outcome classification.
   *   positive   — the signal/task produced a favourable result
   *   negative   — the signal/task produced an unfavourable result
   *   neutral    — break-even or non-directional outcome
   *   unresolved — outcome not yet determinable (stale=true typical)
   */
  outcome: "positive" | "negative" | "neutral" | "unresolved";
  /** Optional performance metrics supporting the outcome claim. */
  metric?: OutcomeMetric;
  /**
   * Base creator fee (in lamports or smallest-unit USDC) already collected
   * at delivery time via x402.
   */
  creatorFee: number;
  /**
   * Additional success fee collected (or to be collected) when
   * outcome === 'positive'.  Absent or zero for non-positive outcomes.
   */
  successFee?: number;
  /**
   * SHA-256 hex digest of the raw result bytes (e.g. signal payload,
   * task output). Lets subscribers verify they received the exact content
   * the creator attested to.
   */
  resultDigest: string;
  /**
   * True when the outcome window has passed without a resolution event.
   * Stale receipts should be treated as 'unresolved' regardless of the
   * `outcome` field.
   */
  stale: boolean;
  /** Creator's Solana public key encoded as base-58. */
  attestedBy: string;
  /**
   * Hex-encoded Ed25519 signature of `canonicalBytes(receipt)` produced
   * by the creator's keypair.  Populated by `buildOutcomeReceipt`.
   */
  signature: string;
}

// ---------------------------------------------------------------------------
// Canonical serialisation (used for signing and for the chain digest)
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic byte representation of the receipt fields that
 * are covered by the creator's signature.
 *
 * We JSON-serialize a sorted subset (everything except `signature` itself)
 * and encode as UTF-8.  This is intentionally simple so any off-chain
 * verifier can reproduce it without a special library.
 */
export function canonicalBytes(receipt: Omit<OutcomeReceipt, "signature">): Uint8Array {
  const obj: Record<string, unknown> = {
    receiptId:   receipt.receiptId,
    deliveredAt: receipt.deliveredAt,
    outcome:     receipt.outcome,
    creatorFee:  receipt.creatorFee,
    resultDigest: receipt.resultDigest,
    stale:       receipt.stale,
    attestedBy:  receipt.attestedBy,
  };
  // Include optional fields only when present so the canonical form is stable
  if (receipt.signalId    !== undefined) obj.signalId    = receipt.signalId;
  if (receipt.resolvedAt  !== undefined) obj.resolvedAt  = receipt.resolvedAt;
  if (receipt.metric      !== undefined) obj.metric      = receipt.metric;
  if (receipt.successFee  !== undefined) obj.successFee  = receipt.successFee;

  // Sort keys for determinism
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => { acc[k] = obj[k]; return acc; }, {});

  return new TextEncoder().encode(JSON.stringify(sorted));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildOutcomeReceiptParams {
  receiptId:    string;
  signalId?:    string;
  deliveredAt:  number;
  resolvedAt?:  number;
  outcome:      OutcomeReceipt["outcome"];
  metric?:      OutcomeMetric;
  creatorFee:   number;
  successFee?:  number;
  /** SHA-256 hex digest of the raw result bytes. */
  resultDigest: string;
  stale?:       boolean;
  /** Creator's public key (base-58). */
  attestedBy:   string;
  /**
   * Sign function supplied by the caller.  Receives the canonical bytes and
   * must return an Ed25519 signature as a Uint8Array (64 bytes).
   *
   * Typical usage with @solana/web3.js Keypair:
   *   sign: (msg) => nacl.sign.detached(msg, keypair.secretKey)
   */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

/**
 * Constructs and signs an OutcomeReceipt.
 *
 * The caller provides a `sign` callback so that this package stays
 * agnostic of the specific signing library / HSM / wallet adapter in use.
 */
export async function buildOutcomeReceipt(
  params: BuildOutcomeReceiptParams,
): Promise<OutcomeReceipt> {
  const partial: Omit<OutcomeReceipt, "signature"> = {
    receiptId:    params.receiptId,
    deliveredAt:  params.deliveredAt,
    outcome:      params.outcome,
    creatorFee:   params.creatorFee,
    resultDigest: params.resultDigest,
    stale:        params.stale ?? false,
    attestedBy:   params.attestedBy,
  };
  if (params.signalId   !== undefined) partial.signalId   = params.signalId;
  if (params.resolvedAt !== undefined) partial.resolvedAt = params.resolvedAt;
  if (params.metric     !== undefined) partial.metric     = params.metric;
  if (params.successFee !== undefined) partial.successFee = params.successFee;

  const bytes     = canonicalBytes(partial);
  const sigBytes  = await params.sign(bytes);

  if (sigBytes.length !== 64) {
    throw new RangeError(
      `sign() must return a 64-byte Ed25519 signature, got ${sigBytes.length} bytes`,
    );
  }

  return {
    ...partial,
    signature: Buffer.from(sigBytes).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyOutcomeReceiptResult {
  valid: boolean;
  error?: string;
}

/**
 * Verifies the creator's Ed25519 signature on an OutcomeReceipt.
 *
 * Uses the Web Crypto API (available in Node >=15 and all modern browsers).
 * Returns `{ valid: true }` on success or `{ valid: false, error }` on failure.
 *
 * NOTE: This verifies that the receipt was signed by the key in `attestedBy`.
 * It does NOT verify that `attestedBy` is authorised to issue receipts for
 * the given `receiptId` — that check is the caller's responsibility.
 */
export async function verifyOutcomeReceipt(
  receipt: OutcomeReceipt,
): Promise<VerifyOutcomeReceiptResult> {
  try {
    // Decode the signer's public key from base-58
    const pubkeyBytes = base58Decode(receipt.attestedBy);
    if (pubkeyBytes.length !== 32) {
      return { valid: false, error: `attestedBy must be a 32-byte Ed25519 pubkey (got ${pubkeyBytes.length} bytes after base-58 decode)` };
    }

    const sigBytes = hexDecode(receipt.signature);
    if (sigBytes.length !== 64) {
      return { valid: false, error: `signature must be 64 bytes (got ${sigBytes.length})` };
    }

    const { signature: _sig, ...rest } = receipt;
    const message = canonicalBytes(rest);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      sigBytes,
      message,
    );

    return valid ? { valid: true } : { valid: false, error: "signature mismatch" };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

/**
 * Anchors the SHA-256 digest of the receipt on Solana via receipt_anchor.
 *
 * Instruction data layout (34 bytes):
 *   [0x01][0x00][32-byte SHA-256 of UTF-8 JSON of the full receipt]
 *
 * The payer signs and submits the transaction.  Returns the transaction
 * signature string on success.
 */
export async function anchorOutcomeReceipt(
  receipt: OutcomeReceipt,
  connection: Connection,
  payer: Signer,
): Promise<string> {
  const receiptJson = JSON.stringify(receipt);
  const digest = createHash("sha256")
    .update(receiptJson, "utf8")
    .digest();

  const ixData = new Uint8Array(34);
  ixData[0] = 0x01;
  ixData[1] = 0x00;
  ixData.set(digest, 2);

  const programId = new PublicKey(RECEIPT_ANCHOR_PROGRAM_ID);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;

  const txSig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return txSig;
}

// ---------------------------------------------------------------------------
// Helpers — minimal base-58 and hex decoders (no extra deps)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of input) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) throw new Error(`Invalid base-58 character: ${char}`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's → leading zero bytes
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** SHA-256 of arbitrary bytes — convenience export for callers building resultDigest. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
