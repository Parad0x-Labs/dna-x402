import crypto from "node:crypto";
import { PUBLIC_BETA_RISK_CAPS_USD } from "../config.js";
import { stableHash } from "../common/stable.js";

export type DegenAgentMode = "WATCH_ONLY" | "SIGNAL_ONLY" | "USER_CONFIRMED_LIVE" | "CAPPED_AUTO_LIVE" | "PAPER_SIM";

export interface DegenRiskConfig {
  maxTradeUsd: number;
  maxDailySpendUsd: number;
  maxDailyLossUsd: number;
  maxOpenExposureUsd: number;
  maxSlippageBps: number;
  takeProfitBps?: number;
  stopLossBps?: number;
  maxTradesPerHour?: number;
  allowedTokens?: string[];
  blockedTokens?: string[];
  allowedWalletsToCopy?: string[];
  blockedWalletsToCopy?: string[];
  requireUserConfirmAboveUsd?: number;
  pauseOnDrawdownBps?: number;
}

export type ExecutionVenue = "JUPITER" | "RAYDIUM" | "PUMPFUN" | "CUSTOM_WEBHOOK" | "POLYMARKET" | "NONE";

export type TradeIntentStatus =
  | "PROPOSED"
  | "APPROVED"
  | "SIGNED_CLIENT_SIDE"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "REJECTED"
  | "CANCELLED";

export interface TradeIntent {
  intentId: string;
  agentId: string;
  ownerWallet: string;
  venue: ExecutionVenue;
  inputMint?: string;
  outputMint?: string;
  marketId?: string;
  side: "BUY" | "SELL" | "YES" | "NO";
  maxInputAmountAtomic: string;
  minOutputAmountAtomic?: string;
  slippageBps: number;
  mode: DegenAgentMode;
  riskConfigHash: string;
  requiresClientSignature: boolean;
  status: TradeIntentStatus;
  createdAt: string;
}

export type DegenExecutionCapability =
  | "WATCH"
  | "QUOTE_SHAPE"
  | "USER_CONFIRMED_INTENT"
  | "CAPPED_AUTO_INTENT_GATED";

export interface DegenExecutionAdapter {
  venue: ExecutionVenue;
  label: string;
  capabilities: DegenExecutionCapability[];
  liveSubmitSupported: false;
  backendSigning: false;
  backendCustody: false;
  notes: string[];
}

export type DegenTemplateCategory =
  | "fresh-pair"
  | "wallet-watch"
  | "copy-follow"
  | "risk-signal"
  | "momentum-signal"
  | "paper-lab"
  | "alpha-room";

export interface DegenAgentTemplate {
  slug: string;
  name: string;
  category: DegenTemplateCategory;
  degenPitch: string;
  whatItDoes: string[];
  defaultMode: DegenAgentMode;
  venue: ExecutionVenue;
  walletModel: "NONE_REQUIRED" | "CLIENT_SIDE_USER_OWNED" | "EXTERNAL_WALLET";
  backendCustody: false;
  backendSigning: false;
  defaultRiskConfig?: DegenRiskConfig;
  receiptBehavior: {
    receiptRequired: boolean;
    bindsRiskConfig: boolean;
    bindsTradeIntent: boolean;
  };
  rejectedAlgoatPatterns: string[];
  cursorPrompt: string;
}

export type DegenRejectionCode =
  | "DEGEN_OWNER_WALLET_REQUIRED"
  | "DEGEN_RISK_CONFIG_REQUIRED"
  | "DEGEN_RISK_CONFIG_INVALID"
  | "DEGEN_RISK_CAP_EXCEEDED"
  | "DEGEN_SLIPPAGE_EXCEEDED"
  | "DEGEN_AMOUNT_INVALID"
  | "DEGEN_BACKEND_SIGNING_FORBIDDEN"
  | "DEGEN_BACKEND_CUSTODY_FORBIDDEN"
  | "DEGEN_PRIVATE_KEY_FORBIDDEN"
  | "DEGEN_LIVE_ADAPTER_GATE_REQUIRED"
  | "DEGEN_UNSUPPORTED_LIVE_SUBMIT";

