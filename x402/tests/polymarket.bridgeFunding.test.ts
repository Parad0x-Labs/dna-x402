import { describe, expect, it } from "vitest";
import {
  DepositIntentStore,
  PolymarketBridgeClient,
  mapBridgeDepositStatus,
  sortDepositAssetsForUx,
  validateDepositSelection,
} from "../src/polymarket/bridge.js";

describe("polymarket bridge and funding guardrails", () => {
  it("fetches supported assets live and does not rely on hardcoded minimums", async () => {
    let calls = 0;
    const client = new PolymarketBridgeClient(async (url) => {
      calls += 1;
      expect(url).toContain("/supported-assets");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            { chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 },
            { chain: "Solana", addressType: "svm", tokenSymbol: "SOL", minCheckoutUsd: 2 },
          ],
        }),
      };
    });

    const first = await client.supportedAssets();
    const second = await client.supportedAssets();
    expect(calls).toBe(2);
    expect(first[0]?.minCheckoutUsd).toBe(2);
    expect(second[0]?.minCheckoutUsd).toBe(2);
  });

  it("shows Solana USDC first when supported", () => {
    const sorted = sortDepositAssetsForUx([
      { chain: "Base", addressType: "evm", tokenSymbol: "USDC", minCheckoutUsd: 2 },
      { chain: "Solana", addressType: "svm", tokenSymbol: "SOL", minCheckoutUsd: 2 },
      { chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 },
    ]);

    expect(sorted[0]?.chain).toBe("Solana");
    expect(sorted[0]?.tokenSymbol).toBe("USDC");
  });

  it("returns warnings for below-minimum, wrong-chain, and unsupported-token deposits", () => {
    const assets = [{ chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 }];

    expect(validateDepositSelection({
      assets,
      selectedChain: "Solana",
      selectedToken: "USDC",
      amountUsd: 1,
    })).toBe("BELOW_MINIMUM");

    expect(validateDepositSelection({
      assets,
      selectedChain: "Ethereum",
      selectedToken: "USDC",
      amountUsd: 5,
    })).toBe("WRONG_CHAIN_OR_UNSUPPORTED");

    expect(validateDepositSelection({
      assets,
      selectedChain: "Solana",
      selectedToken: "MEME",
      amountUsd: 5,
    })).toBe("WRONG_CHAIN_OR_UNSUPPORTED");
  });

  it("tracks bridge status until pUSD is credited", () => {
    expect(mapBridgeDepositStatus("DEPOSIT_DETECTED")).toBe("TX_DETECTED");
    expect(mapBridgeDepositStatus("PROCESSING")).toBe("BRIDGE_PENDING");
    expect(mapBridgeDepositStatus("ORIGIN_TX_CONFIRMED")).toBe("BRIDGE_PENDING");
    expect(mapBridgeDepositStatus("SUBMITTED")).toBe("BRIDGE_PENDING");
    expect(mapBridgeDepositStatus("COMPLETED")).toBe("PUSD_CREDITED");
    expect(mapBridgeDepositStatus("FAILED")).toBe("FAILED");
  });

  it("creates idempotent deposit intents and only creates addresses after asset selection", () => {
    const store = new DepositIntentStore();
    const assets = [{ chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 }];

    const selected = store.selectAsset({
      id: "dep-1",
      userId: "user-1",
      agentId: "agent-1",
      depositWallet: "0xDepositWallet",
      selectedChain: "Solana",
      selectedToken: "USDC",
      amountUsd: 10,
      idempotencyKey: "select-1",
      assets,
      now: new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(selected.status).toBe("ASSET_SELECTED");
    expect(selected.depositAddress).toBeUndefined();
    expect(store.selectAsset({
      id: "dep-1",
      userId: "user-1",
      agentId: "agent-1",
      depositWallet: "0xDepositWallet",
      selectedChain: "Solana",
      selectedToken: "USDC",
      amountUsd: 10,
      idempotencyKey: "select-1",
      assets,
      now: new Date("2026-05-15T00:01:00.000Z"),
    })).toEqual(selected);

    const addressed = store.createDepositAddress({
      id: "dep-1",
      depositAddress: "SolanaBridgeAddress",
      bridgePayloadHash: "payload-hash",
      idempotencyKey: "address-1",
      now: new Date("2026-05-15T00:02:00.000Z"),
    });

    expect(addressed.status).toBe("ADDRESS_CREATED");
    expect(addressed.depositAddress).toBe("SolanaBridgeAddress");
    expect(store.createDepositAddress({
      id: "dep-1",
      depositAddress: "DifferentAddress",
      bridgePayloadHash: "different-hash",
      idempotencyKey: "address-1",
    })).toEqual(addressed);
  });

  it("blocks deposit address creation for unsupported or below-minimum selections", () => {
    const store = new DepositIntentStore();
    const assets = [{ chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 }];

    const belowMin = store.selectAsset({
      id: "dep-low",
      userId: "user-1",
      agentId: "agent-1",
      depositWallet: "0xDepositWallet",
      selectedChain: "Solana",
      selectedToken: "USDC",
      amountUsd: 1,
      idempotencyKey: "select-low",
      assets,
    });
    expect(belowMin.status).toBe("BELOW_MINIMUM");
    expect(() => store.createDepositAddress({
      id: "dep-low",
      depositAddress: "SolanaBridgeAddress",
      bridgePayloadHash: "payload-hash",
      idempotencyKey: "address-low",
    })).toThrow(/asset selection/i);
  });

  it("reconciles deposit statuses from detected tx to credited pUSD", () => {
    const store = new DepositIntentStore();
    const assets = [{ chain: "Solana", addressType: "svm", tokenSymbol: "USDC", minCheckoutUsd: 2 }];

    store.selectAsset({
      id: "dep-2",
      userId: "user-1",
      agentId: "agent-1",
      depositWallet: "0xDepositWallet",
      selectedChain: "Solana",
      selectedToken: "USDC",
      amountUsd: 10,
      idempotencyKey: "select-2",
      assets,
    });
    store.createDepositAddress({
      id: "dep-2",
      depositAddress: "SolanaBridgeAddress",
      bridgePayloadHash: "payload-hash",
      idempotencyKey: "address-2",
    });

    expect(store.applyBridgeStatus("dep-2", "DEPOSIT_DETECTED", "solanaTx").status).toBe("TX_DETECTED");
    expect(store.applyBridgeStatus("dep-2", "PROCESSING").status).toBe("BRIDGE_PENDING");
    expect(store.applyBridgeStatus("dep-2", "COMPLETED").status).toBe("PUSD_CREDITED");
    expect(store.markReconciled("dep-2").status).toBe("RECONCILED");
  });
});
