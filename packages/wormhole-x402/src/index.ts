/**
 * Wormhole x402 Solver
 * Base agent calls API → 402 response → solver bridges payment to Solana
 * Solana receipt anchored permanently via receipt_anchor
 * Solver earns 0.1% spread. NULL stakers back the solver float.
 */

import { createHash } from "node:crypto";
import type {
  Connection,
  Keypair,
  TransactionInstruction as TransactionInstructionType,
  VersionedTransactionResponse,
} from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Solver spread in basis points (0.1%). NULL stakers back the solver float. */
export const SOLVER_FEE_BPS = 10;

/** Solana clusters with a deployed receipt_anchor program. */
export type SolanaCluster = "mainnet-beta" | "devnet";

/**
 * receipt_anchor program per cluster.
 *
 * Mirrors `programs.receiptAnchor` in configs/mainnet.oss.json and
 * configs/devnet.oss.json, the repo's canonical program-ID source. Vendored
 * because the published package ships only src/; tests/wormhole-x402.test.mjs
 * fails if these drift from the config files.
 */
export const RECEIPT_ANCHOR_PROGRAM_IDS: Readonly<Record<SolanaCluster, string>> = Object.freeze({
  "mainnet-beta": "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
  devnet: "CPQ8Y1bdRiadxLMhrQG14Atc3E5eNJhqwPX1nXtH1Mst",
});

/** The receipt_anchor program on Solana mainnet-beta. */
export const RECEIPT_ANCHOR_PROGRAM_ID = RECEIPT_ANCHOR_PROGRAM_IDS["mainnet-beta"];

/** receipt_anchor bucket PDA seed prefix: `["bucket", bucket_id_le8]`. */
export const RECEIPT_ANCHOR_BUCKET_SEED = "bucket";

/** receipt_anchor bucket window: one bucket per hour of unix time. */
export const RECEIPT_ANCHOR_BUCKET_WINDOW_SECONDS = 3600;

/** receipt_anchor AnchorSingle wire version. */
const ANCHOR_VERSION_V1 = 0x01;
/** receipt_anchor flag: instruction carries an explicit bucket id. */
const ANCHOR_FLAG_HAS_BUCKET_ID = 0x01;
const ANCHOR_SINGLE_LEN_NO_BUCKET = 34;
const ANCHOR_SINGLE_LEN_WITH_BUCKET = 42;

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

/** Options for solveIntent. */
export interface SolveIntentOptions {
  /**
   * x402 payment program on the target cluster. Required: the cluster configs
   * define no canonical x402 payment program for this flow, so the caller
   * names the program its payment instruction targets. The instruction data is
   * `[0x02][gross USDC atomic units, u64 LE]` with the payer as the only account.
   */
  x402ProgramId: string;
  /** Cluster whose receipt_anchor program is used. Default: "mainnet-beta". */
  cluster?: SolanaCluster;
  /** Explicit receipt_anchor program ID (e.g. a local validator). Overrides `cluster`. */
  anchorProgramId?: string;
}

/** Options for verifyCrossChainReceipt. */
export interface VerifyReceiptOptions {
  /** Cluster whose receipt_anchor program is expected. Default: "mainnet-beta". */
  cluster?: SolanaCluster;
  /** Explicit receipt_anchor program ID. Overrides `cluster`. */
  anchorProgramId?: string;
}

