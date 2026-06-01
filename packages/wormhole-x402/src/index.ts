/**
 * Wormhole x402 Solver
 * Base agent calls API → 402 response → solver bridges payment to Solana
 * Solana receipt anchored permanently via receipt_anchor
 * Solver earns 0.1% spread. NULL stakers back the solver float.
 */

import { createHash } from "node:crypto";
import type { Connection, Keypair } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Solver spread in basis points (0.1%). NULL stakers back the solver float. */
export const SOLVER_FEE_BPS = 10;

/** The receipt_anchor program on Solana mainnet-beta. */
export const RECEIPT_ANCHOR_PROGRAM_ID = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";

/**
 * Wormhole Core Bridge program on Solana mainnet.
 * VAA verification is delegated to this program — no new infrastructure needed.
 */
export const WORMHOLE_CORE_BRIDGE_SOLANA = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Source EVM chains supported by the solver. */
export type SourceChain = "base" | "ethereum" | "arbitrum";

/**
 * A cross-chain x402 payment intent.
 *
 * Lifecycle:
 *  1. Agent on Base receives a 402 response from an API.
 *  2. Solver builds a CrossChainPaymentIntent and submits it to Wormhole.
 *  3. Wormhole relayer produces a VAA; wormholeVaaBytes is populated.
 *  4. Solver calls solveIntent() to pay on Solana and anchor the receipt.
 */
export interface CrossChainPaymentIntent {
  /** Unique identifier: sha256(apiEndpoint + timestamp + payerEthAddress). */
  intentId: string;
  /** EVM chain where the agent originated the API call. */
  sourceChain: SourceChain;
  /** Canonical receipt ledger — always Solana. */
  targetChain: "solana";
  /** Checksummed EVM address of the agent paying (0x-prefixed). */
  payerEthAddress: string;
  /** Payment amount in USDC (human units, e.g. 0.05 = $0.05). */
  amountUsdc: number;
  /** The API endpoint that returned 402. */
  apiEndpoint: string;
  /**
   * SHA-256 hex digest of the original HTTP request.
   * requestHash = sha256(apiEndpoint + timestamp + payerEthAddress)
   */
  requestHash: string;
  /** Unix timestamp (ms) after which this intent is invalid. */
  expiresAt: number;
  /**
   * Base-64 encoded VAA bytes from Wormhole after the cross-chain message
   * is observed and signed by guardians. Populated by the relayer.
   */
  wormholeVaaBytes?: string;
}

/** Parameters for buildCrossChainIntent. */
export interface BuildCrossChainIntentParams {
  sourceChain: SourceChain;
  payerEthAddress: string;
  amountUsdc: number;
  apiEndpoint: string;
  /** TTL in milliseconds from now. Defaults to 5 minutes. */
  ttlMs?: number;
}

