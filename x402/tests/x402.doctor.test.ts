import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { traceIdMiddleware } from "../src/middleware/traceId.js";
import { analyzeX402 } from "../src/x402/doctor.js";

describe("x402 doctor", () => {
  it("detects coinbase fixture and memeputer fixture", () => {
    const required = Buffer.from(JSON.stringify({
      network: "solana",
      currency: "USDC",
      amountAtomic: "1000",
      recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      settlement: { mode: "spl_transfer", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    }), "utf8").toString("base64");

    const coinbase = analyzeX402({
      headers: {
        "PAYMENT-REQUIRED": required,
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ txSig: "sig-1", scheme: "solana_spl" }), "utf8").toString("base64"),
      },
    });
    expect(coinbase.dialectDetected).toBe("coinbase");
    expect(coinbase.missing).toHaveLength(0);

    const memeputer = analyzeX402({
      headers: {
        "X-PAYMENT-REQUIRED": required,
        "X-PAYMENT": JSON.stringify({ txSignature: "sig-2", scheme: "solana_spl" }),
      },
    });
    expect(memeputer.dialectDetected).toBe("memeputer");
    expect(memeputer.missing).toHaveLength(0);
  });

  it("exposes actionable diagnostics via endpoint", async () => {
    const app = express();
    app.use(traceIdMiddleware);
    app.use(express.json());
    app.post("/x402/doctor", (req, res) => {
      res.json(analyzeX402({
        headers: req.body.headers,
        body: req.body.body,
      }));
    });

    const response = await request(app)
      .post("/x402/doctor")
      .send({ headers: { "PAYMENT-REQUIRED": "not-json" } })
      .expect(200);

    expect(response.body.missing).toContain("PAYMENT-SIGNATURE|X-PAYMENT|X-402-PAYMENT");
    expect(response.body.parseWarnings.length).toBeGreaterThan(0);
    expect(response.body.exampleFix.curl).toContain("curl");
  });
});
