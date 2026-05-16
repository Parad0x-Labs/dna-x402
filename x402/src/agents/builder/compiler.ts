import crypto from "node:crypto";
import { stableHash } from "../../common/stable.js";
import { DurableRepository } from "../../db/schema/tables.js";
import { assertNoBackendPrivateKeyPayload } from "../trading.js";

export type AgentBuilderInputMode = "PROMPT" | "GUIDED" | "TEMPLATE" | "CLONE";

export type AgentType =
  | "PAPER_AGENT"
  | "POLYMARKET_SIGNAL_AGENT"
  | "POLYMARKET_COPY_AGENT"
  | "SOLANA_TOKEN_SIGNAL_AGENT"
  | "SOLANA_TOKEN_COPY_AGENT"
  | "PAID_API_AGENT"
  | "DATA_FEED_AGENT"
  | "BUILDER_TOOL_AGENT"
  | "ALPHA_PROFILE_AGENT";

export interface AgentBuilderRequest {
  inputMode: AgentBuilderInputMode;
  prompt?: string;
  templateId?: string;
  cloneFromAgentId?: string;
  guidedAnswers?: Record<string, unknown>;
  ownerWallet: string;
}

export type AgentBuilderReasonCode =
  | "AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN"
  | "AGENT_BUILDER_BACKEND_SIGNING_FORBIDDEN"
  | "AGENT_BUILDER_BACKEND_CUSTODY_FORBIDDEN"
  | "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE"
  | "AGENT_BUILDER_POLYMARKET_LIVE_OUT_OF_SCOPE"
  | "AGENT_BUILDER_SOLANA_AUTONOMOUS_OUT_OF_SCOPE"
  | "AGENT_BUILDER_HIGH_RISK_CATEGORY_OUT_OF_SCOPE"
  | "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN"
  | "AGENT_BUILDER_INVALID_ALPHA_FEE"
  | "AGENT_BUILDER_MISSING_RISK_LIMITS"
  | "AGENT_BUILDER_REVIEW_REQUIRED"
  | "AGENT_BUILDER_DRAFT_CONFIRMED"
  | "AGENT_BUILDER_TEMPLATE_NOT_FOUND"
  | "AGENT_BUILDER_RECIPE_NOT_FOUND"
  | "AGENT_BUILDER_OWNER_MISMATCH"
  | "AGENT_BUILDER_RISK_ACK_REQUIRED"
  | "AGENT_BUILDER_REJECTED_DRAFT";

export interface AgentBuilderResult {
  status: "DRAFT_CREATED" | "REJECTED" | "REVIEW_REQUIRED";
  draftId?: string;
  agentConfig?: AgentConfigDraft;
  riskSummary?: AgentRiskSummary;
  reasonCodes: AgentBuilderReasonCode[];
  explanation: string[];
  safeAlternative?: string;
}

export interface AgentConfigDraft {
  draftId: string;
  ownerWallet: string;
  agentType: AgentType;
  displayName: string;
  slug: string;
  mode: "PAPER" | "SIGNAL_ONLY" | "USER_CONFIRMED_LIVE" | "AUTO_COPY_PUBLIC_BETA";
  walletMode: "NONE_REQUIRED" | "CLIENT_SIDE_USER_OWNED" | "EXTERNAL_WALLET";
  backendCustody: false;
  backendSigning: false;
  marketScope?: {
    venue?: "POLYMARKET" | "SOLANA" | "DNA_X402" | "OTHER";
    categories?: string[];
    allowedMarketIds?: string[];
    blockedMarketIds?: string[];
    tokenMints?: string[];
    marketFilters?: string[];
  };
  copySettings?: {
    copyBuys: boolean;
    copySells: boolean;
    copyExits: boolean;
    minEntryPriceBps?: number;
    maxEntryPriceBps?: number;
    maxBetSizeAtomic?: string;
    maxDailySpendAtomic?: string;
    maxDailyLossAtomic?: string;
    maxOpenExposureAtomic?: string;
    customTakeProfitBps?: number;
    customStopLossBps?: number;
    requireApprovalAlways: boolean;
    requireApprovalAboveAtomic?: string;
  };
  monetization?: {
    enabled: boolean;
    successFeeBps?: 50 | 100 | 150 | 200 | 250 | 300;
    appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL";
    mode: "DISPLAY_ONLY" | "ACCRUAL" | "DIRECT_SPLIT_GATED";
  };
  visibility: "PRIVATE" | "PUBLIC";
  createdAt: string;
  updatedAt: string;
}

export interface AgentRiskSummary {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "OUT_OF_SCOPE";
  realFundsAtRisk: boolean;
  requiresClientSignature: boolean;
  backendCustody: false;
  backendSigning: false;
  maxBetSizeAtomic?: string;
  maxDailySpendAtomic?: string;
  maxDailyLossAtomic?: string;
  maxOpenExposureAtomic?: string;
  warnings: string[];
  requiredConfirmations: string[];
}

export interface GuidedBuilderNode {
  nodeId: string;
  question: string;
  options: Array<{
    label: string;
    value: string;
    nextNodeId?: string;
    patch?: Partial<AgentConfigDraft>;
  }>;
}

export interface AgentRecipe {
  recipeId: string;
  ownerAgentId?: string;
  source: AgentBuilderInputMode;
  title: string;
  description: string;
  prompt?: string;
  config: AgentConfigDraft;
  riskSummary: AgentRiskSummary;
  visibility: "PRIVATE" | "PUBLIC" | "CLONEABLE";
  version: number;
  createdAt: string;
}

