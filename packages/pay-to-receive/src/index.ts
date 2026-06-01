/**
 * @parad0x_labs/pay-to-receive
 *
 * Pay-to-Receive Channels — flip x402 inbound.
 *
 * Normal x402: caller pays BEFORE receiving an API response (outbound attention).
 * Pay-to-Receive: the SENDER pays to have their payload received, processed, or
 * decrypted by a bot, room, agent, or webhook. You sell inbound attention and
 * delivery guarantees, not API responses.
 *
 * Flow:
 *   1. Receiver (bot / agent / webhook) calls buildReceiveQuote() and publishes it.
 *   2. Sender calls buildPayToReceivePayload() to bind a ciphertext to the quote.
 *   3. Sender pays the quoted price via x402 and submits ciphertext to receiver.
 *   4. Receiver processes the payload, calls buildDeliveryReceipt(), and optionally
 *      anchors it on-chain via anchorDeliveryReceipt().
 *
 * On-chain anchor: receipt_anchor program
 *   6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN  (mainnet-beta)
 *
 * Instruction data layout:  [0x01][0x00][32 bytes SHA-256 commitment]  = 34 bytes
 */

import { createHash, randomBytes } from "node:crypto";
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
// DeliveryClass
// ---------------------------------------------------------------------------

/**
 * Classification of inbound delivery.
 *
 * - STANDARD      — fire-and-forget delivery, best-effort processing
 * - PRIORITY      — elevated queue placement, faster processing guarantee
 * - ENCRYPTED     — payload is encrypted; receiver must decrypt before processing
 * - WEBHOOK       — relay to an HTTP endpoint and return HTTP status
 * - AGENT_ACTION  — trigger an autonomous agent action with the payload as input
 */
export const DeliveryClass = {
  STANDARD:     "standard",
  PRIORITY:     "priority",
  ENCRYPTED:    "encrypted",
  WEBHOOK:      "webhook",
  AGENT_ACTION: "agent_action",
} as const;

export type DeliveryClassValue = (typeof DeliveryClass)[keyof typeof DeliveryClass];

// ---------------------------------------------------------------------------
// ReceiveQuote
// ---------------------------------------------------------------------------

/**
 * A signed quote issued by a receiver advertising its willingness to accept
 * and process inbound payloads in exchange for a micropayment.
 *
 * `receiverSubjectHash` is SHA-256(receiverPubkey) — the raw wallet is not
 * exposed in the quote, preventing enumeration of receiver addresses.
 */
export interface ReceiveQuote {
  /** Unique quote identifier (16 random bytes, hex). */
  quoteId: string;
  /** SHA-256 hex of the receiver's public key.  Raw key is not exposed. */
  receiverSubjectHash: string;
  /** Delivery class this quote covers. */
  deliveryClass: DeliveryClassValue;
  /** Price in the smallest indivisible unit of `currency`. */
  priceAtomic: number;
  /** Currency the price is denominated in. */
  currency: "USDC" | "SOL";
  /** Unix ms timestamp after which this quote is no longer valid. */
  validUntil: number;
  /**
   * Optional: SHA-256 hex of a ciphertext the sender pre-uploaded to
   * Arweave / IPFS.  When present the sender has already committed to a
   * specific payload; the receipt will bind to this hash.
   */
  ciphertextHash?: string;
  /** Maximum accepted payload size in bytes. */
  maxPayloadBytes: number;
  /**
   * Ed25519 signature of the canonical quote fields (hex).
   *
   * Canonical form signed:
   *   SHA-256( quoteId | receiverSubjectHash | deliveryClass |
   *            priceAtomic | currency | validUntil | maxPayloadBytes )
   * encoded as the UTF-8 string of that pipe-joined sequence.
   */
  receiverSignature: string;
}

// ---------------------------------------------------------------------------
// DeliveryReceipt
// ---------------------------------------------------------------------------

/**
 * A signed, tamper-evident proof that a receiver processed a payload.
 *
 * `senderNonce` is a one-time random value supplied by the sender to prevent
 * receipt replay across different senders or payment sessions.
 */