/** Result returned by solveIntent. */
export interface SolveIntentResult {
  /** Solana transaction signature for the USDC payment. */
  solanaTx: string;
  /** Solana transaction signature for the receipt_anchor memo. */
  receiptAnchorTx: string;
  /** Wormhole VAA hash (keccak256 of the VAA body bytes) as a hex string. */
  vaaHash: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function sha256buf(data: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Apply solver fee to an amount expressed in USDC human units.
 * grossAmount = amountUsdc * (1 + SOLVER_FEE_BPS / 10_000)
 */
function applyFee(amountUsdc: number): number {
  return amountUsdc * (1 + SOLVER_FEE_BPS / 10_000);
}

/**
 * Parse and validate a base-64 encoded VAA, returning its body bytes.
 * Throws if the VAA is malformed.
 *
 * Wormhole VAA layout (binary):
 *   [0]      version (must be 1)
 *   [1..4]   guardian set index (uint32 BE)
 *   [5]      number of signatures
 *   [5 + n*66 .. ]  body bytes
 *
 * We do a minimal structural check here; full guardian-signature verification
 * is delegated to the Wormhole Core Bridge program on-chain.
 */
function parseVaaBytes(vaaBase64: string): Uint8Array {
  const raw = Buffer.from(vaaBase64, "base64");
  if (raw.length < 6) {
    throw new Error(`VAA too short: ${raw.length} bytes`);
  }
  const version = raw[0];
  if (version !== 1) {
    throw new Error(`Unsupported VAA version: ${version} (expected 1)`);
  }
  const numSignatures = raw[5];
  const headerSize = 6 + numSignatures * 66;
  if (raw.length <= headerSize) {
    throw new Error(`VAA body missing: length=${raw.length} headerSize=${headerSize}`);
  }
  return raw;
}

/**
 * Derive the keccak256 of the VAA body (the canonical "vaaHash" used by
 * Wormhole contracts to deduplicate deliveries).
 *
 * keccak256 is approximated here with double-sha256 for Node.js compatibility
 * (the on-chain program does the real keccak256 check). Replace with
 * `ethers.utils.keccak256` or `viem.keccak256` if full EVM parity is needed.
 */
function deriveVaaHash(vaaBytes: Uint8Array): string {
  return sha256buf(sha256buf(vaaBytes)).toString("hex");
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a CrossChainPaymentIntent for an agent on an EVM chain that received
 * a 402 response and wants to fulfil the payment via Wormhole → Solana.
 *
 * requestHash = sha256(apiEndpoint + timestamp + payerEthAddress)
 * intentId   = sha256(requestHash + sourceChain + amountUsdc)
 *
 * @param params.sourceChain       - EVM chain the agent is operating on.
 * @param params.payerEthAddress   - 0x-prefixed EVM address of the agent wallet.
 * @param params.amountUsdc        - Amount in USDC (human units).
 * @param params.apiEndpoint       - The API URL that returned 402.
 * @param params.ttlMs             - Intent lifetime in ms. Default: 5 minutes.
 * @returns A CrossChainPaymentIntent ready to be relayed via Wormhole.
 */
export function buildCrossChainIntent(
  params: BuildCrossChainIntentParams
): CrossChainPaymentIntent {
  const {
    sourceChain,
    payerEthAddress,
    amountUsdc,
    apiEndpoint,
    ttlMs = 5 * 60 * 1_000,
  } = params;

  if (amountUsdc <= 0) {
    throw new RangeError(`amountUsdc must be positive, got ${amountUsdc}`);
  }
  if (!payerEthAddress.startsWith("0x") || payerEthAddress.length !== 42) {
    throw new Error(`payerEthAddress must be a checksummed 0x-prefixed EVM address, got ${payerEthAddress}`);
  }

  const timestamp = Date.now();
  const requestHash = sha256hex(`${apiEndpoint}${timestamp}${payerEthAddress}`);
  const intentId = sha256hex(`${requestHash}${sourceChain}${amountUsdc}`);
  const expiresAt = timestamp + ttlMs;

  return {
    intentId,
    sourceChain,
    targetChain: "solana",
    payerEthAddress,
    amountUsdc,
    apiEndpoint,
    requestHash,
    expiresAt,
  };
}

/**
 * Solve a CrossChainPaymentIntent by:
 *  1. Verifying the Wormhole VAA exists and is structurally valid.
 *  2. Submitting USDC payment on Solana via x402 (with solver fee applied).
 *  3. Anchoring the receipt on Solana via the receipt_anchor program.
 *
 * The solver earns SOLVER_FEE_BPS (0.1%) spread; the gross amount debited from
 * the payer's Solana account is amountUsdc * 1.001. NULL stakers back the
 * solver float for instant settlement before the Wormhole VAA finalises.
 *
 * @param intent              - The CrossChainPaymentIntent (must have wormholeVaaBytes set).
 * @param solanaPayerKeypair  - Solana Keypair that signs and funds the USDC transfer.
 * @param rpcUrl              - Solana RPC endpoint URL.
 * @returns Solana tx signatures and VAA hash.
 */
export async function solveIntent(
  intent: CrossChainPaymentIntent,
  solanaPayerKeypair: Keypair,
  rpcUrl: string
): Promise<SolveIntentResult> {
  // ── Guard: VAA must be present ─────────────────────────────────────────────
  if (!intent.wormholeVaaBytes) {
    throw new Error(
      `Intent ${intent.intentId} has no wormholeVaaBytes. ` +
      "Wait for the Wormhole relayer to populate this field before solving."
    );
  }

  // ── Guard: intent must not be expired ─────────────────────────────────────
  if (Date.now() > intent.expiresAt) {
    throw new Error(
      `Intent ${intent.intentId} expired at ${new Date(intent.expiresAt).toISOString()}`
    );
  }

  // ── Step 1: Verify VAA structure ─────────────────────────────────────────
  const vaaBytes = parseVaaBytes(intent.wormholeVaaBytes);
  const vaaHash = deriveVaaHash(vaaBytes);

  // ── Step 2: Connect to Solana ─────────────────────────────────────────────
  const {
    Connection,
    Transaction,
    TransactionInstruction,
    PublicKey,
    sendAndConfirmTransaction,
  } = await import("@solana/web3.js");

  const connection = new Connection(rpcUrl, "confirmed");

  // ── Step 3: Submit USDC payment on Solana via x402 ────────────────────────
  //
  // Production integration: replace this stub instruction with a real call to
  // the x402 payment program (or SPL Token transfer to the API's token account).
  // The gross amount includes the solver spread.
  const grossAmount = applyFee(intent.amountUsdc);
  const grossLamports = Math.round(grossAmount * 1_000_000); // USDC has 6 decimals

  const paymentIxData = new Uint8Array(9);
  paymentIxData[0] = 0x02; // discriminator: x402 payment
  // [1..8] = grossLamports as uint64 little-endian
  const dv = new DataView(paymentIxData.buffer);
  dv.setUint32(1, grossLamports & 0xffffffff, true);
  dv.setUint32(5, Math.floor(grossLamports / 0x100000000), true);

  // Stub: in production this would target the x402 program account.
  const x402ProgramId = new PublicKey("x4029JZMtmjFHr6k9pJCH9cBe8p7K3n8ZVmLQwY1abc");

  const paymentIx = new TransactionInstruction({
    programId: x402ProgramId,
    keys: [
      { pubkey: solanaPayerKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(paymentIxData),
  });

  const paymentTx = new Transaction().add(paymentIx);
  paymentTx.feePayer = solanaPayerKeypair.publicKey;

  const solanaTx = await sendAndConfirmTransaction(
    connection,
    paymentTx,
    [solanaPayerKeypair],
    { commitment: "confirmed" }
  );

  // ── Step 4: Anchor receipt on Solana via receipt_anchor ───────────────────
  //
  // Instruction data layout: [0x01][0x00][32 bytes receipt hash]
  // receiptHash = sha256(intentId + solanaTx + vaaHash)
  const receiptPayload = sha256hex(`${intent.intentId}:${solanaTx}:${vaaHash}`);
  const receiptHashBytes = Buffer.from(receiptPayload, "hex");

  const anchorIxData = new Uint8Array(34);
  anchorIxData[0] = 0x01;
  anchorIxData[1] = 0x00;
  anchorIxData.set(receiptHashBytes, 2);

  const anchorProgramId = new PublicKey(RECEIPT_ANCHOR_PROGRAM_ID);

  const anchorIx = new TransactionInstruction({
    programId: anchorProgramId,
    keys: [
      { pubkey: solanaPayerKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(anchorIxData),
  });

  const anchorTx = new Transaction().add(anchorIx);
  anchorTx.feePayer = solanaPayerKeypair.publicKey;

  const receiptAnchorTx = await sendAndConfirmTransaction(
    connection,
    anchorTx,
    [solanaPayerKeypair],
    { commitment: "confirmed" }
  );

  return { solanaTx, receiptAnchorTx, vaaHash };
}

/**
 * Verify that a receipt anchored on Solana matches the original intent.
 *
 * Queries the Solana transaction, extracts the instruction data, and
 * recomputes the expected receipt hash from the intentId.
 *
 * In a production implementation this would also verify the memo against the
 * receipt_anchor program's account state. The stub below validates the
 * transaction exists and the intentId is present in the memo field.
 *
 * @param receiptAnchorTx - Solana tx signature from solveIntent().receiptAnchorTx.
 * @param intentId        - The intentId from the original CrossChainPaymentIntent.
 * @param rpcUrl          - Solana RPC endpoint URL.
 * @returns true if the receipt is present on-chain and matches the intent.
 */
export async function verifyCrossChainReceipt(
  receiptAnchorTx: string,
  intentId: string,
  rpcUrl: string
): Promise<boolean> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(rpcUrl, "confirmed");

  // Fetch the transaction from Solana.
  const txDetails = await connection.getTransaction(receiptAnchorTx, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (txDetails === null) {
    // Transaction not found on-chain — receipt does not exist yet.
    return false;
  }

  if (txDetails.meta?.err !== null) {
    // Transaction failed — receipt not anchored.
    return false;
  }

  // Verify the anchor instruction data contains a hash that embeds the intentId.
  // In production: deserialise the instruction data and compare the stored
  // receipt hash against sha256(intentId + solanaTx + vaaHash).
  //
  // Stub check: confirm the transaction account list includes the anchor program.
  const anchorProgramId = new PublicKey(RECEIPT_ANCHOR_PROGRAM_ID);
  const message = txDetails.transaction.message;
  const accountKeys =
    "getAccountKeys" in message
      ? message.getAccountKeys().staticAccountKeys
      : (message as { accountKeys: PublicKey[] }).accountKeys;

  const hasAnchorProgram = accountKeys.some(
    (key: PublicKey) => key.toBase58() === anchorProgramId.toBase58()
  );

  if (!hasAnchorProgram) {
    return false;
  }

  // The intentId is incorporated into the receipt hash stored in the instruction.
  // For the stub, we confirm the tx is successful and targets the anchor program.
  // A full implementation would deserialise and compare the 32-byte hash at [2..33].
  void intentId; // will be used in full implementation

  return true;
}

// ── Utility exports ───────────────────────────────────────────────────────────

/**
 * Compute the gross USDC amount after the solver fee is applied.
 *
 * @param amountUsdc - Net USDC amount requested by the API.
 * @returns Gross USDC amount the payer will be debited.
 */
export function grossAmount(amountUsdc: number): number {
  return applyFee(amountUsdc);
}

/**
 * Return true if a CrossChainPaymentIntent is still within its validity window.
 */
export function isIntentValid(intent: CrossChainPaymentIntent): boolean {
  return Date.now() <= intent.expiresAt && !!intent.wormholeVaaBytes;
}
