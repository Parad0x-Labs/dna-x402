/**
 * DNA Payment Rail - Agent SDK
 *
 * One-import integration for any AI agent to plug into DNA payments.
 *
 * Quick start:
 *   import { fetchWith402, marketCall, dnaPaywall } from "dna-x402";
 *
 * Agent (buyer) side:
 *   const result = await fetchWith402("https://provider.example/api/inference", {
 *     wallet: myAgentWallet,
 *     maxSpendAtomic: "50000",
 *   });
 *
 * Provider (seller) side:
 *   import express from "express";
 *   const app = express();
 *   app.use("/api", dnaPaywall({ priceAtomic: "5000", recipient: "YOUR_WALLET" }));
 *   app.get("/api/inference", (req, res) => res.json({ result: "..." }));
 */

export {
  fetchWith402,
  marketCall,
  InMemoryReceiptStore,
  InMemorySpendTracker,
} from "../client.js";

export type {
  AgentWallet,
  ReceiptStore,
  SpendTracker,
  FetchWith402Options,
  FetchWith402Result,
  MarketCallOptions,
  MarketCallResult,
} from "../client.js";

export { dnaPaywall, apiKeyGuard } from "./paywall.js";
export type { PaywallOptions } from "./paywall.js";

export { dnaSeller, dnaPrice } from "./seller.js";
export type { DnaSellerOptions } from "./seller.js";

export {
  createDnaGuard,
  DnaGuardLedger,
  createFileBackedDnaGuardLedger,
  loadDnaGuardSnapshot,
  persistDnaGuardSnapshot,
} from "./guard.js";
export type {
  DnaGuardActor,
  DnaGuardSpendCeilings,
  DnaGuardSpendDecision,
  DnaGuardProviderSnapshot,
  DnaGuardReceiptStatus,
  DnaGuardFailMode,
  DnaGuardValidationResult,
  DnaGuardBestQuoteResult,
  DnaGuardController,
  DnaGuardControllerOptions,
  DnaGuardMiddlewareOptions,
  DnaGuardFileStoreOptions,
} from "./guard.js";

export { WebhookService } from "./webhook.js";
export type { WebhookPayload, WebhookDeliveryResult, WebhookServiceOptions } from "./webhook.js";

export { AuditLogger } from "../logging/audit.js";
export type { AuditEntry, AuditEventKind, AuditLoggerOptions } from "../logging/audit.js";

export type {
  Quote,
  QuoteResponse,
  PaymentProof,
  PaymentRequirements,
  SignedReceipt,
  ReceiptPayload,
  SettlementMode,
  PricingModel,
  PaymentAccept,
} from "../types.js";

export type { MarketPolicy } from "../market/policy.js";
export type { MarketQuote, MarketOrder, ShopEndpoint } from "../market/types.js";

export { LiquefyVaultExporter } from "../bridge/liquefy/exporter.js";
export { LiquefySidecar } from "../bridge/liquefy/sidecar.js";
export {
  auditEntryToTelemetry,
  receiptToProofArtifact,
  buildRunManifest,
} from "../bridge/liquefy/adapter.js";
export type {
  LiquefyTelemetryRecord,
  LiquefyProofArtifact,
  LiquefyRunManifest,
} from "../bridge/liquefy/adapter.js";
