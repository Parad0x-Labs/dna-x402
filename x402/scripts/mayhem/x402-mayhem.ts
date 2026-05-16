import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { assertNoBundleCycle, enforceOutstandingCommitLimit, sealedBidHash, trustedExternalVolume, verifySealedBidReveal } from "../../src/economics/abuse.js";
import { buildFeeWaterfall, assertNoDuplicateFeeAssessment } from "../../src/fees/waterfall.js";
import { GovernanceService } from "../../src/governance/service.js";
import { evaluateAgentSpend } from "../../src/permissions/agentSpendPolicy.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { assertNoRawPii } from "../../src/privacy/pii.js";
import { PrivacyRequestService } from "../../src/privacy/requests.js";
import { hashReceiptV1 } from "../../src/proof/receiptV1.js";
import { SettlementRegistry } from "../../src/settlement/registry.js";
import { TaxAggregator } from "../../src/tax/engine.js";
import { createReplayKey, ReplayStore } from "../../src/verifier/replayStore.js";
import { signWebhookPayload, verifyWebhookPayload, WebhookReplayStore } from "../../src/webhooks/signed.js";

export interface MayhemResult {
  name: string;
  ok: boolean;
  detail: string;
}

function expectThrow(name: string, fn: () => void): MayhemResult {
  try {
    fn();
    return { name, ok: false, detail: "attack succeeded unexpectedly" };
  } catch (error) {
    return { name, ok: true, detail: error instanceof Error ? error.message : String(error) };
  }
}

