import { describe, expect, it } from "vitest";
import { assertNoBundleCycle, enforceOutstandingCommitLimit, reservationLocksCapacity, sealedBidHash, trustedExternalVolume, verifySealedBidReveal } from "../src/economics/abuse.js";
import {
  assertNoDuplicateFeeAssessment,
  assertNoDuplicateFeeAssessmentV2,
  buildFeeWaterfall,
  buildFeeWaterfallV2,
  buildSplitPaymentRequirements,
  createFeeAccrualRecords,
  validateBuilderFeeConfig,
  validateSplitFinalizeRequest,
  type BuilderFeeConfig,
  type BuilderProfile,
} from "../src/fees/waterfall.js";
import { evaluateAgentSpend, AgentSpendPolicy } from "../src/permissions/agentSpendPolicy.js";
import { SettlementRegistry, SettlementOption } from "../src/settlement/registry.js";
import { ComputeJobStateMachine } from "../src/compute/jobs.js";

const now = new Date("2026-05-15T00:00:00.000Z");

describe("modular commerce services", () => {
  it("enforces agent spend policy and revoked sessions", () => {
    const policy: AgentSpendPolicy = {
      agentId: "agent-1",
      ownerWallet: "owner",
      allowedCapabilities: ["data_feed"],
      blockedCapabilities: ["gambling"],
      maxSpendPerCall: "1000",
      maxSpendPerDay: "2000",
      maxSpendPerSeller: "1500",
      maxBundleDepth: 2,
      allowedSettlementModes: ["transfer", "stream"],
      allowedTokens: ["USDC"],
      expiresAt: "2026-05-16T00:00:00.000Z",
      requiresHumanApprovalAbove: "800",
      canUseNetting: false,
      canUseStreaming: true,
      canDelegateToSubagents: false,
    };
    expect(evaluateAgentSpend(policy, {
      agentId: "agent-1",
      sellerId: "seller-1",
      capability: "data_feed",
      amountAtomic: "900",
      token: "USDC",
      settlementMode: "transfer",
      bundleDepth: 1,
      spentTodayAtomic: "500",
      spentWithSellerAtomic: "200",
      now,
    })).toMatchObject({ ok: true, requiresHumanApproval: true });

    expect(evaluateAgentSpend({ ...policy, revokedAt: now.toISOString() }, {
      agentId: "agent-1",
      sellerId: "seller-1",
      capability: "gambling",
      amountAtomic: "3000",
      token: "USDC",
      settlementMode: "netting",
      bundleDepth: 3,
      spentTodayAtomic: "0",
      spentWithSellerAtomic: "0",
      now,
    }).reasonCodes).toEqual(expect.arrayContaining([
      "revoked_session",
      "blocked_capability",
      "netting_not_allowed",
      "bundle_depth_exceeded",
      "per_call_limit_exceeded",
      "daily_limit_exceeded",
      "seller_limit_exceeded",
    ]));
  });

  it("builds fee waterfall, exposes no-double-charge key, and rejects duplicates", () => {
    const waterfall = buildFeeWaterfall({
      grossAmount: "10000",
      token: "USDC",
      providerRecipient: "seller",
      platformFeeBps: 100,
      platformRecipient: "platform",
      affiliateFeeBps: 50,
      affiliateRecipient: "affiliate",
      alphaFeeAtomic: "200",
      alphaRecipient: "alpha",
      noDoubleChargeScope: "receipt-1",
    });
    expect(waterfall.providerAmount).toBe("9650");
    expect(waterfall.platformFee).toBe("100");
    expect(waterfall.affiliateFee).toBe("50");
    expect(waterfall.alphaFee).toBe("200");
    expect(waterfall.buyerVisibleBreakdown.map((line) => line.kind)).toContain("alpha");
    const existing = new Set([waterfall.noDoubleChargeKey]);
    expect(() => assertNoDuplicateFeeAssessment(existing, waterfall)).toThrow(/duplicate fee/);
  });

  it("builds FeeWaterfallV2 with DNA, builder, affiliate, alpha, stable hash, and no override", () => {
    const builder: BuilderProfile = {
      builderId: "builder-1",
      displayName: "Builder One",
      slug: "builder-one",
      ownerWallet: "builder-owner",
      treasuryWallet: "builder-treasury",
      verifiedStatus: "DOMAIN_VERIFIED",
      allowedFeeBpsMax: 500,
      defaultFeeBps: 50,
      status: "ACTIVE",
      policyStrikeCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const builderFee: BuilderFeeConfig = {
      builderId: "builder-1",
      enabled: true,
      feeBps: 50,
      recipient: "builder-treasury",
      token: "USDC",
      mode: "builder_accrual",
      capBps: 500,
      refundBehavior: "REFUND_PRO_RATA",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const waterfall = buildFeeWaterfallV2({
      quoteId: "quote-1",
      grossAmount: "100000000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna-treasury",
      platformMode: "seller_accrual",
      builderProfile: builder,
      builderFee,
      affiliateFeeBps: 20,
      affiliateRecipient: "affiliate",
      affiliateMode: "affiliate_accrual",
      alphaFeeAtomic: "100000",
      alphaRecipient: "alpha",
      noDoubleChargeScope: "quote-1",
      createdAt: now.toISOString(),
    });

    expect(waterfall.version).toBe("fee_waterfall_v2");
    expect(waterfall.providerAmount).toBe("99100000");
    expect(waterfall.totalFees).toBe("900000");
    expect(waterfall.lines.map((line) => line.kind)).toEqual([
      "PROVIDER_AMOUNT",
      "DNA_PLATFORM_FEE",
      "BUILDER_FEE",
      "AFFILIATE_FEE",
      "ALPHA_SUCCESS_FEE",
    ]);
    expect(waterfall.lines.find((line) => line.kind === "DNA_PLATFORM_FEE")).toMatchObject({
      amount: "100000",
      recipient: "dna-treasury",
      visibleToBuyer: true,
    });
    expect(waterfall.lines.find((line) => line.kind === "BUILDER_FEE")).toMatchObject({
      amount: "500000",
      recipient: "builder-treasury",
      collectionStatus: "ACCRUED_NOT_COLLECTED",
    });
    const again = buildFeeWaterfallV2({
      quoteId: "quote-1",
      grossAmount: "100000000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna-treasury",
      platformMode: "seller_accrual",
      builderProfile: builder,
      builderFee,
      affiliateFeeBps: 20,
      affiliateRecipient: "affiliate",
      affiliateMode: "affiliate_accrual",
      alphaFeeAtomic: "100000",
      alphaRecipient: "alpha",
      noDoubleChargeScope: "quote-1",
      createdAt: now.toISOString(),
    });
    expect(again.feeWaterfallHash).toBe(waterfall.feeWaterfallHash);
    expect(() => assertNoDuplicateFeeAssessmentV2(new Set([waterfall.noDoubleChargeKey]), waterfall)).toThrow(/duplicate/);
  });

  it("fails closed for builder fee caps, suspended builders, negative provider, and dust fees", () => {
    const profile: BuilderProfile = {
      builderId: "builder-2",
      displayName: "Builder Two",
      slug: "builder-two",
      ownerWallet: "owner",
      treasuryWallet: "treasury",
      verifiedStatus: "UNVERIFIED",
      allowedFeeBpsMax: 100,
      defaultFeeBps: 50,
      status: "ACTIVE",
      policyStrikeCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const fee: BuilderFeeConfig = {
      builderId: "builder-2",
      enabled: true,
      feeBps: 200,
      recipient: "treasury",
      token: "USDC",
      mode: "builder_accrual",
      refundBehavior: "REFUND_PRO_RATA",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    expect(validateBuilderFeeConfig(profile, fee)).toContain("BUILDER_FEE_EXCEEDS_CAP");
    expect(validateBuilderFeeConfig({ ...profile, status: "SUSPENDED" }, { ...fee, feeBps: 50 })).toContain("BUILDER_SUSPENDED");
    expect(() => buildFeeWaterfallV2({
      quoteId: "dust",
      grossAmount: "1",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna",
      noDoubleChargeScope: "dust",
    })).toThrow(/dust amount/);
    expect(() => buildFeeWaterfallV2({
      quoteId: "too-much",
      grossAmount: "1000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 9000,
      platformRecipient: "dna",
      builderProfile: { ...profile, allowedFeeBpsMax: 2000 },
      builderFee: { ...fee, feeBps: 2000, capBps: 2000 },
      noDoubleChargeScope: "too-much",
    })).toThrow(/exceeds gross/);
  });

  it("creates receipt-bound accruals and validates gated direct split proofs", () => {
    const waterfall = buildFeeWaterfallV2({
      quoteId: "split-q",
      grossAmount: "100000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna",
      platformMode: "direct_split",
      builderProfile: {
        builderId: "builder-split",
        displayName: "Builder Split",
        slug: "builder-split",
        ownerWallet: "owner",
        treasuryWallet: "builder",
        verifiedStatus: "ADMIN_VERIFIED",
        allowedFeeBpsMax: 500,
        defaultFeeBps: 50,
        status: "ACTIVE",
        policyStrikeCount: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      builderFee: {
        builderId: "builder-split",
        enabled: true,
        feeBps: 50,
        recipient: "builder",
        token: "USDC",
        mode: "direct_split",
        refundBehavior: "REFUND_PRO_RATA",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      directSplitEnabled: true,
      noDoubleChargeScope: "split-q",
      createdAt: now.toISOString(),
    });
    const requirements = buildSplitPaymentRequirements(waterfall, "solana");
    expect(requirements.map((item) => item.kind)).toEqual(["PROVIDER_AMOUNT", "DNA_PLATFORM_FEE", "BUILDER_FEE"]);
    expect(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "split-q", commitId: "commit-1", proofs: [] },
      chain: "solana",
      directSplitEnabled: false,
      proofResults: [],
    })).toThrow(/direct split fee gate disabled/);
    expect(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "split-q", commitId: "commit-1", proofs: [] },
      chain: "solana",
      directSplitEnabled: true,
      gateRef: "docs/DNA_X402_LIVE_GATE_CHECKLISTS.md#direct-split",
      proofResults: requirements.filter((item) => item.kind !== "BUILDER_FEE").map((item) => ({
        feeLineId: item.feeLineId,
        chain: item.chain,
        token: item.token,
        recipient: item.recipient,
        amount: item.amount,
        quoteId: "split-q",
      })),
    })).toThrow(/missing BUILDER_FEE proof/);
    expect(validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "split-q", commitId: "commit-1", proofs: [] },
      chain: "solana",
      directSplitEnabled: true,
      gateRef: "docs/DNA_X402_LIVE_GATE_CHECKLISTS.md#direct-split",
      proofResults: requirements.map((item) => ({
        feeLineId: item.feeLineId,
        chain: item.chain,
        token: item.token,
        recipient: item.recipient,
        amount: item.amount,
        quoteId: "split-q",
      })),
    })).toEqual({ ok: true });

    const accrualWaterfall = buildFeeWaterfallV2({
      quoteId: "accrual-q",
      grossAmount: "100000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna",
      platformMode: "seller_accrual",
      noDoubleChargeScope: "accrual-q",
      createdAt: now.toISOString(),
    });
    const accruals = createFeeAccrualRecords(accrualWaterfall, {
      commitId: "commit-2",
      receiptId: "receipt-2",
      createdAt: now.toISOString(),
    });
    expect(accruals).toHaveLength(1);
    expect(accruals[0]).toMatchObject({
      feeKind: "DNA_PLATFORM_FEE",
      quoteId: "accrual-q",
      commitId: "commit-2",
      receiptId: "receipt-2",
      status: "ACCRUED_NOT_COLLECTED",
    });
  });

  it("removes unavailable/depegged settlement options and rejects wrong chain/token", () => {
    const options: SettlementOption[] = [
      {
        chain: "solana",
        tokenSymbol: "USDC",
        tokenAddressOrMint: "sol-usdc",
        amount: "1000",
        recipient: "seller",
        expiry: "2026-05-15T01:00:00.000Z",
        verifier: "solana-spl",
        bridgeRequired: false,
        riskFlags: [],
      },
      {
        chain: "base",
        tokenSymbol: "USDC",
        tokenAddressOrMint: "base-usdc",
        amount: "1000",
        recipient: "seller",
        expiry: "2026-05-15T01:00:00.000Z",
        verifier: "evm-erc20",
        bridgeRequired: true,
        riskFlags: [],
      },
    ];
    const registry = new SettlementRegistry([
      { chain: "solana", available: true, riskFlags: [] },
      { chain: "base", available: false, riskFlags: ["CHAIN_UNAVAILABLE"] },
    ], [
      { chain: "solana", tokenSymbol: "USDC", tokenAddressOrMint: "sol-usdc", depegFlag: "WARN" },
    ]);
    const available = registry.availableOptions(options);
    expect(available).toHaveLength(1);
    expect(available[0].riskFlags).toContain("DEPEG_WARN");
    expect(() => registry.assertPaymentMatches(options[0], {
      chain: "base",
      tokenAddressOrMint: "sol-usdc",
      recipient: "seller",
    })).toThrow(/wrong chain/);
  });

  it("covers commit abandonment, wash volume, sealed bids, bundle loops, and compute proof", () => {
    expect(reservationLocksCapacity({
      reservationId: "r1",
      buyerId: "b1",
      sellerId: "s1",
      capacityUnits: 1,
      paidHold: false,
      expiresAt: "2026-05-15T01:00:00.000Z",
    }, now)).toBe(false);
    expect(() => enforceOutstandingCommitLimit([
      { buyerId: "b1", paid: false, expiresAt: "2026-05-15T01:00:00.000Z" },
      { buyerId: "b1", paid: false, expiresAt: "2026-05-15T01:00:00.000Z" },
    ], "b1", 2, now)).toThrow(/outstanding unpaid commit/);

    expect(trustedExternalVolume([
      { buyerWallet: "a", sellerWallet: "a", amountAtomic: "1000" },
      { buyerWallet: "b", sellerWallet: "c", amountAtomic: "2000" },
    ])).toBe("2000");

    const commitmentHash = sealedBidHash({ bidderId: "b1", amountAtomic: "1000", salt: "secret" });
    expect(() => verifySealedBidReveal({ bidderId: "b1", commitmentHash }, {
      bidderId: "b1",
      amountAtomic: "900",
      salt: "secret",
    })).toThrow(/does not match/);
    expect(() => assertNoBundleCycle([{ from: "a", to: "b" }, { from: "b", to: "a" }], 3)).toThrow(/circular/);

    const machine = new ComputeJobStateMachine();
    const job = machine.create({
      providerId: "gpu-1",
      quoteId: "q1",
      paidAmountAtomic: "1000",
      timeoutAt: "2026-05-15T01:00:00.000Z",
      proof: {
        inputDigest: "input",
        environmentDigest: "env",
      },
    }, now);
    const running = machine.transition(machine.transition(machine.transition(job, "PAID", now), "QUEUED", now), "RUNNING", now);
    const completed = machine.bindOutput(running, { result: "ok" }, { logs: "clean" }, now);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.proof.outputDigest).toBeDefined();
  });
});
