/**
 * @parad0x_labs/royalty-waterfalls
 *
 * Receipt-based agent royalty waterfalls for the x402 payment rail.
 *
 * Design:
 *   - RoyaltyWaterfall defines how fees split across tiers (in basis points).
 *   - DerivativeAttribution proves that Agent B derived from Agent A's output.
 *   - Attribution rides inside the receipt itself — no backend custody, no
 *     custodial fee splitting. Any verifier can re-derive the distribution from
 *     the on-chain receipt + waterfall struct alone.
 *
 * Signing model:
 *   - All signatures are Ed25519 produced by Web Crypto (available Node >=15).
 *   - The caller supplies a `sign(message: Uint8Array) => Uint8Array` callback
 *     and a `publicKey: Uint8Array` (32 bytes, raw Ed25519) in a KeypairLike.
 *   - Verification uses crypto.subtle — no extra dependencies.
 *
 * Basis points (bps): 1 bps = 0.01 %, 10 000 bps = 100 %.
 */

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// KeypairLike — caller-supplied signing abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal interface for an Ed25519 keypair. Compatible with @solana/web3.js
 * Keypair as long as you provide the publicKey bytes separately (use
 * `keypair.publicKey.toBytes()`) and a detached-sign function (use tweetnacl's
 * `nacl.sign.detached(msg, keypair.secretKey)`).
 */
