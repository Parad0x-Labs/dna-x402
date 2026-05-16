import { describe, expect, it } from "vitest";
import { redactRpcUrlForReport, resolveDrillRpcUrl } from "../scripts/drill/rpc.js";

describe("Solana USDC drill RPC resolution", () => {
  it("prefers a full Helius RPC URL and redacts the API key in reports", () => {
    const resolved = resolveDrillRpcUrl({
      HELIUS_RPC: "https://mainnet.helius-rpc.com/?api-key=secret-helius-key",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv);

    expect(resolved.source).toBe("HELIUS_RPC");
    expect(resolved.rpcUrl).toContain("secret-helius-key");
    expect(resolved.reportValue).not.toContain("secret-helius-key");
    expect(resolved.reportValue).toContain("api-key=%3Credacted%3E");
    expect(resolved.highThroughput).toBe(true);
  });

  it("builds a Helius mainnet URL from HELIUS_API_KEY without leaking it", () => {
    const resolved = resolveDrillRpcUrl({
      HELIUS_API_KEY: "bare-secret-key",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv);

    expect(resolved.source).toBe("HELIUS_API_KEY");
    expect(resolved.rpcUrl).toBe("https://mainnet.helius-rpc.com/?api-key=bare-secret-key");
    expect(resolved.reportValue).toBe("https://mainnet.helius-rpc.com/?api-key=%3Credacted%3E");
    expect(resolved.highThroughput).toBe(true);
  });

  it("falls back to Solana RPC only when Helius is not configured", () => {
    const resolved = resolveDrillRpcUrl({
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv);

    expect(resolved.source).toBe("SOLANA_RPC_URL");
    expect(resolved.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(resolved.highThroughput).toBe(false);
  });

  it("redacts token-like query parameters for custom RPC URLs", () => {
    const reportValue = redactRpcUrlForReport("https://rpc.example.com/path?token=abc123&foo=bar");

    expect(reportValue).not.toContain("abc123");
    expect(reportValue).toContain("token=%3Credacted%3E");
    expect(reportValue).toContain("foo=bar");
  });
});