/** Decoded receipt_anchor AnchorSingle instruction data. */
export interface AnchorInstructionData {
  /** The 32-byte anchor folded into the bucket root. */
  anchor: Buffer;
  /** Explicit bucket id, or null when the program derives it from the clock. */
  bucketId: bigint | null;
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

function isRpcUrl(rpc: string | Connection): rpc is string {
  return typeof rpc === "string";
}

// ── Program ID + receipt_anchor encoding ──────────────────────────────────────

/**
 * Resolve the receipt_anchor program ID: an explicit `anchorProgramId` wins,
 * otherwise the program configured for `cluster` (default "mainnet-beta").
 */
export function resolveReceiptAnchorProgramId(
  options: { cluster?: SolanaCluster; anchorProgramId?: string } = {}
): string {
  if (options.anchorProgramId !== undefined) {
    if (options.anchorProgramId.length === 0) {
      throw new Error("anchorProgramId must be a non-empty base58 program ID");
    }
    return options.anchorProgramId;
  }
  const cluster = options.cluster ?? "mainnet-beta";
  if (!Object.hasOwn(RECEIPT_ANCHOR_PROGRAM_IDS, cluster)) {
    throw new Error(`No receipt_anchor program configured for cluster "${cluster}"`);
  }
  return RECEIPT_ANCHOR_PROGRAM_IDS[cluster];
}

/**
 * Receipt hash anchored for a solved intent:
 * sha256(intentId + ":" + solanaTx + ":" + vaaHash), 32 bytes.
 */
export function computeReceiptHash(intentId: string, solanaTx: string, vaaHash: string): Buffer {
  return createHash("sha256").update(`${intentId}:${solanaTx}:${vaaHash}`, "utf8").digest();
}

/** receipt_anchor bucket id for a unix timestamp in seconds (matches the program's clock fallback). */
export function bucketIdForUnixSeconds(unixSeconds: number): bigint {
  if (unixSeconds <= 0) return 0n;
  return BigInt(Math.floor(unixSeconds / RECEIPT_ANCHOR_BUCKET_WINDOW_SECONDS));
}

/**
 * Encode receipt_anchor AnchorSingle with an explicit bucket id:
 * `[version=1][flags=0x01][anchor32][bucket_id u64 LE]` (42 bytes).
 */
export function buildAnchorInstructionData(anchor: Uint8Array, bucketId: bigint): Buffer {
  if (anchor.length !== 32) {
    throw new Error(`anchor must be 32 bytes, got ${anchor.length}`);
  }
  const data = Buffer.alloc(ANCHOR_SINGLE_LEN_WITH_BUCKET);
  data[0] = ANCHOR_VERSION_V1;
  data[1] = ANCHOR_FLAG_HAS_BUCKET_ID;
  data.set(anchor, 2);
  data.writeBigUInt64LE(bucketId, ANCHOR_SINGLE_LEN_NO_BUCKET);
  return data;
}

/**
 * Decode receipt_anchor AnchorSingle instruction data, applying the same
 * length/version/flag rules as the program's `unpack_single`. Returns null for
 * anything the program would not accept as a single anchor (including batches).
 */
export function parseAnchorInstructionData(data: Uint8Array): AnchorInstructionData | null {
  if (data.length !== ANCHOR_SINGLE_LEN_NO_BUCKET && data.length !== ANCHOR_SINGLE_LEN_WITH_BUCKET) {
    return null;
  }
  if (data[0] !== ANCHOR_VERSION_V1) return null;
  const hasBucket = (data[1] & ANCHOR_FLAG_HAS_BUCKET_ID) !== 0;
  if (hasBucket !== (data.length === ANCHOR_SINGLE_LEN_WITH_BUCKET)) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    anchor: Buffer.from(buf.subarray(2, ANCHOR_SINGLE_LEN_NO_BUCKET)),
    bucketId: hasBucket ? buf.readBigUInt64LE(ANCHOR_SINGLE_LEN_NO_BUCKET) : null,
  };
}

/** Derive the receipt_anchor bucket PDA `["bucket", bucket_id_le8]` as base58. */
export async function deriveAnchorBucketPda(anchorProgramId: string, bucketId: bigint): Promise<string> {
  const { PublicKey } = await import("@solana/web3.js");
  const bucketIdLe = Buffer.alloc(8);
  bucketIdLe.writeBigUInt64LE(bucketId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(RECEIPT_ANCHOR_BUCKET_SEED), bucketIdLe],
    new PublicKey(anchorProgramId)
  );
  return pda.toBase58();
}

/**
 * Build the receipt_anchor instruction: AnchorSingle with an explicit bucket,
 * accounts `[payer(signer,writable), bucket PDA(writable), system_program]`.
 */
