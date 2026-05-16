import { parseAtomic, toAtomicString } from "../feePolicy.js";
import { stableHash } from "../common/stable.js";

export type FeeKind = "provider" | "platform" | "affiliate" | "alpha" | "network" | "refund_reserve";

export interface LegacyFeeLine {
  kind: FeeKind;
  label: string;
  amountAtomic: string;
  recipient: string;
  basis: string;
  capAtomic?: string;
  rounding: "floor" | "ceil" | "nearest";
  refundBehavior: "refundable" | "non_refundable" | "pro_rata";
}

export interface FeeWaterfall {
  grossAmount: string;
  token: string;
  providerAmount: string;
  platformFee: string;
  affiliateFee: string;
  alphaFee: string;
  networkFeeEstimate?: string;
  refundReserve?: string;
  totalCharged: string;
  buyerVisibleBreakdown: LegacyFeeLine[];
  sellerVisibleBreakdown: LegacyFeeLine[];
  noDoubleChargeKey: string;
}

export interface FeeWaterfallInput {
  grossAmount: string;
  token: string;
  providerRecipient: string;
  platformFeeBps?: number;
  platformRecipient?: string;
  affiliateFeeBps?: number;
  affiliateRecipient?: string;
  alphaFeeAtomic?: string;
  alphaRecipient?: string;
  networkFeeEstimate?: string;
  refundReserve?: string;
  noDoubleChargeScope: string;
}