function expectSafe(name: string, fn: () => void): MayhemResult {
  try {
    fn();
    return { name, ok: true, detail: "safe" };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function runMayhem(): MayhemResult[] {
  const now = new Date("2026-05-15T00:00:00.000Z");
  const results: MayhemResult[] = [];

  results.push(expectThrow("commit abandonment limit", () => enforceOutstandingCommitLimit([
    { buyerId: "attacker", paid: false, expiresAt: "2026-05-15T01:00:00.000Z" },
    { buyerId: "attacker", paid: false, expiresAt: "2026-05-15T01:00:00.000Z" },
  ], "attacker", 2, now)));

  results.push(expectSafe("replay and concurrent replay", () => {
    const replay = new ReplayStore();
    const key = createReplayKey({ shopId: "s", txSig: "tx", amountAtomic: "1", recipient: "r", mint: "m" });
    assert.equal(replay.consume(key, now.getTime()), true);
    assert.equal(replay.consume(key, now.getTime()), false);
  }));

  results.push(expectThrow("sealed bid mismatch", () => verifySealedBidReveal({
    bidderId: "b",
    commitmentHash: sealedBidHash({ bidderId: "b", amountAtomic: "100", salt: "s" }),
  }, { bidderId: "b", amountAtomic: "99", salt: "s" })));

  results.push(expectThrow("bundle circular dependency", () => assertNoBundleCycle([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ], 4)));

  results.push(expectSafe("wash trade ignored", () => {
    assert.equal(trustedExternalVolume([
      { buyerWallet: "w1", sellerWallet: "w1", amountAtomic: "100" },
      { buyerWallet: "w2", sellerWallet: "w3", amountAtomic: "200" },
    ]), "200");
  }));

  results.push(expectSafe("policy restricted listing block", () => {
    const decision = new PolicyEngine({ now: () => now }).decide({
      actor: { jurisdictionFlags: [] },
      listing: {
        category: "gambling",
        capabilityTags: ["sports_betting"],
        riskTier: "HIGH",
        physicalGoods: false,
        regulatedGoods: false,
        publicMarketplace: true,
      },
      transaction: { action: "PUBLISH" },
      system: { emergencyPaused: false, marketplacePaused: false, finalizePaused: false, policyVersion: "policy-v1" },
    });
    assert.equal(decision.state, "BLOCK");
  }));

  results.push(expectSafe("agent overspend and revoked session", () => {
    const decision = evaluateAgentSpend({
      agentId: "agent",
      ownerWallet: "owner",
      allowedCapabilities: ["data"],
      blockedCapabilities: ["gambling"],
      maxSpendPerCall: "100",
      maxSpendPerDay: "100",
      maxSpendPerSeller: "100",
      maxBundleDepth: 1,
      allowedSettlementModes: ["transfer"],
      allowedTokens: ["USDC"],
      expiresAt: "2026-05-16T00:00:00.000Z",
      requiresHumanApprovalAbove: "50",
      canUseNetting: false,
      canUseStreaming: false,
      canDelegateToSubagents: false,
      revokedAt: now.toISOString(),
    }, {
      agentId: "agent",
      sellerId: "seller",
      capability: "gambling",
      amountAtomic: "101",
      token: "USDC",
      settlementMode: "netting",
      bundleDepth: 2,
      spentTodayAtomic: "0",
      spentWithSellerAtomic: "0",
      now,
    });
    assert.equal(decision.ok, false);
    assert.ok(decision.reasonCodes.includes("revoked_session"));
  }));

  results.push(expectThrow("webhook replay", () => {
    const store = new WebhookReplayStore();
    const envelope = signWebhookPayload("secret", {
      idempotencyKey: "wh-1",
      event: "receipt.issued",
      timestamp: now.toISOString(),
      payload: { receiptId: "r1" },
    });
    verifyWebhookPayload("secret", envelope, store, now);
    verifyWebhookPayload("secret", envelope, store, now);
  }));

  results.push(expectThrow("fee double charge", () => {
    const waterfall = buildFeeWaterfall({
      grossAmount: "1000",
      token: "USDC",
      providerRecipient: "seller",
      platformFeeBps: 100,
      platformRecipient: "platform",
      noDoubleChargeScope: "receipt-1",
    });
    assertNoDuplicateFeeAssessment(new Set([waterfall.noDoubleChargeKey]), waterfall);
  }));

  results.push(expectSafe("depeg and unavailable chain quote removal", () => {
    const registry = new SettlementRegistry([
      { chain: "solana", available: true, riskFlags: [] },
      { chain: "base", available: false, riskFlags: ["CHAIN_UNAVAILABLE"] },
    ], [
      { chain: "solana", tokenSymbol: "USDC", tokenAddressOrMint: "sol-usdc", depegFlag: "BLOCK" },
    ]);
    assert.equal(registry.availableOptions([
      { chain: "solana", tokenSymbol: "USDC", tokenAddressOrMint: "sol-usdc", amount: "1", recipient: "r", expiry: now.toISOString(), verifier: "v", bridgeRequired: false, riskFlags: [] },
      { chain: "base", tokenSymbol: "USDC", tokenAddressOrMint: "base-usdc", amount: "1", recipient: "r", expiry: now.toISOString(), verifier: "v", bridgeRequired: true, riskFlags: [] },
    ]).length, 0);
  }));

  results.push(expectSafe("tax threshold without profile blocks payout", () => {
    const tax = new TaxAggregator([{ jurisdiction: "US", grossPaymentsAtomic: "100", transactionCount: 1, nearThresholdRatio: 0.8 }]);
    tax.record({ sellerProfileId: "seller", receiptId: "r", calendarYear: 2026, grossAmountAtomic: "101", feeAmountAtomic: "0", jurisdiction: "US" });
    tax.record({ sellerProfileId: "seller", receiptId: "r2", calendarYear: 2026, grossAmountAtomic: "1", feeAmountAtomic: "0", jurisdiction: "US" });
    const aggregate = tax.aggregate("seller", 2026);
    assert.equal(tax.canPayout({ sellerProfileId: "seller", taxIdStatus: "NOT_COLLECTED" }, aggregate).ok, false);
  }));

  results.push(expectThrow("PII in receipt", () => hashReceiptV1({
    receiptVersion: "receipt-v1",
    quoteId: "q",
    commitId: "c",
    payer: "buyer@example.com",
    seller: "seller",
    listingManifestHash: "manifest",
    requestDigest: "request",
    responseDigest: "response",
    paymentProofDigest: "payment",
    settlementOptionHash: "settlement",
    feeWaterfallHash: "fee",
    policyDecisionHash: "policy",
    fulfillmentStatus: "FULFILLED",
    timestamp: now.toISOString(),
    anchorStatus: "LOCAL_ONLY",
  })));

  results.push(expectThrow("PII in audit event", () => assertNoRawPii({ email: "buyer@example.com" })));

  results.push(expectSafe("GDPR erasure preserves immutable reference", () => {
    const privacy = new PrivacyRequestService(() => now);
    privacy.putPersonalRecord({ actorId: "actor", encryptedPayload: "cipher", piiHash: "hash", legalHold: false });
    const request = privacy.openRequest({ subjectActorId: "actor", type: "ERASURE", region: "EU", affectedTables: ["profile"], immutableReferences: ["receipt:r"] });
    assert.equal(privacy.processErasure(request.requestId).status, "COMPLETED");
  }));

  results.push(expectThrow("denylist without evidence", () => new GovernanceService(() => now).addDenylistEntry({
    subjectType: "LISTING",
    subjectValue: "listing",
    reasonCode: "restricted",
    evidenceRefs: [],
    severity: "HIGH",
    createdBy: "admin",
  })));

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = runMayhem();
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