export class DegenModeError extends Error {
  constructor(
    public readonly code: DegenRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "DegenModeError";
  }
}

export interface CreateTradeIntentInput {
  intentId?: string;
  agentId: string;
  ownerWallet?: string;
  venue: ExecutionVenue;
  inputMint?: string;
  outputMint?: string;
  marketId?: string;
  side: "BUY" | "SELL" | "YES" | "NO";
  maxInputAmountAtomic: string;
  minOutputAmountAtomic?: string;
  slippageBps: number;
  mode: DegenAgentMode;
  riskConfig?: DegenRiskConfig;
  estimatedTradeUsd?: number;
  adapterGateRef?: string;
  backendSigning?: boolean;
  backendCustody?: boolean;
  payload?: Record<string, unknown>;
}

export interface DegenSafetyReport {
  ok: boolean;
  reasonCodes: DegenRejectionCode[];
  riskConfigHash?: string;
  requiresClientSignature: boolean;
  warnings: string[];
}

export const DEGEN_PUBLIC_BETA_MAX_SLIPPAGE_BPS = 3_000;

const PRIVATE_KEY_FIELD_PATTERN =
  /(^|[_-])(private[-_]?key|secret[-_]?key|seed[-_]?phrase|mnemonic|keypair|wallet[-_]?secret|trading[-_]?wallet[-_]?secret)([_-]|$)/i;

const PRIVATE_KEY_VALUE_PATTERN =
  /(BEGIN (OPENSSH )?PRIVATE KEY|\[[0-9,\s]{80,}\]|(?:\b[1-9A-HJ-NP-Za-km-z]{80,}\b))/;

