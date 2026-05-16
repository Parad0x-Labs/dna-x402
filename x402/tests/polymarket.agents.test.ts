import { describe, expect, it } from "vitest";
import {
  AgentProfileStore,
  DEFAULT_AGENT_RISK_SETTINGS,
  cleanAgentSlug,
} from "../src/polymarket/agents.js";

function createProfile(store = new AgentProfileStore()) {
  return store.create({
    id: "agent-1",
    displayName: "Sharp Money Desk",
    ownerSolanaAddress: "So11111111111111111111111111111111111111112",
    ownerEvmAddress: "0x1111111111111111111111111111111111111111",
    depositWallet: "0x2222222222222222222222222222222222222222",
    now: new Date("2026-05-15T00:00:00.000Z"),
  });
}

describe("polymarket agent profiles", () => {
  it("creates immutable public agent profiles bound only to public wallet addresses", () => {
    const profile = createProfile();

    expect(profile.immutableSlug).toBe("sharp-money-desk");
    expect(profile.defaultWithdrawalRecipient).toBe(profile.ownerSolanaAddress);
    expect(profile.riskSettings).toEqual(DEFAULT_AGENT_RISK_SETTINGS);
    expect(profile.createdAt).toBe("2026-05-15T00:00:00.000Z");
  });

  it("normalizes slugs and rejects duplicates", () => {
    const store = new AgentProfileStore();
    expect(cleanAgentSlug("  My ALPHA!!! Bot  ")).toBe("my-alpha-bot");
    createProfile(store);
    expect(() => store.create({
      id: "agent-2",
      displayName: "Sharp Money Desk",
      ownerSolanaAddress: "So11111111111111111111111111111111111111112",
      ownerEvmAddress: "0x3333333333333333333333333333333333333333",
      depositWallet: "0x4444444444444444444444444444444444444444",
    })).toThrow(/already exists/i);
  });

  it("rejects custody material in agent profile payloads", () => {
    const store = new AgentProfileStore();
    expect(() => store.create({
      id: "agent-1",
      displayName: "Custody Leak",
      ownerSolanaAddress: "So11111111111111111111111111111111111111112",
      ownerEvmAddress: "0x1111111111111111111111111111111111111111",
      depositWallet: "0x2222222222222222222222222222222222222222",
      payloadForCustodyScan: { privateKey: "redacted" },
    })).toThrow(/forbidden signer material/i);
  });

  it("prevents renames and allows only risk setting updates", () => {
    const store = new AgentProfileStore();
    createProfile(store);
    expect(() => store.rename()).toThrow(/immutable/i);

    const updated = store.updateRiskSettings("agent-1", {
      dryRun: false,
      maxTradeSizePusd: 10,
      categoryBlacklist: ["politics"],
    }, new Date("2026-05-15T01:00:00.000Z"));

    expect(updated.immutableSlug).toBe("sharp-money-desk");
    expect(updated.riskSettings.dryRun).toBe(false);
    expect(updated.riskSettings.maxTradeSizePusd).toBe(10);
    expect(updated.riskSettings.categoryBlacklist).toEqual(["politics"]);
    expect(updated.updatedAt).toBe("2026-05-15T01:00:00.000Z");
  });

  it("requires admin audit approval for emergency withdrawal recipients", () => {
    const store = new AgentProfileStore();
    createProfile(store);

    expect(() => store.setEmergencyWithdrawalRecipient({
      id: "agent-1",
      recipientAddress: "EmergencySolanaAddress",
      adminApproved: false,
    })).toThrow(/admin approval/i);

    const updated = store.setEmergencyWithdrawalRecipient({
      id: "agent-1",
      recipientAddress: "EmergencySolanaAddress",
      adminApproved: true,
      adminAuditLogId: "audit-1",
      reason: "user recovery request",
      now: new Date("2026-05-15T02:00:00.000Z"),
    });

    expect(updated.emergencyWithdrawalRecipient).toBe("EmergencySolanaAddress");
    expect(updated.emergencyWithdrawalAuditLogId).toBe("audit-1");
  });
});
