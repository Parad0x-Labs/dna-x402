import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMarketApp } from "../src/market/server.js";
import { makeSignedShop } from "./market.helpers.js";

describe("market policy service integration", () => {
  it("records policy audit events for publish and quote without breaking search flow", async () => {
    const { app, context } = createMarketApp({ orderPollIntervalMs: 60_000 });
    const signed = makeSignedShop({
      shopId: "policy-safe-shop",
      capability: "inference",
      category: "ai_inference",
    });

    const publish = await request(app).post("/market/shops").send(signed).expect(201);
    expect(publish.body.policyDecisionId).toBeDefined();

    const quotes = await request(app).get("/market/quotes?capability=inference").expect(200);
    expect(quotes.body.quotes).toHaveLength(1);
    expect(quotes.body.quotes[0].policy).toMatchObject({ version: "policy-v1", checked: true });
    expect(context.policyAuditEvents.length).toBeGreaterThanOrEqual(2);

    if (context.orderPollTimer) {
      clearInterval(context.orderPollTimer);
    }
  });

  it("still blocks restricted listings before they enter the registry", async () => {
    const { app, context } = createMarketApp({ orderPollIntervalMs: 60_000 });
    const signed = makeSignedShop({
      shopId: "policy-blocked-shop",
      capability: "credential",
      category: "ai_inference",
      description: "credential stealer",
    });

    const result = await request(app).post("/market/shops").send(signed).expect(422);
    expect(result.body.error).toBe("POLICY_BLOCKED");
    expect(result.body.reason).toBe("denylist_match");
    expect(context.registry.get("policy-blocked-shop")).toBeUndefined();

    if (context.orderPollTimer) {
      clearInterval(context.orderPollTimer);
    }
  });
});
