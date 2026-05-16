import { stableHash } from "../common/stable.js";
import { assertImmutableRecordSafe } from "../privacy/immutableGuard.js";

export type AnchorStatus = "LOCAL_ONLY" | "ANCHOR_PENDING" | "ANCHORED" | "ANCHOR_FAILED" | "ANCHOR_NOT_CONFIGURED";

export interface ReceiptV1 {
  receiptVersion: "receipt-v1";
  quoteId: string;
  commitId: string;
  payer: string;
  seller: string;
  listingManifestHash: string;
  requestDigest: string;
  responseDigest: string;
  paymentProofDigest: string;
  settlementOptionHash: string;
  feeWaterfallHash: string;
  policyDecisionHash: string;
  fulfillmentStatus: "PENDING" | "FULFILLED" | "FAILED" | "REFUNDED";
  timestamp: string;
  previousReceiptHash?: string;
  signature?: string;
  anchorStatus: AnchorStatus;
}

export function hashReceiptV1(receipt: ReceiptV1): string {
  assertImmutableRecordSafe("RECEIPT", receipt);
  return stableHash(receipt);
}

export function verifyReceiptV1(receipt: ReceiptV1, expected: {
  responseDigest?: string;
  feeWaterfallHash?: string;
  policyDecisionHash?: string;
}): boolean {
  if (expected.responseDigest && expected.responseDigest !== receipt.responseDigest) {
    return false;
  }
  if (expected.feeWaterfallHash && expected.feeWaterfallHash !== receipt.feeWaterfallHash) {
    return false;
  }
  if (expected.policyDecisionHash && expected.policyDecisionHash !== receipt.policyDecisionHash) {
    return false;
  }
  hashReceiptV1(receipt);
  return true;
}