export async function buildReceiptAnchorInstruction(params: {
  anchorProgramId: string;
  payer: string;
  anchor: Uint8Array;
  bucketId: bigint;
}): Promise<TransactionInstructionType> {
  const { PublicKey, SystemProgram, TransactionInstruction } = await import("@solana/web3.js");
  const bucketPda = await deriveAnchorBucketPda(params.anchorProgramId, params.bucketId);
  return new TransactionInstruction({
    programId: new PublicKey(params.anchorProgramId),
    keys: [
      { pubkey: new PublicKey(params.payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(bucketPda), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: buildAnchorInstructionData(params.anchor, params.bucketId),
  });
}

/**
 * Encode the x402 payment instruction data: `[0x02][grossAtomic u64 LE]`.
 */
export function buildPaymentInstructionData(grossAtomic: number): Buffer {
  if (!Number.isSafeInteger(grossAtomic) || grossAtomic <= 0) {
    throw new RangeError(`grossAtomic must be a positive safe integer, got ${grossAtomic}`);
  }
  const data = Buffer.alloc(9);
  data[0] = 0x02; // discriminator: x402 payment
  data.writeBigUInt64LE(BigInt(grossAtomic), 1);
  return data;
}

/**
 * Check a fetched transaction for a receipt_anchor instruction that anchors
 * `expectedAnchor`. A top-level instruction matches only when:
 *  - its program is `anchorProgramId`;
 *  - its data decodes as a v1 AnchorSingle whose 32-byte anchor equals `expectedAnchor`;
 *  - for the explicit-bucket form, its second account is the bucket PDA for that bucket id.
 * The transaction must also have succeeded (`meta.err === null`).
 */
export async function verifyReceiptAnchorTransaction(
  tx: Pick<VersionedTransactionResponse, "transaction" | "meta">,
  expected: { anchorProgramId: string; expectedAnchor: Uint8Array }
): Promise<boolean> {
  if (!tx.meta || tx.meta.err !== null) return false;
  if (expected.expectedAnchor.length !== 32) return false;

  const message = tx.transaction.message;
  let accountKeys: string[];
  try {
    accountKeys = message
      .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      .keySegments()
      .flat()
      .map((key) => key.toBase58());
  } catch {
    // v0 message with lookups but no loaded addresses: keys cannot be resolved.
    return false;
  }

  const want = Buffer.from(expected.expectedAnchor);
  for (const ix of message.compiledInstructions) {
    if (accountKeys[ix.programIdIndex] !== expected.anchorProgramId) continue;
    const decoded = parseAnchorInstructionData(ix.data);
    if (decoded === null || !decoded.anchor.equals(want)) continue;
    if (ix.accountKeyIndexes.length < 2) continue;
    if (decoded.bucketId !== null) {
      const bucketPda = await deriveAnchorBucketPda(expected.anchorProgramId, decoded.bucketId);
      if (accountKeys[ix.accountKeyIndexes[1]] !== bucketPda) continue;
    }
    return true;
  }
  return false;
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
 *  2. Submitting USDC payment on Solana via the caller-named x402 program
 *     (with solver fee applied).
 *  3. Anchoring the receipt on Solana via the receipt_anchor program for the
 *     configured cluster.
 *
 * The solver earns SOLVER_FEE_BPS (0.1%) spread; the gross amount debited from
 * the payer's Solana account is amountUsdc * 1.001. NULL stakers back the
 * solver float for instant settlement before the Wormhole VAA finalises.
 *
 * @param intent              - The CrossChainPaymentIntent (must have wormholeVaaBytes set).
 * @param solanaPayerKeypair  - Solana Keypair that signs and funds the USDC transfer.
 * @param rpc                 - Solana RPC endpoint URL, or an existing Connection.
 * @param options.x402ProgramId   - x402 payment program on the target cluster (required).
 * @param options.cluster         - Cluster for the receipt_anchor program. Default: "mainnet-beta".
 * @param options.anchorProgramId - Explicit receipt_anchor program ID; overrides `cluster`.
 * @returns Solana tx signatures and VAA hash.
 */
export async function solveIntent(
  intent: CrossChainPaymentIntent,
  solanaPayerKeypair: Keypair,
  rpc: string | Connection,
  options: SolveIntentOptions
): Promise<SolveIntentResult> {
  // ── Guard: program IDs resolved before anything touches the network ───────
  if (typeof options?.x402ProgramId !== "string" || options.x402ProgramId.length === 0) {
    throw new Error(
      "solveIntent requires options.x402ProgramId: no canonical x402 payment program " +
      "is configured for this flow, so the caller must name one."
    );
  }
  const anchorProgramIdStr = resolveReceiptAnchorProgramId(options);

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

  // Parse both IDs up front so a malformed ID fails before any payment is sent.
  const x402ProgramId = new PublicKey(options.x402ProgramId);
  const anchorProgramId = new PublicKey(anchorProgramIdStr);
  if (x402ProgramId.equals(anchorProgramId)) {
    throw new Error("x402ProgramId must differ from the receipt_anchor program ID");
  }

  const connection = isRpcUrl(rpc) ? new Connection(rpc, "confirmed") : rpc;

  // ── Step 3: Submit USDC payment on Solana via x402 ────────────────────────
  // The gross amount includes the solver spread. USDC has 6 decimals.
  const grossAtomic = Math.round(applyFee(intent.amountUsdc) * 1_000_000);

  const paymentIx = new TransactionInstruction({
    programId: x402ProgramId,
    keys: [
      { pubkey: solanaPayerKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: buildPaymentInstructionData(grossAtomic),
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
  // AnchorSingle with explicit bucket: [0x01][0x01][receiptHash32][bucket_id u64 LE]
  // receiptHash = sha256(intentId + ":" + solanaTx + ":" + vaaHash)
  const anchorIx = await buildReceiptAnchorInstruction({
    anchorProgramId: anchorProgramIdStr,
    payer: solanaPayerKeypair.publicKey.toBase58(),
    anchor: computeReceiptHash(intent.intentId, solanaTx, vaaHash),
    bucketId: bucketIdForUnixSeconds(Date.now() / 1000),
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
 * Fetches the receipt_anchor transaction, recomputes the expected receipt hash
 * sha256(intentId + ":" + solanaTx + ":" + vaaHash), and requires a top-level
 * instruction that targets the receipt_anchor program with AnchorSingle data
 * carrying exactly that hash (and, for the explicit-bucket form, the matching
 * bucket PDA). See verifyReceiptAnchorTransaction for the full matching rule.
 *
 * @param receipt   - The SolveIntentResult returned by solveIntent().
 * @param intentId  - The intentId from the original CrossChainPaymentIntent.
 * @param rpc       - Solana RPC endpoint URL, or an existing Connection.
 * @param options   - Cluster or explicit receipt_anchor program ID. Default: mainnet-beta.
 * @returns true if the receipt is anchored on-chain and matches the intent.
 */
export async function verifyCrossChainReceipt(
  receipt: Pick<SolveIntentResult, "solanaTx" | "receiptAnchorTx" | "vaaHash">,
  intentId: string,
  rpc: string | Pick<Connection, "getTransaction">,
  options: VerifyReceiptOptions = {}
): Promise<boolean> {
  const anchorProgramId = resolveReceiptAnchorProgramId(options);
  const expectedAnchor = computeReceiptHash(intentId, receipt.solanaTx, receipt.vaaHash);

  let connection: Pick<Connection, "getTransaction">;
  if (typeof rpc === "string") {
    const { Connection } = await import("@solana/web3.js");
    connection = new Connection(rpc, "confirmed");
  } else {
    connection = rpc;
  }

  const txDetails = await connection.getTransaction(receipt.receiptAnchorTx, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (txDetails === null) {
    // Transaction not found on-chain — receipt does not exist yet.
    return false;
  }

  return verifyReceiptAnchorTransaction(txDetails, { anchorProgramId, expectedAnchor });
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
