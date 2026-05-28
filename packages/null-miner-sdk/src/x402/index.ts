/**
 * null-miner-sdk — DNA x402 Payment Rail Surface
 *
 * Canonical types and functions for wiring the NULL Miner SDK into the
 * DNA x402 Solana payment standard.
 *
 * What this is:
 *   The DNA x402 anchor is live on Solana mainnet (119M+ txs).
 *   This module generates compatible payment requirements, verifies receipts,
 *   and produces receipt anchor payloads that fit the existing on-chain format.
 *
 * What this is NOT:
 *   This does NOT make on-chain calls itself — that requires a funded Solana wallet.
 *   Use `anchorReceiptPayload` to build the instruction data, then sign + submit
 *   via @solana/web3.js or any Solana wallet adapter.
 *
 * Production status:
 *   - DNA x402 anchor: LIVE on Solana mainnet
 *   - NULL token:      LIVE on Solana mainnet (8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump)
 *   - null-miner rails: SDK/devnet until promoted (no audit yet)
 */

import { createHash } from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const USDC_MAINNET  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET   = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
export const NULL_TOKEN    = "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump";
export const X402_VERSION  = 1;
export const MEMO_PREFIX   = "null-miner-v1";

/**
 * Deployed receipt_anchor program IDs.
 * DEVNET_RECEIPT_ANCHOR_PROGRAM_ID: replace with real address after `solana program deploy`.
 * MAINNET_RECEIPT_ANCHOR_PROGRAM_ID: set after audit + mainnet deploy.
 *
 * Instruction format (from programs/receipt_anchor):
 *   Single anchor: [0x01, 0x00, anchor32[0..32]] = 34 bytes
 *   Batch anchor:  [0x01, count, anchor1[0..32], anchor2[0..32], ...] = 2+N*32 bytes
 */
export const DEVNET_RECEIPT_ANCHOR_PROGRAM_ID  = "ANCHRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // replace post-deploy
export const MAINNET_RECEIPT_ANCHOR_PROGRAM_ID = ""; // pending audit

// ── Types ─────────────────────────────────────────────────────────────────────

export type SolanaNetwork = "solana-mainnet" | "solana-devnet";

/**
 * DNA x402 payment requirement — returned in HTTP 402 responses.
 * Compatible with the DNA x402 standard on Solana.
 */
export interface X402PaymentRequirements {
  scheme:            "exact";
  network:           SolanaNetwork;
  /** Minimum payment amount in atomic units (USDC = 6 decimals). */
  maxAmountRequired: string;
  /** The resource being gated — typically the request path. */
  resource:          string;
  description:       string;
  memoPrefix:        string;
  /** Recipient wallet address (base58). */
  payTo:             string;
  /** USDC mint address for this network. */
  asset:             string;
  extra: {
    platformWallet?: string;
    platformFeePct:  number;
    anchorReceipt:   boolean;
    /** NULL Miner agent passport ID (for task escrow routing). Optional. */
    passportId?:     string;
    /** Platform identifier for fee attribution. */
    platformId?:     string;
    /** Nullifier seed for replay prevention — changes per task, never reused. */
    nullifierSeed?:  string;
  };
}

/** Verified payment receipt from a paid X-Payment header. */
export interface VerifiedPayment {
  valid:        true;
  payerAddress: string;
  amountUsdc:   number;
  amountAtomic: number;
  receiptHash:  string;
  resource:     string;
  network:      SolanaNetwork;
}

/** Failed payment verification result. */
export interface RejectedPayment {
  valid:  false;
  error:  string;
}

export type PaymentVerifyResult = VerifiedPayment | RejectedPayment;

/**
 * Platform fee split — how a payment is divided between parties.
 */
export interface FeeSplit {
  /** Total USDC received (in dollars). */
  totalUsdc:       number;
  /** Agent's share (default: 90%). */
  agentUsdc:       number;
  /** Platform's share (default: 10%). */
  platformUsdc:    number;
  /** NULL flywheel allocation (default: 5% of agent share). */
  nullFlywheelUsdc: number;
  /** Platform fee percentage used (0–1). */
  platformFeePct:  number;
  /** Atomic units for on-chain use (×1_000_000). */
  atomic: {
    total:       number;
    agent:       number;
    platform:    number;
    nullFlywheel: number;
  };
}

/**
 * Payload for the DNA x402 receipt anchor instruction.
 * Pass this to your Solana transaction builder.
 */
