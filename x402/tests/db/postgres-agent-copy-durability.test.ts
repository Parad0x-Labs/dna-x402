import { describe, expect, it } from "vitest";
import {
  AgentTradingRepositories,
  AgentTradingService,
  assertNoBackendPrivateKeyPayload,
} from "../../src/agents/trading.js";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { createLivePostgres, postgresAvailable, resetAndMigrateLivePostgres, withLivePostgresTestLock } from "./postgres-test-helpers.js";

function agentRepos(db: ReturnType<typeof createLivePostgres>): AgentTradingRepositories {
  const repos = createPostgresCommerceRepositories(db);
  return {
    agentWallets: repos.agent_wallets as AgentTradingRepositories["agentWallets"],
    paperAgentAccounts: repos.paper_agent_accounts as AgentTradingRepositories["paperAgentAccounts"],
    agentProfiles: repos.agent_profiles as AgentTradingRepositories["agentProfiles"],
    alphaMonetizationConfigs: repos.alpha_monetization_configs as AgentTradingRepositories["alphaMonetizationConfigs"],
    copySettings: repos.copy_settings as AgentTradingRepositories["copySettings"],
    copyDecisions: repos.copy_decisions as AgentTradingRepositories["copyDecisions"],
    copiedLots: repos.copied_lots as AgentTradingRepositories["copiedLots"],
    alphaFeeAccruals: repos.alpha_fee_accruals as AgentTradingRepositories["alphaFeeAccruals"],
    agentActionLedgers: repos.agent_action_ledgers as AgentTradingRepositories["agentActionLedgers"],
  };
}

function sourceAction(overrides: Record<string, unknown> = {}) {
  return {
    sourceActionId: `source-${Math.random().toString(36).slice(2)}`,
    sourceAgentId: "alpha-pg",
    actionType: "BUY" as const,
    marketId: "pg-market",
    category: "prediction_research",
    side: "YES" as const,
    entryPriceBps: 5000,
    sizeAtomic: "100000",
    ...overrides,
  };
}

