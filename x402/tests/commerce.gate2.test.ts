import { describe, expect, it } from "vitest";
import { stableHash } from "../src/common/stable.js";
import { PolicyEngine, normalizePolicyInput } from "../src/policy/engine.js";
import { assertNoRawPii } from "../src/privacy/pii.js";
import { PrivacyRequestService } from "../src/privacy/requests.js";
import { hashReceiptV1, verifyReceiptV1, ReceiptV1 } from "../src/proof/receiptV1.js";
import { TaxAggregator } from "../src/tax/engine.js";
import { MarketEventPrivacyService } from "../src/eventPrivacy/access.js";
import { GovernanceService } from "../src/governance/service.js";

const fixedNow = () => new Date("2026-05-15T00:00:00.000Z");

function basePolicy() {
  return {
    actor: { jurisdictionFlags: [] },
    listing: {
      category: "ai_inference",
      capabilityTags: ["inference"],
      riskTier: "LOW" as const,
      physicalGoods: false,
      regulatedGoods: false,
      publicMarketplace: true,
    },
    transaction: { action: "QUOTE" as const },
    system: {
      emergencyPaused: false,
      marketplacePaused: false,
      finalizePaused: false,
      policyVersion: "policy-v1",
    },
  };
}

describe("Gate 2 policy, tax, privacy, event access, and governance", () => {
  it("normalizes missing policy signals to UNKNOWN/MISSING and keeps decision hash stable", () => {
    const normalized = normalizePolicyInput(basePolicy());
    expect(normalized.actor.sanctionsScreeningStatus).toBe("UNKNOWN");
    expect(normalized.actor.kycStatus).toBe("UNKNOWN");
    expect(normalized.actor.kybStatus).toBe("UNKNOWN");
    expect(normalized.actor.taxProfileStatus).toBe("MISSING");
    expect(normalized.compliance.taxThresholdStatus).toBe("UNKNOWN");

    const engine = new PolicyEngine({ now: fixedNow });
    const a = engine.decide(basePolicy());
    const b = engine.decide(basePolicy());
    expect(a.decisionId).toBe(b.decisionId);
    expect(a.policyVersion).toBe("policy-v1");
  });

  it("blocks sanctions, restricted categories, public regulated goods, and tax-gated payouts", () => {
    const engine = new PolicyEngine({ now: fixedNow });
    expect(engine.decide({
      ...basePolicy(),
      actor: { jurisdictionFlags: [], sanctionsScreeningStatus: "HIT" },
    }).state).toBe("BLOCK");

    expect(engine.decide({
      ...basePolicy(),
      listing: { ...basePolicy().listing, category: "gambling" },
    }).state).toBe("BLOCK");

    expect(engine.decide({
      ...basePolicy(),
      listing: { ...basePolicy().listing, regulatedGoods: true },
    }).state).toBe("BLOCK");

    const payout = engine.decide({
      ...basePolicy(),
      actor: { jurisdictionFlags: [], taxProfileStatus: "MISSING" },
      transaction: { action: "PAYOUT" },
      compliance: {
        taxReportingRequired: true,
        taxThresholdStatus: "ABOVE_THRESHOLD",
        amlMonitoringFlags: [],
        ofacFlags: [],
        reviewReasonCodes: [],
      },
    });
    expect(payout.state).toBe("BLOCK");
    expect(payout.reasonCodes).toContain("BLOCK_TAX_PROFILE_REQUIRED_FOR_PAYOUT");
  });

  it("creates PII-free policy audit events and rejects PII in immutable receipts", () => {
    const engine = new PolicyEngine({ now: fixedNow });
    const decision = engine.decide(basePolicy());
    expect(() => assertNoRawPii(engine.auditEvent(decision))).not.toThrow();

    const receipt: ReceiptV1 = {
      receiptVersion: "receipt-v1",
      quoteId: "q1",
      commitId: "c1",
      payer: "buyer-pseudonym",
      seller: "seller-profile",
      listingManifestHash: stableHash("manifest"),
      requestDigest: stableHash("request"),
      responseDigest: stableHash("response"),
      paymentProofDigest: stableHash("payment"),
      settlementOptionHash: stableHash("settlement"),
      feeWaterfallHash: stableHash("fees"),
      policyDecisionHash: decision.decisionId,
      fulfillmentStatus: "FULFILLED",
      timestamp: fixedNow().toISOString(),
      anchorStatus: "LOCAL_ONLY",
    };
    expect(verifyReceiptV1(receipt, { responseDigest: receipt.responseDigest })).toBe(true);
    expect(() => hashReceiptV1({ ...receipt, payer: "buyer@example.com" })).toThrow(/PII_FORBIDDEN/);
  });

  it("tracks seller tax aggregates without erasing gross history on refunds", () => {
    const tax = new TaxAggregator([{
      jurisdiction: "US",
      grossPaymentsAtomic: "1000",
      transactionCount: 2,
      nearThresholdRatio: 0.8,
    }]);
    tax.record({
      sellerProfileId: "seller-1",
      receiptId: "r1",
      calendarYear: 2026,
      grossAmountAtomic: "600",
      feeAmountAtomic: "60",
      refundAmountAtomic: "600",
      jurisdiction: "US",
    });
    tax.record({
      sellerProfileId: "seller-1",
      receiptId: "r2",
      calendarYear: 2026,
      grossAmountAtomic: "600",
      feeAmountAtomic: "60",
      jurisdiction: "US",
    });
    const aggregate = tax.aggregate("seller-1", 2026);
    expect(aggregate.grossPayments).toBe("1200");
    expect(aggregate.refunds).toBe("600");
    expect(aggregate.thresholdStatus).toBe("NEAR_THRESHOLD");
    expect(tax.canPayout({
      sellerProfileId: "seller-1",
      taxIdStatus: "NOT_COLLECTED",
      dac7Status: "NOT_APPLICABLE",
    }, { ...aggregate, thresholdStatus: "ABOVE_THRESHOLD" }).ok).toBe(false);
    expect(JSON.stringify(tax.exportAggregate({
      sellerProfileId: "seller-1",
      taxIdStatus: "VALIDATED",
    }, aggregate))).not.toContain("buyer");
  });

  it("handles erasure on mutable records while immutable receipt references remain usable", () => {
    const privacy = new PrivacyRequestService(fixedNow);
    privacy.putPersonalRecord({
      actorId: "actor-1",
      encryptedPayload: "ciphertext",
      piiHash: stableHash("actor@example.com"),
      legalHold: false,
    });
    const request = privacy.openRequest({
      subjectActorId: "actor-1",
      type: "ERASURE",
      region: "EU",
      affectedTables: ["seller_profiles"],
      immutableReferences: ["receipt:abc"],
    });
    const processed = privacy.processErasure(request.requestId);
    expect(processed.status).toBe("COMPLETED");
    expect(privacy.exportSubject("actor-1")).toMatchObject({
      personalRecord: { actorId: "actor-1", deletedAt: fixedNow().toISOString() },
    });
  });

  it("protects raw transaction graph and thresholds public aggregates", () => {
    const service = new MarketEventPrivacyService([{
      eventType: "PAYMENT_VERIFIED",
      defaultVisibility: "COUNTERPARTY_VISIBLE",
      aggregationThreshold: 3,
      allowedRoles: ["admin", "compliance"],
      redactedFields: ["buyerActorId"],
    }]);
    const event = {
      eventId: "e1",
      eventType: "PAYMENT_VERIFIED",
      buyerActorId: "buyer-1",
      sellerProfileId: "seller-1",
      payload: { buyerActorId: "buyer-1", latencyMs: 123 },
    };
    expect(service.canViewRaw(event, { roles: [] })).toBe(false);
    expect(service.canViewRaw(event, { actorId: "buyer-1", roles: [] })).toBe(true);
    expect(service.canViewRaw(event, { sellerProfileId: "seller-2", roles: [] })).toBe(false);
    expect(service.redact(event, { sellerProfileId: "seller-2", roles: [] }).payload.buyerActorId).toBe("REDACTED");
    expect(service.publicAggregate([1, 2], 3).visible).toBe(false);
    expect(service.publicAggregate([1, 2, 3], 3).visible).toBe(true);
  });

  it("requires denylist evidence and resolves appeals through audited governance actions", () => {
    const governance = new GovernanceService(fixedNow);
    expect(() => governance.addDenylistEntry({
      subjectType: "LISTING",
      subjectValue: "listing-1",
      reasonCode: "",
      evidenceRefs: [],
      severity: "HIGH",
      createdBy: "admin-1",
    })).toThrow(/reason code and evidence/);

    const entry = governance.addDenylistEntry({
      subjectType: "LISTING",
      subjectValue: "listing-1",
      reasonCode: "restricted_goods",
      evidenceRefs: ["evidence:1"],
      severity: "HIGH",
      createdBy: "admin-1",
    });
    expect(entry.status).toBe("ACTIVE");

    const appeal = governance.openAppeal({
      subjectType: "LISTING",
      subjectId: "listing-1",
      policyDecisionId: "decision-1",
      reason: "wrong category",
      evidenceRefs: ["seller-proof:1"],
    });
    expect(governance.resolveAppeal(appeal.appealId, "reviewer-1", true, "evidence accepted", ["appeal_reviewer"]).status).toBe("APPROVED");
    expect(governance.history().map((event) => event.action)).toContain("policy.appeal.approve");
  });
});