export const DEGEN_EXECUTION_ADAPTERS: Record<ExecutionVenue, DegenExecutionAdapter> = {
  NONE: {
    venue: "NONE",
    label: "No execution",
    capabilities: ["WATCH"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["For paper, profile, and signal-only agents."],
  },
  CUSTOM_WEBHOOK: {
    venue: "CUSTOM_WEBHOOK",
    label: "Custom webhook intent",
    capabilities: ["WATCH", "QUOTE_SHAPE", "USER_CONFIRMED_INTENT"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["Produces intent/proof shapes only; the external system must enforce signing and risk policy."],
  },
  JUPITER: {
    venue: "JUPITER",
    label: "Jupiter swap intent",
    capabilities: ["WATCH", "QUOTE_SHAPE", "USER_CONFIRMED_INTENT", "CAPPED_AUTO_INTENT_GATED"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["Quote/intent adapter only in Public Beta. Signed swap submission stays client-side."],
  },
  RAYDIUM: {
    venue: "RAYDIUM",
    label: "Raydium watch intent",
    capabilities: ["WATCH", "QUOTE_SHAPE", "USER_CONFIRMED_INTENT", "CAPPED_AUTO_INTENT_GATED"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["Signal and intent layer only until adapter-specific fill tests exist."],
  },
  PUMPFUN: {
    venue: "PUMPFUN",
    label: "Pump.fun / PumpSwap watch intent",
    capabilities: ["WATCH", "QUOTE_SHAPE", "USER_CONFIRMED_INTENT"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["Fresh-pair and tape signals only. No direct Pump.fun live trading path is exposed."],
  },
  POLYMARKET: {
    venue: "POLYMARKET",
    label: "Polymarket intent",
    capabilities: ["WATCH", "QUOTE_SHAPE", "USER_CONFIRMED_INTENT"],
    liveSubmitSupported: false,
    backendSigning: false,
    backendCustody: false,
    notes: ["Paper, signal, and user-confirmed intent designs only in Public Beta."],
  },
};

export function isLiveDegenMode(mode: DegenAgentMode): boolean {
  return mode === "USER_CONFIRMED_LIVE" || mode === "CAPPED_AUTO_LIVE";
}

export function degenRiskConfigHash(config: DegenRiskConfig): string {
  return stableHash(config);
}

export function assertNoDegenPrivateKeyPayload(payload: unknown, path = "payload"): void {
  if (payload === null || payload === undefined) return;
  if (typeof payload === "string") {
    if (PRIVATE_KEY_VALUE_PATTERN.test(payload)) {
      throw new DegenModeError("DEGEN_PRIVATE_KEY_FORBIDDEN", `${path} looks like private key material`);
    }
    return;
  }
  if (typeof payload !== "object") return;

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertNoDegenPrivateKeyPayload(item, `${path}[${index}]`));
    return;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (PRIVATE_KEY_FIELD_PATTERN.test(key)) {
      throw new DegenModeError("DEGEN_PRIVATE_KEY_FORBIDDEN", `${path}.${key} is forbidden; degen agents never accept private keys`);
    }
    assertNoDegenPrivateKeyPayload(value, `${path}.${key}`);
  }
}

export function validateDegenRiskConfig(config: DegenRiskConfig): DegenSafetyReport {
  const reasonCodes: DegenRejectionCode[] = [];
  const warnings: string[] = [];
  const positiveFields: Array<keyof Pick<DegenRiskConfig, "maxTradeUsd" | "maxDailySpendUsd" | "maxDailyLossUsd" | "maxOpenExposureUsd" | "maxSlippageBps">> = [
    "maxTradeUsd",
    "maxDailySpendUsd",
    "maxDailyLossUsd",
    "maxOpenExposureUsd",
    "maxSlippageBps",
  ];

  for (const field of positiveFields) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      reasonCodes.push("DEGEN_RISK_CONFIG_INVALID");
      warnings.push(`${field} must be a positive number`);
    }
  }

  if (config.maxTradeUsd > PUBLIC_BETA_RISK_CAPS_USD.maxTxUsd) {
    reasonCodes.push("DEGEN_RISK_CAP_EXCEEDED");
    warnings.push(`maxTradeUsd exceeds Public Beta max trade USD ${PUBLIC_BETA_RISK_CAPS_USD.maxTxUsd}`);
  }
  if (config.maxDailySpendUsd > PUBLIC_BETA_RISK_CAPS_USD.maxDailySpendUsd) {
    reasonCodes.push("DEGEN_RISK_CAP_EXCEEDED");
    warnings.push(`maxDailySpendUsd exceeds Public Beta daily spend USD ${PUBLIC_BETA_RISK_CAPS_USD.maxDailySpendUsd}`);
  }
  if (config.maxDailyLossUsd > PUBLIC_BETA_RISK_CAPS_USD.maxDailyLossUsd) {
    reasonCodes.push("DEGEN_RISK_CAP_EXCEEDED");
    warnings.push(`maxDailyLossUsd exceeds Public Beta daily loss USD ${PUBLIC_BETA_RISK_CAPS_USD.maxDailyLossUsd}`);
  }
  if (config.maxOpenExposureUsd > PUBLIC_BETA_RISK_CAPS_USD.maxOpenExposureUsd) {
    reasonCodes.push("DEGEN_RISK_CAP_EXCEEDED");
    warnings.push(`maxOpenExposureUsd exceeds Public Beta open exposure USD ${PUBLIC_BETA_RISK_CAPS_USD.maxOpenExposureUsd}`);
  }
  if (config.maxSlippageBps > DEGEN_PUBLIC_BETA_MAX_SLIPPAGE_BPS) {
    reasonCodes.push("DEGEN_SLIPPAGE_EXCEEDED");
    warnings.push(`maxSlippageBps exceeds Public Beta max slippage ${DEGEN_PUBLIC_BETA_MAX_SLIPPAGE_BPS} bps`);
  }

  return {
    ok: reasonCodes.length === 0,
    reasonCodes: Array.from(new Set(reasonCodes)),
    riskConfigHash: reasonCodes.length === 0 ? degenRiskConfigHash(config) : undefined,
    requiresClientSignature: true,
    warnings,
  };
}

export function createTradeIntent(input: CreateTradeIntentInput, now: () => Date = () => new Date()): TradeIntent {
  assertNoDegenPrivateKeyPayload(input.payload ?? {});
  if (input.backendSigning) {
    throw new DegenModeError("DEGEN_BACKEND_SIGNING_FORBIDDEN", "backend signing is never allowed for degen agents");
  }
  if (input.backendCustody) {
    throw new DegenModeError("DEGEN_BACKEND_CUSTODY_FORBIDDEN", "backend custody is never allowed for degen agents");
  }
  if (!/^\d+$/.test(input.maxInputAmountAtomic) || BigInt(input.maxInputAmountAtomic) <= 0n) {
    throw new DegenModeError("DEGEN_AMOUNT_INVALID", "maxInputAmountAtomic must be a positive atomic string");
  }
  if (input.minOutputAmountAtomic !== undefined && (!/^\d+$/.test(input.minOutputAmountAtomic) || BigInt(input.minOutputAmountAtomic) < 0n)) {
    throw new DegenModeError("DEGEN_AMOUNT_INVALID", "minOutputAmountAtomic must be an unsigned atomic string");
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > DEGEN_PUBLIC_BETA_MAX_SLIPPAGE_BPS) {
    throw new DegenModeError("DEGEN_SLIPPAGE_EXCEEDED", `slippageBps must be between 0 and ${DEGEN_PUBLIC_BETA_MAX_SLIPPAGE_BPS}`);
  }

  const live = isLiveDegenMode(input.mode);
  if (live && !input.ownerWallet?.trim()) {
    throw new DegenModeError("DEGEN_OWNER_WALLET_REQUIRED", "live degen intents require a user-owned wallet");
  }
  if (live && !input.riskConfig) {
    throw new DegenModeError("DEGEN_RISK_CONFIG_REQUIRED", "live degen intents require ape budget, max pain, and kill switch risk config");
  }

  let riskConfigHash = "none";
  if (input.riskConfig) {
    const risk = validateDegenRiskConfig(input.riskConfig);
    if (!risk.ok) {
      throw new DegenModeError(risk.reasonCodes[0] ?? "DEGEN_RISK_CONFIG_INVALID", risk.warnings.join("; "));
    }
    riskConfigHash = risk.riskConfigHash!;
    if (input.estimatedTradeUsd !== undefined && input.estimatedTradeUsd > input.riskConfig.maxTradeUsd) {
      throw new DegenModeError("DEGEN_RISK_CAP_EXCEEDED", "estimatedTradeUsd exceeds maxTradeUsd");
    }
    if (input.slippageBps > input.riskConfig.maxSlippageBps) {
      throw new DegenModeError("DEGEN_SLIPPAGE_EXCEEDED", "trade slippage exceeds risk profile maxSlippageBps");
    }
  }

  const adapter = DEGEN_EXECUTION_ADAPTERS[input.venue];
  if (!adapter) {
    throw new DegenModeError("DEGEN_UNSUPPORTED_LIVE_SUBMIT", `unsupported degen execution venue ${input.venue}`);
  }
  if (input.mode === "CAPPED_AUTO_LIVE" && !adapter.capabilities.includes("CAPPED_AUTO_INTENT_GATED")) {
    throw new DegenModeError("DEGEN_UNSUPPORTED_LIVE_SUBMIT", `${input.venue} does not expose capped auto-live intent support`);
  }
  if (input.mode === "CAPPED_AUTO_LIVE" && !input.adapterGateRef?.trim()) {
    throw new DegenModeError("DEGEN_LIVE_ADAPTER_GATE_REQUIRED", "capped auto-live requires an explicit adapter gate reference");
  }

  return {
    intentId: input.intentId ?? `degen-intent-${cryptoRandomId()}`,
    agentId: input.agentId,
    ownerWallet: input.ownerWallet ?? "",
    venue: input.venue,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    marketId: input.marketId,
    side: input.side,
    maxInputAmountAtomic: input.maxInputAmountAtomic,
    minOutputAmountAtomic: input.minOutputAmountAtomic,
    slippageBps: input.slippageBps,
    mode: input.mode,
    riskConfigHash,
    requiresClientSignature: live,
    status: "PROPOSED",
    createdAt: now().toISOString(),
  };
}

export function getDegenExecutionAdapter(venue: ExecutionVenue): DegenExecutionAdapter {
  return DEGEN_EXECUTION_ADAPTERS[venue];
}

export const DEGEN_AGENT_TEMPLATES: DegenAgentTemplate[] = [
  {
    slug: "fresh-pair-goblin",
    name: "Fresh Pair Goblin",
    category: "fresh-pair",
    degenPitch: "Watch fresh Solana pairs without handing anyone your keys.",
    whatItDoes: ["Tracks new token/pair noise", "Flags liquidity, volume, age, holder, and creator-wallet risk", "Creates signal or user-confirmed intents only"],
    defaultMode: "SIGNAL_ONLY",
    venue: "PUMPFUN",
    walletModel: "NONE_REQUIRED",
    backendCustody: false,
    backendSigning: false,
    receiptBehavior: { receiptRequired: true, bindsRiskConfig: true, bindsTradeIntent: true },
    rejectedAlgoatPatterns: ["no PumpPortal API-key execution", "no browser localStorage private key", "no auto-buy by default"],
    cursorPrompt: "Build a Fresh Pair Goblin agent that watches Solana launches, scores risk, emits paid alerts, and never stores private keys.",
  },
  {
    slug: "copy-the-chad-safe",
    name: "Copy The Chad Safe",
    category: "copy-follow",
    degenPitch: "Copy entries with max pain rules instead of blind ape mode.",
    whatItDoes: ["Copies selected wallets/agents", "Supports entry filters, TP/SL, daily caps, and open exposure caps", "Creates copied lots for receipt-bound alpha fees"],
    defaultMode: "USER_CONFIRMED_LIVE",
    venue: "JUPITER",
    walletModel: "CLIENT_SIDE_USER_OWNED",
    backendCustody: false,
    backendSigning: false,
    defaultRiskConfig: {
      maxTradeUsd: 25,
      maxDailySpendUsd: 100,
      maxDailyLossUsd: 50,
      maxOpenExposureUsd: 150,
      maxSlippageBps: 1_000,
      takeProfitBps: 2_000,
      stopLossBps: 1_000,
      maxTradesPerHour: 6,
    },
    receiptBehavior: { receiptRequired: true, bindsRiskConfig: true, bindsTradeIntent: true },
    rejectedAlgoatPatterns: ["no uncapped auto-copy", "no success fee on loss", "no fake PnL"],
    cursorPrompt: "Build a Copy The Chad agent with client-side signing, max pain risk rules, copied lots, and no win/no alpha fee.",
  },
  {
    slug: "rug-radar-signal",
    name: "Rug Radar Signal",
    category: "risk-signal",
    degenPitch: "Risk siren for coins that start smelling cooked.",
    whatItDoes: ["Flags liquidity drops", "Flags creator sells, holder concentration, authority risk, and abnormal volume", "Never claims guaranteed rug detection"],
    defaultMode: "WATCH_ONLY",
    venue: "NONE",
    walletModel: "NONE_REQUIRED",
    backendCustody: false,
    backendSigning: false,
    receiptBehavior: { receiptRequired: true, bindsRiskConfig: false, bindsTradeIntent: false },
    rejectedAlgoatPatterns: ["no guaranteed-profit claim", "no guaranteed-rug claim", "no manipulation calls"],
    cursorPrompt: "Build a Rug Radar signal agent that produces paid risk notes and never executes trades.",
  },
  {
    slug: "paper-ape-lab",
    name: "Paper Ape Lab",
    category: "paper-lab",
    degenPitch: "Let degens test the strategy before they donate to the trenches.",
    whatItDoes: ["Runs simulated trades", "Shows PnL, ROI, average entry, max drawdown, and sample-size badges", "Marks all demo data as simulated"],
    defaultMode: "PAPER_SIM",
    venue: "NONE",
    walletModel: "NONE_REQUIRED",
    backendCustody: false,
    backendSigning: false,
    receiptBehavior: { receiptRequired: true, bindsRiskConfig: false, bindsTradeIntent: false },
    rejectedAlgoatPatterns: ["no fake live PnL", "no in-sample paper replay as proof of edge"],
    cursorPrompt: "Build a Paper Ape Lab with simulated PnL, sample-size warnings, and no live trading path.",
  },
];

export function listDegenAgentTemplates(): DegenAgentTemplate[] {
  return structuredClone(DEGEN_AGENT_TEMPLATES);
}

function cryptoRandomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
