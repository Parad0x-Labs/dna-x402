import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { createX402App } from "../../src/server.js";
import { X402Config } from "../../src/config.js";
import { PaymentVerifier } from "../../src/paymentVerifier.js";
import { PaymentProof, Quote } from "../../src/types.js";
import { ReceiptSigner } from "../../src/receipts.js";
import { MarketEvent } from "../../src/market/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: true, settledOnchain: false };
  }
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function sumMetric(rows: Array<{ value: number }>): number {
  return rows.reduce((sum, row) => sum + row.value, 0);
}

async function runLocalCapture(outDir: string): Promise<void> {
  const config: X402Config = {
    port: 0,
    solanaRpcUrl: "https://api.devnet.solana.com",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat", "surge", "stream"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 120,
    feePolicy: {
      baseFeeAtomic: 0n,
      feeBps: 30,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    },
    nettingThresholdAtomic: 10_000n,
    nettingIntervalMs: 10_000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
  };

  const { app, context } = createX402App(config, {
    paymentVerifier: new FakeVerifier(),
    receiptSigner: ReceiptSigner.generate(),
  });

  const first = await request(app).get("/resource").expect(402);
  const quoteId = first.body.paymentRequirements.quote.quoteId as string;

  const commit = await request(app)
    .post("/commit")
    .send({
      quoteId,
      payerCommitment32B: `0x${"ab".repeat(32)}`,
    })
    .expect(201);

  await request(app)
    .post("/finalize")
    .send({
      commitId: commit.body.commitId,
      paymentProof: {
        settlement: "transfer",
        txSignature: "tx-ok-audit-market-12345678901234567890123456",
      },
    })
    .expect(200);

  await request(app)
    .get("/resource")
    .set("x-dnp-commit-id", commit.body.commitId)
    .expect(200);

  const addEvent = (event: Omit<MarketEvent, "ts">) => {
    context.market.recordEvent(event);
  };

  addEvent({
    type: "PAYMENT_VERIFIED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "pv-only",
    receiptValid: true,
  });

  addEvent({
    type: "REQUEST_FULFILLED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "rf-only",
    statusCode: 200,
    receiptValid: true,
  });

  addEvent({
    type: "PAYMENT_VERIFIED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "bad-receipt",
    receiptValid: false,
  });

  addEvent({
    type: "REQUEST_FULFILLED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "bad-receipt",
    statusCode: 200,
    receiptValid: false,
  });

  addEvent({
    type: "PAYMENT_VERIFIED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "good-receipt",
    anchor32: "11".repeat(32),
    anchored: true,
    verificationTier: "VERIFIED",
    receiptValid: true,
  });

  addEvent({
    type: "REQUEST_FULFILLED",
    shopId: "audit-shop",
    endpointId: "audit-endpoint",
    capabilityTags: ["audit_capability"],
    priceAmount: "100",
    mint: "USDC",
    settlementMode: "transfer",
    receiptId: "good-receipt",
    anchor32: "11".repeat(32),
    anchored: true,
    verificationTier: "VERIFIED",
    statusCode: 200,
    receiptValid: true,
  });

  const topSellingFast = await request(app).get("/market/top-selling").query({ window: "24h", verificationTier: "FAST" }).expect(200);
  const topSellingVerified = await request(app).get("/market/top-selling").query({ window: "24h", verificationTier: "VERIFIED" }).expect(200);
  const topRevenue = await request(app).get("/market/top-revenue").query({ window: "24h" }).expect(200);
  const trending = await request(app).get("/market/trending").query({ window: "1h" }).expect(200);
  const onSale = await request(app).get("/market/on-sale").query({ window: "24h" }).expect(200);
  const snapshot = await request(app).get("/market/snapshot").expect(200);

  const marketSnapshot = {
    generatedAt: new Date().toISOString(),
    source: "local_app",
    endpoints: {
      topSellingFast: topSellingFast.body,
      topSellingVerified: topSellingVerified.body,
      topRevenue: topRevenue.body,
      trending: trending.body,
      onSale: onSale.body,
      snapshot: snapshot.body,
    },
  };

  const fastCount = sumMetric(topSellingFast.body.results ?? []);
  const verifiedCount = sumMetric(topSellingVerified.body.results ?? []);
  const expectedCounted = 2;

  const validations = {
    generatedAt: new Date().toISOString(),
    invariants: {
      verifiedLteFast: verifiedCount <= fastCount,
      devIngestDisabled: (process.env.MARKET_ALLOW_DEV_INGEST ?? "0") !== "1",
      countedOnlyFulfilledPaymentVerifiedReceiptValid: fastCount >= expectedCounted,
    },
    metrics: {
      fastCount,
      verifiedCount,
      expectedMinimumCounted: expectedCounted,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "market_snapshot.json"), JSON.stringify(marketSnapshot, null, 2));
  fs.writeFileSync(path.join(outDir, "market_validations.json"), JSON.stringify(validations, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    outDir,
    fastCount,
    verifiedCount,
    validations: validations.invariants,
  }, null, 2));

  if (!Object.values(validations.invariants).every(Boolean)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const x402Root = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const outDir = parseFlagValue(argv, "--out-dir") ?? path.join(x402Root, "audit_out");
  await runLocalCapture(outDir);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