export interface AgentBuilderDraftRecord {
  draftId: string;
  status: "DRAFT" | "REJECTED" | "REVIEW_REQUIRED" | "CONFIRMED";
  source: AgentBuilderInputMode;
  ownerWallet: string;
  request: AgentBuilderRequest;
  result: AgentBuilderResult;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBuilderEvent {
  eventId: string;
  kind:
    | "AGENT_BUILDER_DRAFT_CREATED"
    | "AGENT_BUILDER_DRAFT_REJECTED"
    | "AGENT_BUILDER_DRAFT_CONFIRMED"
    | "AGENT_RECIPE_CREATED"
    | "AGENT_RECIPE_CLONED";
  ownerWallet?: string;
  draftId?: string;
  recipeId?: string;
  reasonCodes?: AgentBuilderReasonCode[];
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentBuilderRepositories {
  drafts: DurableRepository<AgentBuilderDraftRecord>;
  recipes: DurableRepository<AgentRecipe>;
  events: DurableRepository<AgentBuilderEvent>;
}

export class AgentBuilderError extends Error {
  constructor(
    public readonly code: AgentBuilderReasonCode | "AGENT_BUILDER_NOT_FOUND" | "AGENT_BUILDER_INVALID_REQUEST",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

const ALPHA_FEE_VALUES = [50, 100, 150, 200, 250, 300] as const;

const FORBIDDEN_PATTERNS: Array<{ code: AgentBuilderReasonCode; pattern: RegExp; explanation: string }> = [
  {
    code: "AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN",
    pattern: /(private\s*key|seed\s*phrase|mnemonic|keypair).*(server|backend|store|host)|server.*(private\s*key|seed\s*phrase|mnemonic|keypair)/i,
    explanation: "Backend private-key storage is forbidden. Agent wallets must be client-side and user-owned.",
  },
  {
    code: "AGENT_BUILDER_BACKEND_SIGNING_FORBIDDEN",
    pattern: /(backend|server).*(sign|signing)|sign.*(on\s*the\s*server|in\s*backend)/i,
    explanation: "Backend signing is forbidden. Live actions require client-side user signing or a separate approved gate.",
  },
  {
    code: "AGENT_BUILDER_BACKEND_CUSTODY_FORBIDDEN",
    pattern: /(custody|custodial|hold\s*(my|user|customer)?\s*funds|server.*wallet)/i,
    explanation: "Backend custody is forbidden.",
  },
  {
    code: "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN",
    pattern: /(hidden|secret|undisclosed|invisible).*(fee|commission|charge)/i,
    explanation: "Hidden fees are forbidden. Every fee line must be visible and receipt-bound.",
  },
  {
    code: "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN",
    pattern: /(bypass|override|replace|steal|remove).*(dna|platform).*(fee|fees)/i,
    explanation: "DNA platform fees cannot be bypassed or replaced by generated agent configs.",
  },
  {
    code: "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE",
    pattern: /(disable|turn\s*off|bypass).*(emergency\s*pause|pause)/i,
    explanation: "Emergency pause cannot be disabled by generated agent configs.",
  },
  {
    code: "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE",
    pattern: /\b(unlimited|uncapped)\b.*\b(auto[-\s]*trading|trading|bot|copy|betting|bet|spend)\b|\b(no\s*stop\s*loss|no\s*caps|without\s*limits?|no\s*limits?)\b|auto(nomous)?.*(unlimited|no\s*limit|uncapped)/i,
    explanation: "Unrestricted unattended live trading is outside Public Beta scope.",
  },
  {
    code: "AGENT_BUILDER_POLYMARKET_LIVE_OUT_OF_SCOPE",
    pattern: /(autonomous|unattended|auto).*(polymarket).*(live|betting)|public.*(autonomous|unattended|auto).*(polymarket|betting)|polymarket.*(unrestricted|unlimited|unattended|autonomous).*live/i,
    explanation: "Public unattended Polymarket live betting is not in beta scope.",
  },
  {
    code: "AGENT_BUILDER_SOLANA_AUTONOMOUS_OUT_OF_SCOPE",
    pattern: /(autonomous|unattended|unlimited).*(shitcoin|meme\s*coin|token\s*trading|solana\s*trading)/i,
    explanation: "Unrestricted autonomous Solana token trading is not in beta scope.",
  },
  {
    code: "AGENT_BUILDER_HIGH_RISK_CATEGORY_OUT_OF_SCOPE",
    pattern: /(physical\s*goods|weapon|gun|drug|adult|casino|gambling|high[-\s]*risk)/i,
    explanation: "High-risk categories and physical goods are not in beta scope.",
  },
  {
    code: "AGENT_BUILDER_INVALID_ALPHA_FEE",
    pattern: /(fee|charge).*(loss|losses|unrealized)|success\s*fee.*(loss|unrealized)/i,
    explanation: "Alpha fees can apply only to positive finalized copied-lot PnL.",
  },
];

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "agent-draft";
}

function usdToAtomic(value: number): string {
  return Math.floor(value * 1_000_000).toString();
}

function numberFromMatch(prompt: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(prompt);
  return match?.[1] ? Number(match[1]) : undefined;
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function parseEntryRange(prompt: string): { minEntryPriceBps?: number; maxEntryPriceBps?: number } {
  const centRange = /(\d{1,3})\s*c(?:ents?)?\s*(?:-|to|and|through)\s*(\d{1,3})\s*c/i.exec(prompt);
  if (centRange) {
    return {
      minEntryPriceBps: clampBps(Number(centRange[1]) * 100),
      maxEntryPriceBps: clampBps(Number(centRange[2]) * 100),
    };
  }
  const percentRange = /(\d{1,3})\s*%(?:\s*(?:-|to|and|through)\s*)(\d{1,3})\s*%/i.exec(prompt);
  if (percentRange) {
    return {
      minEntryPriceBps: clampBps(Number(percentRange[1]) * 100),
      maxEntryPriceBps: clampBps(Number(percentRange[2]) * 100),
    };
  }
  return {};
}

function parseAlphaFee(prompt: string): 50 | 100 | 150 | 200 | 250 | 300 | undefined {
  const raw = numberFromMatch(prompt, /(?:charge|fee|success\s*fee).*?(\d+(?:\.\d+)?)\s*%/i)
    ?? numberFromMatch(prompt, /(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:profit|positive)/i);
  if (raw === undefined) return undefined;
  const bps = Math.round(raw * 100);
  return ALPHA_FEE_VALUES.includes(bps as typeof ALPHA_FEE_VALUES[number])
    ? bps as typeof ALPHA_FEE_VALUES[number]
    : undefined;
}

function detectAgentType(prompt: string): AgentType {
  const lower = prompt.toLowerCase();
  if (lower.includes("paid api")) return "PAID_API_AGENT";
  if (lower.includes("data feed") || lower.includes("data-feed")) return "DATA_FEED_AGENT";
  if (lower.includes("builder tool") || lower.includes("tool agent")) return "BUILDER_TOOL_AGENT";
  if (lower.includes("alpha profile")) return "ALPHA_PROFILE_AGENT";
  if (lower.includes("solana") || lower.includes("token") || lower.includes("shitcoin")) {
    return lower.includes("copy") ? "SOLANA_TOKEN_COPY_AGENT" : "SOLANA_TOKEN_SIGNAL_AGENT";
  }
  if (lower.includes("polymarket") || lower.includes("bet") || lower.includes("market")) {
    return lower.includes("copy") || lower.includes("follow") ? "POLYMARKET_COPY_AGENT" : "POLYMARKET_SIGNAL_AGENT";
  }
  if (lower.includes("paper")) return "PAPER_AGENT";
  return "PAPER_AGENT";
}

function inferMode(prompt: string, agentType: AgentType): AgentConfigDraft["mode"] {
  const lower = prompt.toLowerCase();
  if (lower.includes("paper")) return "PAPER";
  if (lower.includes("signal") || lower.includes("watch")) return "SIGNAL_ONLY";
  if (lower.includes("user-confirmed") || lower.includes("manual") || lower.includes("confirm")) return "USER_CONFIRMED_LIVE";
  if (agentType.endsWith("_COPY_AGENT")) return "AUTO_COPY_PUBLIC_BETA";
  if (agentType === "PAPER_AGENT") return "PAPER";
  return "SIGNAL_ONLY";
}

function marketScopeFromPrompt(prompt: string, agentType: AgentType): AgentConfigDraft["marketScope"] {
  const lower = prompt.toLowerCase();
  const filters: string[] = [];
  if (/\bbtc\b|bitcoin/i.test(prompt)) filters.push("BTC");
  if (/\beth\b|ethereum/i.test(prompt)) filters.push("ETH");
  if (/5\s*m(in)?\b/i.test(prompt)) filters.push("5m");
  if (/15\s*m(in)?\b/i.test(prompt)) filters.push("15m");
  if (/1\s*h(our)?\b/i.test(prompt)) filters.push("1h");

  const categories: string[] = [];
  if (lower.includes("crypto") || filters.some((filter) => filter === "BTC" || filter === "ETH")) categories.push("crypto");
  if (lower.includes("sports")) categories.push("sports");
  if (lower.includes("politics")) categories.push("politics");

  if (agentType.startsWith("POLYMARKET")) {
    return { venue: "POLYMARKET", categories: categories.length ? categories : undefined, marketFilters: filters.length ? filters : undefined };
  }
  if (agentType.startsWith("SOLANA")) {
    return { venue: "SOLANA", categories: categories.length ? categories : ["token_research"], marketFilters: filters.length ? filters : undefined };
  }
  if (agentType === "PAID_API_AGENT" || agentType === "DATA_FEED_AGENT" || agentType === "BUILDER_TOOL_AGENT") {
    return { venue: "DNA_X402", categories: ["low_risk_api_tool"] };
  }
  return undefined;
}

function defaultDisplayName(agentType: AgentType, prompt?: string): string {
  if (prompt && /\bbtc\b/i.test(prompt) && /40\s*c/i.test(prompt)) return "BTC 40c-60c Copy Agent";
  return agentType.toLowerCase().split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function buildCopySettingsFromPrompt(prompt: string): NonNullable<AgentConfigDraft["copySettings"]> {
  const entryRange = parseEntryRange(prompt);
  const maxBetUsd = numberFromMatch(prompt, /max(?:imum)?\s*\$?(\d+(?:\.\d+)?)\s*(?:per\s*)?(?:bet|trade|copy|entry)/i);
  const maxDailySpendUsd = numberFromMatch(prompt, /max(?:imum)?\s*daily\s*(?:spend|volume).*?\$?(\d+(?:\.\d+)?)/i);
  const maxDailyLossUsd = numberFromMatch(prompt, /(?:daily\s*loss|stops?\s*after|stop\s*after).*?\$?(\d+(?:\.\d+)?)/i);
  const maxExposureUsd = numberFromMatch(prompt, /(?:open\s*exposure|max\s*exposure).*?\$?(\d+(?:\.\d+)?)/i);
  const takeProfitPct = numberFromMatch(prompt, /(?:take\s*profit|tp).*?(\d+(?:\.\d+)?)\s*%/i);
  const stopLossPct = numberFromMatch(prompt, /(?:stop\s*loss|sl).*?(\d+(?:\.\d+)?)\s*%/i);
  const buysOnly = /buys?\s*only|copy\s*buys?\s*only/i.test(prompt);
  const sells = /copy\s*sells?|copy\s*exits?|follow\s*exits?/i.test(prompt);

  return {
    copyBuys: !/do\s*not\s*copy\s*buys?|no\s*buys?/i.test(prompt),
    copySells: buysOnly ? false : sells,
    copyExits: buysOnly ? false : /copy\s*exits?|follow\s*exits?/i.test(prompt),
    ...entryRange,
    maxBetSizeAtomic: maxBetUsd !== undefined ? usdToAtomic(maxBetUsd) : undefined,
    maxDailySpendAtomic: maxDailySpendUsd !== undefined ? usdToAtomic(maxDailySpendUsd) : undefined,
    maxDailyLossAtomic: maxDailyLossUsd !== undefined ? usdToAtomic(maxDailyLossUsd) : undefined,
    maxOpenExposureAtomic: maxExposureUsd !== undefined ? usdToAtomic(maxExposureUsd) : undefined,
    customTakeProfitBps: takeProfitPct !== undefined ? Math.round(takeProfitPct * 100) : undefined,
    customStopLossBps: stopLossPct !== undefined ? Math.round(stopLossPct * 100) : undefined,
    requireApprovalAlways: false,
    requireApprovalAboveAtomic: maxBetUsd !== undefined ? usdToAtomic(maxBetUsd) : undefined,
  };
}

function applyBetaDefaults(config: AgentConfigDraft): AgentConfigDraft {
  const next = { ...config };
  if (next.mode === "PAPER" || next.mode === "SIGNAL_ONLY") {
    next.walletMode = "NONE_REQUIRED";
  }
  if (next.mode === "USER_CONFIRMED_LIVE" || next.mode === "AUTO_COPY_PUBLIC_BETA") {
    next.walletMode = "CLIENT_SIDE_USER_OWNED";
  }
  next.backendCustody = false;
  next.backendSigning = false;
  return next;
}

function validateDraft(config: AgentConfigDraft): { status: AgentBuilderResult["status"]; reasonCodes: AgentBuilderReasonCode[]; explanation: string[] } {
  const reasonCodes: AgentBuilderReasonCode[] = [];
  const explanation: string[] = [];
  if (config.backendCustody !== false) {
    reasonCodes.push("AGENT_BUILDER_BACKEND_CUSTODY_FORBIDDEN");
    explanation.push("Backend custody is forbidden.");
  }
  if (config.backendSigning !== false) {
    reasonCodes.push("AGENT_BUILDER_BACKEND_SIGNING_FORBIDDEN");
    explanation.push("Backend signing is forbidden.");
  }
  if (config.monetization?.enabled && !ALPHA_FEE_VALUES.includes(config.monetization.successFeeBps as typeof ALPHA_FEE_VALUES[number])) {
    reasonCodes.push("AGENT_BUILDER_INVALID_ALPHA_FEE");
    explanation.push("Alpha success fee must be one of 0.5%, 1%, 1.5%, 2%, 2.5%, or 3%.");
  }
  if (config.mode === "AUTO_COPY_PUBLIC_BETA") {
    const limits = config.copySettings;
    const missing = !limits?.maxBetSizeAtomic || !limits.maxDailyLossAtomic || !limits.maxOpenExposureAtomic;
    if (missing) {
      reasonCodes.push("AGENT_BUILDER_MISSING_RISK_LIMITS");
      explanation.push("Auto-copy beta drafts need max bet, max daily loss, and max open exposure limits before activation.");
    }
  }
  if (reasonCodes.length > 0) {
    return { status: reasonCodes.includes("AGENT_BUILDER_MISSING_RISK_LIMITS") ? "REVIEW_REQUIRED" : "REJECTED", reasonCodes, explanation };
  }
  return { status: "DRAFT_CREATED", reasonCodes: [], explanation: ["Draft is inside Public Beta policy scope."] };
}

function riskSummary(config: AgentConfigDraft, status: AgentBuilderResult["status"]): AgentRiskSummary {
  const realFundsAtRisk = config.mode === "USER_CONFIRMED_LIVE" || config.mode === "AUTO_COPY_PUBLIC_BETA";
  const copy = config.copySettings;
  const warnings = [
    config.mode === "PAPER" ? "This agent uses paper funds only." : undefined,
    config.mode === "SIGNAL_ONLY" ? "This agent can publish signals but does not execute trades." : undefined,
    realFundsAtRisk ? "Live actions require client-side user signing and beta caps." : undefined,
    copy?.minEntryPriceBps !== undefined && copy.maxEntryPriceBps !== undefined
      ? `This copy agent skips entries outside ${copy.minEntryPriceBps / 100}c-${copy.maxEntryPriceBps / 100}c.`
      : undefined,
    config.monetization?.enabled
      ? `This agent charges ${(config.monetization.successFeeBps ?? 0) / 100}% only on positive finalized copied-lot profit.`
      : undefined,
  ].filter(Boolean) as string[];
  const requiredConfirmations = [
    "I understand DNA x402 never stores private keys.",
    "I understand DNA x402 never signs trades on the backend.",
    "I accept the generated risk limits and fee preview.",
  ];
  return {
    riskLevel: status === "REJECTED" ? "OUT_OF_SCOPE" : status === "REVIEW_REQUIRED" ? "HIGH" : realFundsAtRisk ? "MEDIUM" : "LOW",
    realFundsAtRisk,
    requiresClientSignature: realFundsAtRisk,
    backendCustody: false,
    backendSigning: false,
    maxBetSizeAtomic: copy?.maxBetSizeAtomic,
    maxDailySpendAtomic: copy?.maxDailySpendAtomic,
    maxDailyLossAtomic: copy?.maxDailyLossAtomic,
    maxOpenExposureAtomic: copy?.maxOpenExposureAtomic,
    warnings,
    requiredConfirmations,
  };
}

function rejectedResult(reasonCodes: AgentBuilderReasonCode[], explanation: string[]): AgentBuilderResult {
  return {
    status: "REJECTED",
    reasonCodes,
    explanation,
    riskSummary: {
      riskLevel: "OUT_OF_SCOPE",
      realFundsAtRisk: true,
      requiresClientSignature: true,
      backendCustody: false,
      backendSigning: false,
      warnings: explanation,
      requiredConfirmations: [],
    },
    safeAlternative: "Use paper mode, signal mode, or user-confirmed live mode with caps.",
  };
}

function configFromPrompt(request: AgentBuilderRequest, now: string): AgentBuilderResult {
  const prompt = request.prompt?.trim() ?? "";
  const forbidden = FORBIDDEN_PATTERNS.filter((entry) => entry.pattern.test(prompt));
  if (forbidden.length > 0) {
    return rejectedResult(forbidden.map((entry) => entry.code), forbidden.map((entry) => entry.explanation));
  }

  const alphaFee = parseAlphaFee(prompt);
  const askedFee = /(?:charge|fee|success\s*fee).*?(\d+(?:\.\d+)?)\s*%/i.exec(prompt);
  if (askedFee && alphaFee === undefined) {
    return rejectedResult(["AGENT_BUILDER_INVALID_ALPHA_FEE"], ["Alpha success fee must be 0.5% to 3.0% in fixed beta steps."]);
  }

  const agentType = detectAgentType(prompt);
  const mode = inferMode(prompt, agentType);
  const displayName = defaultDisplayName(agentType, prompt);
  const draftId = crypto.randomUUID();
  const config = applyBetaDefaults({
    draftId,
    ownerWallet: request.ownerWallet,
    agentType,
    displayName,
    slug: slugify(`${displayName}-${draftId.slice(0, 8)}`),
    mode,
    walletMode: "NONE_REQUIRED",
    backendCustody: false,
    backendSigning: false,
    marketScope: marketScopeFromPrompt(prompt, agentType),
    copySettings: agentType.endsWith("_COPY_AGENT") ? buildCopySettingsFromPrompt(prompt) : undefined,
    monetization: alphaFee ? {
      enabled: true,
      successFeeBps: alphaFee,
      appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL",
      mode: "ACCRUAL",
    } : undefined,
    visibility: /public/i.test(prompt) ? "PUBLIC" : "PRIVATE",
    createdAt: now,
    updatedAt: now,
  });
  const validation = validateDraft(config);
  return {
    status: validation.status,
    draftId,
    agentConfig: config,
    riskSummary: riskSummary(config, validation.status),
    reasonCodes: validation.reasonCodes,
    explanation: [
      ...validation.explanation,
      ...riskSummary(config, validation.status).warnings,
    ],
  };
}

export const GUIDED_BUILDER_TREE: GuidedBuilderNode[] = [
  {
    nodeId: "start",
    question: "What do you want to build?",
    options: [
      { label: "Paper strategy agent", value: "PAPER_AGENT", nextNodeId: "visibility", patch: { agentType: "PAPER_AGENT", mode: "PAPER" } },
      { label: "Polymarket signal agent", value: "POLYMARKET_SIGNAL_AGENT", nextNodeId: "market-scope", patch: { agentType: "POLYMARKET_SIGNAL_AGENT", mode: "SIGNAL_ONLY" } },
      { label: "Polymarket copy agent", value: "POLYMARKET_COPY_AGENT", nextNodeId: "copy-filters", patch: { agentType: "POLYMARKET_COPY_AGENT", mode: "AUTO_COPY_PUBLIC_BETA" } },
      { label: "Solana token signal agent", value: "SOLANA_TOKEN_SIGNAL_AGENT", nextNodeId: "market-scope", patch: { agentType: "SOLANA_TOKEN_SIGNAL_AGENT", mode: "SIGNAL_ONLY" } },
      { label: "Solana token copy agent", value: "SOLANA_TOKEN_COPY_AGENT", nextNodeId: "copy-filters", patch: { agentType: "SOLANA_TOKEN_COPY_AGENT", mode: "AUTO_COPY_PUBLIC_BETA" } },
      { label: "Paid API agent", value: "PAID_API_AGENT", nextNodeId: "monetization", patch: { agentType: "PAID_API_AGENT", mode: "SIGNAL_ONLY" } },
      { label: "Data feed agent", value: "DATA_FEED_AGENT", nextNodeId: "monetization", patch: { agentType: "DATA_FEED_AGENT", mode: "SIGNAL_ONLY" } },
      { label: "Builder tool agent", value: "BUILDER_TOOL_AGENT", nextNodeId: "monetization", patch: { agentType: "BUILDER_TOOL_AGENT", mode: "SIGNAL_ONLY" } },
      { label: "Alpha profile agent", value: "ALPHA_PROFILE_AGENT", nextNodeId: "monetization", patch: { agentType: "ALPHA_PROFILE_AGENT", mode: "SIGNAL_ONLY" } },
    ],
  },
  {
    nodeId: "copy-filters",
    question: "Which source actions should followers copy?",
    options: [
      { label: "Copy buys only", value: "buys_only", nextNodeId: "risk-limits" },
      { label: "Copy buys and exits", value: "buys_exits", nextNodeId: "risk-limits" },
      { label: "Watch only", value: "watch_only", nextNodeId: "visibility" },
    ],
  },
  {
    nodeId: "risk-limits",
    question: "Set max bet, daily loss, and open exposure before live-copy beta.",
    options: [
      { label: "Conservative caps", value: "conservative", nextNodeId: "monetization" },
      { label: "Custom caps", value: "custom", nextNodeId: "monetization" },
    ],
  },
  {
    nodeId: "monetization",
    question: "How should alpha monetization work?",
    options: [
      { label: "No alpha fee", value: "off", nextNodeId: "visibility" },
      { label: "1% positive finalized copied-lot PnL", value: "100", nextNodeId: "visibility" },
      { label: "2% positive finalized copied-lot PnL", value: "200", nextNodeId: "visibility" },
    ],
  },
  {
    nodeId: "visibility",
    question: "Should the profile be public?",
    options: [
      { label: "Private", value: "PRIVATE", nextNodeId: "review" },
      { label: "Public", value: "PUBLIC", nextNodeId: "review" },
    ],
  },
  {
    nodeId: "review",
    question: "Review the generated config and safety summary before confirming.",
    options: [{ label: "Preview draft", value: "preview" }],
  },
];

function templateConfig(templateId: string, ownerWallet: string, now: string): AgentConfigDraft | undefined {
  const draftId = crypto.randomUUID();
  const base = {
    draftId,
    ownerWallet,
    backendCustody: false as const,
    backendSigning: false as const,
    createdAt: now,
    updatedAt: now,
  };
  const templates: Record<string, AgentConfigDraft> = {
    "btc-40-60-copy-agent": applyBetaDefaults({
      ...base,
      agentType: "POLYMARKET_COPY_AGENT",
      displayName: "BTC 40c-60c Copy Agent",
      slug: `btc-40-60-copy-${draftId.slice(0, 8)}`,
      mode: "AUTO_COPY_PUBLIC_BETA",
      walletMode: "CLIENT_SIDE_USER_OWNED",
      marketScope: { venue: "POLYMARKET", categories: ["crypto"], marketFilters: ["BTC", "5m"] },
      copySettings: {
        copyBuys: true,
        copySells: false,
        copyExits: false,
        minEntryPriceBps: 4000,
        maxEntryPriceBps: 6000,
        maxBetSizeAtomic: "5000000",
        maxDailyLossAtomic: "25000000",
        maxOpenExposureAtomic: "100000000",
        requireApprovalAlways: false,
        requireApprovalAboveAtomic: "5000000",
      },
      monetization: { enabled: true, successFeeBps: 200, appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL", mode: "ACCRUAL" },
      visibility: "PUBLIC",
    }),
    "paper-polymarket-scout": applyBetaDefaults({
      ...base,
      agentType: "PAPER_AGENT",
      displayName: "Paper Polymarket Scout",
      slug: `paper-polymarket-scout-${draftId.slice(0, 8)}`,
      mode: "PAPER",
      walletMode: "NONE_REQUIRED",
      marketScope: { venue: "POLYMARKET", categories: ["crypto", "macro"] },
      visibility: "PUBLIC",
    }),
    "solana-token-signal-watcher": applyBetaDefaults({
      ...base,
      agentType: "SOLANA_TOKEN_SIGNAL_AGENT",
      displayName: "Solana Token Signal Watcher",
      slug: `solana-token-signal-${draftId.slice(0, 8)}`,
      mode: "SIGNAL_ONLY",
      walletMode: "NONE_REQUIRED",
      marketScope: { venue: "SOLANA", categories: ["token_research"] },
      visibility: "PRIVATE",
    }),
    "low-risk-data-feed-seller": applyBetaDefaults({
      ...base,
      agentType: "DATA_FEED_AGENT",
      displayName: "Low-Risk Data Feed Seller",
      slug: `low-risk-data-feed-${draftId.slice(0, 8)}`,
      mode: "SIGNAL_ONLY",
      walletMode: "NONE_REQUIRED",
      marketScope: { venue: "DNA_X402", categories: ["low_risk_data_feed"] },
      visibility: "PUBLIC",
    }),
    "paid-api-agent": applyBetaDefaults({
      ...base,
      agentType: "PAID_API_AGENT",
      displayName: "Paid API Agent",
      slug: `paid-api-agent-${draftId.slice(0, 8)}`,
      mode: "SIGNAL_ONLY",
      walletMode: "NONE_REQUIRED",
      marketScope: { venue: "DNA_X402", categories: ["low_risk_api_tool"] },
      visibility: "PUBLIC",
    }),
    "alpha-profile-agent": applyBetaDefaults({
      ...base,
      agentType: "ALPHA_PROFILE_AGENT",
      displayName: "Alpha Profile Agent",
      slug: `alpha-profile-${draftId.slice(0, 8)}`,
      mode: "SIGNAL_ONLY",
      walletMode: "NONE_REQUIRED",
      monetization: { enabled: true, successFeeBps: 100, appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL", mode: "ACCRUAL" },
      visibility: "PUBLIC",
    }),
    "conservative-copy-agent": applyBetaDefaults({
      ...base,
      agentType: "POLYMARKET_COPY_AGENT",
      displayName: "Conservative Copy Agent",
      slug: `conservative-copy-${draftId.slice(0, 8)}`,
      mode: "AUTO_COPY_PUBLIC_BETA",
      walletMode: "CLIENT_SIDE_USER_OWNED",
      marketScope: { venue: "POLYMARKET", categories: ["crypto"] },
      copySettings: {
        copyBuys: true,
        copySells: false,
        copyExits: true,
        minEntryPriceBps: 3500,
        maxEntryPriceBps: 6500,
        maxBetSizeAtomic: "2500000",
        maxDailyLossAtomic: "10000000",
        maxOpenExposureAtomic: "25000000",
        requireApprovalAlways: false,
        requireApprovalAboveAtomic: "2500000",
      },
      monetization: { enabled: true, successFeeBps: 100, appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL", mode: "ACCRUAL" },
      visibility: "PUBLIC",
    }),
    "degen-paper-strategy-lab": applyBetaDefaults({
      ...base,
      agentType: "PAPER_AGENT",
      displayName: "Degen Paper Strategy Lab",
      slug: `degen-paper-lab-${draftId.slice(0, 8)}`,
      mode: "PAPER",
      walletMode: "NONE_REQUIRED",
      marketScope: { venue: "POLYMARKET", categories: ["crypto", "sports", "macro"] },
      visibility: "PUBLIC",
    }),
  };
  return templates[templateId];
}

export function listAgentBuilderTemplates(now: () => Date = () => new Date()): AgentRecipe[] {
  const createdAt = nowIso(now);
  const ownerWallet = "template";
  const templateIds = [
    "btc-40-60-copy-agent",
    "paper-polymarket-scout",
    "solana-token-signal-watcher",
    "low-risk-data-feed-seller",
    "paid-api-agent",
    "alpha-profile-agent",
    "conservative-copy-agent",
    "degen-paper-strategy-lab",
  ];
  return templateIds.map((templateId) => {
    const config = templateConfig(templateId, ownerWallet, createdAt)!;
    const summary = riskSummary(config, "DRAFT_CREATED");
    return {
      recipeId: templateId,
      source: "TEMPLATE",
      title: config.displayName,
      description: summary.warnings.join(" "),
      config,
      riskSummary: summary,
      visibility: "CLONEABLE",
      version: 1,
      createdAt,
    };
  });
}

function configFromGuided(request: AgentBuilderRequest, now: string): AgentBuilderResult {
  const answers = request.guidedAnswers ?? {};
  const agentType = String(answers.agentType ?? "PAPER_AGENT") as AgentType;
  const mode = String(answers.mode ?? (agentType.endsWith("_COPY_AGENT") ? "AUTO_COPY_PUBLIC_BETA" : agentType === "PAPER_AGENT" ? "PAPER" : "SIGNAL_ONLY")) as AgentConfigDraft["mode"];
  const draftId = crypto.randomUUID();
  const config = applyBetaDefaults({
    draftId,
    ownerWallet: request.ownerWallet,
    agentType,
    displayName: String(answers.displayName ?? defaultDisplayName(agentType)),
    slug: slugify(String(answers.slug ?? `${defaultDisplayName(agentType)}-${draftId.slice(0, 8)}`)),
    mode,
    walletMode: "NONE_REQUIRED",
    backendCustody: false,
    backendSigning: false,
    marketScope: answers.marketScope as AgentConfigDraft["marketScope"] | undefined,
    copySettings: agentType.endsWith("_COPY_AGENT") ? {
      copyBuys: answers.copyBuys !== false,
      copySells: answers.copySells === true,
      copyExits: answers.copyExits === true,
      minEntryPriceBps: typeof answers.minEntryPriceBps === "number" ? answers.minEntryPriceBps : undefined,
      maxEntryPriceBps: typeof answers.maxEntryPriceBps === "number" ? answers.maxEntryPriceBps : undefined,
      maxBetSizeAtomic: typeof answers.maxBetSizeAtomic === "string" ? answers.maxBetSizeAtomic : "2500000",
      maxDailySpendAtomic: typeof answers.maxDailySpendAtomic === "string" ? answers.maxDailySpendAtomic : undefined,
      maxDailyLossAtomic: typeof answers.maxDailyLossAtomic === "string" ? answers.maxDailyLossAtomic : "10000000",
      maxOpenExposureAtomic: typeof answers.maxOpenExposureAtomic === "string" ? answers.maxOpenExposureAtomic : "25000000",
      customTakeProfitBps: typeof answers.customTakeProfitBps === "number" ? answers.customTakeProfitBps : undefined,
      customStopLossBps: typeof answers.customStopLossBps === "number" ? answers.customStopLossBps : undefined,
      requireApprovalAlways: answers.requireApprovalAlways === true,
      requireApprovalAboveAtomic: typeof answers.requireApprovalAboveAtomic === "string" ? answers.requireApprovalAboveAtomic : "2500000",
    } : undefined,
    monetization: typeof answers.successFeeBps === "number" ? {
      enabled: true,
      successFeeBps: answers.successFeeBps as 50 | 100 | 150 | 200 | 250 | 300,
      appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL",
      mode: "ACCRUAL",
    } : undefined,
    visibility: answers.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE",
    createdAt: now,
    updatedAt: now,
  });
  const validation = validateDraft(config);
  return {
    status: validation.status,
    draftId,
    agentConfig: config,
    riskSummary: riskSummary(config, validation.status),
    reasonCodes: validation.reasonCodes,
    explanation: [...validation.explanation, ...riskSummary(config, validation.status).warnings],
  };
}

export class AgentBuilderService {
  private readonly drafts = new Map<string, AgentBuilderDraftRecord>();
  private readonly recipes = new Map<string, AgentRecipe>();
  private readonly events = new Map<string, AgentBuilderEvent>();
  private loadPromise?: Promise<void>;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly repositories?: AgentBuilderRepositories,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.repositories) return;
    this.loadPromise ??= this.loadFromRepositories();
    await this.loadPromise;
  }

  private async loadFromRepositories(): Promise<void> {
    const repos = this.repositories;
    if (!repos) return;
    const [drafts, recipes, events] = await Promise.all([
      repos.drafts.list(),
      repos.recipes.list(),
      repos.events.list(),
    ]);
    this.drafts.clear();
    this.recipes.clear();
    this.events.clear();
    for (const row of drafts) this.drafts.set(row.payload.draftId, row.payload);
    for (const row of recipes) this.recipes.set(row.payload.recipeId, row.payload);
    for (const row of events) this.events.set(row.payload.eventId, row.payload);
  }

  private async persistEvent(event: AgentBuilderEvent): Promise<void> {
    this.events.set(event.eventId, event);
    await this.repositories?.events.append(event.eventId, event, { actorId: event.ownerWallet ?? "agent-builder" });
  }

  async createDraft(request: AgentBuilderRequest): Promise<AgentBuilderResult> {
    await this.ensureLoaded();
    assertNoBackendPrivateKeyPayload(request);
    if (!request.ownerWallet?.trim()) {
      throw new AgentBuilderError("AGENT_BUILDER_INVALID_REQUEST", "ownerWallet is required");
    }
    const ts = nowIso(this.now);
    let result: AgentBuilderResult;
    if (request.inputMode === "PROMPT") {
      result = configFromPrompt(request, ts);
    } else if (request.inputMode === "GUIDED") {
      result = configFromGuided(request, ts);
    } else if (request.inputMode === "TEMPLATE") {
      const config = request.templateId ? templateConfig(request.templateId, request.ownerWallet, ts) : undefined;
      if (!config) {
        result = rejectedResult(["AGENT_BUILDER_TEMPLATE_NOT_FOUND"], ["Requested agent template was not found."]);
      } else {
        const validation = validateDraft(config);
        result = {
          status: validation.status,
          draftId: config.draftId,
          agentConfig: config,
          riskSummary: riskSummary(config, validation.status),
          reasonCodes: validation.reasonCodes,
          explanation: [...validation.explanation, ...riskSummary(config, validation.status).warnings],
        };
      }
    } else {
      const recipe = request.cloneFromAgentId ? await this.findCloneableRecipe(request.cloneFromAgentId) : undefined;
      if (!recipe) {
        result = rejectedResult(["AGENT_BUILDER_RECIPE_NOT_FOUND"], ["Requested public or cloneable recipe was not found."]);
      } else {
        const draftId = crypto.randomUUID();
        const config: AgentConfigDraft = {
          ...recipe.config,
          draftId,
          ownerWallet: request.ownerWallet,
          displayName: `${recipe.config.displayName} Clone`,
          slug: slugify(`${recipe.config.slug}-clone-${draftId.slice(0, 8)}`),
          createdAt: ts,
          updatedAt: ts,
        };
        const validation = validateDraft(config);
        result = {
          status: validation.status,
          draftId,
          agentConfig: config,
          riskSummary: riskSummary(config, validation.status),
          reasonCodes: validation.reasonCodes,
          explanation: [...validation.explanation, "Cloned from a public/cloneable recipe. Review risk limits before confirming."],
        };
      }
    }

    if (result.draftId) {
      const record: AgentBuilderDraftRecord = {
        draftId: result.draftId,
        status: result.status === "DRAFT_CREATED" ? "DRAFT" : result.status,
        source: request.inputMode,
        ownerWallet: request.ownerWallet,
        request,
        result,
        createdAt: ts,
        updatedAt: ts,
      };
      this.drafts.set(record.draftId, record);
      await this.repositories?.drafts.put(record.draftId, record, { actorId: request.ownerWallet });
      await this.persistEvent({
        eventId: crypto.randomUUID(),
        kind: result.status === "REJECTED" ? "AGENT_BUILDER_DRAFT_REJECTED" : "AGENT_BUILDER_DRAFT_CREATED",
        ownerWallet: request.ownerWallet,
        draftId: record.draftId,
        reasonCodes: result.reasonCodes,
        payload: { status: result.status, inputMode: request.inputMode },
        createdAt: ts,
      });
    }
    return result;
  }

  async getDraft(draftId: string): Promise<AgentBuilderDraftRecord | undefined> {
    await this.ensureLoaded();
    const draft = this.drafts.get(draftId);
    return draft ? structuredClone(draft) : undefined;
  }

  async rejectDraft(draftId: string, ownerWallet?: string): Promise<AgentBuilderDraftRecord> {
    await this.ensureLoaded();
    const draft = this.drafts.get(draftId);
    if (!draft) throw new AgentBuilderError("AGENT_BUILDER_NOT_FOUND", "draft not found", 404);
    if (ownerWallet && draft.ownerWallet !== ownerWallet) {
      throw new AgentBuilderError("AGENT_BUILDER_OWNER_MISMATCH", "owner wallet does not match draft owner", 403);
    }
    const ts = nowIso(this.now);
    const next = { ...draft, status: "REJECTED" as const, updatedAt: ts };
    this.drafts.set(draftId, next);
    await this.repositories?.drafts.put(draftId, next, { actorId: draft.ownerWallet });
    await this.persistEvent({
      eventId: crypto.randomUUID(),
      kind: "AGENT_BUILDER_DRAFT_REJECTED",
      ownerWallet: draft.ownerWallet,
      draftId,
      payload: { rejectedByUser: true },
      createdAt: ts,
    });
    return structuredClone(next);
  }

  async confirmDraft(input: {
    draftId: string;
    ownerWallet: string;
    acceptedRiskSummary: boolean;
    confirmations?: string[];
  }): Promise<{ draft: AgentBuilderDraftRecord; agentConfig: AgentConfigDraft; riskSummary: AgentRiskSummary }> {
    await this.ensureLoaded();
    const draft = this.drafts.get(input.draftId);
    if (!draft) throw new AgentBuilderError("AGENT_BUILDER_NOT_FOUND", "draft not found", 404);
    if (draft.ownerWallet !== input.ownerWallet) {
      throw new AgentBuilderError("AGENT_BUILDER_OWNER_MISMATCH", "owner wallet does not match draft owner", 403);
    }
    if (draft.status === "REJECTED") {
      throw new AgentBuilderError("AGENT_BUILDER_REJECTED_DRAFT", "rejected draft cannot be confirmed", 409);
    }
    const config = draft.result.agentConfig;
    const summary = draft.result.riskSummary;
    if (!config || !summary) {
      throw new AgentBuilderError("AGENT_BUILDER_REJECTED_DRAFT", "draft has no confirmable config", 409);
    }
    if (!input.acceptedRiskSummary) {
      throw new AgentBuilderError("AGENT_BUILDER_RISK_ACK_REQUIRED", "risk summary acceptance is required", 400);
    }
    for (const confirmation of summary.requiredConfirmations) {
      if (!(input.confirmations ?? []).includes(confirmation)) {
        throw new AgentBuilderError("AGENT_BUILDER_RISK_ACK_REQUIRED", `missing confirmation: ${confirmation}`, 400);
      }
    }
    const validation = validateDraft(config);
    if (validation.status === "REJECTED" || draft.status === "REVIEW_REQUIRED") {
      throw new AgentBuilderError("AGENT_BUILDER_REVIEW_REQUIRED", "draft still requires manual review before confirmation", 409);
    }
    const ts = nowIso(this.now);
    const next = { ...draft, status: "CONFIRMED" as const, confirmedAt: ts, updatedAt: ts };
    this.drafts.set(input.draftId, next);
    await this.repositories?.drafts.put(input.draftId, next, { actorId: input.ownerWallet });
    await this.persistEvent({
      eventId: crypto.randomUUID(),
      kind: "AGENT_BUILDER_DRAFT_CONFIRMED",
      ownerWallet: input.ownerWallet,
      draftId: input.draftId,
      reasonCodes: ["AGENT_BUILDER_DRAFT_CONFIRMED"],
      payload: { configHash: stableHash(config), riskLevel: summary.riskLevel },
      createdAt: ts,
    });
    return { draft: structuredClone(next), agentConfig: structuredClone(config), riskSummary: structuredClone(summary) };
  }

  async listTemplates(): Promise<AgentRecipe[]> {
    return listAgentBuilderTemplates(this.now).map((recipe) => structuredClone(recipe));
  }

  guidedTree(): GuidedBuilderNode[] {
    return structuredClone(GUIDED_BUILDER_TREE);
  }

  async createRecipe(input: {
    ownerWallet: string;
    title: string;
    description: string;
    config: AgentConfigDraft;
    riskSummary?: AgentRiskSummary;
    visibility?: AgentRecipe["visibility"];
    prompt?: string;
    source?: AgentBuilderInputMode;
    ownerAgentId?: string;
  }): Promise<AgentRecipe> {
    await this.ensureLoaded();
    assertNoBackendPrivateKeyPayload(input);
    const validation = validateDraft(input.config);
    if (validation.status === "REJECTED") {
      throw new AgentBuilderError(validation.reasonCodes[0] ?? "AGENT_BUILDER_INVALID_REQUEST", validation.explanation.join(" "), 400);
    }
    const ts = nowIso(this.now);
    const recipe: AgentRecipe = {
      recipeId: crypto.randomUUID(),
      ownerAgentId: input.ownerAgentId,
      source: input.source ?? "PROMPT",
      title: input.title,
      description: input.description,
      prompt: input.prompt,
      config: { ...applyBetaDefaults(input.config), updatedAt: ts },
      riskSummary: input.riskSummary ?? riskSummary(input.config, validation.status),
      visibility: input.visibility ?? "PRIVATE",
      version: 1,
      createdAt: ts,
    };
    this.recipes.set(recipe.recipeId, recipe);
    await this.repositories?.recipes.put(recipe.recipeId, recipe, { actorId: input.ownerWallet });
    await this.persistEvent({
      eventId: crypto.randomUUID(),
      kind: "AGENT_RECIPE_CREATED",
      ownerWallet: input.ownerWallet,
      recipeId: recipe.recipeId,
      payload: { title: recipe.title, visibility: recipe.visibility },
      createdAt: ts,
    });
    return structuredClone(recipe);
  }

  async getRecipe(recipeId: string): Promise<AgentRecipe | undefined> {
    await this.ensureLoaded();
    const template = templateConfig(recipeId, "template", nowIso(this.now));
    if (template) {
      const summary = riskSummary(template, "DRAFT_CREATED");
      return {
        recipeId,
        source: "TEMPLATE",
        title: template.displayName,
        description: summary.warnings.join(" "),
        config: template,
        riskSummary: summary,
        visibility: "CLONEABLE",
        version: 1,
        createdAt: template.createdAt,
      };
    }
    const recipe = this.recipes.get(recipeId);
    return recipe ? structuredClone(recipe) : undefined;
  }

  async cloneRecipe(recipeId: string, ownerWallet: string): Promise<AgentBuilderResult> {
    return this.createDraft({ inputMode: "CLONE", cloneFromAgentId: recipeId, ownerWallet });
  }

  async publicRecipes(): Promise<AgentRecipe[]> {
    await this.ensureLoaded();
    const templates = await this.listTemplates();
    return [
      ...templates,
      ...Array.from(this.recipes.values()).filter((recipe) => recipe.visibility === "PUBLIC" || recipe.visibility === "CLONEABLE"),
    ].map((recipe) => structuredClone(recipe));
  }

  async listEvents(): Promise<AgentBuilderEvent[]> {
    await this.ensureLoaded();
    return Array.from(this.events.values()).map((event) => structuredClone(event));
  }

  private async findCloneableRecipe(id: string): Promise<AgentRecipe | undefined> {
    const recipe = await this.getRecipe(id);
    if (!recipe) return undefined;
    if (recipe.visibility !== "PUBLIC" && recipe.visibility !== "CLONEABLE") return undefined;
    return recipe;
  }
}

export function compileAgentPrompt(prompt: string, ownerWallet: string, now: () => Date = () => new Date()): AgentBuilderResult {
  return configFromPrompt({ inputMode: "PROMPT", prompt, ownerWallet }, nowIso(now));
}
