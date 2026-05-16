import { createX402App } from "../../x402/dist/server.js";
import { ReceiptSigner, verifySignedReceipt } from "../../x402/dist/receipts.js";
import request from "../../x402/node_modules/supertest/index.js";

class FakeVerifier {
  async verify(_quote, paymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature === "tx-ok-123456789012345678901234567890") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "bad proof" };
  }
}

const config = {
  port: 8080,
  appVersion: "smoke",
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 120,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 100,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 10_000n,
  nettingIntervalMs: 10_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
};

const { app } = createX402App(config, {
  paymentVerifier: new FakeVerifier(),
  receiptSigner: ReceiptSigner.generate(),
});

const server = await new Promise((resolve, reject) => {
  const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
  bound.once("error", reject);
});

try {
  const client = request(server);

  const first = await client.get("/resource");
  if (first.status !== 402) {
    throw new Error(`expected /resource to return 402, got ${first.status}`);
  }

  const quoteId = first.body?.paymentRequirements?.quote?.quoteId;
  if (!quoteId) {
    throw new Error("missing quoteId in 402 payment requirements");
  }

  const commit = await client
    .post("/commit")
    .send({
      quoteId,
      payerCommitment32B: `0x${"11".repeat(32)}`,
    });
  if (commit.status !== 201) {
    throw new Error(`expected /commit to return 201, got ${commit.status}`);
  }

  const commitId = commit.body?.commitId;
  if (!commitId) {
    throw new Error("missing commitId in /commit response");
  }

  const finalize = await client
    .post("/finalize")
    .send({
      commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-ok-123456789012345678901234567890",
      },
    });
  if (finalize.status !== 200) {
    throw new Error(`expected /finalize to return 200, got ${finalize.status}`);
  }

  const receiptId = finalize.body?.receiptId;
  if (!receiptId) {
    throw new Error("missing receiptId in /finalize response");
  }

  const replay = await client
    .get("/resource")
    .set("x-dnp-commit-id", commitId);
  if (replay.status !== 200) {
    throw new Error(`expected replay /resource to return 200, got ${replay.status}`);
  }

  const receipt = await client.get(`/receipt/${receiptId}`);
  if (receipt.status !== 200) {
    throw new Error(`expected /receipt/${receiptId} to return 200, got ${receipt.status}`);
  }
  if (!verifySignedReceipt(receipt.body)) {
    throw new Error("signed receipt verification failed");
  }

  console.log(JSON.stringify({
    resource: first.status,
    commit: commit.status,
    finalize: finalize.status,
    replay: replay.status,
    receipt: receipt.status,
    receiptId,
  }));
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