export interface KeypairLike {
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /**
   * Sign `message` and return a 64-byte Ed25519 signature.
   * May be synchronous or async.
   */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** One recipient slice in a royalty waterfall. */
export interface RoyaltyTier {
  /** Base-58 or hex-encoded public key of the recipient. */
  recipientPubkey: string;
  /**
   * Share in basis points (1 bps = 0.01 %).
   * Must be > 0. All tier shares must sum to ≤ 10 000.
   */
  sharesBps: number;
  /** Semantic role of the recipient in the attribution chain. */
  role: "creator" | "builder" | "source" | "rail" | "affiliate";
}

/**
 * RoyaltyWaterfall
 *
 * The canonical split definition for a signal or agent output. Signed by the
 * creator so that any downstream agent can verify it was not tampered with.
 */
export interface RoyaltyWaterfall {
  /** UUID or deterministic hash identifying this waterfall. */
  waterfallId: string;
  /** Ordered list of royalty recipients. */
  tiers: RoyaltyTier[];
  /**
   * Sum of all tier sharesBps.  Stored for fast validation; must equal
   * the actual sum of tiers (enforced by buildWaterfall).
   */
  totalBps: number;
  /** SHA-256 hex digest of the human-readable licence terms text. */
  licenceTermsHash: string;
  /** Unix timestamp (ms) when this waterfall was created. */
  createdAt: number;
  /** Base-58 or hex-encoded public key of the waterfall creator. */
  creatorPubkey: string;
  /**
   * Hex-encoded Ed25519 signature of `waterfallCanonicalBytes(waterfall)`
   * produced by the creator's keypair.
   */
  signature: string;
}

/**
 * DerivativeAttribution
 *
 * What a downstream agent embeds to prove it derived from an upstream receipt.
 * The source agent signs the derivation, so the attribution cannot be forged.
 */
export interface DerivativeAttribution {
  /** Public key (base-58 / hex) of the upstream agent being attributed. */
  sourceAgentId: string;
  /** SHA-256 hex digest of the upstream receipt that was consumed. */
  sourceReceiptHash: string;
  /** waterfallId of the upstream waterfall that governs royalties. */
  sourceWaterfallId: string;
  /** Unix timestamp (ms) when this derivation was created. */
  derivedAt: number;
  /** Random 32-byte hex nonce to prevent replay. */
  derivationNonce: string;
  /**
   * Hex-encoded Ed25519 signature produced by the source agent over
   * `attributionCanonicalBytes(attribution)`.
   */
  attributionSignature: string;
}

/** One line item in a fee distribution computation. */
export interface FeeDistributionEntry {
  recipient: string;
  amountAtomic: bigint;
  role: string;
}

// ---------------------------------------------------------------------------
// Canonical serialisation helpers
// ---------------------------------------------------------------------------

/**
 * Returns deterministic UTF-8 bytes for a waterfall, excluding the signature.
 * Used for signing and verification.
 */
export function waterfallCanonicalBytes(
  waterfall: Omit<RoyaltyWaterfall, "signature">,
): Uint8Array {
  const obj = {
    createdAt:        waterfall.createdAt,
    creatorPubkey:    waterfall.creatorPubkey,
    licenceTermsHash: waterfall.licenceTermsHash,
    tiers:            waterfall.tiers.map((t) => ({
      recipientPubkey: t.recipientPubkey,
      role:            t.role,
      sharesBps:       t.sharesBps,
    })),
    totalBps:   waterfall.totalBps,
    waterfallId: waterfall.waterfallId,
  };
  // Keys already sorted; stringify is deterministic for these primitives.
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Returns deterministic UTF-8 bytes for an attribution, excluding the
 * attributionSignature.
 */
export function attributionCanonicalBytes(
  attribution: Omit<DerivativeAttribution, "attributionSignature">,
): Uint8Array {
  const obj = {
    derivationNonce:  attribution.derivationNonce,
    derivedAt:        attribution.derivedAt,
    sourceAgentId:    attribution.sourceAgentId,
    sourceReceiptHash: attribution.sourceReceiptHash,
    sourceWaterfallId: attribution.sourceWaterfallId,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Hex-encode a Uint8Array. */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Decode a hex string to Uint8Array. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Minimal base-58 decoder (no external dependencies).
 * Handles Solana-style 32-byte public keys encoded as base-58.
 */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
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
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Decode a public key that may be hex (64 chars) or base-58.
 * Returns the raw 32-byte Ed25519 key.
 */
function decodePubkey(pubkey: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return fromHex(pubkey);
  }
  return base58Decode(pubkey);
}

/**
 * Verify an Ed25519 signature using Web Crypto.
 * Returns true if valid, false otherwise.
 */
async function verifyEd25519(
  pubkeyBytes: Uint8Array,
  message: Uint8Array,
  sigBytes: Uint8Array,
): Promise<boolean> {
  if (pubkeyBytes.length !== 32) return false;
  if (sigBytes.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sigBytes, message);
  } catch {
    return false;
  }
}

/** Generate a unique waterfall ID from creator pubkey + timestamp + random bytes. */
function generateWaterfallId(creatorPubkey: string, createdAt: number): string {
  const data = `${creatorPubkey}:${createdAt}:${randomBytes(16).toString("hex")}`;
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Generate a derivation nonce (32 random bytes, hex encoded). */
function generateDerivationNonce(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// buildWaterfall
// ---------------------------------------------------------------------------

/**
 * Build and sign a RoyaltyWaterfall.
 *
 * @param tiers            - Ordered list of royalty tiers.
 * @param licenceTermsHash - SHA-256 hex digest of the licence terms text.
 * @param creatorKeypair   - Signing keypair for the creator.
 * @returns Signed RoyaltyWaterfall.
 *
 * @throws {Error} if any tier has sharesBps = 0 or recipientPubkey is empty.
 * @throws {RangeError} if total bps exceeds 10 000.
 */
export async function buildWaterfall(
  tiers: RoyaltyTier[],
  licenceTermsHash: string,
  creatorKeypair: KeypairLike,
): Promise<RoyaltyWaterfall> {
  if (tiers.length === 0) {
    throw new Error("Waterfall must have at least one tier");
  }

  let totalBps = 0;
  for (const tier of tiers) {
    if (!tier.recipientPubkey || tier.recipientPubkey.trim() === "") {
      throw new Error(
        `Tier with role '${tier.role}' has an empty recipientPubkey`,
      );
    }
    if (tier.sharesBps === 0) {
      throw new Error(
        `Tier for recipient '${tier.recipientPubkey}' has sharesBps = 0; all tiers must be > 0`,
      );
    }
    if (tier.sharesBps < 0 || !Number.isInteger(tier.sharesBps)) {
      throw new Error(
        `Tier for recipient '${tier.recipientPubkey}' has invalid sharesBps ${tier.sharesBps}; must be a positive integer`,
      );
    }
    totalBps += tier.sharesBps;
  }

  if (totalBps > 10_000) {
    throw new RangeError(
      `Tier shares sum to ${totalBps} bps, which exceeds the maximum of 10 000 bps`,
    );
  }

  const creatorPubkey = toHex(creatorKeypair.publicKey);
  const createdAt = Date.now();
  const waterfallId = generateWaterfallId(creatorPubkey, createdAt);

  const partial: Omit<RoyaltyWaterfall, "signature"> = {
    waterfallId,
    tiers,
    totalBps,
    licenceTermsHash,
    createdAt,
    creatorPubkey,
  };

  const message = waterfallCanonicalBytes(partial);
  const sigBytes = await creatorKeypair.sign(message);

  if (sigBytes.length !== 64) {
    throw new RangeError(
      `Keypair sign() must return 64 bytes, got ${sigBytes.length}`,
    );
  }

  return { ...partial, signature: toHex(sigBytes) };
}

// ---------------------------------------------------------------------------
// verifyWaterfall
// ---------------------------------------------------------------------------

/**
 * Verify the creator's Ed25519 signature on a RoyaltyWaterfall.
 *
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifyWaterfall(
  waterfall: RoyaltyWaterfall,
): Promise<boolean> {
  try {
    const pubkeyBytes = decodePubkey(waterfall.creatorPubkey);
    const sigBytes = fromHex(waterfall.signature);
    const { signature: _sig, ...partial } = waterfall;
    const message = waterfallCanonicalBytes(partial);
    return verifyEd25519(pubkeyBytes, message, sigBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildDerivativeAttribution
// ---------------------------------------------------------------------------

/**
 * Build and sign a DerivativeAttribution.
 *
 * The source agent signs the attribution to authorise the derivation. This
 * binding means the attribution cannot be forged by the downstream agent.
 *
 * @param sourceAgentId    - Public key of the upstream agent being attributed.
 * @param sourceReceiptHash - SHA-256 hex digest of the consumed upstream receipt.
 * @param waterfallId      - waterfallId of the upstream waterfall.
 * @param signerKeypair    - Keypair of the source agent that authorises the derivation.
 * @returns Signed DerivativeAttribution.
 */
export async function buildDerivativeAttribution(
  sourceAgentId: string,
  sourceReceiptHash: string,
  waterfallId: string,
  signerKeypair: KeypairLike,
): Promise<DerivativeAttribution> {
  const derivedAt = Date.now();
  const derivationNonce = generateDerivationNonce();

  const partial: Omit<DerivativeAttribution, "attributionSignature"> = {
    sourceAgentId,
    sourceReceiptHash,
    sourceWaterfallId: waterfallId,
    derivedAt,
    derivationNonce,
  };

  const message = attributionCanonicalBytes(partial);
  const sigBytes = await signerKeypair.sign(message);

  if (sigBytes.length !== 64) {
    throw new RangeError(
      `Keypair sign() must return 64 bytes, got ${sigBytes.length}`,
    );
  }

  return { ...partial, attributionSignature: toHex(sigBytes) };
}

// ---------------------------------------------------------------------------
// verifyDerivativeAttribution
// ---------------------------------------------------------------------------

/**
 * Verify a DerivativeAttribution against the expected source agent's public key.
 *
 * @param attribution          - The attribution to verify.
 * @param expectedSourcePubkey - The public key (hex or base-58) that should have signed it.
 * @returns true if the signature is valid and matches the expected key, false otherwise.
 */
export async function verifyDerivativeAttribution(
  attribution: DerivativeAttribution,
  expectedSourcePubkey: string,
): Promise<boolean> {
  try {
    const pubkeyBytes = decodePubkey(expectedSourcePubkey);
    const sigBytes = fromHex(attribution.attributionSignature);
    const { attributionSignature: _sig, ...partial } = attribution;
    const message = attributionCanonicalBytes(partial);
    return verifyEd25519(pubkeyBytes, message, sigBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// computeFeeDistribution
// ---------------------------------------------------------------------------

/**
 * Split `totalAmountAtomic` across the waterfall tiers according to their
 * basis-point shares.
 *
 * Rounding: integer division is used per tier; the remainder from rounding
 * is added to the first tier (creator tier at index 0).
 *
 * @param totalAmountAtomic - Total amount in the smallest unit (lamports, atoms, etc.).
 * @param waterfall         - The waterfall that defines the splits.
 * @returns Array of per-recipient distribution entries.
 */
export function computeFeeDistribution(
  totalAmountAtomic: bigint,
  waterfall: RoyaltyWaterfall,
): FeeDistributionEntry[] {
  const result: FeeDistributionEntry[] = waterfall.tiers.map((tier) => ({
    recipient: tier.recipientPubkey,
    amountAtomic: (totalAmountAtomic * BigInt(tier.sharesBps)) / 10_000n,
    role: tier.role,
  }));

  // The maximum amount the tiers are entitled to based on totalBps.
  // e.g. if totalBps = 5000, only 50 % of totalAmountAtomic is distributed.
  const entitledAmount = (totalAmountAtomic * BigInt(waterfall.totalBps)) / 10_000n;

  // Rounding remainder: difference between the entitled amount and what was
  // actually allocated (due to integer division per tier). Assign to first tier.
  const distributed = result.reduce((sum, e) => sum + e.amountAtomic, 0n);
  const roundingRemainder = entitledAmount - distributed;
  if (roundingRemainder > 0n && result.length > 0) {
    result[0] = { ...result[0], amountAtomic: result[0].amountAtomic + roundingRemainder };
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildAttributedReceipt
// ---------------------------------------------------------------------------

/**
 * Extend any receipt object with attribution and distribution metadata.
 *
 * The returned object is a shallow copy of `baseReceipt` with the following
 * fields added (all at the top level):
 *   - sourceAgentId       (from attribution)
 *   - sourceReceiptHash   (from attribution)
 *   - waterfallId         (from waterfall)
 *   - licenceTermsHash    (from waterfall)
 *   - feeDistribution     (computed from waterfall tiers)
 *
 * The `feeDistribution` field omits `amountAtomic` because the base receipt
 * may not carry a fee amount. Callers that have a concrete amount should call
 * `computeFeeDistribution` separately and merge the result.
 *
 * @param baseReceipt - Any existing receipt object (x402 receipt, DagReceipt, etc.).
 * @param attribution - The DerivativeAttribution to embed.
 * @param waterfall   - The RoyaltyWaterfall to embed.
 * @returns New object with attribution and waterfall metadata grafted on.
 */
export function buildAttributedReceipt(
  baseReceipt: object,
  attribution: DerivativeAttribution,
  waterfall: RoyaltyWaterfall,
): object {
  const feeDistribution = waterfall.tiers.map((tier) => ({
    recipient: tier.recipientPubkey,
    sharesBps: tier.sharesBps,
    role: tier.role,
  }));

  return {
    ...baseReceipt,
    sourceAgentId:     attribution.sourceAgentId,
    sourceReceiptHash: attribution.sourceReceiptHash,
    waterfallId:       waterfall.waterfallId,
    licenceTermsHash:  waterfall.licenceTermsHash,
    feeDistribution,
  };
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of arbitrary bytes — convenience for building licenceTermsHash. */
export function sha256Hex(data: Uint8Array | string): string {
  const input = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(input).digest("hex");
}
