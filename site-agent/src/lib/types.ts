export type ClusterLabel = "devnet" | "mainnet-beta" | "localnet";

export interface RuntimeConfig {
  x402BaseUrl: string;
  walletUrl: string;
  cluster: ClusterLabel;
  pollIntervalMs: number;
}

export interface HealthResponse {
  ok: boolean;
  cluster?: string;
  build?: {
    version?: string | null;
    commit?: string | null;
  };
  feePolicy?: {
    baseFeeAtomic?: string;
    feeBps?: number;
    minFeeAtomic?: string;
    accrueThresholdAtomic?: string;
    minSettleAtomic?: string;
  };
  pauseFlags?: {
    market?: boolean;
    orders?: boolean;
    finalize?: boolean;
  };
  programs?: {
    paymentProgramId?: string | null;
    receiptAnchorProgramId?: string | null;
  };
  market?: {
    registeredShops?: number;
    disabledShops?: string[];
    eventsIndexed?: number;
    paused?: boolean;
    ordersPaused?: boolean;
  };
  anchoring?: {
    enabled?: boolean;
    programId?: string | null;
    altAddress?: string | null;
    pending?: number;
    anchored?: number;
    recentSignatures?: string[];
  };
}

export interface RankedMetric {
  key: string;
  value: number;
  verificationTier?: "FAST" | "VERIFIED";
  meta?: Record<string, unknown>;
}

export interface MarketSnapshotResponse {
  fastCount24h?: number;
  verifiedCount24h?: number;
  topCapabilitiesByDemandVelocity: RankedMetric[];
  medianPriceByCapability: Record<string, string>;
  sellerDensityByCapability: Record<string, number>;
  volatilityScoreByCapability: Record<string, number>;
  recommendedProviders: Array<{
    capability: string;
    quotes: Array<{
      quoteId: string;
      shopId: string;
      endpointId: string;
      price: string;
      mint: string;
      expectedLatencyMs: number;
      reputation: number;
      settlementModes: Array<"transfer" | "stream" | "netting">;
      expiresAt: string;
      signature: string;
      rankScore: number;
      trust?: {
        score: number;
        report_count: number;
        warning: boolean;
      };
      seller_defined?: boolean;
      verifiable?: {
        receipt: boolean;
        anchored: boolean;
      };
    }>;
  }>;
}

export interface MarketMetricsResponse {
  window: string;
  verificationTier?: "FAST" | "VERIFIED";
  results: RankedMetric[];
}

export interface AnchoringStatusResponse {
  enabled: boolean;
  queueDepth: number;
  anchoredCount: number;
  lastFlushAt: string | null;
  lastAnchorSig: string | null;
  lastBucketId: string | null;
  lastBucketCount: number | null;
}

export interface DemoPingResponse {
  ok: boolean;
  serverTime: string;
  requestId: string;
}

export type SettlementMode = "transfer" | "stream" | "netting";

export interface QuoteResponse {
  amount: string;
  mint: string;
  recipient: string;
  expiresAt: string;
  settlement: SettlementMode[];
  memoHash: string;
  quoteId: string;
  feeAtomic: string;
  totalAtomic: string;
}

export interface PaymentAccept {
  scheme: string;
  network: string;
  mint: string;
  maxAmount: string;
  recipient: string;
  mode: SettlementMode;
}

export interface PaymentRequirements {
  version: string;
  quote: QuoteResponse;
  accepts: PaymentAccept[];
  recommendedMode: SettlementMode;
  commitEndpoint: string;
  finalizeEndpoint: string;
  receiptEndpoint: string;
}

export interface ResourceResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface CommitResponse {
  commitId: string;
}

export interface FinalizeResponse {
  ok: boolean;
  receiptId: string;
  accessTokenOrResult?: Record<string, unknown>;
}

export interface SignedReceipt {
  payload: {
    receiptId: string;
    quoteId: string;
    commitId: string;
    resource: string;
    payerCommitment32B: string;
    recipient: string;
    mint: string;
    amountAtomic: string;
    feeAtomic: string;
    totalAtomic: string;
    settlement: SettlementMode;
    settledOnchain: boolean;
    txSignature?: string;
    streamId?: string;
    createdAt: string;
  };
  prevHash: string;
  receiptHash: string;
  signerPublicKey: string;
  signature: string;
}

export interface AnchoredReceiptResponse {
  ok: boolean;
  anchored: {
    receiptId: string;
    signature: string;
    bucketId: string;
    bucketPda: string;
    anchoredAt: string;
  };
}

export type LogChannel = "health" | "market" | "anchoring" | "demo";

export interface ControlLog {
  id: string;
  ts: string;
  channel: LogChannel;
  message: string;
  data?: unknown;
}

export type DemoStepState = "pending" | "running" | "success" | "error" | "skipped";

export interface DemoTimelineStep {
  id: string;
  title: string;
  state: DemoStepState;
  detail?: string;
  payload?: unknown;
}
