import { Request } from "express";
import { SettlementMode } from "../../../../src/types.js";

export type PrimitiveId =
  | "fixed_price_tool"
  | "usage_metered_tool"
  | "surge_priced_tool"
  | "english_auction"
  | "dutch_auction"
  | "sealed_bid_commit_reveal"
  | "prediction_market_binary"
  | "reverse_auction"
  | "subscription_stream_gate"
  | "bundle_reseller_margin";

export interface PrimitiveQuoteView {
  amountAtomic: string;
  settlementModes: SettlementMode[];
  recommendedMode: SettlementMode;
  pricingLabel: string;
}

export interface PrimitiveExecutionResult {
  output: Record<string, unknown>;
  note: string;
}

export interface PrimitiveDefinition<TState = Record<string, unknown>> {
  id: PrimitiveId;
  title: string;
  category: string;
  description: string;
  capabilityTags: string[];
  resourcePath: string;
  createState: (nowMs: number) => TState;
  quoteForRequest: (state: TState, req: Request, nowMs: number) => PrimitiveQuoteView;
  executePaidRequest: (state: TState, req: Request, nowMs: number) => PrimitiveExecutionResult;
}