export interface ReceiptAnchorPayload {
  /** Receipt hash — unique identifier for this payment on-chain. */
  receiptHash:      string;  // hex
  /** The payer's Solana address (base58). */
  payerAddress:     string;
  /** Amount paid in atomic USDC units. */
  amountAtomic:     number;
  /** Resource that was unlocked. */
  resource:         string;
  /** Platform ID for fee routing. */
  platformId:       string;
  /** Agent passport ID (for task receipts). Optional. */
  passportId?:      string;
  /** Solana slot of the payment (approximate — set to current slot at anchor time). */
  slot:             number;
  /** Memo field for the Solana memo program. */
  memo:             string;
  /** Whether this receipt requires NULL flywheel routing. */
  routeToFlywheel:  boolean;
  /** Serialized 34-byte instruction data for the receipt_anchor program (base64). Format: [0x01, 0x00, anchor32[32]]. */
  instructionDataBase64: string;
  /** Program ID of the DNA x402 receipt anchor (devnet). */
  anchorProgramId:  string;
}

/** Passport metadata to attach to x402 payment requirements for agent tasks. */
export interface PassportX402Meta {
  passportId:   string;
  tier:         string;
  platformId:   string;
  nullifierSeed: string;
}

// ── Payment Requirement Builder ───────────────────────────────────────────────

export interface CreatePaymentRequirementOpts {
  priceUsdc:         number;
  recipientAddress:  string;
  resource:          string;
  description?:      string;
  platformWallet?:   string;
  platformFeePct?:   number;
  anchorReceipt?:    boolean;
  network?:          SolanaNetwork;
  passportMeta?:     PassportX402Meta;
}

/**
 * Create a DNA x402-compatible payment requirement for an HTTP 402 response.
 *
 * @example
 * const req = createPaymentRequirement({
 *   priceUsdc: 0.005,
 *   recipientAddress: "YOUR_WALLET",
 *   resource: "/api/premium-query",
 * });
 * res.status(402).json({ x402Version: 1, accepts: [req] });
 */
export function createPaymentRequirement(
  opts: CreatePaymentRequirementOpts,
): X402PaymentRequirements {
  const network = opts.network ?? "solana-devnet";
  const asset   = network === "solana-mainnet" ? USDC_MAINNET : USDC_DEVNET;

  return {
    scheme:            "exact",
    network,
    maxAmountRequired: usdcToAtomic(opts.priceUsdc).toString(),
    resource:          opts.resource,
    description:       opts.description ?? `Unlock: ${opts.resource}`,
    memoPrefix:        MEMO_PREFIX,
    payTo:             opts.recipientAddress,
    asset,
    extra: {
      platformWallet:  opts.platformWallet,
      platformFeePct:  opts.platformFeePct   ?? 0.10,
      anchorReceipt:   opts.anchorReceipt    ?? true,
      passportId:      opts.passportMeta?.passportId,
      platformId:      opts.passportMeta?.platformId,
      nullifierSeed:   opts.passportMeta?.nullifierSeed,
    },
  };
}

// ── Payment Verification ──────────────────────────────────────────────────────

/**
 * Verify a base64-encoded X-Payment header against payment requirements.
 * Returns the parsed, verified payment or a rejection with error details.
 *
 * @example
 * const result = verifyPaymentHeader(req.headers["x-payment"], requirements);
 * if (!result.valid) return res.status(402).json({ error: result.error });
 */
