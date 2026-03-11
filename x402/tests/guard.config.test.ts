import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("DNA Guard config", () => {
  it("loads guard flags and spend ceilings from env", () => {
    const config = loadConfig({
      CLUSTER: "devnet",
      PORT: "8080",
      APP_VERSION: "test",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      PAYMENT_RECIPIENT: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      DNA_GUARD_ENABLED: "true",
      DNA_GUARD_FAIL_MODE: "fail-closed",
      DNA_GUARD_WINDOW_MS: "60000",
      DNA_GUARD_SNAPSHOT_PATH: "./tmp/guard.json",
      DNA_GUARD_BUYER_CEILING_ATOMIC: "1000",
      DNA_GUARD_WALLET_CEILING_ATOMIC: "2000",
      DNA_GUARD_AGENT_CEILING_ATOMIC: "3000",
      DNA_GUARD_API_KEY_CEILING_ATOMIC: "4000",
    });

    expect(config.dnaGuard).toEqual({
      enabled: true,
      failMode: "fail-closed",
      windowMs: 60_000,
      snapshotPath: "./tmp/guard.json",
      spendCeilings: {
        buyerAtomic: "1000",
        walletAtomic: "2000",
        agentAtomic: "3000",
        apiKeyAtomic: "4000",
      },
    });
  });
});
