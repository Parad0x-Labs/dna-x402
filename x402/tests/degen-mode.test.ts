import { describe, expect, it } from "vitest";
import {
  DEGEN_EXECUTION_ADAPTERS,
  DegenModeError,
  assertNoDegenPrivateKeyPayload,
  createTradeIntent,
  degenRiskConfigHash,
  listDegenAgentTemplates,
  validateDegenRiskConfig,
  type DegenRiskConfig,
} from "../src/agents/degen.js";

const now = () => new Date("2026-05-17T12:00:00.000Z");

const safeRisk: DegenRiskConfig = {
  maxTradeUsd: 25,
  maxDailySpendUsd: 150,
  maxDailyLossUsd: 40,
  maxOpenExposureUsd: 200,
  maxSlippageBps: 1_000,
  takeProfitBps: 2_000,
  stopLossBps: 1_000,
  maxTradesPerHour: 5,
};

describe("Degen Mode safe Solana agent primitives", () => {
  it("keeps useful ALgoat-like scanner ideas while rejecting custody and backend signing", () => {
    const templates = listDegenAgentTemplates();
    expect(templates.map((template) => template.slug)).toEqual(
      expect.arrayContaining(["fresh-pair-scout", "copy-the-chad-safe", "rug-radar-signal", "paper-ape-lab"]),
    );

    for (const template of templates) {
      expect(template.backendCustody).toBe(false);
      expect(template.backendSigning).toBe(false);
      expect(template.rejectedAlgoatPatterns.join(" ")).not.toMatch(/store private key|backend sign/i);
      expect(template.receiptBehavior).toBeDefined();
    }
  });

  it("allows watch, signal, and paper simulation without a wallet", () => {
    const watch = createTradeIntent(
      {
        agentId: "rug-radar",
        venue: "NONE",
        side: "BUY",
        maxInputAmountAtomic: "1",
        slippageBps: 0,
        mode: "WATCH_ONLY",
      },
      now,
    );
    expect(watch.ownerWallet).toBe("");
    expect(watch.requiresClientSignature).toBe(false);
    expect(watch.riskConfigHash).toBe("none");

    const paper = createTradeIntent(
      {
        agentId: "paper-ape-lab",
        venue: "NONE",
        side: "SELL",
        maxInputAmountAtomic: "1000000",
        slippageBps: 0,
        mode: "PAPER_SIM",
      },
      now,
    );
    expect(paper.mode).toBe("PAPER_SIM");
    expect(paper.requiresClientSignature).toBe(false);
  });

  it("requires a user-owned wallet and max-pain risk config for live intents", () => {
    expect(() =>
      createTradeIntent(
        {
          agentId: "copy-the-chad",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "25000000",
          slippageBps: 500,
          mode: "USER_CONFIRMED_LIVE",
        },
        now,
      ),
    ).toThrowError(new DegenModeError("DEGEN_OWNER_WALLET_REQUIRED", "live degen intents require a user-owned wallet"));

    expect(() =>
      createTradeIntent(
        {
          agentId: "copy-the-chad",
          ownerWallet: "owner-wallet",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "25000000",
          slippageBps: 500,
          mode: "USER_CONFIRMED_LIVE",
        },
        now,
      ),
    ).toThrowError(/risk config/);
  });

  it("creates receipt-bindable user-confirmed live intents only with valid risk caps", () => {
    const intent = createTradeIntent(
      {
        agentId: "copy-the-chad",
        ownerWallet: "owner-wallet",
        venue: "JUPITER",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "meme-token-mint",
        side: "BUY",
        maxInputAmountAtomic: "25000000",
        minOutputAmountAtomic: "1",
        slippageBps: 500,
        mode: "USER_CONFIRMED_LIVE",
        riskConfig: safeRisk,
        estimatedTradeUsd: 25,
      },
      now,
    );

    expect(intent).toMatchObject({
      agentId: "copy-the-chad",
      ownerWallet: "owner-wallet",
      venue: "JUPITER",
      mode: "USER_CONFIRMED_LIVE",
      status: "PROPOSED",
      requiresClientSignature: true,
      riskConfigHash: degenRiskConfigHash(safeRisk),
      createdAt: "2026-05-17T12:00:00.000Z",
    });
  });

  it("rejects ALgoat-style browser wallet secret payloads", () => {
    expect(() =>
      assertNoDegenPrivateKeyPayload({
        tradingWalletSecret: "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32]",
      }),
    ).toThrowError(/private keys/);

    expect(() =>
      createTradeIntent(
        {
          agentId: "bad-agent",
          ownerWallet: "owner-wallet",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "1",
          slippageBps: 100,
          mode: "USER_CONFIRMED_LIVE",
          riskConfig: safeRisk,
          payload: { privateKey: "not-going-anywhere" },
        },
        now,
      ),
    ).toThrowError(/forbidden/);
  });

  it("rejects backend signing, backend custody, uncapped risk, high slippage, and hidden auto-live", () => {
    expect(() =>
      createTradeIntent(
        {
          agentId: "bad-agent",
          ownerWallet: "owner-wallet",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "1",
          slippageBps: 100,
          mode: "USER_CONFIRMED_LIVE",
          riskConfig: safeRisk,
          backendSigning: true,
        },
        now,
      ),
    ).toThrowError(/backend signing/);

    expect(() =>
      createTradeIntent(
        {
          agentId: "bad-agent",
          ownerWallet: "owner-wallet",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "1",
          slippageBps: 100,
          mode: "USER_CONFIRMED_LIVE",
          riskConfig: safeRisk,
          backendCustody: true,
        },
        now,
      ),
    ).toThrowError(/backend custody/);

    const overCaps = validateDegenRiskConfig({
      maxTradeUsd: 201,
      maxDailySpendUsd: 1501,
      maxDailyLossUsd: 301,
      maxOpenExposureUsd: 501,
      maxSlippageBps: 3_001,
    });
    expect(overCaps.ok).toBe(false);
    expect(overCaps.reasonCodes).toEqual(expect.arrayContaining(["DEGEN_RISK_CAP_EXCEEDED", "DEGEN_SLIPPAGE_EXCEEDED"]));

    expect(() =>
      createTradeIntent(
        {
          agentId: "auto-agent",
          ownerWallet: "owner-wallet",
          venue: "PUMPFUN",
          side: "BUY",
          maxInputAmountAtomic: "1",
          slippageBps: 100,
          mode: "CAPPED_AUTO_LIVE",
          riskConfig: safeRisk,
        },
        now,
      ),
    ).toThrowError(/does not expose capped auto-live/);

    expect(() =>
      createTradeIntent(
        {
          agentId: "auto-agent",
          ownerWallet: "owner-wallet",
          venue: "JUPITER",
          side: "BUY",
          maxInputAmountAtomic: "1",
          slippageBps: 100,
          mode: "CAPPED_AUTO_LIVE",
          riskConfig: safeRisk,
        },
        now,
      ),
    ).toThrowError(/adapter gate/);
  });

  it("documents execution adapters as intent-only and never live-submit engines", () => {
    for (const adapter of Object.values(DEGEN_EXECUTION_ADAPTERS)) {
      expect(adapter.backendCustody).toBe(false);
      expect(adapter.backendSigning).toBe(false);
      expect(adapter.liveSubmitSupported).toBe(false);
    }
    expect(DEGEN_EXECUTION_ADAPTERS.JUPITER.capabilities).toContain("USER_CONFIRMED_INTENT");
    expect(DEGEN_EXECUTION_ADAPTERS.PUMPFUN.notes.join(" ")).toMatch(/No direct Pump\.fun live trading/);
  });
});