function bps(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

export function buildFeeWaterfall(input: FeeWaterfallInput): FeeWaterfall {
  const gross = parseAtomic(input.grossAmount);
  const platform = input.platformRecipient ? bps(gross, input.platformFeeBps ?? 0) : 0n;
  const affiliate = input.affiliateRecipient ? bps(gross, input.affiliateFeeBps ?? 0) : 0n;
  const alpha = input.alphaRecipient ? parseAtomic(input.alphaFeeAtomic ?? "0") : 0n;
  const network = parseAtomic(input.networkFeeEstimate ?? "0");
  const reserve = parseAtomic(input.refundReserve ?? "0");
  const totalFees = platform + affiliate + alpha;
  if (totalFees > gross) {
    throw new Error("fee waterfall exceeds gross amount");
  }
  const provider = gross - totalFees;
  const lines: LegacyFeeLine[] = [
    {
      kind: "provider",
      label: "Provider amount",
      amountAtomic: toAtomicString(provider),
      recipient: input.providerRecipient,
      basis: "gross minus explicit fee lines",
      rounding: "floor",
      refundBehavior: "pro_rata",
    },
  ];
  if (platform > 0n && input.platformRecipient) {
    lines.push({
      kind: "platform",
      label: "Platform fee",
      amountAtomic: toAtomicString(platform),
      recipient: input.platformRecipient,
      basis: `${input.platformFeeBps ?? 0} bps of gross`,
      rounding: "floor",
      refundBehavior: "pro_rata",
    });
  }
  if (affiliate > 0n && input.affiliateRecipient) {
    lines.push({
      kind: "affiliate",
      label: "Affiliate fee",
      amountAtomic: toAtomicString(affiliate),
      recipient: input.affiliateRecipient,
      basis: `${input.affiliateFeeBps ?? 0} bps of gross`,
      rounding: "floor",
      refundBehavior: "pro_rata",
    });
  }
  if (alpha > 0n && input.alphaRecipient) {
    lines.push({
      kind: "alpha",
      label: "Alpha success fee",
      amountAtomic: toAtomicString(alpha),
      recipient: input.alphaRecipient,
      basis: "positive finalized copied-lot PnL only",
      rounding: "floor",
      refundBehavior: "non_refundable",
    });
  }

  return {
    grossAmount: input.grossAmount,
    token: input.token,
    providerAmount: toAtomicString(provider),
    platformFee: toAtomicString(platform),
    affiliateFee: toAtomicString(affiliate),
    alphaFee: toAtomicString(alpha),
    networkFeeEstimate: network > 0n ? toAtomicString(network) : undefined,
    refundReserve: reserve > 0n ? toAtomicString(reserve) : undefined,
    totalCharged: toAtomicString(gross + network + reserve),
    buyerVisibleBreakdown: lines,
    sellerVisibleBreakdown: lines.filter((line) => line.kind !== "network"),
    noDoubleChargeKey: stableHash({
      scope: input.noDoubleChargeScope,
      grossAmount: input.grossAmount,
      token: input.token,
      recipients: lines.map((line) => [line.kind, line.recipient, line.amountAtomic]),
    }),
  };
}

export function assertNoDuplicateFeeAssessment(existingKeys: Set<string>, waterfall: FeeWaterfall): void {
  if (existingKeys.has(waterfall.noDoubleChargeKey)) {
    throw new Error("duplicate fee assessment");
  }
}

export type FeeLineKind =
  | "PROVIDER_AMOUNT"
  | "DNA_PLATFORM_FEE"
  | "BUILDER_FEE"
  | "AFFILIATE_FEE"
  | "ALPHA_SUCCESS_FEE"
  | "NETWORK_FEE_ESTIMATE"
  | "REFUND_RESERVE";

export type FeeCollectionMode =
  | "off"
  | "display_only"
  | "seller_accrual"
  | "builder_accrual"
  | "affiliate_accrual"
  | "direct_split";

export type FeeCollectionStatus =
  | "NOT_COLLECTED"
  | "ACCRUED_NOT_COLLECTED"
  | "COLLECTED_DIRECT_SPLIT"
  | "WAIVED"
  | "MANUALLY_SETTLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

export type FeeLineBasis = "GROSS" | "PROVIDER_AMOUNT" | "PROFIT" | "UNITS" | "FIXED";

export type FeeLineRecipientType =
  | "SELLER"
  | "DNA_TREASURY"
  | "BUILDER_TREASURY"
  | "AFFILIATE_TREASURY"
  | "ALPHA_SELLER"
  | "NONE";

export type FeeRefundBehavior =
  | "REFUND_PRO_RATA"
  | "REFUND_FULL"
  | "NON_REFUNDABLE_AFTER_FULFILLMENT"
  | "MANUAL_REVIEW";

export type FeeLine = {
  id: string;
  kind: FeeLineKind;
  label: string;
  amount: string;
  token: string;
  decimals: number;
  bps?: number;
  fixedAmount?: string;
  basis: FeeLineBasis;
  recipient?: string;
  recipientType: FeeLineRecipientType;
  collectionMode: FeeCollectionMode;
  collectionStatus: FeeCollectionStatus;
  refundBehavior: FeeRefundBehavior;
  requiredForFinalize: boolean;
  proofId?: string;
  visibleToBuyer: boolean;
  visibleToSeller: boolean;
  capAmount?: string;
  capBps?: number;
  metadata?: Record<string, unknown>;
};

export type BuilderProfile = {
  builderId: string;
  displayName: string;
  slug: string;
  ownerWallet: string;
  treasuryWallet?: string;
  verifiedDomain?: string;
  verifiedStatus: "UNVERIFIED" | "DOMAIN_VERIFIED" | "ADMIN_VERIFIED";
  allowedFeeBpsMax: number;
  defaultFeeBps: number;
  status: "ACTIVE" | "REVIEW_REQUIRED" | "SUSPENDED" | "DISABLED";
  policyStrikeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BuilderFeeConfig = {
  builderId: string;
  listingId?: string;
  agentId?: string;
  enabled: boolean;
  feeBps?: number;
  fixedFeeAmount?: string;
  recipient: string;
  token: string;
  mode: "display_only" | "builder_accrual" | "direct_split";
  capAmount?: string;
  capBps?: number;
  refundBehavior: FeeRefundBehavior;
  createdAt: string;
  updatedAt: string;
};

export type FeeAccrualRecord = {
  id: string;
  feeLineId: string;
  feeKind: "DNA_PLATFORM_FEE" | "BUILDER_FEE" | "AFFILIATE_FEE" | "ALPHA_SUCCESS_FEE";
  quoteId: string;
  commitId?: string;
  receiptId?: string;
  listingId?: string;
  sellerProfileId?: string;
  builderId?: string;
  affiliateId?: string;
  token: string;
  amount: string;
  decimals: number;
  recipient: string;
  status: "ACCRUED_NOT_COLLECTED" | "WAIVED" | "MANUALLY_SETTLED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  settlementRef?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type FeeWaterfallV2 = {
  version: "fee_waterfall_v2";
  quoteId: string;
  commitId?: string;
  grossAmount: string;
  token: string;
  decimals: number;
  providerAmount: string;
  totalFees: string;
  totalBuyerCost: string;
  lines: FeeLine[];
  noDoubleChargeKey: string;
  feeWaterfallHash: string;
  createdAt: string;
};

export type SplitPaymentProofRequirement = {
  feeLineId: string;
  kind: FeeLineKind;
  recipient: string;
  amount: string;
  token: string;
  chain: string;
  required: boolean;
};

export type SplitFinalizeRequest = {
  quoteId: string;
  commitId: string;
  proofs: Array<{
    feeLineId: string;
    proof: unknown;
  }>;
};

export interface BuildFeeWaterfallV2Input {
  quoteId: string;
  commitId?: string;
  grossAmount: string;
  token: string;
  decimals: number;
  providerRecipient: string;
  platformFeeBps?: number;
  platformRecipient?: string;
  platformMode?: FeeCollectionMode;
  builderProfile?: BuilderProfile;
  builderFee?: BuilderFeeConfig;
  affiliateFeeBps?: number;
  affiliateRecipient?: string;
  affiliateId?: string;
  affiliateMode?: FeeCollectionMode;
  alphaFeeAtomic?: string;
  alphaRecipient?: string;
  networkFeeEstimate?: string;
  refundReserve?: string;
  noDoubleChargeScope: string;
  directSplitEnabled?: boolean;
  createdAt?: string;
}

function statusForMode(mode: FeeCollectionMode): FeeCollectionStatus {
  if (mode === "off") return "NOT_COLLECTED";
  if (mode === "direct_split") return "COLLECTED_DIRECT_SPLIT";
  if (mode === "display_only") return "NOT_COLLECTED";
  return "ACCRUED_NOT_COLLECTED";
}

function requireRepresentableFee(kind: FeeLineKind, gross: bigint, amount: bigint, bpsValue?: number, fixed?: string): void {
  if (gross <= 0n) {
    throw new Error("gross amount must be positive");
  }
  if ((bpsValue ?? 0) > 0 && amount === 0n) {
    throw new Error(`${kind} dust amount cannot represent required bps fee`);
  }
  if (fixed !== undefined && parseAtomic(fixed) === 0n) {
    throw new Error(`${kind} fixed fee must be positive when configured`);
  }
}

function capCheck(kind: FeeLineKind, amount: bigint, capAmount?: string, capBps?: number, gross?: bigint): void {
  if (capAmount !== undefined && amount > parseAtomic(capAmount)) {
    throw new Error(`${kind} exceeds cap amount`);
  }
  if (capBps !== undefined && gross !== undefined && amount > bps(gross, capBps)) {
    throw new Error(`${kind} exceeds cap bps`);
  }
}

function stableFeeHashPayload(waterfall: Omit<FeeWaterfallV2, "feeWaterfallHash">): unknown {
  return {
    ...waterfall,
    lines: waterfall.lines.map((line) => ({
      ...line,
      metadata: line.metadata ?? {},
    })),
  };
}

export function validateBuilderFeeConfig(
  profile: BuilderProfile | undefined,
  config: BuilderFeeConfig | undefined,
  options: { directSplitEnabled?: boolean } = {},
): string[] {
  if (!config?.enabled) return [];
  const reasons: string[] = [];
  if (!profile) reasons.push("BUILDER_PROFILE_MISSING");
  if (!config.recipient) reasons.push("BUILDER_FEE_RECIPIENT_MISSING");
  if (profile?.status === "SUSPENDED") reasons.push("BUILDER_SUSPENDED");
  if (profile?.status === "DISABLED") reasons.push("BUILDER_DISABLED");
  if ((config.feeBps ?? 0) > (profile?.allowedFeeBpsMax ?? 0)) reasons.push("BUILDER_FEE_EXCEEDS_CAP");
  if (config.mode === "direct_split" && !options.directSplitEnabled) reasons.push("BUILDER_FEE_DIRECT_SPLIT_GATED");
  return reasons;
}

export function buildFeeWaterfallV2(input: BuildFeeWaterfallV2Input): FeeWaterfallV2 {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const gross = parseAtomic(input.grossAmount);
  if (gross <= 0n) throw new Error("gross amount must be positive");

  const lines: FeeLine[] = [];
  let totalFees = 0n;

  const platformMode = input.platformMode ?? "display_only";
  const platformBps = input.platformFeeBps ?? 0;
  const platformAmount = input.platformRecipient && platformMode !== "off" ? bps(gross, platformBps) : 0n;
  if (input.platformRecipient && platformMode !== "off" && platformBps > 0 && platformAmount === 0n) {
    requireRepresentableFee("DNA_PLATFORM_FEE", gross, platformAmount, platformBps);
  }
  if (platformAmount > 0n && input.platformRecipient) {
    requireRepresentableFee("DNA_PLATFORM_FEE", gross, platformAmount, platformBps);
    totalFees += platformAmount;
    lines.push({
      id: stableHash(["fee-line", input.quoteId, "DNA_PLATFORM_FEE", input.platformRecipient]),
      kind: "DNA_PLATFORM_FEE",
      label: "DNA platform fee",
      amount: toAtomicString(platformAmount),
      token: input.token,
      decimals: input.decimals,
      bps: platformBps,
      basis: "GROSS",
      recipient: input.platformRecipient,
      recipientType: "DNA_TREASURY",
      collectionMode: platformMode,
      collectionStatus: statusForMode(platformMode),
      refundBehavior: "REFUND_PRO_RATA",
      requiredForFinalize: platformMode === "direct_split",
      visibleToBuyer: true,
      visibleToSeller: true,
    });
  }

  if (input.builderFee?.enabled) {
    const reasons = validateBuilderFeeConfig(input.builderProfile, input.builderFee, {
      directSplitEnabled: input.directSplitEnabled,
    });
    if (reasons.length > 0) {
      throw new Error(reasons.join(" "));
    }
    const mode = input.builderFee.mode;
    if (mode === "direct_split" && !input.directSplitEnabled) {
      throw new Error("BUILDER_FEE_DIRECT_SPLIT_GATED");
    }
    const builderBps = input.builderFee.feeBps ?? input.builderProfile?.defaultFeeBps ?? 0;
    const builderAmount = input.builderFee.fixedFeeAmount !== undefined
      ? parseAtomic(input.builderFee.fixedFeeAmount)
      : bps(gross, builderBps);
    requireRepresentableFee("BUILDER_FEE", gross, builderAmount, input.builderFee.fixedFeeAmount === undefined ? builderBps : undefined, input.builderFee.fixedFeeAmount);
    capCheck("BUILDER_FEE", builderAmount, input.builderFee.capAmount, input.builderFee.capBps ?? input.builderProfile?.allowedFeeBpsMax, gross);
    totalFees += builderAmount;
    lines.push({
      id: stableHash(["fee-line", input.quoteId, "BUILDER_FEE", input.builderFee.builderId, input.builderFee.recipient]),
      kind: "BUILDER_FEE",
      label: "Builder fee",
      amount: toAtomicString(builderAmount),
      token: input.token,
      decimals: input.decimals,
      bps: input.builderFee.fixedFeeAmount === undefined ? builderBps : undefined,
      fixedAmount: input.builderFee.fixedFeeAmount,
      basis: input.builderFee.fixedFeeAmount === undefined ? "GROSS" : "FIXED",
      recipient: input.builderFee.recipient,
      recipientType: "BUILDER_TREASURY",
      collectionMode: mode,
      collectionStatus: statusForMode(mode),
      refundBehavior: input.builderFee.refundBehavior,
      requiredForFinalize: mode === "direct_split",
      visibleToBuyer: true,
      visibleToSeller: true,
      capAmount: input.builderFee.capAmount,
      capBps: input.builderFee.capBps ?? input.builderProfile?.allowedFeeBpsMax,
      metadata: { builderId: input.builderFee.builderId, listingId: input.builderFee.listingId, agentId: input.builderFee.agentId },
    });
  }

  const affiliateMode = input.affiliateMode ?? "off";
  const affiliateBps = input.affiliateFeeBps ?? 0;
  if (affiliateMode !== "off" && input.affiliateRecipient && affiliateBps > 0) {
    const affiliateAmount = bps(gross, affiliateBps);
    if (affiliateAmount === 0n) {
      requireRepresentableFee("AFFILIATE_FEE", gross, affiliateAmount, affiliateBps);
    }
    requireRepresentableFee("AFFILIATE_FEE", gross, affiliateAmount, affiliateBps);
    totalFees += affiliateAmount;
    lines.push({
      id: stableHash(["fee-line", input.quoteId, "AFFILIATE_FEE", input.affiliateRecipient]),
      kind: "AFFILIATE_FEE",
      label: "Affiliate fee",
      amount: toAtomicString(affiliateAmount),
      token: input.token,
      decimals: input.decimals,
      bps: affiliateBps,
      basis: "GROSS",
      recipient: input.affiliateRecipient,
      recipientType: "AFFILIATE_TREASURY",
      collectionMode: affiliateMode,
      collectionStatus: statusForMode(affiliateMode),
      refundBehavior: "REFUND_PRO_RATA",
      requiredForFinalize: affiliateMode === "direct_split",
      visibleToBuyer: true,
      visibleToSeller: true,
      metadata: { affiliateId: input.affiliateId },
    });
  }

  const alphaAmount = input.alphaRecipient ? parseAtomic(input.alphaFeeAtomic ?? "0") : 0n;
  if (alphaAmount > 0n && input.alphaRecipient) {
    totalFees += alphaAmount;
    lines.push({
      id: stableHash(["fee-line", input.quoteId, "ALPHA_SUCCESS_FEE", input.alphaRecipient]),
      kind: "ALPHA_SUCCESS_FEE",
      label: "Alpha success fee",
      amount: toAtomicString(alphaAmount),
      token: input.token,
      decimals: input.decimals,
      basis: "PROFIT",
      recipient: input.alphaRecipient,
      recipientType: "ALPHA_SELLER",
      collectionMode: "seller_accrual",
      collectionStatus: "ACCRUED_NOT_COLLECTED",
      refundBehavior: "NON_REFUNDABLE_AFTER_FULFILLMENT",
      requiredForFinalize: false,
      visibleToBuyer: true,
      visibleToSeller: true,
    });
  }

  if (totalFees > gross) {
    throw new Error("fee waterfall exceeds gross amount");
  }
  const provider = gross - totalFees;
  if (provider < 0n) {
    throw new Error("provider amount cannot be negative");
  }

  const providerRequiresDirectSplit = lines.some((line) => line.requiredForFinalize);
  lines.unshift({
    id: stableHash(["fee-line", input.quoteId, "PROVIDER_AMOUNT", input.providerRecipient]),
    kind: "PROVIDER_AMOUNT",
    label: "Provider amount",
    amount: toAtomicString(provider),
    token: input.token,
    decimals: input.decimals,
    basis: "GROSS",
    recipient: input.providerRecipient,
    recipientType: "SELLER",
    collectionMode: "direct_split",
    collectionStatus: providerRequiresDirectSplit ? "COLLECTED_DIRECT_SPLIT" : "NOT_COLLECTED",
    refundBehavior: "REFUND_PRO_RATA",
    requiredForFinalize: providerRequiresDirectSplit,
    visibleToBuyer: true,
    visibleToSeller: true,
  });

  const noDoubleChargeKey = stableHash({
    scope: input.noDoubleChargeScope,
    quoteId: input.quoteId,
    grossAmount: input.grossAmount,
    token: input.token,
    lines: lines.map((line) => [line.kind, line.recipient, line.amount, line.collectionMode]),
  });
  const withoutHash: Omit<FeeWaterfallV2, "feeWaterfallHash"> = {
    version: "fee_waterfall_v2",
    quoteId: input.quoteId,
    commitId: input.commitId,
    grossAmount: input.grossAmount,
    token: input.token,
    decimals: input.decimals,
    providerAmount: toAtomicString(provider),
    totalFees: toAtomicString(totalFees),
    totalBuyerCost: input.grossAmount,
    lines,
    noDoubleChargeKey,
    createdAt,
  };
  return {
    ...withoutHash,
    feeWaterfallHash: stableHash(stableFeeHashPayload(withoutHash)),
  };
}

export function createFeeAccrualRecords(waterfall: FeeWaterfallV2, input: {
  commitId?: string;
  receiptId?: string;
  listingId?: string;
  sellerProfileId?: string;
  createdAt?: string;
} = {}): FeeAccrualRecord[] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return waterfall.lines
    .filter((line) => line.collectionStatus === "ACCRUED_NOT_COLLECTED")
    .filter((line): line is FeeLine & { recipient: string } => Boolean(line.recipient))
    .filter((line) => ["DNA_PLATFORM_FEE", "BUILDER_FEE", "AFFILIATE_FEE", "ALPHA_SUCCESS_FEE"].includes(line.kind))
    .map((line) => ({
      id: stableHash(["fee-accrual", waterfall.quoteId, waterfall.commitId ?? "", input.receiptId ?? "", line.id]),
      feeLineId: line.id,
      feeKind: line.kind as FeeAccrualRecord["feeKind"],
      quoteId: waterfall.quoteId,
      commitId: input.commitId ?? waterfall.commitId,
      receiptId: input.receiptId,
      listingId: input.listingId,
      sellerProfileId: input.sellerProfileId,
      builderId: typeof line.metadata?.builderId === "string" ? line.metadata.builderId : undefined,
      affiliateId: typeof line.metadata?.affiliateId === "string" ? line.metadata.affiliateId : undefined,
      token: waterfall.token,
      amount: line.amount,
      decimals: line.decimals,
      recipient: line.recipient,
      status: "ACCRUED_NOT_COLLECTED",
      notes: "Non-custodial accrual only. No auto-sweep, backend custody, or hidden fee collection.",
      createdAt,
      updatedAt: createdAt,
    }));
}

export function buildSplitPaymentRequirements(waterfall: FeeWaterfallV2, chain: string): SplitPaymentProofRequirement[] {
  return waterfall.lines
    .filter((line) => line.requiredForFinalize)
    .filter((line): line is FeeLine & { recipient: string } => Boolean(line.recipient))
    .map((line) => ({
      feeLineId: line.id,
      kind: line.kind,
      recipient: line.recipient,
      amount: line.amount,
      token: waterfall.token,
      chain,
      required: true,
    }));
}

export function assertDirectSplitGate(enabled: boolean, gateRef?: string): void {
  if (!enabled || !gateRef) {
    throw new Error("direct split fee gate disabled");
  }
}

export function validateSplitFinalizeRequest(input: {
  waterfall: FeeWaterfallV2;
  request: SplitFinalizeRequest;
  chain: string;
  directSplitEnabled: boolean;
  gateRef?: string;
  proofResults: Array<{
    feeLineId: string;
    chain: string;
    token: string;
    recipient: string;
    amount: string;
    replayed?: boolean;
    quoteId?: string;
  }>;
}): { ok: true } {
  assertDirectSplitGate(input.directSplitEnabled, input.gateRef);
  if (input.request.quoteId !== input.waterfall.quoteId) {
    throw new Error("proof for different quote");
  }
  const requirements = buildSplitPaymentRequirements(input.waterfall, input.chain);
  const seen = new Set<string>();
  for (const required of requirements) {
    const proof = input.proofResults.find((item) => item.feeLineId === required.feeLineId);
    if (!proof) throw new Error(`missing ${required.kind} proof`);
    if (seen.has(proof.feeLineId)) throw new Error("proof reused across fee lines");
    seen.add(proof.feeLineId);
    if (proof.replayed) throw new Error("proof replay");
    if (proof.quoteId && proof.quoteId !== input.waterfall.quoteId) throw new Error("proof for different quote");
    if (proof.chain !== required.chain) throw new Error("wrong chain");
    if (proof.token !== required.token) throw new Error("wrong token");
    if (proof.recipient !== required.recipient) throw new Error("wrong recipient");
    if (parseAtomic(proof.amount) < parseAtomic(required.amount)) throw new Error("underpay");
  }
  return { ok: true };
}

export function assertNoDuplicateFeeAssessmentV2(existingKeys: Set<string>, waterfall: FeeWaterfallV2): void {
  if (existingKeys.has(waterfall.noDoubleChargeKey)) {
    throw new Error("duplicate fee assessment");
  }
}
