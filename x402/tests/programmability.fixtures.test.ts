import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import {
  AgentWallet,
  fetchWith402,
} from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof } from "../src/types.js";
import { installProgrammabilityFixtures } from "../scripts/audit/programmability/fixtures/install.js";
import { PROGRAMMABILITY_FIXTURES } from "../scripts/audit/programmability/fixtures/primitives.js";

class FixtureVerifier {
  async verify(_quote: unknown, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: true, settledOnchain: false };
  }
}

function wallet(): AgentWallet {
  return {
    async payTransfer(quote) {
      return {
        settlement: "transfer",
        txSignature: `tx-${quote.quoteId.replace(/-/g, "").slice(0, 32)}`,
      };
    },
    async payStream(quote) {
      return {
        settlement: "stream",
        streamId: `stream-${quote.quoteId.replace(/-/g, "").slice(0, 16)}`,
      };
    },
    async payNetted() {
      return {
        settlement: "netting",
        note: "fixture-test",
      };
    },
  };
}

describe("programmability fixtures", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const cfg = loadConfig();
    const { app, context } = createX402App({
      ...cfg,
      port: 0,
      pauseMarket: false,
      pauseFinalize: false,
      pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
      anchoringEnabled: false,
    }, {
      paymentVerifier: new FixtureVerifier() as any,
      receiptSigner: ReceiptSigner.generate(),
    });
    installProgrammabilityFixtures(app, context);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  });

  afterAll(async () => {
    if (closeServer) {
      await closeServer();
    }
  });

  it("serves all 10 programmable primitives through x402 pay flow", async () => {
    for (const fixture of PROGRAMMABILITY_FIXTURES) {
      const first = await fetch(`${baseUrl}${fixture.resourcePath}`);
      expect(first.status, `${fixture.id} should require payment`).toBe(402);

      const result = await fetchWith402(`${baseUrl}${fixture.resourcePath}`, {
        wallet: wallet(),
        maxSpendAtomic: "100000000",
      });
      expect(result.response.status, `${fixture.id} paid retry should succeed`).toBe(200);
      expect(Boolean(result.receipt?.payload.receiptId)).toBe(true);
    }
  });
});

