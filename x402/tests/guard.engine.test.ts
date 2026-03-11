import { describe, expect, it } from "vitest";
import { DnaGuardLedger } from "../src/guard/engine.js";

describe("DNA Guard ledger", () => {
  it("enforces rolling spend ceilings across buyer, wallet, agent, and api key scopes", () => {
    const ledger = new DnaGuardLedger({ windowMs: 60_000 });
    const actor = {
      buyerId: "buyer-1",
      walletAddress: "wallet-1",
      agentId: "agent-1",
      apiKeyId: "key-1",
    };
    const ceilings = {
      buyerAtomic: "100",
      walletAtomic: "100",
      agentAtomic: "100",
      apiKeyAtomic: "100",
    };
    const startedAt = new Date("2026-03-11T10:00:00.000Z");

    ledger.commitSpend(actor, "40", startedAt);
    ledger.commitSpend(actor, "50", new Date("2026-03-11T10:00:20.000Z"));

    expect(ledger.spendSnapshot(actor, new Date("2026-03-11T10:00:30.000Z"))).toEqual({
      buyer: "90",
      wallet: "90",
      agent: "90",
      apiKey: "90",
    });

    const blocked = ledger.checkSpend(actor, "20", ceilings, new Date("2026-03-11T10:00:45.000Z"));
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked).toEqual([
      {
        scope: "buyer",
        actorId: "buyer-1",
        attemptedAtomic: "20",
        currentAtomic: "90",
        limitAtomic: "100",
      },
      {
        scope: "wallet",
        actorId: "wallet-1",
        attemptedAtomic: "20",
        currentAtomic: "90",
        limitAtomic: "100",
      },
      {
        scope: "agent",
        actorId: "agent-1",
        attemptedAtomic: "20",
        currentAtomic: "90",
        limitAtomic: "100",
      },
      {
        scope: "apiKey",
        actorId: "key-1",
        attemptedAtomic: "20",
        currentAtomic: "90",
        limitAtomic: "100",
      },
    ]);

    const afterWindow = ledger.checkSpend(actor, "20", ceilings, new Date("2026-03-11T10:01:30.000Z"));
    expect(afterWindow).toEqual({ ok: true, blocked: [] });
    expect(ledger.spendSnapshot(actor, new Date("2026-03-11T10:01:30.000Z"))).toEqual({
      buyer: "0",
      wallet: "0",
      agent: "0",
      apiKey: "0",
    });
  });

  it("tracks provider quality, disputes, receipt verification, and replay alerts", () => {
    const ledger = new DnaGuardLedger();

    ledger.recordDelivery({
      providerId: "provider-good",
      endpointId: "inference",
      latencyMs: 220,
      statusCode: 200,
      receiptId: "receipt-good",
      qualityAccepted: true,
    });
    ledger.recordReceiptVerification({
      providerId: "provider-good",
      endpointId: "inference",
      receiptId: "receipt-good",
      valid: true,
    });

    ledger.recordDelivery({
      providerId: "provider-bad",
      endpointId: "inference",
      latencyMs: 6_400,
      statusCode: 502,
      receiptId: "receipt-bad",
      qualityAccepted: false,
    });
    ledger.recordDispute({
      providerId: "provider-bad",
      endpointId: "inference",
      receiptId: "receipt-bad",
      reason: "non_conforming_schema",
    });
    ledger.recordReplayAlert({
      providerId: "provider-bad",
      endpointId: "inference",
      reason: "duplicate_receipt",
    });
    ledger.recordSpendBlocked("provider-bad", "inference");
    ledger.recordReceiptVerification({
      providerId: "provider-bad",
      endpointId: "inference",
      receiptId: "receipt-bad",
      valid: false,
      reason: "signature_mismatch",
    }, new Date("2026-03-11T10:05:00.000Z"));

    const good = ledger.providerSnapshot("provider-good");
    const goodEndpoint = ledger.providerSnapshot("provider-good", "inference");
    const bad = ledger.providerSnapshot("provider-bad");
    const receipt = ledger.receiptStatus("receipt-bad");

    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.riskLevel).toBe("low");
    expect(goodEndpoint.totals.avgLatencyMs).toBe(220);
    expect(bad.riskLevel).toBe("high");
    expect(bad.totals).toMatchObject({
      requests: 1,
      fulfilled: 0,
      failed: 1,
      qualityRejected: 1,
      disputes: 1,
      replayAlerts: 1,
      receiptsVerified: 0,
      receiptsInvalid: 1,
      spendBlocked: 1,
    });
    expect(receipt).toEqual({
      receiptId: "receipt-bad",
      providerId: "provider-bad",
      endpointId: "inference",
      disputed: true,
      disputeReasons: ["non_conforming_schema"],
      qualityRejected: true,
      verification: {
        valid: false,
        reason: "signature_mismatch",
        ts: "2026-03-11T10:05:00.000Z",
      },
    });
    expect(ledger.summary()).toEqual({
      providers: 2,
      receiptsTracked: 2,
      disputes: 1,
      replayAlerts: 1,
      spendBlocked: 1,
    });
  });

  it("builds a provider leaderboard from provider-level aggregates only", () => {
    const ledger = new DnaGuardLedger();

    ledger.recordDelivery({
      providerId: "provider-alpha",
      endpointId: "chat",
      latencyMs: 180,
      statusCode: 200,
      qualityAccepted: true,
    });
    ledger.recordDelivery({
      providerId: "provider-alpha",
      endpointId: "embed",
      latencyMs: 200,
      statusCode: 200,
      qualityAccepted: true,
    });
    ledger.recordDelivery({
      providerId: "provider-beta",
      endpointId: "chat",
      latencyMs: 4_100,
      statusCode: 500,
      qualityAccepted: false,
      receiptId: "receipt-beta",
    });
    ledger.recordDispute({
      providerId: "provider-beta",
      endpointId: "chat",
      receiptId: "receipt-beta",
      reason: "timeout",
    });

    const leaderboard = ledger.leaderboard(5);

    expect(leaderboard).toHaveLength(2);
    expect(leaderboard.map((snapshot) => snapshot.providerId)).toEqual([
      "provider-alpha",
      "provider-beta",
    ]);
    expect(leaderboard.every((snapshot) => snapshot.endpointId === undefined)).toBe(true);
    expect(leaderboard[0]?.totals.fulfilled).toBe(2);
    expect(leaderboard[1]?.riskLevel).toBe("high");
  });
});