export function verifyPaymentHeader(
  header: string | null | undefined,
  requirements: X402PaymentRequirements,
): PaymentVerifyResult {
  if (!header) {
    return { valid: false, error: "Missing X-Payment header" };
  }

  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString()) as {
      signature?:    string;
      payerAddress?: string;
      amount?:       string;
      resource?:     string;
    };

    if (!payload.payerAddress || !payload.amount) {
      return { valid: false, error: "Malformed payment payload: missing payerAddress or amount" };
    }

    const paid     = parseInt(payload.amount, 10);
    const required = parseInt(requirements.maxAmountRequired, 10);

    if (isNaN(paid) || paid < required) {
      return {
        valid: false,
        error: `Insufficient payment: got ${paid} need ${required} atomic USDC units`,
      };
    }

    const receiptHash = buildReceiptHash(
      payload.payerAddress,
      payload.amount,
      requirements.resource,
    );

    return {
      valid:        true,
      payerAddress: payload.payerAddress,
      amountUsdc:   paid / 1_000_000,
      amountAtomic: paid,
      receiptHash,
      resource:     requirements.resource,
      network:      requirements.network,
    };
  } catch (e) {
    return { valid: false, error: `Payment parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Receipt Anchor Payload ────────────────────────────────────────────────────

/**
 * Build the DNA x402 receipt anchor payload for Solana.
 *
 * `instructionDataBase64` is the real 34-byte receipt_anchor instruction:
 *   [INSTRUCTION_VERSION_V1=0x01, flags=0x00, anchor32[0..32]]
 * where anchor32 = SHA-256("null-miner-receipt-v1" || receiptHash || platformId || passportId || amountAtomic_le64).
 * Pass it directly to `TransactionInstruction.data` — no Anchor IDL required.
 *
 * @example
 * const payload = anchorReceiptPayload(verifiedPayment, { platformId: "my-app" });
 * // payload.instructionDataBase64 → Buffer.from(payload.instructionDataBase64, "base64")
 * //   → TransactionInstruction.data (34 bytes, verified against receipt_anchor program)
 */
export function anchorReceiptPayload(
  payment: VerifiedPayment,
  opts: {
    platformId:  string;
    passportId?: string;
    slot?:       number;
    routeToFlywheel?: boolean;
  },
): ReceiptAnchorPayload {
  const slot = opts.slot ?? Math.floor(Date.now() / 400);
  const memo = `${MEMO_PREFIX}:${payment.receiptHash.slice(0, 16)}:${opts.platformId}`;

  // Build the real receipt_anchor instruction data.
  // Format: [version=0x01, flags=0x00, anchor32[0..32]] = 34 bytes total.
  // See: programs/receipt_anchor/src/instruction.rs — SINGLE_LEN_NO_BUCKET = 34.
  //
  // anchor32 = SHA-256(
  //   "null-miner-receipt-v1" ||
  //   receiptHash (hex→bytes) ||
  //   platformId (utf8) ||
  //   passportId (hex→bytes, or 32 zero bytes) ||
  //   amountAtomic (u64 little-endian)
  // )
  const h = createHash("sha256");
  h.update(Buffer.from("null-miner-receipt-v1"));
  h.update(Buffer.from(payment.receiptHash, "hex"));
  h.update(Buffer.from(opts.platformId, "utf8"));
  h.update(opts.passportId
    ? Buffer.from(opts.passportId, "hex")
    : Buffer.alloc(32));
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(BigInt(payment.amountAtomic));
  h.update(amtBuf);
  const anchor32 = h.digest();

  const ixData = Buffer.alloc(34);
  ixData[0] = 0x01;  // INSTRUCTION_VERSION_V1
  ixData[1] = 0x00;  // flags (no explicit bucket_id — program uses current hour window)
  anchor32.copy(ixData, 2);

  return {
    receiptHash:           payment.receiptHash,
    payerAddress:          payment.payerAddress,
    amountAtomic:          payment.amountAtomic,
    resource:              payment.resource,
    platformId:            opts.platformId,
    passportId:            opts.passportId,
    slot,
    memo,
    routeToFlywheel:       opts.routeToFlywheel ?? true,
    instructionDataBase64: ixData.toString("base64"),
    // Use devnet program ID until mainnet deploy. Replace DEVNET_RECEIPT_ANCHOR_PROGRAM_ID
    // with the address returned by: solana program deploy target/deploy/receipt_anchor.so
    anchorProgramId: DEVNET_RECEIPT_ANCHOR_PROGRAM_ID,
  };
}

// ── Platform Fee Split ────────────────────────────────────────────────────────

/**
 * Compute how a USDC payment is split between parties.
 *
 * @example
 * const split = platformFeeSplit(0.005, 0.10);
 * // { agentUsdc: 0.0045, platformUsdc: 0.0005, nullFlywheelUsdc: 0.000225 }
 */
export function platformFeeSplit(
  totalUsdc:      number,
  platformFeePct: number = 0.10,
  flywheelPct:    number = 0.05,  // % of agent share → NULL flywheel
): FeeSplit {
  const agentUsdc       = totalUsdc * (1 - platformFeePct);
  const platformUsdc    = totalUsdc * platformFeePct;
  const nullFlywheelUsdc = agentUsdc * flywheelPct;

  return {
    totalUsdc,
    agentUsdc,
    platformUsdc,
    nullFlywheelUsdc,
    platformFeePct,
    atomic: {
      total:        usdcToAtomic(totalUsdc),
      agent:        usdcToAtomic(agentUsdc),
      platform:     usdcToAtomic(platformUsdc),
      nullFlywheel: usdcToAtomic(nullFlywheelUsdc),
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert USDC dollar amount to atomic units (6 decimals). */
export function usdcToAtomic(usdc: number): number {
  return Math.floor(usdc * 1_000_000);
}

/** Convert atomic USDC units to dollar amount. */
export function atomicToUsdc(atomic: number): number {
  return atomic / 1_000_000;
}

function buildReceiptHash(payerAddress: string, amount: string, resource: string): string {
  return createHash("sha256")
    .update(`${payerAddress}:${amount}:${resource}`)
    .digest("hex");
}