export interface DeliveryReceipt {
  /** Unique receipt identifier (16 random bytes, hex). */
  receiptId: string;
  /** The quote this delivery settles. */
  quoteId: string;
  /** SHA-256 hex of the processed ciphertext. */
  ciphertextHash: string;
  /** Delivery class executed. */
  deliveryClass: DeliveryClassValue;
  /** Unix ms timestamp when the payload was delivered / processed. */
  deliveredAt: number;
  /**
   * Optional: SHA-256 hex of the action result produced by the receiver.
   * Present for AGENT_ACTION and WEBHOOK delivery classes.
   */
  resultDigest?: string;
  /** SHA-256 hex of the receiver's public key (mirrors ReceiveQuote). */
  receiverSubjectHash: string;
  /** One-time nonce supplied by the sender; prevents receipt replay. */
  senderNonce: string;
  /**
   * Ed25519 signature of the canonical receipt fields (hex).
   *
   * Canonical form signed:
   *   SHA-256( receiptId | quoteId | ciphertextHash | deliveryClass |
   *            deliveredAt | receiverSubjectHash | senderNonce )
   */
  receiverSignature: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of a UTF-8 string. */
function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 hex of a Uint8Array. */
function sha256hexBytes(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 16-byte cryptographically random hex string. */
function newId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Minimal Ed25519 sign/verify using Node's built-in `node:crypto`.
 *
 * `keypair.privateKey` must be a 32-byte seed (raw Ed25519 private key bytes)
 * or a hex string of such a seed.
 *
 * In production, pass the Solana Keypair's secretKey (first 32 bytes are the
 * seed) or a Web Crypto CryptoKeyPair.  This implementation uses Node's native
 * WebCrypto (available since Node 15) so no additional dependencies are needed.
 */

/**
 * Sign `message` bytes with a 32-byte Ed25519 seed.
 * Returns the 64-byte signature as a hex string.
 *
 * WebCrypto requires Ed25519 private keys in PKCS#8 DER format.
 * PKCS#8 for Ed25519 (RFC 8410):
 *   SEQUENCE {
 *     INTEGER 0                           -- version
 *     SEQUENCE { OID 1.3.101.112 }        -- Ed25519 OID
 *     OCTET STRING {
 *       OCTET STRING { <32-byte seed> }   -- nested OCTET STRING
 *     }
 *   }
 * Encoded as hex: 302e020100300506032b657004220420 + <32 seed bytes>
 */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

async function signEd25519(seed32: Uint8Array, message: Uint8Array): Promise<string> {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed32]);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("Ed25519", cryptoKey, message);
  return Buffer.from(sig).toString("hex");
}

/**
 * Verify an Ed25519 signature.
 * `pubkey32` must be the 32-byte public key (raw).
 * Returns true if signature is valid.
 */
async function verifyEd25519(
  pubkey32: Uint8Array,
  message: Uint8Array,
  sigHex: string,
): Promise<boolean> {
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      pubkey32,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sigBytes = Buffer.from(sigHex, "hex");
    return await globalThis.crypto.subtle.verify("Ed25519", cryptoKey, sigBytes, message);
  } catch {
    return false;
  }
}

/**
 * Resolve the public-key bytes from a Solana-style keypair object.
 *
 * Accepts objects shaped like:
 *   { publicKey: Uint8Array | { toBytes(): Uint8Array } }
 *   { secretKey: Uint8Array }  (first 32 bytes = seed, last 32 = pubkey)
 */
function extractPubkeyBytes(receiverPubkey: string | Uint8Array): Uint8Array {
  if (typeof receiverPubkey === "string") {
    // Hex string
    if (/^[0-9a-fA-F]{64}$/.test(receiverPubkey)) {
      return Buffer.from(receiverPubkey, "hex");
    }
    // Base58 string (Solana address) — decode inline
    return base58Decode(receiverPubkey);
  }
  return receiverPubkey;
}

/**
 * Extract the 32-byte seed from a keypair for signing.
 * Accepts a Solana Keypair (secretKey is 64 bytes: seed || pubkey) or
 * a plain object with { seed: Uint8Array } or { secretKey: Uint8Array }.
 */
