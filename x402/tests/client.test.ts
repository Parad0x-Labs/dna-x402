import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { fetchWith402, InMemoryReceiptStore, InMemorySpendTracker } from "../src/client.js";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature === "tx-ok-123456789012345678901234567890") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "bad payment" };
  }
}

const config: X402Config = {
  port: 0,
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 60,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 0,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 1_000n,
  nettingIntervalMs: 60_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
};

describe("fetchWith402", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const info = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });

  it("auto-pays 402 resources and stores receipt", async () => {
    const store = new InMemoryReceiptStore();

    const result = await fetchWith402(`${baseUrl}/resource`, {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-123456789012345678901234567890",
          };
        },
      },
      maxSpendAtomic: "100000",
      receiptStore: store,
    });

    expect(result.response.status).toBe(200);
    expect(result.commitId).toBeTruthy();
    expect(result.receipt?.payload.receiptId).toBeTruthy();
    expect(store.receipts.size).toBe(1);
  });

  it("enforces maxPrice policy", async () => {
    await expect(fetchWith402(`${baseUrl}/resource`, {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-123456789012345678901234567890",
          };
        },
      },
      maxSpendAtomic: "100000",
      maxPriceAtomic: "100",
    })).rejects.toThrow(/maxPrice/i);
  });

  it("enforces maxSpendPerDay policy", async () => {
    const spendTracker = new InMemorySpendTracker();

    await fetchWith402(`${baseUrl}/resource`, {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-123456789012345678901234567890",
          };
        },
      },
      maxSpendAtomic: "100000",
      maxSpendPerDayAtomic: "1500",
      spendTracker,
    });

    await expect(fetchWith402(`${baseUrl}/resource`, {
      wallet: {
        async payTransfer() {
          return {
            settlement: "transfer",
            txSignature: "tx-ok-123456789012345678901234567890",
          };
        },
      },
      maxSpendAtomic: "100000",
      maxSpendPerDayAtomic: "1500",
      spendTracker,
    })).rejects.toThrow(/Daily spend limit exceeded/);
  });
});