describe.skipIf(!postgresAvailable)("agent/copy live Postgres durability", () => {
  it("survives restart for wallets, paper accounts, profiles, copy settings, copied lots, and alpha accruals", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      let dbClosed = false;
      try {
        await resetAndMigrateLivePostgres(db);

        const first = new AgentTradingService(() => new Date("2026-05-16T10:00:00.000Z"), agentRepos(db));
        await first.registerWallet("agent-pg", {
          ownerWallet: "mother-wallet-pg",
          publicKey: "agent-wallet-pg",
          chain: "SOLANA",
          keyStorage: "LOCAL_ENCRYPTED",
        });
        expect(() => assertNoBackendPrivateKeyPayload({ nested: { privateKey: "forbidden" } })).toThrow(/public keys only/i);

        await first.createPaperAccount("agent-pg");
        await first.recordPaperTrade("agent-pg", {
          marketId: "paper-market-pg",
          side: "YES",
          amountAtomic: "5000000",
          priceBps: 5000,
          realizedPnlAtomic: "125000",
        });
        await first.updateProfile("agent-pg", {
          visibility: "PUBLIC",
          averageEntryPriceBps: 5000,
          tradeCount: 1,
          totalVolumeAtomic: "5000000",
        });
        await first.setMonetization("alpha-pg", { enabled: true, successFeeBps: 100, mode: "ACCRUAL" });
        const settings = await first.createCopySettings({
          copySettingsId: "copy-settings-pg",
          followerAgentId: "agent-pg",
          sourceAgentId: "alpha-pg",
          enabled: true,
          mode: "PAPER_COPY",
          copyBuys: true,
          copySells: true,
          copyExits: true,
          minEntryPriceBps: 4000,
          maxEntryPriceBps: 6000,
          maxBetSizeAtomic: "250000",
          maxDailySpendAtomic: "1000000",
          maxOpenExposureAtomic: "500000",
          useSourceExitRules: false,
          customTakeProfitBps: 2000,
          customStopLossBps: 1000,
          requireApprovalAlways: false,
        });
        const opened = await first.decide({
          copySettingsId: settings.copySettingsId,
          sourceAction: sourceAction({ sourceActionId: "source-open-pg" }),
          createLot: true,
        });
        expect(opened.copiedLot?.alphaFeeBpsAtEntry).toBe(100);

        await db.close();
        dbClosed = true;

        const reopenedDb = createLivePostgres();
        try {
          const restarted = new AgentTradingService(() => new Date("2026-05-16T10:01:00.000Z"), agentRepos(reopenedDb));
          await expect(restarted.listWallets("agent-pg")).resolves.toMatchObject([
            { ownerWallet: "mother-wallet-pg", publicKey: "agent-wallet-pg", backendHasPrivateKey: false },
          ]);
          await expect(restarted.getPaperAccount("agent-pg")).resolves.toMatchObject({
            startingBalanceAtomic: "10000000000",
            currentBalanceAtomic: "10000125000",
            realizedPnlAtomic: "125000",
          });
          await expect(restarted.profile("agent-pg")).resolves.toMatchObject({
            visibility: "PUBLIC",
            averageEntryPriceBps: 5000,
          });
          await expect(restarted.getMonetization("alpha-pg")).resolves.toMatchObject({
            enabled: true,
            successFeeBps: 100,
          });
          await expect(restarted.getCopySettings("copy-settings-pg")).resolves.toMatchObject({
            copyBuys: true,
            copySells: true,
            copyExits: true,
            minEntryPriceBps: 4000,
            maxEntryPriceBps: 6000,
            customTakeProfitBps: 2000,
            customStopLossBps: 1000,
            maxBetSizeAtomic: "250000",
            maxDailySpendAtomic: "1000000",
            maxOpenExposureAtomic: "500000",
          });
          const copiedLot = await restarted.getCopiedLot(opened.copiedLot!.copiedLotId);
          expect(copiedLot).toMatchObject({ status: "OPEN", entryPriceBps: 5000 });

          const highEntry = await restarted.decide({
            copySettingsId: "copy-settings-pg",
            sourceAction: sourceAction({ sourceActionId: "source-high-pg", entryPriceBps: 8000 }),
          });
          expect(highEntry.decision).toMatchObject({ decision: "SKIP" });
          expect(highEntry.decision.reasonCodes).toContain("ENTRY_PRICE_ABOVE_MAX");

          const overDaily = await restarted.decide({
            copySettingsId: "copy-settings-pg",
            sourceAction: sourceAction({ sourceActionId: "source-daily-pg" }),
            currentDailySpendAtomic: "950001",
          });
          expect(overDaily.decision.reasonCodes).toContain("MAX_DAILY_SPEND_EXCEEDED");

          const paused = await restarted.decide({
            copySettingsId: "copy-settings-pg",
            sourceAction: sourceAction({ sourceActionId: "source-paused-pg" }),
            emergencyPaused: true,
          });
          expect(paused.decision.reasonCodes).toContain("EMERGENCY_PAUSED");

          const win = await restarted.finalizeCopiedLot(opened.copiedLot!.copiedLotId, {
            realizedPnlAtomic: "100000",
            finalized: true,
          });
          expect(win.alphaFeeAccrual).toMatchObject({
            feeBps: 100,
            feeAmountAtomic: "1000",
            profitBasisAtomic: "100000",
          });
          await expect(restarted.finalizeCopiedLot(opened.copiedLot!.copiedLotId, {
            realizedPnlAtomic: "100000",
            finalized: true,
          })).rejects.toThrow(/finalized twice/i);

          const loss = await restarted.decide({
            copySettingsId: "copy-settings-pg",
            sourceAction: sourceAction({ sourceActionId: "source-loss-pg" }),
            createLot: true,
          });
          const closedLoss = await restarted.finalizeCopiedLot(loss.copiedLot!.copiedLotId, {
            realizedPnlAtomic: "-100000",
            finalized: true,
          });
          expect(closedLoss.alphaFeeAccrual).toBeUndefined();

          const finalRestart = new AgentTradingService(() => new Date("2026-05-16T10:02:00.000Z"), agentRepos(reopenedDb));
          await expect(finalRestart.listAlphaAccruals()).resolves.toMatchObject([
            { copiedLotId: opened.copiedLot!.copiedLotId, feeAmountAtomic: "1000" },
          ]);
          const ledger = await finalRestart.listActionLedger();
          expect(ledger.some((entry) => entry.kind === "PAPER_TRADE" && entry.agentId === "agent-pg")).toBe(true);
          expect(ledger.some((entry) => entry.kind === "COPIED_LOT_FINALIZED" && entry.copiedLotId === opened.copiedLot!.copiedLotId)).toBe(true);
        } finally {
          await reopenedDb.close();
        }
      } finally {
        if (!dbClosed) {
          await db.close();
        }
      }
    });
  }, 60_000);
});
