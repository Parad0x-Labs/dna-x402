import { describe, expect, it } from "vitest";
import { FileSnapshotRepository } from "../src/db/adapters/fileRepository.js";
import { assertImmutableRecordSafe, checkImmutableRecordSafe } from "../src/privacy/immutableGuard.js";
import { hashReceiptV1, ReceiptV1 } from "../src/proof/receiptV1.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { GovernanceService } from "../src/governance/service.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const safeReceipt: ReceiptV1 = {
  receiptVersion: "receipt-v1",
  quoteId: "q1",
  commitId: "c1",
  payer: "actor_123",
  seller: "seller_123",
  listingManifestHash: "hash_manifest",
  requestDigest: "hash_request",
  responseDigest: "hash_response",
  paymentProofDigest: "hash_payment",
  settlementOptionHash: "hash_settlement",
  feeWaterfallHash: "hash_fee",
  policyDecisionHash: "hash_policy",
  fulfillmentStatus: "FULFILLED",
  timestamp: "2026-05-15T00:00:00.000Z",
  anchorStatus: "LOCAL_ONLY",
};

describe("immutable record PII hard write guard", () => {
  it("rejects forbidden raw data before hash/signature/write", async () => {
    expect(() => assertImmutableRecordSafe("RECEIPT", { payer: "buyer@example.com" })).toThrow(/IMMUTABLE_PII_BLOCKED/);
    expect(() => assertImmutableRecordSafe("POLICY_AUDIT_EVENT", { ipAddress: "127.0.0.1" })).toThrow(/IMMUTABLE_PII_BLOCKED/);
    expect(() => assertImmutableRecordSafe("GOVERNANCE_AUDIT_EVENT", { legalName: "Alice Buyer" })).toThrow(/IMMUTABLE_PII_BLOCKED/);
    expect(() => assertImmutableRecordSafe("ANCHOR_PAYLOAD", { taxId: "123-45-6789" })).toThrow(/IMMUTABLE_PII_BLOCKED/);
    expect(() => hashReceiptV1({ ...safeReceipt, payer: "buyer@example.com" })).toThrow(/IMMUTABLE_PII_BLOCKED/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dna-x402-pii-"));
    const repo = new FileSnapshotRepository(path.join(dir, "state.json"), "receipts");
    expect(checkImmutableRecordSafe("RECEIPT", { email: "buyer@example.com" }).ok).toBe(false);
    await expect((async () => {
      assertImmutableRecordSafe("RECEIPT", { email: "buyer@example.com" });
      await repo.append("bad", { email: "buyer@example.com" });
    })()).rejects.toThrow(/IMMUTABLE_PII_BLOCKED/);
    await expect(repo.get("bad")).resolves.toBeUndefined();
  });

  it("allows pseudonymous IDs, hashes, wallet-like addresses, policy IDs, and safe audit events", () => {
    expect(() => hashReceiptV1(safeReceipt)).not.toThrow();
    expect(() => assertImmutableRecordSafe("PROOF_RECORD", {
      actorId: "actor_123",
      policyDecisionHash: "hash_policy",
      wallet: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    })).not.toThrow();

    const engine = new PolicyEngine({ now: () => new Date("2026-05-15T00:00:00.000Z") });
    const decision = engine.decide({
      actor: { jurisdictionFlags: [] },
      listing: {
        category: "ai_inference",
        capabilityTags: ["inference"],
        riskTier: "LOW",
        physicalGoods: false,
        regulatedGoods: false,
        publicMarketplace: true,
      },
      transaction: { action: "QUOTE" },
      system: { emergencyPaused: false, marketplacePaused: false, finalizePaused: false, policyVersion: "policy-v1" },
    });
    expect(() => engine.auditEvent(decision)).not.toThrow();

    const governance = new GovernanceService(() => new Date("2026-05-15T00:00:00.000Z"));
    governance.addDenylistEntry({
      subjectType: "LISTING",
      subjectValue: "listing-1",
      reasonCode: "restricted",
      evidenceRefs: ["evidence-1"],
      severity: "HIGH",
      createdBy: "operator_1",
    });
    expect(governance.history()).toHaveLength(1);
  });
});