function extractSeed(keypair: {
  secretKey?: Uint8Array;
  seed?: Uint8Array;
}): Uint8Array {
  if (keypair.seed) return keypair.seed;
  if (keypair.secretKey) return keypair.secretKey.slice(0, 32);
  throw new TypeError("keypair must have secretKey or seed");
}

// ---------------------------------------------------------------------------
// Quote canonical bytes
// ---------------------------------------------------------------------------

function quoteCanonicalBytes(q: {
  quoteId: string;
  receiverSubjectHash: string;
  deliveryClass: string;
  priceAtomic: number;
  currency: string;
  validUntil: number;
  maxPayloadBytes: number;
}): Uint8Array {
  const canonical = [
    q.quoteId,
    q.receiverSubjectHash,
    q.deliveryClass,
    String(q.priceAtomic),
    q.currency,
    String(q.validUntil),
    String(q.maxPayloadBytes),
  ].join("|");
  return new TextEncoder().encode(canonical);
}

// ---------------------------------------------------------------------------
// Receipt canonical bytes
// ---------------------------------------------------------------------------

function receiptCanonicalBytes(r: {
  receiptId: string;
  quoteId: string;
  ciphertextHash: string;
  deliveryClass: string;
  deliveredAt: number;
  receiverSubjectHash: string;
  senderNonce: string;
}): Uint8Array {
  const canonical = [
    r.receiptId,
    r.quoteId,
    r.ciphertextHash,
    r.deliveryClass,
    String(r.deliveredAt),
    r.receiverSubjectHash,
    r.senderNonce,
  ].join("|");
  return new TextEncoder().encode(canonical);
}

// ---------------------------------------------------------------------------
// Public API — Quote
// ---------------------------------------------------------------------------

/**
 * Build a signed ReceiveQuote.
 *
 * The receiver calls this to advertise willingness to accept inbound payloads.
 *
 * @param params.receiverPubkey   32-byte raw public key, hex string, or base58.
 * @param params.deliveryClass    One of DeliveryClass values.
 * @param params.priceAtomic      Price in smallest units (lamports for SOL,
 *                                1e-6 USDC for USDC).
 * @param params.currency         "USDC" or "SOL".
 * @param params.validSeconds     How many seconds from now the quote is valid.
 * @param params.maxPayloadBytes  Maximum accepted ciphertext size.
 * @param receiverKeypair         Solana Keypair or `{ secretKey: Uint8Array }`.
 *
 * @example
 * const quote = await buildReceiveQuote(
 *   { receiverPubkey: keypair.publicKey.toBytes(), deliveryClass: "priority",
 *     priceAtomic: 1_000, currency: "USDC", validSeconds: 300, maxPayloadBytes: 65536 },
 *   keypair,
 * );
 */
export async function buildReceiveQuote(
  params: {
    receiverPubkey: string | Uint8Array;
    deliveryClass: DeliveryClassValue;
    priceAtomic: number;
    currency: "USDC" | "SOL";
    validSeconds: number;
    maxPayloadBytes: number;
    ciphertextHash?: string;
  },
  receiverKeypair: { secretKey?: Uint8Array; seed?: Uint8Array },
): Promise<ReceiveQuote> {
  if (params.priceAtomic < 0) throw new RangeError("priceAtomic must be >= 0");
  if (params.validSeconds <= 0) throw new RangeError("validSeconds must be > 0");
  if (params.maxPayloadBytes <= 0) throw new RangeError("maxPayloadBytes must be > 0");

  const pubkeyBytes = extractPubkeyBytes(params.receiverPubkey);
  const receiverSubjectHash = sha256hexBytes(pubkeyBytes);
  const quoteId = newId();
  const validUntil = Date.now() + params.validSeconds * 1000;

  const partial = {
    quoteId,
    receiverSubjectHash,
    deliveryClass: params.deliveryClass,
    priceAtomic: params.priceAtomic,
    currency: params.currency,
    validUntil,
    maxPayloadBytes: params.maxPayloadBytes,
  };

  const seed = extractSeed(receiverKeypair);
  const receiverSignature = await signEd25519(seed, quoteCanonicalBytes(partial));

  const quote: ReceiveQuote = {
    ...partial,
    receiverSignature,
  };
  if (params.ciphertextHash !== undefined) {
    quote.ciphertextHash = params.ciphertextHash;
  }
  return quote;
}

