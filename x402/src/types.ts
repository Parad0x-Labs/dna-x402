export type AtomicAmount = string;

export type SettlementMode = "transfer" | "stream" | "netting";

export type PricingModelKind = "flat" | "metered" | "surge" | "stream" | "netting";

export interface FlatPricingModel {
  kind: "flat";
  amountAtomic: AtomicAmount;
}

export interface MeteredPricingModel {
  kind: "metered";
  unitName: string;
  amountPerUnitAtomic: AtomicAmount;
  minUnits?: number;
}

export interface SurgePricingModel {
  kind: "surge";
  baseAmountAtomic: AtomicAmount;
  minMultiplier: number;
  maxMultiplier: number;
}

export interface StreamPricingModel {
  kind: "stream";
  rateAtomicPerSecond: AtomicAmount;
  minTopupAtomic?: AtomicAmount;
}

export interface NettingPricingModel {
  kind: "netting";
  unitAmountAtomic: AtomicAmount;
  settlementThresholdAtomic: AtomicAmount;
}

export type PricingModel =
  | FlatPricingModel
  | MeteredPricingModel
  | SurgePricingModel
  | StreamPricingModel
  | NettingPricingModel;

export interface Tool {
  toolId: string;
  endpointId: string;
  shopId?: string;
  name: string;
  capabilityTags: string[];
  description: string;
  pricingModel: PricingModel;
  typicalUnitsPerCall?: number;
  latencyMs?: number;
}

export interface Quote {
  quoteId: string;
  resource: string;
  amountAtomic: AtomicAmount;
  feeAtomic: AtomicAmount;
  totalAtomic: AtomicAmount;
  mint: string;
  recipient: string;
  expiresAt: string;
  settlement: SettlementMode[];
  memoHash: string;
}

export interface CompetitiveQuote {
  quoteId: string;
  shopId: string;
  endpointId: string;
  capabilityTags: string[];
  priceAtomic: AtomicAmount;
  mint: string;
  recipient: string;
  settlementModes: SettlementMode[];
  expectedLatencyMs: number;
  reputationScore: number;
  loadFactor: number;
  expiresAt: string;
  quoteSig: string;
}

export interface TransferPaymentProof {
  settlement: "transfer";
  txSignature: string;
  amountAtomic?: AtomicAmount;
}

export interface StreamPaymentProof {
  settlement: "stream";
  streamId: string;
  topupSignature?: string;
  amountAtomic?: AtomicAmount;
}

export interface NettingPaymentProof {
  settlement: "netting";
  amountAtomic?: AtomicAmount;
  note?: string;
}

export type PaymentProof = TransferPaymentProof | StreamPaymentProof | NettingPaymentProof;

export interface CommitRecord {
  commitId: string;
  quoteId: string;
  payerCommitment32B: string;
  createdAt: string;
  status: "pending" | "finalized" | "failed";
  settlementMode?: SettlementMode;
  receiptId?: string;
}

export interface ReceiptPayload {
  receiptId: string;
  quoteId: string;
  commitId: string;
  resource: string;
  requestId: string;
  requestDigest: string;
  responseDigest: string;
  shopId: string;
  payerCommitment32B: string;
  recipient: string;
  mint: string;
  amountAtomic: AtomicAmount;
  feeAtomic: AtomicAmount;
  totalAtomic: AtomicAmount;
  settlement: SettlementMode;
  settledOnchain: boolean;
  txSignature?: string;
  streamId?: string;
  createdAt: string;
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  prevHash: string;
  receiptHash: string;
  signerPublicKey: string;
  signature: string;
}

export interface QuoteResponse {
  amount: AtomicAmount;
  mint: string;
  recipient: string;
  expiresAt: string;
  settlement: SettlementMode[];
  memoHash: string;
  quoteId: string;
  feeAtomic: AtomicAmount;
  totalAtomic: AtomicAmount;
}

export interface PaymentAccept {
  scheme: "solana-spl";
  network: "solana-devnet" | "solana-mainnet";
  mint: string;
  maxAmount: AtomicAmount;
  recipient: string;
  mode: SettlementMode;
}

export interface PaymentRequirements {
  version: "x402-dnp-v1";
  quote: QuoteResponse;
  accepts: PaymentAccept[];
  recommendedMode: SettlementMode;
  commitEndpoint: string;
  finalizeEndpoint: string;
  receiptEndpoint: string;
}

export interface VerificationResult {
  ok: boolean;
  settledOnchain: boolean;
  txSignature?: string;
  streamId?: string;
  error?: string;
  errorCode?:
    | "INVALID_PROOF"
    | "NOT_CONFIRMED_YET"
    | "RPC_UNAVAILABLE"
    | "PAYMENT_INVALID"
    | "UNDERPAY"
    | "WRONG_MINT"
    | "WRONG_RECIPIENT"
    | "TOO_OLD";
  retryable?: boolean;
  details?: Record<string, unknown>;
}
