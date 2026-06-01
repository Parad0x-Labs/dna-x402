/**
 * @parad0x_labs/blind-access
 *
 * Blind Access Receipts — anonymous API access tokens for DNA x402.
 *
 * Phase 1: HMAC-SHA256 blind tokens.
 *   Server mints N tokens when buyer pays via x402. Each token is
 *   HMAC-SHA256(server_secret, tokenId + buyerNonce). The buyer chooses
 *   a random nonce locally, so the server cannot link the presented token
 *   back to the original purchase (server-side unlinkability).
 *
 * Phase 2: replace HMAC with RSA blind signatures (Chaum) or BLS blind sigs
 *   for true unlinkability. Phase 1 HMAC tokens provide server-side
 *   unlinkability but not cryptographic unlinkability.
 */

import { createHmac, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlindToken {
  /** Random UUID chosen by the buyer (or server-assigned). */
  tokenId: string;
  /** HMAC-SHA256(serverSecret, tokenId + buyerNonce) — hex encoded. */
  hmac: string;
  /** Unix timestamp (ms) when the token was spent, undefined if unspent. */
  spentAt?: number;
  /** Solana transaction signature anchoring the spend receipt on-chain. */
  solanaAnchorTx?: string;
}

export interface BlindTokenBatch {
  tokens: BlindToken[];
  issuedAt: number;
  expiresAt: number;
  /** e.g. "basic" | "pro" | "enterprise" */
  tier: string;
}

/**
 * The payload a buyer sends to the server when redeeming a token.
 * Separating tokenId + hmac lets the server verify without revealing
 * any purchase-linkable metadata.
 */
export interface RedeemPayload {
  tokenId: string;
  hmac: string;
  /** ISO timestamp of redemption attempt — informational only. */
  redeemedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA256(secret, tokenId + nonce) → hex string.
 * The nonce is chosen by the buyer; the server never stores it.
 */
function computeHmac(serverSecret: string, tokenId: string, buyerNonce: string): string {
  return createHmac("sha256", serverSecret)
    .update(tokenId + buyerNonce)
    .digest("hex");
}

/**
 * Generate a hex-encoded random token ID.
 */
function newTokenId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Generate a hex-encoded random buyer nonce.
 * In production the buyer generates this client-side so the server
 * never sees it — here it stands in for the buyer-side operation.
 */
function newBuyerNonce(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * mintBlindTokens — server calls this after x402 payment is confirmed.
 *
 * @param serverSecret  Secret held only by the server (never exposed).
 * @param count         Number of tokens to mint (one per future API call).
 * @param tier          Access tier label ("basic" | "pro" | "enterprise").
 * @param ttlMs         Token lifetime in milliseconds (default: 30 days).
 * @returns             A BlindTokenBatch to hand to the buyer.
 *
 * Security note: the buyer nonce is generated server-side here for
 * demonstration. In a real deployment the buyer sends their own nonce
 * during the mint request so the server cannot reconstruct the token
 * from its logs — achieving server-side unlinkability.
 */
export function mintBlindTokens(
  serverSecret: string,
  count: number,
  tier: string,
  ttlMs: number = 30 * 24 * 60 * 60 * 1000
): BlindTokenBatch {
  if (count < 1 || !Number.isInteger(count)) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }
  if (!serverSecret) {
    throw new TypeError("serverSecret must be a non-empty string");
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;

  const tokens: BlindToken[] = Array.from({ length: count }, () => {
    const tokenId = newTokenId();
    const buyerNonce = newBuyerNonce();
    const hmac = computeHmac(serverSecret, tokenId, buyerNonce);
    return { tokenId, hmac };
  });

  return { tokens, issuedAt, expiresAt, tier };
}

/**
 * verifyBlindToken — server validates a presented token.
 *
 * The server must recompute HMAC(secret, tokenId + nonce). Because the
 * buyer holds the nonce, the server must have stored `(tokenId → nonce)`
 * at mint time OR the buyer must include the nonce in the RedeemPayload.
 *
 * Simplified here: the token's hmac is validated by recomputing with the
 * tokenId as both message and nonce component (demo mode). In production,
 * store the nonce server-side at mint time and look it up by tokenId.
 *
 * @param token         BlindToken presented by the buyer.
 * @param serverSecret  Same secret used during minting.
 * @returns             true if the HMAC verifies and the token is unspent.
 */
export function verifyBlindToken(token: BlindToken, serverSecret: string): boolean {
  if (!token || !token.tokenId || !token.hmac) return false;
  if (token.spentAt !== undefined) return false; // already spent

  // Re-derive HMAC using the tokenId as a stand-in for the stored nonce.
  // Replace with a real nonce lookup from the mint-time store in production.
  const expected = computeHmac(serverSecret, token.tokenId, token.tokenId);

  // Constant-time comparison to prevent timing attacks.
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(token.hmac.padEnd(expected.length, "0"), "hex");
  if (expectedBuf.length !== actualBuf.length) return false;

  let diff = 0;
  for (let i = 0; i < expectedBuf.length; i++) {
    diff |= expectedBuf[i] ^ actualBuf[i];
  }
  return diff === 0;
}

/**
 * markSpent — server calls this when a token is successfully redeemed.
 *
 * Returns a new BlindToken with spentAt set and optionally an on-chain
 * Solana anchor transaction for permanent tamper-evident record.
 *
 * @param token     The token being spent.
 * @param anchorTx  Optional Solana tx signature anchoring the spend.
 * @returns         Updated BlindToken (immutable — original is unchanged).
 */
export function markSpent(token: BlindToken, anchorTx?: string): BlindToken {
  if (token.spentAt !== undefined) {
    throw new Error(`Token ${token.tokenId} is already spent at ${token.spentAt}`);
  }
  return {
    ...token,
    spentAt: Date.now(),
    ...(anchorTx ? { solanaAnchorTx: anchorTx } : {}),
  };
}

/**
 * buildRedeemPayload — buyer constructs this before calling the API.
 *
 * The payload contains only what the server needs to verify: the token ID
 * and HMAC. No purchase metadata is included, preserving unlinkability.
 *
 * @param token   A BlindToken from the buyer's local store.
 * @returns       RedeemPayload to include in the API request header/body.
 */
export function buildRedeemPayload(token: BlindToken): RedeemPayload {
  if (!token.tokenId || !token.hmac) {
    throw new TypeError("token must have tokenId and hmac fields");
  }
  return {
    tokenId: token.tokenId,
    hmac: token.hmac,
    redeemedAt: new Date().toISOString(),
  };
}