/**
 * Verify a ReceiveQuote's signature against a known receiver public key.
 *
 * @param quote          The quote to verify.
 * @param receiverPubkey 32-byte raw public key, hex string, or base58.
 * @returns true if the signature is valid.
 */
export async function verifyReceiveQuote(
  quote: ReceiveQuote,
  receiverPubkey: string | Uint8Array,
): Promise<boolean> {
  const pubkeyBytes = extractPubkeyBytes(receiverPubkey);
  // Also verify the subject hash matches
  const expectedSubjectHash = sha256hexBytes(pubkeyBytes);
  if (quote.receiverSubjectHash !== expectedSubjectHash) return false;

  const canonical = quoteCanonicalBytes({
    quoteId: quote.quoteId,
    receiverSubjectHash: quote.receiverSubjectHash,
    deliveryClass: quote.deliveryClass,
    priceAtomic: quote.priceAtomic,
    currency: quote.currency,
    validUntil: quote.validUntil,
    maxPayloadBytes: quote.maxPayloadBytes,
  });
  return verifyEd25519(pubkeyBytes, canonical, quote.receiverSignature);
}

// ---------------------------------------------------------------------------
// Public API — Delivery Receipt
// ---------------------------------------------------------------------------

/**
 * Build a signed DeliveryReceipt after processing an inbound payload.
 *
 * @param quoteId           The quoteId this receipt settles.
 * @param ciphertextHash    SHA-256 hex of the ciphertext that was processed.
 * @param senderNonce       One-time nonce supplied by the sender.
 * @param receiverKeypair   Keypair used to sign the receipt.
 * @param resultDigest      Optional SHA-256 hex of the action result.
 *
 * @example
 * const receipt = await buildDeliveryReceipt(
 *   quote.quoteId, payloadResult.payloadHash, payloadResult.senderNonce,
 *   keypair, sha256hexOf(actionResult),
 * );
 */
export async function buildDeliveryReceipt(
  quoteId: string,
  ciphertextHash: string,
  senderNonce: string,
  receiverKeypair: { secretKey?: Uint8Array; seed?: Uint8Array; publicKey?: { toBytes(): Uint8Array } | Uint8Array },
  resultDigest?: string,
): Promise<DeliveryReceipt> {
  // Derive the receiverSubjectHash from the keypair public key if available
  let receiverSubjectHash: string;
  if (receiverKeypair.publicKey) {
    const pkBytes = receiverKeypair.publicKey instanceof Uint8Array
      ? receiverKeypair.publicKey
      : (receiverKeypair.publicKey as { toBytes(): Uint8Array }).toBytes();
    receiverSubjectHash = sha256hexBytes(pkBytes);
  } else {
    // Fall back: derive pubkey from seed via signing a known message is not
    // straightforward without a library. Encode the seed hash as subject hash.
    const seed = extractSeed(receiverKeypair);
    receiverSubjectHash = sha256hexBytes(seed);
  }

  const receiptId = newId();
  const deliveredAt = Date.now();

  const partial = {
    receiptId,
    quoteId,
    ciphertextHash,
    deliveryClass: "standard" as DeliveryClassValue,  // set by caller via quoteId lookup
    deliveredAt,
    receiverSubjectHash,
    senderNonce,
  };

  const seed = extractSeed(receiverKeypair);
  const receiverSignature = await signEd25519(seed, receiptCanonicalBytes(partial));

  const receipt: DeliveryReceipt = {
    ...partial,
    receiverSignature,
  };
  if (resultDigest !== undefined) {
    receipt.resultDigest = resultDigest;
  }
  return receipt;
}

/**
 * Verify a DeliveryReceipt's signature against a known receiver public key.
 *
 * @param receipt        The receipt to verify.
 * @param receiverPubkey 32-byte raw public key, hex string, or base58.
 * @returns true if the signature is valid.
 */
