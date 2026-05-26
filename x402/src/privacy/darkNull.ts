import crypto from "node:crypto";
import type { SignedReceipt } from "../types.js";
import { stableHash, stableStringify } from "../common/stable.js";

export const DARK_NULL_PRIVACY_REQUEST_SCHEMA = "dna-x402-dark-null-privacy-request-v1" as const;
export const DARK_NULL_PRIVACY_RESPONSE_SCHEMA = "dna-x402-dark-null-privacy-response-v1" as const;

export type DnaX402SettlementPath = "normal" | "dark-null";
export type DarkNullCluster = "devnet" | "mainnet-beta";

export interface DarkNullPrivacyTarget {
  cluster: DarkNullCluster;
  programId: string;
  manifestLabel: string;
  manifestSha256?: string;
  proofEncodingHash?: string;
}

export interface CreateDarkNullPrivacyRequestInput {
  signedReceipt: SignedReceipt;
  target: DarkNullPrivacyTarget;
  settlementSlot: number;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  previousDarkNullReceiptHash?: string | null;
  sourceCommit?: string;
  createdAt?: string;
}

export interface DarkNullPrivacyRequest {
  schema: typeof DARK_NULL_PRIVACY_REQUEST_SCHEMA;
  settlementPath: "dark-null";
  normalPath: "dna-x402";
  createdAt: string;
  dna: {
    receiptId: string;
    quoteId: string;
    commitId: string;
    receiptHash: string;
    receiptPayloadHash: string;
    receiptSignatureHash: string;
    signerPublicKey: string;
    requestDigest: string;
    responseDigest: string;
    resourceHash: string;
    amountAtomic: string;
    recipientHash: string;
    mintHash: string;
    settlement: string;
    txSignature: string;
  };
  darkNull: DarkNullPrivacyTarget & {
    previousReceiptHash: string | null;
  };
  privacy: {
    rawResourceStored: false;
    rawRecipientStored: false;
    rawMintStored: false;
    rawPaymentHeaderStored: false;
    rawBuyerMetadataStored: false;
  };
  sourceCommit?: string;
  requestHash: string;
}

export interface DarkNullPrivacyRequestVerification {
  ok: boolean;
  failures: string[];
  expectedRequestHash: string;
  requestHash: string | null;
}

const HASH_RE = /^[0-9a-f]{64}$/;

function sha256Hex(value: unknown): string {
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(stableStringify(value), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertHash(value: string | undefined, label: string): void {
  if (!value || !HASH_RE.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 hex digest`);
  }
}

function withoutRequestHash(request: DarkNullPrivacyRequest): Omit<DarkNullPrivacyRequest, "requestHash"> {
  const { requestHash: _requestHash, ...body } = request;
  return body;
}

export function resolveDnaX402SettlementPath(path: DnaX402SettlementPath = "normal"): DnaX402SettlementPath {
  if (path !== "normal" && path !== "dark-null") {
    throw new Error("settlement path must be normal or dark-null");
  }
  return path;
}

export function createDarkNullPrivacyRequest(input: CreateDarkNullPrivacyRequestInput): DarkNullPrivacyRequest {
  const receipt = input.signedReceipt;
  if (!receipt?.payload) {
    throw new Error("signedReceipt is required");
  }
  assertHash(receipt.receiptHash, "signedReceipt.receiptHash");
  assertHash(receipt.payload.requestDigest, "signedReceipt.payload.requestDigest");
  assertHash(receipt.payload.responseDigest, "signedReceipt.payload.responseDigest");
  if (!receipt.payload.txSignature) {
    throw new Error("dark-null privacy path requires canonical transfer txSignature on the DNA receipt");
  }
  if (!Number.isSafeInteger(input.settlementSlot) || input.settlementSlot <= 0) {
    throw new Error("dark-null privacy path requires a positive Solana settlement slot");
  }

  const base = {
    schema: DARK_NULL_PRIVACY_REQUEST_SCHEMA,
    settlementPath: "dark-null" as const,
    normalPath: "dna-x402" as const,
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    dna: {
      receiptId: receipt.payload.receiptId,
      quoteId: receipt.payload.quoteId,
      commitId: receipt.payload.commitId,
      receiptHash: receipt.receiptHash,
      receiptPayloadHash: stableHash(receipt.payload),
      receiptSignatureHash: sha256Hex(receipt.signature),
      signerPublicKey: receipt.signerPublicKey,
      requestDigest: receipt.payload.requestDigest,
      responseDigest: receipt.payload.responseDigest,
      resourceHash: sha256Hex(receipt.payload.resource),
      amountAtomic: receipt.payload.totalAtomic,
      recipientHash: sha256Hex(receipt.payload.recipient),
      mintHash: sha256Hex(receipt.payload.mint),
      settlement: receipt.payload.settlement,
      txSignature: receipt.payload.txSignature,
    },
    darkNull: {
      ...input.target,
      previousReceiptHash: input.previousDarkNullReceiptHash ?? null,
    },
    privacy: {
      rawResourceStored: false as const,
      rawRecipientStored: false as const,
      rawMintStored: false as const,
      rawPaymentHeaderStored: false as const,
      rawBuyerMetadataStored: false as const,
    },
    sourceCommit: input.sourceCommit,
  };

  return {
    ...base,
    requestHash: stableHash(base),
  };
}

export function verifyDarkNullPrivacyRequest(request: DarkNullPrivacyRequest): DarkNullPrivacyRequestVerification {
  const failures: string[] = [];
  const expectedRequestHash = stableHash(withoutRequestHash(request));

  if (request.schema !== DARK_NULL_PRIVACY_REQUEST_SCHEMA) failures.push("invalid dark null privacy request schema");
  if (request.settlementPath !== "dark-null") failures.push("settlementPath must be dark-null");
  if (request.normalPath !== "dna-x402") failures.push("normalPath must remain dna-x402");
  if (request.requestHash !== expectedRequestHash) failures.push("requestHash mismatch");
  if (request.privacy?.rawResourceStored !== false) failures.push("raw resource must not be stored");
  if (request.privacy?.rawPaymentHeaderStored !== false) failures.push("raw payment headers must not be stored");
  for (const [label, value] of [
    ["dna.receiptHash", request.dna?.receiptHash],
    ["dna.receiptPayloadHash", request.dna?.receiptPayloadHash],
    ["dna.receiptSignatureHash", request.dna?.receiptSignatureHash],
    ["dna.requestDigest", request.dna?.requestDigest],
    ["dna.responseDigest", request.dna?.responseDigest],
    ["dna.resourceHash", request.dna?.resourceHash],
    ["dna.recipientHash", request.dna?.recipientHash],
    ["dna.mintHash", request.dna?.mintHash],
  ] as const) {
    if (typeof value !== "string" || !HASH_RE.test(value)) failures.push(`${label} must be a sha256 hex digest`);
  }

  return {
    ok: failures.length === 0,
    failures,
    expectedRequestHash,
    requestHash: request?.requestHash ?? null,
  };
}
