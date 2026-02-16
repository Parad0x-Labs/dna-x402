import { PricingModel, SettlementMode } from "../types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type VerificationTier = "FAST" | "VERIFIED";
export type Badge =
  | "FAST_P95_<800MS"
  | "FULFILLMENT_99"
  | "LOW_REFUND"
  | "STREAM_READY"
  | "PROOF_ANCHORED"
  | "TOP_SELLER_24H";

export interface EndpointSla {
  maxLatencyMs: number;
  availabilityTarget: number;
}

export interface ShopEndpoint {
  endpointId: string;
  method: HttpMethod;
  path: string;
  capabilityTags: string[];
  description: string;
  pricingModel: PricingModel;
  settlementModes: SettlementMode[];
  sla: EndpointSla;
  icon?: string;
  examples?: string[];
  requestSchema?: unknown;
  responseSchema?: unknown;
  pricingParams?: Record<string, string | number | boolean>;
  limits?: Record<string, string | number | boolean>;
  proofPolicy?: Record<string, string | number | boolean>;
}

export interface ShopManifest {
  manifestVersion: "market-v1";
  shopId: string;
  name: string;
  description?: string;
  category?: string;
  ownerPubkey: string;
  endpoints: ShopEndpoint[];
}

export interface SignedShopManifest {
  manifest: ShopManifest;
  manifestHash: string;
  signature: string;
  publishedAt: string;
}

export interface MarketSearchQuery {
  capability?: string;
  maxPriceAtomic?: string;
  maxLatencyMs?: number;
}

export interface QuoteConstraints extends MarketSearchQuery {
  limit?: number;
  mint?: string;
}

export interface ShopHeartbeat {
  shopId: string;
  inflight: number;
  queueDepth: number;
  p95LatencyMs: number;
  errorRate: number;
  updatedAt: string;
  load: number;
}

export interface MarketQuote {
  quoteId: string;
  shopId: string;
  endpointId: string;
  method: HttpMethod;
  path: string;
  capabilityTags: string[];
  price: string;
  mint: string;
  expiresAt: string;
  expectedLatencyMs: number;
  load: number;
  reputation: number;
  badges?: Badge[];
  settlementModes: SettlementMode[];
  signature: string;
  rankScore: number;
}

export type OrderStatus = "pending" | "executed" | "cancelled" | "expired";

export interface MarketOrderInput {
  capability: string;
  maxPrice: string;
  maxLatencyMs?: number;
  expiresAt: string;
  preferSettlement?: SettlementMode;
  callbackUrl?: string;
}

export interface MarketOrder extends MarketOrderInput {
  orderId: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  chosenQuote?: MarketQuote;
}

export type MarketEventType =
  | "QUOTE_ISSUED"
  | "PAYMENT_VERIFIED"
  | "REQUEST_FULFILLED"
  | "REQUEST_FAILED"
  | "REFUND_ISSUED"
  | "BUNDLE_RUN"
  | "BUNDLE_STEP_EXECUTED";

export interface MarketEvent {
  type: MarketEventType;
  ts: string;
  shopId: string;
  endpointId: string;
  ownerPubkey?: string;
  bundleId?: string;
  capabilityTags: string[];
  priceAmount: string;
  upstreamCostAmount?: string;
  netRevenueAmount?: string;
  mint: string;
  settlementMode?: SettlementMode;
  latencyMs?: number;
  statusCode?: number;
  receiptId?: string;
  anchor32?: string;
  anchored?: boolean;
  receiptValid?: boolean;
  verificationTier?: VerificationTier;
}

export interface MarketWindowQuery {
  windowMs: number;
}

export interface RankedMetric {
  key: string;
  value: number;
  verificationTier?: VerificationTier;
  meta?: Record<string, unknown>;
}

export interface BundleStep {
  capability: string;
  constraints?: {
    maxPriceAtomic?: string;
    maxLatencyMs?: number;
  };
  policyOverrides?: {
    prefer?: Array<"on_sale" | "trending" | "high_reputation" | "lowest_price">;
    preferSettlement?: SettlementMode;
  };
}

export type BundlePriceModel =
  | {
    kind: "flat";
    amountAtomic: string;
  }
  | {
    kind: "metered";
    amountPerRunAtomic: string;
  };

export type MarginPolicy =
  | {
    kind: "percent";
    value: number;
  }
  | {
    kind: "fixed_atomic";
    value: string;
  };

export interface BundleManifest {
  bundleId: string;
  ownerPubkey: string;
  name: string;
  description?: string;
  steps: BundleStep[];
  bundlePriceModel: BundlePriceModel;
  marginPolicy: MarginPolicy;
  examples?: string[];
}

export interface SignedBundleManifest {
  manifest: BundleManifest;
  manifestHash: string;
  signature: string;
  publishedAt: string;
}

export interface BundleRunResult {
  bundleId: string;
  executionId: string;
  output: Record<string, unknown>;
  bundleReceiptId: string;
  upstreamReceipts: Array<{
    stepIndex: number;
    quoteId?: string;
    shopId?: string;
    endpointId?: string;
    receiptId?: string;
    amountAtomic?: string;
  }>;
  grossAmountAtomic: string;
  upstreamCostAtomic: string;
  netMarginAtomic: string;
}