export async function verifyDeliveryReceipt(
  receipt: DeliveryReceipt,
  receiverPubkey: string | Uint8Array,
): Promise<boolean> {
  const pubkeyBytes = extractPubkeyBytes(receiverPubkey);
  const canonical = receiptCanonicalBytes({
    receiptId: receipt.receiptId,
    quoteId: receipt.quoteId,
    ciphertextHash: receipt.ciphertextHash,
    deliveryClass: receipt.deliveryClass,
    deliveredAt: receipt.deliveredAt,
    receiverSubjectHash: receipt.receiverSubjectHash,
    senderNonce: receipt.senderNonce,
  });
  return verifyEd25519(pubkeyBytes, canonical, receipt.receiverSignature);
}

// ---------------------------------------------------------------------------
// Public API — Sender payload preparation
// ---------------------------------------------------------------------------

/**
 * Prepare a pay-to-receive payload for upload.
 *
 * Binds a ciphertext to a specific quote and generates a one-time sender
 * nonce that prevents receipt replay. The caller should:
 *   1. Upload `encryptedPayload` to Arweave / IPFS.
 *   2. Submit `payloadHash` + `senderNonce` + the x402 payment to the receiver.
 *
 * @param quote            The ReceiveQuote from the receiver.
 * @param ciphertextBytes  Pre-encrypted payload bytes (caller handles encryption).
 *
 * @returns
 *   - `payloadHash`      SHA-256 hex of the ciphertext; what the receipt binds to.
 *   - `encryptedPayload` The ciphertext bytes, ready for off-chain storage.
 *   - `senderNonce`      16-byte random hex; must be included in the payment.
 *
 * @throws RangeError if the payload exceeds `quote.maxPayloadBytes`.
 */
export function buildPayToReceivePayload(
  quote: ReceiveQuote,
  ciphertextBytes: Uint8Array,
): {
  payloadHash: string;
  encryptedPayload: Uint8Array;
  senderNonce: string;
} {
  if (ciphertextBytes.length > quote.maxPayloadBytes) {
    throw new RangeError(
      `Payload size ${ciphertextBytes.length} exceeds maxPayloadBytes ${quote.maxPayloadBytes}`,
    );
  }
  if (Date.now() > quote.validUntil) {
    throw new Error(`Quote ${quote.quoteId} has expired`);
  }

  const payloadHash = sha256hexBytes(ciphertextBytes);
  // senderNonce is generated fresh each call — prevents replay even if the
  // same ciphertext is submitted multiple times.
  const senderNonce = newId();

  return {
    payloadHash,
    encryptedPayload: ciphertextBytes,
    senderNonce,
  };
}

// ---------------------------------------------------------------------------
// Public API — On-chain anchor
// ---------------------------------------------------------------------------

/**
 * Anchor a DeliveryReceipt on Solana via the receipt_anchor program.
 *
 * Stores SHA-256(JSON.stringify(receipt)) as a 32-byte commitment in a
 * memo-style instruction.  The receipt JSON can be stored off-chain (Arweave /
 * IPFS) with the transaction signature as a permanent pointer.
 *
 * Instruction data layout: [0x01][0x00][32 bytes SHA-256]  = 34 bytes
 *
 * @param receipt       The signed DeliveryReceipt to anchor.
 * @param connection    A Solana web3.js Connection.
 * @param payerKeypair  Solana Keypair (Signer) that pays the tx fee.
 * @returns The Solana transaction signature string.
 */
export async function anchorDeliveryReceipt(
  receipt: DeliveryReceipt,
  connection: Connection,
  payerKeypair: Signer,
): Promise<string> {
  const receiptJson = JSON.stringify(receipt);
  const digest = createHash("sha256").update(receiptJson, "utf8").digest();

  const ixData = new Uint8Array(34);
  ixData[0] = 0x01;
  ixData[1] = 0x00;
  ixData.set(digest, 2);

  const programId = new PublicKey(RECEIPT_ANCHOR_PROGRAM_ID);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payerKeypair.publicKey;

  const txSig = await connection.sendTransaction(tx, [payerKeypair], {
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
// Base58 helper (no external deps)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of input) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) throw new Error(`Invalid base58 character: ${char}`);
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
  // Leading zeroes
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
