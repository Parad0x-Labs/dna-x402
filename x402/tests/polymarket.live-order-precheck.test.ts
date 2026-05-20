import { afterEach, describe, expect, it } from "vitest";
import {
  precheckPolymarketUserOrder,
  resolvePolymarketBuilderEnvReadiness,
  resolvePolymarketLiveReadiness,
} from "../src/polymarket/live.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function clearPolymarketEnv(): void {
  for (const key of [
    "POLYMARKET_BUILDER_CODE",
    "POLYMARKET_BUILDER_API_KEY",
    "POLYMARKET_BUILDER_SECRET",
    "POLYMARKET_BUILDER_PASSPHRASE",
    "POLY_BUILDER_CODE",
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
    "POLYMARKET_PRIVATE_KEY",
    "DEPOSIT_WALLET_ADDRESS",
  ]) {
    delete process.env[key];
  }
}

function validOrderInput() {
  return {
    agentId: "agent-live-1",
    ownerWallet: "owner-wallet-1",
    depositWallet: "0xDepositWallet",
    funder: "0xDepositWallet",
    signatureType: "POLY_1271" as const,
    complianceAllowed: true,
    marketActive: true,
    orderbookEnabled: true,
    tokenId: "token-yes",
    side: "YES" as const,
    price: 0.5,
    size: 10,
    tickSize: 0.01,
    minSize: 5,
    negRiskKnown: true,
    pUsdAvailable: 10,
    allowanceApproved: true,
    orderbookFresh: true,
    duplicateRetrySafe: true,
    rateLimitAllowed: true,
    maxSlippageBps: 100,
    estimatedSlippageBps: 10,
    riskControlsPassed: true,
    activeLocalSignerAvailable: true,
  };
}

afterEach(() => {
  resetEnv();
});

describe("polymarket multi-user live precheck", () => {
  it("reports missing builder credentials and live extras", () => {
    clearPolymarketEnv();
    const readiness = resolvePolymarketLiveReadiness(process.env);
    expect(readiness.builder.ready).toBe(false);
    expect(readiness.builder.entries.filter((entry) => !entry.present).length).toBe(4);
    expect(readiness.liveOrderExtras.filter((entry) => !entry.present).map((entry) => entry.canonicalName))
      .toEqual(["POLYMARKET_PRIVATE_KEY", "DEPOSIT_WALLET_ADDRESS"]);
  });

  it("accepts builder aliases for shared server credentials", () => {
    clearPolymarketEnv();
    process.env.POLY_BUILDER_CODE = "0xbuilder";
    process.env.POLYMARKET_API_KEY = "key";
    process.env.POLYMARKET_API_SECRET = "secret";
    process.env.POLYMARKET_API_PASSPHRASE = "passphrase";

    const readiness = resolvePolymarketBuilderEnvReadiness(process.env);
    expect(readiness.ready).toBe(true);
    expect(readiness.builderCode).toMatchObject({
      value: "0xbuilder",
      sourceName: "POLY_BUILDER_CODE",
    });
  });

  it("passes precheck with alias-based builder env and per-user signer semantics", () => {
    clearPolymarketEnv();
    process.env.POLY_BUILDER_CODE = "0xbuilder";
    process.env.POLYMARKET_API_KEY = "key";
    process.env.POLYMARKET_API_SECRET = "secret";
    process.env.POLYMARKET_API_PASSPHRASE = "passphrase";

    const result = precheckPolymarketUserOrder(validOrderInput(), process.env);
    expect(result.ok).toBe(true);
    expect(result.builderCredentialsReady).toBe(true);
    expect(result.builderCodeSource).toBe("env");
    expect(result.errors).toEqual([]);
  });

  it("fails precheck when builder credentials are missing", () => {
    clearPolymarketEnv();
    const result = precheckPolymarketUserOrder(validOrderInput(), process.env);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("builder_credentials_missing");
  });

  it("rejects forbidden private key material", () => {
    clearPolymarketEnv();
    process.env.POLYMARKET_BUILDER_CODE = "0xbuilder";
    process.env.POLYMARKET_BUILDER_API_KEY = "key";
    process.env.POLYMARKET_BUILDER_SECRET = "secret";
    process.env.POLYMARKET_BUILDER_PASSPHRASE = "passphrase";

    expect(() => precheckPolymarketUserOrder(
      { ...validOrderInput(), privateKey: "forbidden" } as unknown as ReturnType<typeof validOrderInput>,
      process.env,
    )).toThrow(/Backend payload contains forbidden signer material/);
  });
});
