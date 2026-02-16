import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMarketplaceApp } from "../src/marketplace/server.js";
import { RankedQuote, verifyCompetitiveQuote } from "../src/marketplace/quotes.js";

function shop(shopId: string, priceAtomic: string) {
  return {
    shopId,
    name: `${shopId} name`,
    ownerAddress: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    endpoints: [
      {
        endpointId: `${shopId}-pdf`,
        path: "/tool/pdf",
        method: "POST",
        capabilityTags: ["pdf_summarize"],
        description: "Summarize PDF",
        pricingModel: {
          kind: "flat",
          amountAtomic: priceAtomic,
        },
        settlementModes: ["transfer", "stream", "netting"],
        expectedLatencyMs: 1200,
        reputationScore: 0.8,
      },
    ],
  };
}

describe("marketplace discovery and quotes", () => {
  it("registers shops, searches by capability, and returns signed competing quotes", async () => {
    const { app } = createMarketplaceApp({
      quoteRecipientByShop: (id) => `${id}-recipient`,
    });

    await request(app).post("/shops").send(shop("shop-a", "2000")).expect(201);
    await request(app).post("/shops").send(shop("shop-b", "1400")).expect(201);
    await request(app).post("/shops").send(shop("shop-c", "3200")).expect(201);

    const search = await request(app)
      .get("/search")
      .query({ capability: "pdf_summarize", maxPrice: "2500", maxLatencyMs: "2000" })
      .expect(200);

    expect(search.body.results.length).toBe(2);

    const quotes = await request(app)
      .get("/quotes")
      .query({ capability: "pdf_summarize", maxPrice: "4000", limit: "5" })
      .expect(200);

    expect(quotes.body.quotes.length).toBeGreaterThanOrEqual(2);
    const signerPublicKey = quotes.body.signerPublicKey as string;
    for (const quote of quotes.body.quotes as RankedQuote[]) {
      expect(verifyCompetitiveQuote(quote, signerPublicKey)).toBe(true);
    }
  });

  it("executes limit order when market price drops under maxPrice", async () => {
    const { app } = createMarketplaceApp({
      quoteRecipientByShop: () => "provider-wallet",
    });

    await request(app).post("/shops").send({
      shopId: "surge-shop",
      name: "Surge Shop",
      ownerAddress: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      endpoints: [
        {
          endpointId: "inference-v1",
          path: "/inference",
          method: "POST",
          capabilityTags: ["inference"],
          description: "inference endpoint",
          pricingModel: {
            kind: "surge",
            baseAmountAtomic: "1000",
            minMultiplier: 0.8,
            maxMultiplier: 2.8,
          },
          settlementModes: ["transfer"],
          expectedLatencyMs: 900,
          reputationScore: 0.9,
        },
      ],
    }).expect(201);

    await request(app).post("/heartbeat").send({
      shopId: "surge-shop",
      queueDepth: 190,
      inflight: 80,
      p95LatencyMs: 3800,
    }).expect(200);

    const order = await request(app).post("/orders").send({
      capability: "inference",
      maxPrice: "900",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }).expect(201);

    const firstPoll = await request(app).post("/orders/poll").send({}).expect(200);
    expect(firstPoll.body.executed).toHaveLength(0);

    await request(app).post("/heartbeat").send({
      shopId: "surge-shop",
      queueDepth: 0,
      inflight: 0,
      p95LatencyMs: 200,
    }).expect(200);

    const secondPoll = await request(app).post("/orders/poll").send({}).expect(200);
    expect(secondPoll.body.executed).toHaveLength(1);
    expect(secondPoll.body.executed[0].orderId).toBe(order.body.orderId);
  });
});
